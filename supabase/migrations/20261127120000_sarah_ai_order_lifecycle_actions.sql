BEGIN;

-- Add stable target identifiers to the existing bounded, proof-scoped order read.
-- They are only returned after the same-session customer lookup proof succeeds.
DO $projection$
DECLARE
  v_definition text;
  v_anchor text := '''business_date'', d.business_date,';
  v_replacement text := '''order_id'', o.id,
      ''order_version'', o.version,
      ''business_date'', d.business_date,';
  v_item_anchor text := '''device'', COALESCE(i.device_name_snapshot, dt.name_ar, dt.name, ''جهاز''),';
  v_item_replacement text := '''item_id'', i.id,
          ''item_version'', i.version,
          ''order_id'', i.order_id,
          ''device'', COALESCE(i.device_name_snapshot, dt.name_ar, dt.name, ''جهاز''),';
BEGIN
  v_definition := pg_catalog.pg_get_functiondef('public.sarah_ai_get_customer_orders(text,text,integer)'::regprocedure);
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor) <> 1
     OR (length(v_definition)-length(replace(v_definition,v_item_anchor,'')))/length(v_item_anchor) <> 1 THEN
    RAISE EXCEPTION 'Sarah customer order projection changed; refusing unsafe identifier exposure';
  END IF;
  v_definition := replace(v_definition,v_anchor,v_replacement);
  v_definition := replace(v_definition,v_item_anchor,v_item_replacement);
  EXECUTE v_definition;
END;
$projection$;

-- Every lifecycle mutation is bound to a customer lookup proof for this exact
-- Auth session and verifies that the target order/item belongs to that customer.
-- The final transition is always executed by the application's canonical sync
-- command dispatcher, which independently checks live permissions, BIN, state,
-- financial reversals, and idempotency.
CREATE OR REPLACE FUNCTION public.sarah_ai_execute_order_action(
  p_request_id uuid,
  p_customer_code text,
  p_name_hint text,
  p_target_id uuid,
  p_action text,
  p_bin text,
  p_reason text DEFAULT NULL
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
  v_action text := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_action,'')));
  v_customer_id uuid;
  v_customer_count integer;
  v_target_customer_id uuid;
  v_command_type text;
  v_aggregate_type text;
  v_payload jsonb;
  v_result jsonb;
  v_quota jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();

  IF auth.uid() IS NULL OR COALESCE(auth.jwt()->>'session_id','') = '' THEN
    RAISE EXCEPTION 'Authenticated session required' USING ERRCODE='28000';
  END IF;
  v_session_id := (auth.jwt()->>'session_id')::uuid;

  IF p_request_id IS NULL OR p_target_id IS NULL
     OR p_customer_code IS NULL OR pg_catalog.btrim(p_customer_code) !~* '^[A-F0-9]{4}$' THEN
    RAISE EXCEPTION 'A valid request, customer code, and target ID are required' USING ERRCODE='22023';
  END IF;
  v_code := pg_catalog.upper(pg_catalog.btrim(p_customer_code));

  IF p_name_hint IS NOT NULL AND pg_catalog.btrim(p_name_hint) <> '' THEN
    IF pg_catalog.char_length(p_name_hint)>64 OR pg_catalog.char_length(pg_catalog.btrim(p_name_hint))<2
       OR p_name_hint ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'Customer name hint must be 2 to 64 printable characters' USING ERRCODE='22023';
    END IF;
    v_name_hint := pg_catalog.regexp_replace(pg_catalog.btrim(p_name_hint),'\s+',' ','g');
  END IF;

  IF p_bin IS NULL OR p_bin !~ '^\d{4,32}$' THEN
    RAISE EXCEPTION 'BIN_REQUIRED' USING ERRCODE='P4004';
  END IF;
  IF p_reason IS NOT NULL AND (pg_catalog.char_length(p_reason)>500 OR p_reason ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'Action reason is too long or contains control characters' USING ERRCODE='22023';
  END IF;

  PERFORM public._cp_assert_active_admin_permission('orders:view');

  IF v_action='DELIVER_ITEM' THEN
    v_command_type:='DELIVER_ORDER_ITEM';
    v_aggregate_type:='order_items';
    PERFORM public._cp_assert_active_admin_permission('orders:deliver');
  ELSIF v_action='CANCEL_ITEM' THEN
    v_command_type:='CANCEL_ORDER_ITEM';
    v_aggregate_type:='order_items';
    PERFORM public._cp_assert_active_admin_permission('orders:cancel');
  ELSIF v_action='CANCEL_ORDER' THEN
    v_command_type:='CANCEL_ORDER';
    v_aggregate_type:='orders';
    PERFORM public._cp_assert_active_admin_permission('orders:cancel');
  ELSE
    RAISE EXCEPTION 'Unsupported order action' USING ERRCODE='22023';
  END IF;

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

  IF v_action='CANCEL_ORDER' THEN
    SELECT o.customer_id INTO v_target_customer_id
    FROM public.orders o
    WHERE o.id=p_target_id AND o.deleted_at IS NULL
    FOR UPDATE;
  ELSE
    SELECT o.customer_id INTO v_target_customer_id
    FROM public.order_items i
    JOIN public.orders o ON o.id=i.order_id
    WHERE i.id=p_target_id AND i.deleted_at IS NULL AND o.deleted_at IS NULL
    FOR UPDATE OF i,o;
  END IF;

  IF v_target_customer_id IS NULL THEN
    RAISE EXCEPTION 'Order target not found or unavailable' USING ERRCODE='P0002';
  END IF;
  IF v_target_customer_id IS DISTINCT FROM v_customer_id THEN
    RAISE EXCEPTION 'Order target does not belong to the verified customer' USING ERRCODE='42501';
  END IF;

  v_quota:=public.sarah_ai_consume_my_quota('tool_hour');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_QUOTA_EXCEEDED' USING ERRCODE='P0001';
  END IF;
  v_quota:=public.sarah_ai_consume_my_quota('tool_day');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_DAILY_LIMIT_REACHED' USING ERRCODE='P0001';
  END IF;

  IF v_action='CANCEL_ORDER' THEN
    v_payload:=pg_catalog.jsonb_strip_nulls(jsonb_build_object(
      'orderId',p_target_id,'bin',p_bin,'reason',p_reason
    ));
  ELSE
    v_payload:=pg_catalog.jsonb_strip_nulls(jsonb_build_object(
      'itemId',p_target_id,'bin',p_bin,'reason',p_reason
    ));
  END IF;

  v_result:=public.execute_sync_command(
    p_request_id,v_command_type,v_aggregate_type,p_target_id,v_payload,NULL
  );
  RETURN jsonb_build_object(
    'ok',COALESCE((v_result->>'success')::boolean,false),
    'action',v_action,
    'target_id',p_target_id,
    'canonical_result',v_result->'result',
    'idempotent_replay',COALESCE((v_result->>'idempotent')::boolean,false)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_execute_order_action(uuid,text,text,uuid,text,text,text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_execute_order_action(uuid,text,text,uuid,text,text,text)
  TO authenticated;

COMMIT;
