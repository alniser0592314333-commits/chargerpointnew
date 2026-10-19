-- Public landing page: minimal safe projection plus administrator-managed activity and hours.
-- Branch-only migration; do not apply to production without explicit approval.
CREATE OR REPLACE FUNCTION public.public_landing_content()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_hours jsonb; v_devices jsonb;
BEGIN
  SELECT value_json INTO v_hours FROM public.system_settings WHERE key='public_landing_hours' LIMIT 1;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name_ar', COALESCE(name_ar, name),
    'name_en', COALESCE(NULLIF(name_en,''), name, name_ar),
    'price_minor', base_price_minor,
    'charger_fee_applicable', COALESCE(charger_fee_applicable, charger_fee_enabled, false),
    'sort_order', sort_order
  ) ORDER BY sort_order, name), '[]'::jsonb)
  INTO v_devices
  FROM public.device_types
  WHERE is_active IS TRUE AND deleted_at IS NULL AND COALESCE(status,'ACTIVE') <> 'DELETED';
  RETURN jsonb_build_object(
    'hours', COALESCE(v_hours, jsonb_build_object('is_active',false,'open_time',null,'close_time',null,'next_open_time',null,'next_close_time',null)),
    'devices', v_devices,
    'charger_fee_minor', COALESCE((SELECT value_number FROM public.system_settings WHERE key='default_charger_fee_minor' LIMIT 1),50)
  );
END $$;
REVOKE ALL ON FUNCTION public.public_landing_content() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.public_landing_content() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.update_public_landing_settings(p_settings jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_admin_id uuid; v_role text; v_permissions text[]; v_settings jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_admin_session() THEN RAISE EXCEPTION 'ACCESS_DENIED'; END IF;
  SELECT a.id, COALESCE(a.role,r.name,''), COALESCE(a.permissions,ARRAY[]::text[])
  INTO v_admin_id,v_role,v_permissions
  FROM public.admins a LEFT JOIN public.roles r ON r.id=a.role_id
  WHERE a.auth_user_id=auth.uid() AND a.is_active IS TRUE AND a.disabled_at IS NULL LIMIT 1;
  IF v_admin_id IS NULL OR (
    upper(replace(v_role,' ','_')) <> 'SUPER_ADMIN'
    AND NOT ('settings:manage'=ANY(v_permissions))
    AND NOT EXISTS (
      SELECT 1 FROM public.role_permissions rp
      WHERE rp.role=v_role AND rp.permission='settings:manage'
      AND NOT EXISTS (SELECT 1 FROM public.admin_custom_permissions cp WHERE cp.admin_id=v_admin_id AND cp.permission='settings:manage' AND cp.is_grant IS FALSE)
    )
    AND NOT EXISTS (SELECT 1 FROM public.admin_custom_permissions cp WHERE cp.admin_id=v_admin_id AND cp.permission='settings:manage' AND cp.is_grant IS TRUE)
  ) THEN RAISE EXCEPTION 'ACCESS_DENIED'; END IF;
  IF jsonb_typeof(p_settings)<>'object'
    OR jsonb_typeof(p_settings->'is_active')<>'boolean'
    OR COALESCE(p_settings->>'open_time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    OR COALESCE(p_settings->>'close_time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    OR COALESCE(p_settings->>'next_open_time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    OR COALESCE(p_settings->>'next_close_time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  THEN RAISE EXCEPTION 'INVALID_PUBLIC_LANDING_SETTINGS'; END IF;
  v_settings := jsonb_build_object(
    'is_active',(p_settings->>'is_active')::boolean,
    'open_time',p_settings->>'open_time','close_time',p_settings->>'close_time',
    'next_open_time',p_settings->>'next_open_time','next_close_time',p_settings->>'next_close_time'
  );
  INSERT INTO public.system_settings(key,value_type,value_json,description,updated_at,updated_by)
  VALUES('public_landing_hours','json',v_settings,'Public landing activity and operating hours',now(),v_admin_id)
  ON CONFLICT(key) DO UPDATE SET value_type=EXCLUDED.value_type,value_json=EXCLUDED.value_json,
    description=EXCLUDED.description,updated_at=now(),updated_by=EXCLUDED.updated_by;
  RETURN v_settings;
END $$;
REVOKE ALL ON FUNCTION public.update_public_landing_settings(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_public_landing_settings(jsonb) TO authenticated, service_role;
