-- Backward-compatible, fail-closed registration for clients that request
-- the protected profile immediately after a successful Auth sign-in.
--
-- Older APK builds call get_current_admin_profile before registering the
-- account_sessions row. Newer builds register/reactivate explicitly. This
-- wrapper supports both orders without weakening the session boundary:
--   * only a fresh Auth session (<= 5 minutes) can be auto-registered;
--   * the active-admin identity check remains inside the registration helper;
--   * Super Admin registration still consumes the session-bound BIN proof;
--   * existing revoked/expired registry rows are never revived;
--   * concurrent sessions remain independent (no other session is revoked).

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

    -- Legacy Capacitor Android/iOS WebViews identify themselves in the
    -- Auth session user-agent. Keep their intended 30-day idle window.
    IF COALESCE(v_auth_session.user_agent, '') ILIKE '%; wv%'
       OR COALESCE(v_auth_session.user_agent, '') ILIKE '%Capacitor%' THEN
      v_client_type := 'native';
    END IF;

    -- The helper refuses sessions older than five minutes and consumes a
    -- one-time BIN proof for Super Admins before inserting the registry row.
    -- If a row already exists but is revoked/expired, it fails closed.
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
