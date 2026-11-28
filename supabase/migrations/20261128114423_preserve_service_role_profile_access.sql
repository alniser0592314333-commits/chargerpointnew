-- Preserve the existing service-role behavior of the profile RPC while
-- keeping user sessions fail-closed and allowing only fresh-session registration.
CREATE OR REPLACE FUNCTION public.get_current_admin_profile()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_session_id uuid := NULLIF(auth.jwt() ->> 'session_id', '')::uuid;
  v_auth_session auth.sessions%ROWTYPE;
  v_client_type text := 'browser';
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) = 'service_role' THEN
    RETURN public.get_current_admin_profile__session_guarded_impl();
  END IF;

  IF v_user_id IS NULL OR v_session_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated Supabase session required'
      USING ERRCODE = '28000';
  END IF;

  IF public.is_my_account_session_active() IS NOT TRUE THEN
    SELECT *
      INTO v_auth_session
    FROM auth.sessions s
    WHERE s.id = v_session_id
      AND s.user_id = v_user_id
      AND (s.not_after IS NULL OR s.not_after > now());

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Underlying Auth session is no longer active'
        USING ERRCODE = '28000';
    END IF;

    IF COALESCE(v_auth_session.user_agent, '') ILIKE '%; wv%'
       OR COALESCE(v_auth_session.user_agent, '') ILIKE '%Capacitor%' THEN
      v_client_type := 'native';
    END IF;

    PERFORM public.register_my_account_session_v2(
      v_auth_session.user_agent,
      v_client_type
    );
  END IF;

  PERFORM public.assert_my_account_session_active();
  RETURN public.get_current_admin_profile__session_guarded_impl();
END;
$function$;

REVOKE ALL ON FUNCTION public.get_current_admin_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_current_admin_profile() TO authenticated, service_role;
