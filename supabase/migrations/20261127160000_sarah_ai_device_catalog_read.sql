BEGIN;

CREATE OR REPLACE FUNCTION public.sarah_ai_get_device_catalog()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_quota jsonb;
  v_devices jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();
  PERFORM public._cp_assert_active_admin_permission('devices:view');

  v_quota := public.sarah_ai_consume_my_quota('tool_hour');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_QUOTA_EXCEEDED' USING ERRCODE='P0001';
  END IF;
  v_quota := public.sarah_ai_consume_my_quota('tool_day');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_DAILY_LIMIT_REACHED' USING ERRCODE='P0001';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'device_type_id',d.id,
        'name',pg_catalog.left(COALESCE(d.name,''),80),
        'name_ar',pg_catalog.left(COALESCE(d.name_ar,''),80),
        'name_en',pg_catalog.left(COALESCE(d.name_en,''),80),
        'base_price_minor',d.base_price_minor,
        'charger_fee_enabled',d.charger_fee_enabled,
        'charger_fee_applicable',d.charger_fee_applicable,
        'is_active',d.is_active,
        'status',d.status,
        'sort_order',d.sort_order,
        'version',d.version
      ) ORDER BY d.sort_order,d.name,d.id
    ),'[]'::jsonb
  )
  INTO v_devices
  FROM (
    SELECT *
    FROM public.device_types
    WHERE COALESCE(status,'ACTIVE') <> 'RETIRED'
      AND COALESCE(deleted_at IS NULL,true)
    ORDER BY sort_order,name,id
    LIMIT 100
  ) d;

  RETURN jsonb_build_object('ok',true,'devices',v_devices,'count',jsonb_array_length(v_devices));
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_get_device_catalog() FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_get_device_catalog() TO authenticated;

COMMIT;
