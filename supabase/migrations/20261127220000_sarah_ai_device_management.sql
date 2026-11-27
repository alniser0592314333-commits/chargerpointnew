BEGIN;

-- Narrow, session-bound entry points for admin operations already supported by
-- the canonical sync command pipeline. No business table is written directly.

CREATE OR REPLACE FUNCTION public.sarah_ai_manage_device_type(
  p_request_id uuid,
  p_action text,
  p_device_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_name_ar text DEFAULT NULL,
  p_name_en text DEFAULT NULL,
  p_icon text DEFAULT NULL,
  p_base_price_minor bigint DEFAULT NULL,
  p_charger_fee_enabled boolean DEFAULT NULL,
  p_charger_fee_applicable boolean DEFAULT NULL,
  p_is_active boolean DEFAULT NULL,
  p_sort_order integer DEFAULT NULL,
  p_expected_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_action text;
  v_command_type text;
  v_device_id uuid;
  v_payload jsonb;
  v_result jsonb;
  v_quota jsonb;
  v_session_id uuid;
  v_existing_session_id uuid;
  v_request_payload jsonb;
  v_existing_action text;
  v_existing_payload jsonb;
  v_saved_result jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();
  PERFORM public._cp_assert_active_admin_permission('devices:manage');

  v_action:=pg_catalog.upper(pg_catalog.btrim(COALESCE(p_action,'')));
  IF p_request_id IS NULL OR v_action NOT IN ('CREATE','UPDATE','RETIRE') THEN
    RAISE EXCEPTION 'Invalid device action' USING ERRCODE='22023';
  END IF;
  IF p_base_price_minor IS NOT NULL THEN
    PERFORM public._cp_assert_active_admin_permission('devices:pricing');
    IF p_base_price_minor<=0 THEN RAISE EXCEPTION 'Device base price must be positive' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_charger_fee_enabled IS NOT NULL OR p_charger_fee_applicable IS NOT NULL THEN
    PERFORM public._cp_assert_active_admin_permission('devices:charger-policy');
  END IF;
  IF p_sort_order IS NOT NULL AND p_sort_order<0 THEN
    RAISE EXCEPTION 'Device sort order cannot be negative' USING ERRCODE='22023';
  END IF;
  IF p_name IS NOT NULL AND (
       pg_catalog.char_length(pg_catalog.btrim(p_name)) NOT BETWEEN 1 AND 80
       OR p_name ~ '[[:cntrl:]]'
     ) THEN
    RAISE EXCEPTION 'Device name is invalid' USING ERRCODE='22023';
  END IF;
  IF p_name_ar IS NOT NULL AND (
       pg_catalog.char_length(pg_catalog.btrim(p_name_ar)) NOT BETWEEN 1 AND 80
       OR p_name_ar ~ '[[:cntrl:]]'
     ) THEN
    RAISE EXCEPTION 'Arabic device name is invalid' USING ERRCODE='22023';
  END IF;
  IF p_name_en IS NOT NULL AND (
       pg_catalog.char_length(pg_catalog.btrim(p_name_en)) NOT BETWEEN 1 AND 80
       OR p_name_en ~ '[[:cntrl:]]'
     ) THEN
    RAISE EXCEPTION 'English device name is invalid' USING ERRCODE='22023';
  END IF;
  IF p_icon IS NOT NULL AND (
       pg_catalog.char_length(pg_catalog.btrim(p_icon)) NOT BETWEEN 1 AND 40
       OR p_icon ~ '[[:cntrl:]]'
     ) THEN
    RAISE EXCEPTION 'Device icon is invalid' USING ERRCODE='22023';
  END IF;

  IF v_action='CREATE' THEN
    IF p_device_id IS NOT NULL OR p_name IS NULL
       OR pg_catalog.char_length(pg_catalog.btrim(p_name)) NOT BETWEEN 1 AND 80
       OR p_base_price_minor IS NULL THEN
      RAISE EXCEPTION 'New device requires a name and base price' USING ERRCODE='22023';
    END IF;
    v_device_id:=p_request_id;
    v_command_type:='CREATE_DEVICE_TYPE';
  ELSE
    IF p_device_id IS NULL OR p_expected_version IS NULL OR p_expected_version<1 THEN
      RAISE EXCEPTION 'Device id and expected version are required' USING ERRCODE='22023';
    END IF;
    v_device_id:=p_device_id;
    v_command_type:=CASE WHEN v_action='RETIRE' THEN 'RETIRE_DEVICE_TYPE' ELSE 'UPDATE_DEVICE_TYPE' END;
    IF v_action='UPDATE' AND p_name IS NULL AND p_name_ar IS NULL AND p_name_en IS NULL
       AND p_icon IS NULL AND p_base_price_minor IS NULL AND p_charger_fee_enabled IS NULL
       AND p_charger_fee_applicable IS NULL AND p_is_active IS NULL AND p_sort_order IS NULL THEN
      RAISE EXCEPTION 'No device fields were supplied for update' USING ERRCODE='22023';
    END IF;
  END IF;

  IF auth.uid() IS NULL OR COALESCE(auth.jwt()->>'session_id','')='' THEN
    RAISE EXCEPTION 'Authenticated admin session required' USING ERRCODE='28000';
  END IF;
  v_session_id:=(auth.jwt()->>'session_id')::uuid;
  v_payload:=pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'id',v_device_id,'name',p_name,'nameAr',p_name_ar,'nameEn',p_name_en,'icon',p_icon,
    'basePriceMinor',p_base_price_minor,'chargerFeeEnabled',p_charger_fee_enabled,
    'chargerFeeApplicable',p_charger_fee_applicable,
    'isActive',CASE WHEN v_action='RETIRE' THEN false ELSE p_is_active END,
    'sortOrder',p_sort_order
  ));
  v_request_payload:=jsonb_build_object(
    'action',v_action,'device_id',v_device_id,'payload',v_payload,
    'expected_version',p_expected_version
  );
  INSERT INTO public.sarah_ai_action_idempotency(
    auth_user_id,auth_session_id,request_id,action_name,request_payload
  )
  VALUES(auth.uid(),v_session_id,p_request_id,'manage_device_type',v_request_payload)
  ON CONFLICT(auth_user_id,request_id) DO NOTHING;
  SELECT auth_session_id,action_name,request_payload,result
  INTO v_existing_session_id,v_existing_action,v_existing_payload,v_saved_result
  FROM public.sarah_ai_action_idempotency
  WHERE auth_user_id=auth.uid() AND request_id=p_request_id
  FOR UPDATE;
  IF v_existing_session_id IS DISTINCT FROM v_session_id
     OR v_existing_action IS DISTINCT FROM 'manage_device_type' THEN
    RAISE EXCEPTION 'Request id belongs to another session or action' USING ERRCODE='P0409';
  END IF;
  IF v_existing_payload IS DISTINCT FROM v_request_payload THEN
    RAISE EXCEPTION 'Completed request id cannot be reused with different device input' USING ERRCODE='P0409';
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

  v_result:=public.execute_sync_command(p_request_id,v_command_type,'device_types',v_device_id,v_payload,p_expected_version);
  IF COALESCE((v_result->>'success')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Canonical device command did not confirm success' USING ERRCODE='P0001';
  END IF;
  UPDATE public.sarah_ai_action_idempotency
  SET result=v_result
  WHERE auth_user_id=auth.uid() AND request_id=p_request_id;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_manage_device_type(uuid,text,uuid,text,text,text,text,bigint,boolean,boolean,boolean,integer,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_manage_device_type(uuid,text,uuid,text,text,text,text,bigint,boolean,boolean,boolean,integer,integer) TO authenticated;

COMMIT;
