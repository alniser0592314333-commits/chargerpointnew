BEGIN;

-- Add an item to an existing order only after same-session customer lookup.
-- The canonical ADD_ORDER_ITEM command owns price snapshots, charger fee,
-- item sequencing, audit/change-log and idempotency behavior.
CREATE OR REPLACE FUNCTION public.sarah_ai_add_item_to_existing_order(
  p_request_id uuid,
  p_customer_code text,
  p_name_hint text,
  p_order_id uuid,
  p_device_type_id uuid,
  p_has_charger boolean,
  p_manual_price_minor bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session_id uuid;
  v_code text;
  v_name_hint text;
  v_customer_id uuid;
  v_customer_count integer;
  v_order_customer_id uuid;
  v_order_status text;
  v_day_is_closed boolean;
  v_device_count integer;
  v_device_active boolean;
  v_quota jsonb;
  v_payload jsonb;
  v_result jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();

  IF auth.uid() IS NULL OR COALESCE(auth.jwt()->>'session_id','') = '' THEN
    RAISE EXCEPTION 'Authenticated session required' USING ERRCODE='28000';
  END IF;
  v_session_id := (auth.jwt()->>'session_id')::uuid;

  IF p_request_id IS NULL OR p_order_id IS NULL OR p_device_type_id IS NULL
     OR p_customer_code IS NULL OR pg_catalog.btrim(p_customer_code) !~* '^[A-F0-9]{4}$'
     OR p_has_charger IS NULL
     OR (p_manual_price_minor IS NOT NULL AND p_manual_price_minor <= 0) THEN
    RAISE EXCEPTION 'Invalid order item input' USING ERRCODE='22023';
  END IF;
  v_code := pg_catalog.upper(pg_catalog.btrim(p_customer_code));

  IF p_name_hint IS NOT NULL AND pg_catalog.btrim(p_name_hint) <> '' THEN
    IF pg_catalog.char_length(p_name_hint)>64 OR pg_catalog.char_length(pg_catalog.btrim(p_name_hint))<2
       OR p_name_hint ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'Customer name hint must be 2 to 64 printable characters' USING ERRCODE='22023';
    END IF;
    v_name_hint := pg_catalog.regexp_replace(pg_catalog.btrim(p_name_hint),'\s+',' ','g');
  END IF;

  PERFORM public._cp_assert_active_admin_permission('customers:view');
  PERFORM public._cp_assert_active_admin_permission('orders:view');
  PERFORM public._cp_assert_active_admin_permission('orders:edit');
  PERFORM public._cp_assert_active_admin_permission('devices:view');

  SELECT count(*)::integer, (array_agg(c.id ORDER BY c.name,c.id))[1]
    INTO v_customer_count,v_customer_id
  FROM public.customers c
  JOIN public.sarah_ai_customer_lookup_proofs proof
    ON proof.customer_id=c.id
   AND proof.auth_user_id=auth.uid()
   AND proof.auth_session_id=v_session_id
   AND proof.customer_code=v_code
   AND proof.expires_at>now()
  WHERE c.is_active IS TRUE AND c.deleted_at IS NULL
    AND COALESCE(c.status,'')<>'DELETED'
    AND pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text,'-',''),4))=v_code
    AND (v_name_hint IS NULL OR pg_catalog.strpos(pg_catalog.lower(c.name),pg_catalog.lower(v_name_hint))>0);

  IF v_customer_count=0 THEN
    RAISE EXCEPTION 'Customer lookup proof is missing, expired, or belongs to another session' USING ERRCODE='42501';
  ELSIF v_customer_count>1 THEN
    RAISE EXCEPTION 'Customer code is ambiguous; a more specific name hint is required' USING ERRCODE='22023';
  END IF;

  SELECT o.customer_id,o.status,bd.is_closed
    INTO v_order_customer_id,v_order_status,v_day_is_closed
  FROM public.orders o
  JOIN public.business_days bd ON bd.id=o.day_id
  WHERE o.id=p_order_id
    AND o.deleted_at IS NULL
    AND o.cancelled_at IS NULL
  FOR UPDATE OF o;

  IF v_order_customer_id IS NULL THEN
    RAISE EXCEPTION 'Order not found or cancelled' USING ERRCODE='P0002';
  END IF;
  IF v_order_customer_id IS DISTINCT FROM v_customer_id THEN
    RAISE EXCEPTION 'Order does not belong to the verified customer' USING ERRCODE='42501';
  END IF;
  IF COALESCE(v_day_is_closed,false) IS TRUE THEN
    RAISE EXCEPTION 'Cannot add an item to an order in a closed business day' USING ERRCODE='P2201';
  END IF;
  IF lower(COALESCE(v_order_status,'')) IN ('cancelled','canceled') THEN
    RAISE EXCEPTION 'Cannot add an item to a cancelled order' USING ERRCODE='P2201';
  END IF;

  SELECT count(*)::integer, bool_and(dt.is_active IS TRUE AND dt.deleted_at IS NULL
    AND COALESCE(dt.status,'ACTIVE') NOT IN ('RETIRED','DELETED'))
    INTO v_device_count,v_device_active
  FROM public.device_types dt
  WHERE dt.id=p_device_type_id;

  IF v_device_count<>1 OR v_device_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Device type not found or inactive in the current catalog' USING ERRCODE='22023';
  END IF;

  v_quota:=public.sarah_ai_consume_my_quota('tool_hour');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_QUOTA_EXCEEDED' USING ERRCODE='P0001';
  END IF;
  v_quota:=public.sarah_ai_consume_my_quota('tool_day');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_DAILY_LIMIT_REACHED' USING ERRCODE='P0001';
  END IF;

  v_payload:=pg_catalog.jsonb_strip_nulls(jsonb_build_object(
    'id',p_request_id,
    'orderId',p_order_id,
    'deviceTypeId',p_device_type_id,
    'hasCharger',p_has_charger,
    'manualPriceMinor',p_manual_price_minor
  ));

  v_result:=public.execute_sync_command(
    p_request_id,'ADD_ORDER_ITEM','orders',p_order_id,v_payload,NULL
  );

  RETURN jsonb_build_object(
    'ok',COALESCE((v_result->>'success')::boolean,false),
    'order_id',p_order_id,
    'order_item_id',COALESCE(v_result#>>'{result,orderItemId}',p_request_id::text),
    'canonical_result',v_result->'result',
    'idempotent_replay',COALESCE((v_result->>'idempotent')::boolean,false)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_add_item_to_existing_order(uuid,text,text,uuid,uuid,boolean,bigint)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_add_item_to_existing_order(uuid,text,text,uuid,uuid,boolean,bigint)
  TO authenticated;

COMMIT;
