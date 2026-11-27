BEGIN;

CREATE OR REPLACE FUNCTION public.sarah_ai_get_business_day_orders(p_business_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_day_id uuid;
  v_day_status text;
  v_order_count integer;
  v_orders jsonb;
  v_quota jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();
  PERFORM public._cp_assert_active_admin_permission('orders:view');
  IF p_business_date IS NULL THEN
    RAISE EXCEPTION 'Business date is required' USING ERRCODE='22023';
  END IF;

  v_quota:=public.sarah_ai_consume_my_quota('tool_hour');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_QUOTA_EXCEEDED' USING ERRCODE='P0001';
  END IF;
  v_quota:=public.sarah_ai_consume_my_quota('tool_day');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_DAILY_LIMIT_REACHED' USING ERRCODE='P0001';
  END IF;

  SELECT d.id,d.status INTO v_day_id,v_day_status
  FROM public.business_days d
  WHERE d.business_date=p_business_date
  LIMIT 1;
  IF v_day_id IS NULL THEN
    RETURN jsonb_build_object('found',false,'business_date',p_business_date,'orders','[]'::jsonb,'order_count',0);
  END IF;

  SELECT count(*)::integer INTO v_order_count
  FROM public.orders o WHERE o.day_id=v_day_id;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'order_id',o.id,
      'display_number',o.display_number,
      'version',o.version,
      'customer_name',pg_catalog.left(c.name,80),
      'status',o.status,
      'item_count',(SELECT count(*)::integer FROM public.order_items oi WHERE oi.order_id=o.id)
    ) ORDER BY o.display_number,o.id
  ),'[]'::jsonb)
  INTO v_orders
  FROM (
    SELECT * FROM public.orders
    WHERE day_id=v_day_id
    ORDER BY display_number,id
    LIMIT 201
  ) o
  JOIN public.customers c ON c.id=o.customer_id;

  RETURN jsonb_build_object(
    'found',true,'business_date',p_business_date,'business_day_id',v_day_id,
    'status',v_day_status,'order_count',v_order_count,
    'has_more',v_order_count>200,
    'orders',COALESCE(v_orders,'[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.sarah_ai_renumber_business_day_orders(
  p_request_id uuid,
  p_business_date date,
  p_order_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session_id uuid;
  v_day_id uuid;
  v_day_closed boolean;
  v_order_count integer;
  v_changes jsonb;
  v_payload jsonb;
  v_request_payload jsonb;
  v_existing_session_id uuid;
  v_existing_action text;
  v_existing_payload jsonb;
  v_saved_result jsonb;
  v_quota jsonb;
  v_result jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();
  PERFORM public._cp_assert_active_admin_permission('orders:view');
  PERFORM public._cp_assert_active_admin_permission('orders:renumber-day');

  IF p_request_id IS NULL OR p_business_date IS NULL OR p_order_ids IS NULL
     OR cardinality(p_order_ids)<1 OR cardinality(p_order_ids)>200 THEN
    RAISE EXCEPTION 'Renumber request must include a date and 1 to 200 ordered order IDs' USING ERRCODE='22023';
  END IF;
  IF (SELECT count(DISTINCT x) FROM unnest(p_order_ids) x)<>cardinality(p_order_ids) THEN
    RAISE EXCEPTION 'Renumber order IDs must be unique' USING ERRCODE='22023';
  END IF;
  IF auth.uid() IS NULL OR COALESCE(auth.jwt()->>'session_id','')='' THEN
    RAISE EXCEPTION 'Authenticated admin session required' USING ERRCODE='28000';
  END IF;
  v_session_id:=(auth.jwt()->>'session_id')::uuid;

  SELECT d.id,d.is_closed INTO v_day_id,v_day_closed
  FROM public.business_days d
  WHERE d.business_date=p_business_date
  FOR UPDATE;
  IF v_day_id IS NULL THEN
    RAISE EXCEPTION 'Business day not found' USING ERRCODE='P0002';
  END IF;
  IF v_day_closed IS TRUE THEN
    RAISE EXCEPTION 'Closed business days cannot be renumbered' USING ERRCODE='P0409';
  END IF;

  SELECT count(*)::integer INTO v_order_count FROM public.orders o WHERE o.day_id=v_day_id;
  IF v_order_count<>cardinality(p_order_ids) OR v_order_count>200 THEN
    RAISE EXCEPTION 'Renumber list must include every order in the selected day; reload and review the complete day' USING ERRCODE='P0409';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_order_ids) supplied(id)
    WHERE NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id=supplied.id AND o.day_id=v_day_id)
  ) THEN
    RAISE EXCEPTION 'Renumber list contains an order outside the selected business day' USING ERRCODE='P0409';
  END IF;

  v_request_payload:=jsonb_build_object('business_date',p_business_date,'order_ids',to_jsonb(p_order_ids));
  INSERT INTO public.sarah_ai_action_idempotency(
    auth_user_id,auth_session_id,request_id,action_name,request_payload
  )
  VALUES(auth.uid(),v_session_id,p_request_id,'renumber_business_day_orders',v_request_payload)
  ON CONFLICT(auth_user_id,request_id) DO NOTHING;
  SELECT auth_session_id,action_name,request_payload,result
  INTO v_existing_session_id,v_existing_action,v_existing_payload,v_saved_result
  FROM public.sarah_ai_action_idempotency
  WHERE auth_user_id=auth.uid() AND request_id=p_request_id
  FOR UPDATE;
  IF v_existing_session_id IS DISTINCT FROM v_session_id
     OR v_existing_action IS DISTINCT FROM 'renumber_business_day_orders'
     OR v_existing_payload IS DISTINCT FROM v_request_payload THEN
    RAISE EXCEPTION 'Request id belongs to another session or different renumber input' USING ERRCODE='P0409';
  END IF;
  IF v_saved_result IS NOT NULL THEN
    RETURN v_saved_result || jsonb_build_object('idempotent_replay',true);
  END IF;

  v_quota:=public.sarah_ai_consume_my_quota('tool_hour');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_QUOTA_EXCEEDED' USING ERRCODE='P0001';
  END IF;
  v_quota:=public.sarah_ai_consume_my_quota('tool_day');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_DAILY_LIMIT_REACHED' USING ERRCODE='P0001';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'id',o.id,
      'expectedVersion',o.version,
      'oldNumber',o.display_number,
      'newNumber',requested.ordinality
    ) ORDER BY requested.ordinality
  )
  INTO v_changes
  FROM unnest(p_order_ids) WITH ORDINALITY requested(order_id,ordinality)
  JOIN public.orders o ON o.id=requested.order_id AND o.day_id=v_day_id;

  IF COALESCE(jsonb_array_length(v_changes),0)<>v_order_count THEN
    RAISE EXCEPTION 'Renumber target changed while preparing the operation; reload and review again' USING ERRCODE='P0409';
  END IF;

  v_payload:=jsonb_build_object('dayId',v_day_id,'changes',v_changes);
  v_result:=public.execute_sync_command(
    p_request_id,'RENUMBER_DAY_ORDERS','business_days',v_day_id,v_payload,NULL
  );
  IF COALESCE((v_result->>'success')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Canonical renumber command did not confirm success' USING ERRCODE='P0001';
  END IF;
  UPDATE public.sarah_ai_action_idempotency
  SET result=v_result
  WHERE auth_user_id=auth.uid() AND request_id=p_request_id;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_get_business_day_orders(date) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_get_business_day_orders(date) TO authenticated;
REVOKE ALL ON FUNCTION public.sarah_ai_renumber_business_day_orders(uuid,date,uuid[]) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_renumber_business_day_orders(uuid,date,uuid[]) TO authenticated;

COMMIT;
