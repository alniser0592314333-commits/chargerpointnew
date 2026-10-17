-- Close authorization gaps in authenticated-only policies and SECURITY DEFINER QR wrappers.
-- The earlier session-management migration adds a session check, but an authenticated
-- session is not itself proof that the identity belongs to an active application admin.
-- Do not touch policies that also grant anon/PUBLIC access (public QR capability routes).

DO $policies$
DECLARE
  p record;
  v_using text;
  v_check text;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND roles = ARRAY['authenticated']::name[]
  LOOP
    IF p.cmd IN ('SELECT', 'UPDATE', 'DELETE', 'ALL') THEN
      v_using := COALESCE(p.qual, 'true');
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I USING ((%s) AND public.is_active_admin_session())',
        p.policyname, p.schemaname, p.tablename, v_using
      );
    END IF;

    IF p.cmd IN ('INSERT', 'UPDATE', 'ALL') THEN
      v_check := COALESCE(p.with_check, p.qual, 'true');
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I WITH CHECK ((%s) AND public.is_active_admin_session())',
        p.policyname, p.schemaname, p.tablename, v_check
      );
    END IF;
  END LOOP;
END
$policies$;

-- These SECURITY DEFINER functions bypass table RLS. Session validity alone is
-- insufficient: only an active application admin may create/adopt QR identities.
CREATE OR REPLACE FUNCTION public.get_or_create_customer_qr(p_customer_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.assert_my_account_session_active();
  IF public.is_active_admin_session() IS NOT TRUE THEN
    RAISE EXCEPTION 'Active administrator account required'
      USING ERRCODE = '42501';
  END IF;
  RETURN public.get_or_create_customer_qr__session_guarded_impl(p_customer_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_or_create_customer_qr(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_or_create_customer_qr(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.adopt_customer_qr_token(
  p_customer_id uuid,
  p_public_token text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.assert_my_account_session_active();
  IF public.is_active_admin_session() IS NOT TRUE THEN
    RAISE EXCEPTION 'Active administrator account required'
      USING ERRCODE = '42501';
  END IF;
  RETURN public.adopt_customer_qr_token__session_guarded_impl(p_customer_id, p_public_token);
END;
$function$;

REVOKE ALL ON FUNCTION public.adopt_customer_qr_token(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adopt_customer_qr_token(uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
