-- Central, server-authoritative Jawwal Pay recipient number.
CREATE TABLE IF NOT EXISTS public.jawwal_pay_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  recipient_phone text NOT NULL CHECK (recipient_phone ~ '^05[0-9]{8}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE public.jawwal_pay_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.jawwal_pay_settings FROM PUBLIC, anon, authenticated;
INSERT INTO public.jawwal_pay_settings (singleton, recipient_phone)
VALUES (true, '0592369875')
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION public.get_jawwal_pay_recipient()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_phone text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  SELECT recipient_phone INTO v_phone
  FROM public.jawwal_pay_settings WHERE singleton = true;
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'Jawwal Pay recipient is not configured' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('recipient_phone', v_phone);
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_jawwal_pay_recipient(p_recipient_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_phone text;
BEGIN
  IF auth.uid() IS NULL OR public.is_my_account_session_active() IS NOT TRUE THEN
    RAISE EXCEPTION 'Active admin session required' USING ERRCODE = 'P0001';
  END IF;

  v_phone := regexp_replace(coalesce(p_recipient_phone, ''), '[[:space:]()-]', '', 'g');
  IF v_phone !~ '^05[0-9]{8}$' THEN
    RAISE EXCEPTION 'Recipient must be a valid Palestinian mobile number (05xxxxxxxx)' USING ERRCODE = '22023';
  END IF;

  SELECT a.id INTO v_admin_id
  FROM public.admins a
  WHERE a.auth_user_id = auth.uid() AND a.is_active = true
  LIMIT 1;

  IF v_admin_id IS NULL OR (
    NOT EXISTS (
      SELECT 1 FROM public.get_effective_permissions(v_admin_id)
      WHERE permission = 'settings:manage'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.admins a
      WHERE a.id = v_admin_id AND a.role IN ('SUPER_ADMIN', 'Super Admin')
    )
  ) THEN
    RAISE EXCEPTION 'Missing settings management permission' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.jawwal_pay_settings(singleton, recipient_phone, updated_at, updated_by)
  VALUES (true, v_phone, clock_timestamp(), v_admin_id)
  ON CONFLICT (singleton) DO UPDATE
    SET recipient_phone = EXCLUDED.recipient_phone,
        updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by;

  RETURN jsonb_build_object('success', true, 'recipient_phone', v_phone);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_jawwal_pay_recipient() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_jawwal_pay_recipient() TO authenticated;
REVOKE ALL ON FUNCTION public.set_jawwal_pay_recipient(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_jawwal_pay_recipient(text) TO authenticated;
