BEGIN;

-- Narrow, session-bound entry points for admin operations already supported by
-- the canonical sync command pipeline. No business table is written directly.

CREATE OR REPLACE FUNCTION public.sarah_ai_manage_customer_controls(
  p_request_id uuid,
  p_customer_code text,
  p_name_hint text,
  p_debt_limit_minor bigint DEFAULT NULL,
  p_is_active boolean DEFAULT NULL,
  p_charger_fee_exempt boolean DEFAULT NULL,
  p_bin text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session_id uuid;
  v_customer_id uuid;
  v_customer_count integer;
  v_payload jsonb;
  v_result jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();
  PERFORM public._cp_assert_active_admin_permission('customers:view');
  PERFORM public._cp_assert_active_admin_permission('customers:edit');

  IF p_request_id IS NULL OR p_customer_code IS NULL
     OR pg_catalog.btrim(p_customer_code) !~* '^[A-F0-9]{4}$'
     OR p_name_hint IS NULL OR pg_catalog.char_length(pg_catalog.btrim(p_name_hint))<2
     OR pg_catalog.char_length(p_name_hint)>64 OR p_name_hint ~ '[[:cntrl:]]'
     OR (p_debt_limit_minor IS NULL AND p_is_active IS NULL AND p_charger_fee_exempt IS NULL)
     OR (p_debt_limit_minor IS NOT NULL AND p_debt_limit_minor<0) THEN
    RAISE EXCEPTION 'Invalid customer control update' USING ERRCODE='22023';
  END IF;

  IF p_debt_limit_minor IS NOT NULL THEN
    PERFORM public._cp_assert_active_admin_permission('customers:debt-limit');
  END IF;
  IF p_charger_fee_exempt IS NOT NULL THEN
    PERFORM public._cp_assert_active_admin_permission('customers:charger-exemption');
  END IF;
  IF p_is_active IS NOT NULL THEN
    PERFORM public._cp_assert_active_admin_permission('customers:deactivate');
  END IF;

  IF COALESCE(auth.jwt()->>'session_id','')='' THEN
    RAISE EXCEPTION 'Authenticated admin session required' USING ERRCODE='28000';
  END IF;
  v_session_id:=(auth.jwt()->>'session_id')::uuid;

  SELECT count(*)::integer,(array_agg(c.id ORDER BY c.name,c.id))[1]
  INTO v_customer_count,v_customer_id
  FROM public.customers c
  JOIN public.sarah_ai_customer_lookup_proofs proof
    ON proof.customer_id=c.id AND proof.auth_user_id=auth.uid()
   AND proof.auth_session_id=v_session_id
   AND proof.customer_code=pg_catalog.upper(pg_catalog.btrim(p_customer_code))
   AND proof.expires_at>now()
  WHERE c.is_active IS TRUE AND c.deleted_at IS NULL
    AND COALESCE(c.status,'')<>'DELETED'
    AND pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text,'-',''),4))=pg_catalog.upper(pg_catalog.btrim(p_customer_code))
    AND pg_catalog.strpos(pg_catalog.lower(c.name),pg_catalog.lower(pg_catalog.btrim(p_name_hint)))>0;

  IF v_customer_count=0 THEN
    RAISE EXCEPTION 'Customer lookup proof expired or customer not found' USING ERRCODE='P0002';
  ELSIF v_customer_count>1 THEN
    RAISE EXCEPTION 'Customer code is ambiguous; provide a more specific name hint' USING ERRCODE='22023';
  END IF;

  v_payload:=pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'id',v_customer_id,'debtLimitMinor',p_debt_limit_minor,
    'isActive',p_is_active,'chargerFeeExempt',p_charger_fee_exempt,'bin',p_bin
  ));
  v_result:=public.execute_sync_command(p_request_id,'UPDATE_CUSTOMER','customers',v_customer_id,v_payload,NULL);
  IF COALESCE((v_result->>'success')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Canonical customer update did not confirm success' USING ERRCODE='P0001';
  END IF;
  RETURN v_result;
END;
$function$;

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

  v_payload:=pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'id',v_device_id,'name',p_name,'nameAr',p_name_ar,'nameEn',p_name_en,'icon',p_icon,
    'basePriceMinor',p_base_price_minor,'chargerFeeEnabled',p_charger_fee_enabled,
    'chargerFeeApplicable',p_charger_fee_applicable,
    'isActive',CASE WHEN v_action='RETIRE' THEN false ELSE p_is_active END,
    'sortOrder',p_sort_order
  ));
  v_result:=public.execute_sync_command(p_request_id,v_command_type,'device_types',v_device_id,v_payload,p_expected_version);
  IF COALESCE((v_result->>'success')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Canonical device command did not confirm success' USING ERRCODE='P0001';
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_manage_customer_controls(uuid,text,text,bigint,boolean,boolean,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_manage_customer_controls(uuid,text,text,bigint,boolean,boolean,text) TO authenticated;
REVOKE ALL ON FUNCTION public.sarah_ai_manage_device_type(uuid,text,uuid,text,text,text,text,bigint,boolean,boolean,boolean,integer,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_manage_device_type(uuid,text,uuid,text,text,text,text,bigint,boolean,boolean,boolean,integer,integer) TO authenticated;

COMMIT;
