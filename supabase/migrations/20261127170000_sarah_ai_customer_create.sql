BEGIN;

CREATE OR REPLACE FUNCTION public.sarah_ai_create_customer(
  p_request_id uuid,
  p_name text,
  p_phone text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session_id uuid;
  v_customer_id uuid;
  v_name text;
  v_phone text;
  v_request_payload jsonb;
  v_existing_action text;
  v_existing_payload jsonb;
  v_saved_result jsonb;
  v_command_result jsonb;
  v_result jsonb;
  v_quota jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();
  PERFORM public._cp_assert_active_admin_permission('customers:create');

  IF p_request_id IS NULL OR auth.uid() IS NULL
     OR COALESCE(auth.jwt()->>'session_id','') = '' THEN
    RAISE EXCEPTION 'Authenticated session and stable request id required' USING ERRCODE='28000';
  END IF;
  v_session_id := (auth.jwt()->>'session_id')::uuid;
  v_name := pg_catalog.regexp_replace(pg_catalog.btrim(COALESCE(p_name,'')), '\s+', ' ', 'g');
  v_phone := NULLIF(pg_catalog.btrim(COALESCE(p_phone,'')),'');
  IF v_name='' OR pg_catalog.char_length(v_name)>80 OR v_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Customer name must be 1 to 80 printable characters' USING ERRCODE='22023';
  END IF;
  IF v_phone IS NOT NULL AND (pg_catalog.char_length(v_phone)>32 OR v_phone ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'Customer phone must be at most 32 printable characters' USING ERRCODE='22023';
  END IF;

  v_request_payload:=jsonb_build_object('name',v_name,'phone',v_phone,'debt_limit_minor',2000,'charger_fee_exempt',false);
  INSERT INTO public.sarah_ai_action_idempotency(auth_user_id,auth_session_id,request_id,action_name,request_payload)
  VALUES(auth.uid(),v_session_id,p_request_id,'create_customer',v_request_payload)
  ON CONFLICT(auth_user_id,request_id) DO NOTHING;

  SELECT action_name,request_payload,result
    INTO v_existing_action,v_existing_payload,v_saved_result
  FROM public.sarah_ai_action_idempotency
  WHERE auth_user_id=auth.uid() AND request_id=p_request_id
  FOR UPDATE;

  IF v_existing_action IS DISTINCT FROM 'create_customer' THEN
    RAISE EXCEPTION 'Request id was already used for a different action' USING ERRCODE='P0409';
  END IF;
  IF v_saved_result IS NOT NULL THEN
    IF v_existing_payload IS DISTINCT FROM v_request_payload THEN
      RAISE EXCEPTION 'Completed request id cannot be reused with different input' USING ERRCODE='P0409';
    END IF;
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

  v_customer_id:=gen_random_uuid();
  v_command_result:=public.execute_sync_command(
    v_customer_id,'CREATE_CUSTOMER','customers',v_customer_id,
    jsonb_build_object(
      'id',v_customer_id,
      'name',v_name,
      'phone',v_phone,
      'notes','',
      'debtLimitMinor',2000,
      'chargerFeeExempt',false,
      'isActive',true
    ),
    NULL
  );
  IF COALESCE((v_command_result->>'success')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Canonical CREATE_CUSTOMER command did not confirm success' USING ERRCODE='P0001';
  END IF;

  v_result:=jsonb_build_object(
    'ok',true,
    'customer_id',v_customer_id,
    'customer_name',v_name,
    'customer_code',public.derive_customer_code(v_customer_id),
    'phone',v_phone,
    'debt_limit_minor',2000,
    'charger_fee_exempt',false
  );
  UPDATE public.sarah_ai_action_idempotency
  SET result=v_result
  WHERE auth_user_id=auth.uid() AND request_id=p_request_id;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_create_customer(uuid,text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_create_customer(uuid,text,text) TO authenticated;

COMMIT;
