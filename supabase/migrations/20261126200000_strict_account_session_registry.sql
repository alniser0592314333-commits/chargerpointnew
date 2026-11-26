-- Strict account-session registry enforcement.
-- Auth session validity is necessary but not sufficient: every application
-- request must also have a matching, unrevoked, unexpired account_sessions row.
-- The guard is read-only and never auto-registers legacy sessions.
-- Preserve currently active administrator sessions during rollout without
-- granting unregistered customer/non-admin Auth sessions application access.
-- The live inventory showed four active administrator Auth sessions missing
-- registry rows; register them conservatively as browser sessions for seven days.
-- No browser or service-role client may inspect or mutate the registry table
-- directly. All access must pass through the caller-scoped RPCs below.
REVOKE ALL ON TABLE public.account_sessions FROM PUBLIC, anon, authenticated, service_role;

DO $backfill$
BEGIN
  IF to_regclass('public.admins') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO public.account_sessions(
        session_id, user_id, user_agent, created_at, last_seen_at,
        client_type, session_expires_at
      )
      SELECT s.id, s.user_id, s.user_agent, COALESCE(s.created_at, now()),
             now(), 'browser', now() + interval '7 days'
      FROM auth.sessions s
      JOIN public.admins a
        ON a.auth_user_id = s.user_id
       AND a.is_active IS TRUE
       AND a.disabled_at IS NULL
      LEFT JOIN public.account_sessions existing
        ON existing.session_id = s.id
       AND existing.user_id = s.user_id
      WHERE (s.not_after IS NULL OR s.not_after > now())
        AND existing.session_id IS NULL
      ON CONFLICT (session_id) DO NOTHING
    $sql$;
  END IF;
END;
$backfill$;

CREATE OR REPLACE FUNCTION public.is_my_account_session_active()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_account_session public.account_sessions%ROWTYPE;
  v_admin_disabled boolean := false;
BEGIN
  IF v_user_id IS NULL OR v_session_id IS NULL THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM auth.sessions s
    WHERE s.id = v_session_id
      AND s.user_id = v_user_id
      AND (s.not_after IS NULL OR s.not_after > now())
  ) THEN
    RETURN false;
  END IF;

  SELECT *
  INTO v_account_session
  FROM public.account_sessions a
  WHERE a.session_id = v_session_id
    AND a.user_id = v_user_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_account_session.revoked_at IS NOT NULL
     OR v_account_session.session_expires_at IS NULL
     OR v_account_session.session_expires_at <= now() THEN
    RETURN false;
  END IF;

  -- Admin disablement is an authorization revocation, even if the Auth token
  -- and account_sessions row have not yet expired or been revoked.
  IF to_regclass('public.admins') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (
      SELECT 1 FROM public.admins a
      WHERE a.auth_user_id = $1
        AND (a.is_active IS NOT TRUE OR a.disabled_at IS NOT NULL)
    )' INTO v_admin_disabled USING v_user_id;
    IF v_admin_disabled THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END;
$$;

-- Existing registered sessions keep their server-recorded client class.
-- A client cannot upgrade a browser session to native/PWA by changing an RPC
-- argument. Missing registry rows can only be created for a recently issued
-- Auth session; stale unregistered sessions must authenticate again.
CREATE OR REPLACE FUNCTION public.register_my_account_session_v2(
  p_user_agent text DEFAULT NULL,
  p_client_type text DEFAULT 'browser'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_auth_session auth.sessions%ROWTYPE;
  v_account_session public.account_sessions%ROWTYPE;
  v_admin_disabled boolean := false;
  v_requested_client_type text := CASE
    WHEN p_client_type IN ('native', 'installed_pwa') THEN p_client_type
    ELSE 'browser'
  END;
  v_idle_window interval;
BEGIN
  IF v_user_id IS NULL OR v_session_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated Supabase session required' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_auth_session
  FROM auth.sessions s
  WHERE s.id = v_session_id
    AND s.user_id = v_user_id
    AND (s.not_after IS NULL OR s.not_after > now());

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current authentication session is no longer active' USING ERRCODE = '28000';
  END IF;

  IF to_regclass('public.admins') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (
      SELECT 1 FROM public.admins a
      WHERE a.auth_user_id = $1
        AND (a.is_active IS NOT TRUE OR a.disabled_at IS NOT NULL)
    )' INTO v_admin_disabled USING v_user_id;
    IF v_admin_disabled THEN
      RAISE EXCEPTION 'Administrator account is disabled' USING ERRCODE = '28000';
    END IF;
  END IF;

  SELECT * INTO v_account_session
  FROM public.account_sessions a
  WHERE a.session_id = v_session_id
    AND a.user_id = v_user_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_account_session.revoked_at IS NOT NULL
       OR v_account_session.session_expires_at IS NULL
       OR v_account_session.session_expires_at <= now() THEN
      RAISE EXCEPTION 'SESSION_IDLE_EXPIRED_OR_REVOKED' USING ERRCODE = '28000';
    END IF;

    -- Never let the request parameter change an already registered session type.
    v_idle_window := CASE
      WHEN v_account_session.client_type IN ('native', 'installed_pwa') THEN interval '30 days'
      ELSE interval '7 days'
    END;

    UPDATE public.account_sessions
    SET user_agent = COALESCE(user_agent, v_auth_session.user_agent, NULLIF(left(p_user_agent, 1000), '')),
        last_seen_at = now(),
        session_expires_at = now() + v_idle_window
    WHERE session_id = v_session_id
      AND user_id = v_user_id
      AND revoked_at IS NULL
      AND session_expires_at > now()
    RETURNING * INTO v_account_session;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'SESSION_IDLE_EXPIRED_OR_REVOKED' USING ERRCODE = '28000';
    END IF;
  ELSE
    IF v_auth_session.created_at IS NULL
       OR v_auth_session.created_at < now() - interval '5 minutes' THEN
      RAISE EXCEPTION 'SESSION_REGISTRATION_REQUIRES_FRESH_AUTH' USING ERRCODE = '28000';
    END IF;

    v_idle_window := CASE
      WHEN v_requested_client_type IN ('native', 'installed_pwa') THEN interval '30 days'
      ELSE interval '7 days'
    END;

    INSERT INTO public.account_sessions(
      session_id, user_id, user_agent, created_at, last_seen_at,
      client_type, session_expires_at
    )
    VALUES (
      v_session_id, v_user_id,
      COALESCE(v_auth_session.user_agent, NULLIF(left(p_user_agent, 1000), '')),
      COALESCE(v_auth_session.created_at, now()), now(),
      v_requested_client_type, now() + v_idle_window
    )
    ON CONFLICT (session_id) DO NOTHING
    RETURNING * INTO v_account_session;

    IF NOT FOUND THEN
      -- A concurrent registration won the insert; re-read and preserve its type.
      SELECT * INTO v_account_session
      FROM public.account_sessions a
      WHERE a.session_id = v_session_id
        AND a.user_id = v_user_id
      FOR UPDATE;

      IF NOT FOUND
         OR v_account_session.revoked_at IS NOT NULL
         OR v_account_session.session_expires_at IS NULL
         OR v_account_session.session_expires_at <= now() THEN
        RAISE EXCEPTION 'SESSION_REGISTRATION_CONFLICT' USING ERRCODE = '28000';
      END IF;

      v_idle_window := CASE
        WHEN v_account_session.client_type IN ('native', 'installed_pwa') THEN interval '30 days'
        ELSE interval '7 days'
      END;

      UPDATE public.account_sessions
      SET last_seen_at = now(), session_expires_at = now() + v_idle_window
      WHERE session_id = v_session_id
        AND user_id = v_user_id
        AND revoked_at IS NULL
        AND session_expires_at > now()
      RETURNING * INTO v_account_session;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'SESSION_REGISTRATION_CONFLICT' USING ERRCODE = '28000';
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'session_id', v_session_id,
    'client_type', v_account_session.client_type,
    'session_expires_at', v_account_session.session_expires_at
  );
END;
$$;

-- Explicit reactivation is allowed only for a newly issued Auth session
-- (e.g. after the biometric/password login flow). An expired or revoked
-- application session cannot renew itself by claiming to be native/PWA.
-- Existing active sessions retain their registered type regardless of input.
CREATE OR REPLACE FUNCTION public.reactivate_my_account_session(p_client_type text DEFAULT 'native')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_auth_session auth.sessions%ROWTYPE;
  v_account_session public.account_sessions%ROWTYPE;
  v_admin_disabled boolean := false;
  v_requested_client_type text := CASE
    WHEN p_client_type IN ('native', 'installed_pwa') THEN p_client_type
    ELSE 'browser'
  END;
  v_idle_window interval;
BEGIN
  IF v_user_id IS NULL OR v_session_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated Supabase session required' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_auth_session
  FROM auth.sessions s
  WHERE s.id = v_session_id
    AND s.user_id = v_user_id
    AND (s.not_after IS NULL OR s.not_after > now());

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Underlying Auth session is no longer active' USING ERRCODE = '28000';
  END IF;

  IF to_regclass('public.admins') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (
      SELECT 1 FROM public.admins a
      WHERE a.auth_user_id = $1
        AND (a.is_active IS NOT TRUE OR a.disabled_at IS NOT NULL)
    )' INTO v_admin_disabled USING v_user_id;
    IF v_admin_disabled THEN
      RAISE EXCEPTION 'Administrator account is disabled' USING ERRCODE = '28000';
    END IF;
  END IF;

  SELECT * INTO v_account_session
  FROM public.account_sessions a
  WHERE a.session_id = v_session_id
    AND a.user_id = v_user_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_account_session.revoked_at IS NOT NULL
       OR v_account_session.session_expires_at IS NULL
       OR v_account_session.session_expires_at <= now() THEN
      RAISE EXCEPTION 'SESSION_IDLE_EXPIRED_REQUIRES_FRESH_AUTH' USING ERRCODE = '28000';
    END IF;

    v_idle_window := CASE
      WHEN v_account_session.client_type IN ('native', 'installed_pwa') THEN interval '30 days'
      ELSE interval '7 days'
    END;

    UPDATE public.account_sessions
    SET last_seen_at = now(), session_expires_at = now() + v_idle_window
    WHERE session_id = v_session_id
      AND user_id = v_user_id
      AND revoked_at IS NULL
      AND session_expires_at > now()
    RETURNING * INTO v_account_session;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'SESSION_REACTIVATION_FAILED' USING ERRCODE = '28000';
    END IF;
  ELSE
    IF v_auth_session.created_at IS NULL
       OR v_auth_session.created_at < now() - interval '5 minutes' THEN
      RAISE EXCEPTION 'SESSION_REACTIVATION_REQUIRES_FRESH_AUTH' USING ERRCODE = '28000';
    END IF;

    v_idle_window := CASE
      WHEN v_requested_client_type IN ('native', 'installed_pwa') THEN interval '30 days'
      ELSE interval '7 days'
    END;

    INSERT INTO public.account_sessions(
      session_id, user_id, user_agent, created_at, last_seen_at,
      client_type, session_expires_at
    )
    VALUES (
      v_session_id, v_user_id, v_auth_session.user_agent,
      COALESCE(v_auth_session.created_at, now()), now(),
      v_requested_client_type, now() + v_idle_window
    )
    ON CONFLICT (session_id) DO NOTHING
    RETURNING * INTO v_account_session;

    IF NOT FOUND THEN
      SELECT * INTO v_account_session
      FROM public.account_sessions a
      WHERE a.session_id = v_session_id
        AND a.user_id = v_user_id
      FOR UPDATE;

      IF NOT FOUND
         OR v_account_session.revoked_at IS NOT NULL
         OR v_account_session.session_expires_at IS NULL
         OR v_account_session.session_expires_at <= now() THEN
        RAISE EXCEPTION 'SESSION_REACTIVATION_FAILED' USING ERRCODE = '28000';
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'session_id', v_session_id,
    'client_type', v_account_session.client_type,
    'session_expires_at', v_account_session.session_expires_at
  );
END;
$$;


-- Every admin permission/RLS gate also honors the explicit disabled_at
-- timestamp, not just the legacy is_active boolean.
CREATE OR REPLACE FUNCTION public.is_active_admin_session()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_is_active boolean := false;
BEGIN
  IF auth.uid() IS NULL OR public.is_my_account_session_active() IS NOT TRUE
     OR to_regclass('public.admins') IS NULL THEN
    RETURN false;
  END IF;

  EXECUTE 'SELECT EXISTS (
    SELECT 1 FROM public.admins a
    WHERE a.auth_user_id = $1
      AND a.is_active IS TRUE
      AND a.disabled_at IS NULL
  )'
  INTO v_is_active
  USING auth.uid();

  RETURN COALESCE(v_is_active, false);
END;
$function$;
REVOKE ALL ON FUNCTION public.is_active_admin_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_admin_session() TO authenticated, service_role;

-- Legacy registration endpoint delegates to the same strict policy; it cannot
-- silently register an old Auth session or bypass the client-type invariant.
CREATE OR REPLACE FUNCTION public.register_my_account_session(p_user_agent text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN public.register_my_account_session_v2(p_user_agent, 'browser');
END;
$function$;

-- Listing sessions is a read-only operation. It must not create registry rows
-- for every Auth session or extend the current session's expiry as a side effect.
CREATE OR REPLACE FUNCTION public.get_my_account_sessions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_current_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL OR v_current_session_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF public.is_my_account_session_active() IS NOT TRUE THEN
    RAISE EXCEPTION 'Authentication session is revoked, expired, or unregistered'
      USING ERRCODE = '28000';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'session_id', a.session_id,
    'user_agent', COALESCE(a.user_agent, s.user_agent),
    'created_at', a.created_at,
    'last_seen_at', a.last_seen_at,
    'client_type', a.client_type,
    'session_expires_at', a.session_expires_at,
    'is_expired', a.session_expires_at <= now(),
    'is_current', a.session_id = v_current_session_id
  ) ORDER BY (a.session_id = v_current_session_id) DESC, a.last_seen_at DESC), '[]'::jsonb)
  INTO v_result
  FROM public.account_sessions a
  JOIN auth.sessions s
    ON s.id = a.session_id
   AND s.user_id = v_user_id
  WHERE a.user_id = v_user_id
    AND a.revoked_at IS NULL
    AND (s.not_after IS NULL OR s.not_after > now());

  RETURN v_result;
END;
$function$;


-- Internal assertion shared by sensitive RPC wrappers. It is intentionally
-- not executable directly by browser roles; SECURITY DEFINER entry points call it.
CREATE OR REPLACE FUNCTION public.assert_my_account_session_active()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin_disabled boolean := false;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) = 'service_role' THEN
    RETURN;
  END IF;

  IF public.is_my_account_session_active() IS NOT TRUE THEN
    RAISE EXCEPTION 'Authentication session is revoked, expired, or unavailable'
      USING ERRCODE = '28000';
  END IF;

  -- This guard is shared by legacy SECURITY DEFINER business RPCs. A valid
  -- Auth/session registry row must not keep a disabled admin authorized merely
  -- because an older RPC checks only admins.is_active.
  IF to_regclass('public.admins') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (
      SELECT 1 FROM public.admins a
      WHERE a.auth_user_id = $1
        AND (a.is_active IS NOT TRUE OR a.disabled_at IS NOT NULL)
    )' INTO v_admin_disabled USING auth.uid();
    IF v_admin_disabled THEN
      RAISE EXCEPTION 'Administrator account is disabled' USING ERRCODE = '28000';
    END IF;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.assert_my_account_session_active() FROM PUBLIC, anon, authenticated, service_role;

-- The pre-session login gate remains minimal, but it must report a disabled
-- administrator as inactive before the client reaches BIN/session reactivation.
CREATE OR REPLACE FUNCTION public.get_my_admin_login_gate()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('authenticated', false, 'is_admin', false);
  END IF;

  IF to_regclass('public.admins') IS NULL THEN
    RETURN jsonb_build_object('authenticated', true, 'is_admin', false);
  END IF;

  EXECUTE $admin_gate$
    SELECT jsonb_build_object(
      'authenticated', true,
      'is_admin', true,
      'is_active', COALESCE(a.is_active, false) AND a.disabled_at IS NULL,
      'admin_id', a.id,
      'auth_user_id', a.auth_user_id,
      'role', a.role,
      'email', a.email,
      'username', a.username,
      'full_name', a.full_name
    )
    FROM public.admins a
    WHERE a.auth_user_id = $1
    LIMIT 1
  $admin_gate$
  INTO v_result
  USING auth.uid();

  RETURN COALESCE(v_result, jsonb_build_object('authenticated', true, 'is_admin', false));
END;
$function$;
REVOKE ALL ON FUNCTION public.get_my_admin_login_gate() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_admin_login_gate() TO authenticated;
DO $revoke_user_admin_identity_rpc$
BEGIN
  IF to_regprocedure('public.get_current_admin_profile()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.get_current_admin_profile() FROM PUBLIC, anon, service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_current_admin_profile() TO authenticated';
  END IF;
  IF to_regprocedure('public.current_admin_id()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.current_admin_id() FROM PUBLIC, anon, service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.current_admin_id() TO authenticated';
  END IF;
END;
$revoke_user_admin_identity_rpc$;

-- Legacy one-argument registration is retained for older clients but delegates
-- to the same strict, freshness-checked browser registration path. It can never
-- create a registry row for an old Auth session or upgrade the client class.
CREATE OR REPLACE FUNCTION public.register_my_account_session(p_user_agent text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN public.register_my_account_session_v2(p_user_agent, 'browser');
END;
$function$;
REVOKE ALL ON FUNCTION public.register_my_account_session(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_my_account_session(text) TO authenticated;

-- Active-session checks stay STABLE and read-only for RLS. The app's bounded
-- heartbeat uses this separate VOLATILE RPC to slide idle expiry without
-- granting a way to create or revive a missing/expired/revoked session.
CREATE OR REPLACE FUNCTION public.touch_my_account_session()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
BEGIN
  IF public.is_my_account_session_active() IS NOT TRUE THEN
    RETURN false;
  END IF;

  -- A conditional UPDATE avoids taking a row lock on every 30-second client
  -- heartbeat; only one concurrent caller renews the session per five minutes.
  UPDATE public.account_sessions
  SET last_seen_at = now(),
      session_expires_at = now() + CASE
        WHEN client_type IN ('native', 'installed_pwa') THEN interval '30 days'
        ELSE interval '7 days'
      END
  WHERE session_id = v_session_id
    AND user_id = v_user_id
    AND revoked_at IS NULL
    AND session_expires_at > now()
    AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes');

  IF FOUND THEN
    RETURN true;
  END IF;

  -- If no renewal was needed, recheck in case expiry/revocation raced the
  -- initial read. This remains read-only and cannot register or revive a row.
  RETURN public.is_my_account_session_active();
END;
$function$;
REVOKE ALL ON FUNCTION public.touch_my_account_session() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.touch_my_account_session() TO authenticated;

-- Session listing is strictly caller-scoped and read-only with respect to
-- registry membership. It must never auto-register every Auth session.
CREATE OR REPLACE FUNCTION public.get_my_account_sessions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_current_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL OR v_current_session_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated current session required' USING ERRCODE = '28000';
  END IF;

  IF public.touch_my_account_session() IS NOT TRUE THEN
    RAISE EXCEPTION 'Current application session is not active' USING ERRCODE = '28000';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'session_id', a.session_id,
    'user_agent', COALESCE(a.user_agent, s.user_agent),
    'created_at', a.created_at,
    'last_seen_at', GREATEST(a.last_seen_at, COALESCE(s.updated_at, a.last_seen_at)),
    'client_type', a.client_type,
    'session_expires_at', a.session_expires_at,
    'is_expired', a.session_expires_at <= now(),
    'is_current', a.session_id = v_current_session_id
  ) ORDER BY (a.session_id = v_current_session_id) DESC, a.last_seen_at DESC), '[]'::jsonb)
  INTO v_result
  FROM public.account_sessions a
  JOIN auth.sessions s ON s.id = a.session_id AND s.user_id = v_user_id
  WHERE a.user_id = v_user_id
    AND a.revoked_at IS NULL
    AND (s.not_after IS NULL OR s.not_after > now());

  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_my_account_sessions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_account_sessions() TO authenticated;

-- User-scoped session RPCs must never be callable with the elevated
-- service_role credential. Their authority comes only from the caller's own
-- verified Auth subject and session claims.
REVOKE ALL ON FUNCTION public.get_my_admin_login_gate() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_admin_login_gate() TO authenticated;
REVOKE ALL ON FUNCTION public.is_my_account_session_active() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.is_my_account_session_active() TO authenticated;
REVOKE ALL ON FUNCTION public.is_active_admin_session() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.is_active_admin_session() TO authenticated;
REVOKE ALL ON FUNCTION public.register_my_account_session(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.register_my_account_session(text) TO authenticated;
REVOKE ALL ON FUNCTION public.register_my_account_session_v2(text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.register_my_account_session_v2(text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.reactivate_my_account_session(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.reactivate_my_account_session(text) TO authenticated;
REVOKE ALL ON FUNCTION public.get_my_account_sessions() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_account_sessions() TO authenticated;
REVOKE ALL ON FUNCTION public.revoke_my_account_session(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_my_account_session(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.revoke_other_account_sessions() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_other_account_sessions() TO authenticated;
REVOKE ALL ON FUNCTION public.revoke_all_account_sessions() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_all_account_sessions() TO authenticated;

-- Close the legacy business-day restore RPC as an alternate session path.
-- Keep its canonical implementation private and expose only a guarded wrapper.
DO $clone_restore$
DECLARE
  v_definition text;
BEGIN
  v_definition := pg_get_functiondef(
    'public.restore_selected_business_days(text,jsonb,date[])'::regprocedure
  );
  IF pg_catalog.strpos(v_definition, 'restore_selected_business_days__session_guarded_impl') = 0 THEN
    v_definition := replace(
      v_definition,
      'FUNCTION public.restore_selected_business_days(',
      'FUNCTION public.restore_selected_business_days__session_guarded_impl('
    );
    IF v_definition = '' OR v_definition NOT LIKE '%restore_selected_business_days__session_guarded_impl%' THEN
      RAISE EXCEPTION 'Could not create private day-restore implementation';
    END IF;
    EXECUTE v_definition;
  END IF;
END;
$clone_restore$;
REVOKE ALL ON FUNCTION public.restore_selected_business_days__session_guarded_impl(text, jsonb, date[])
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.restore_selected_business_days(
  p_bin text,
  p_snapshot jsonb,
  p_business_dates date[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.assert_my_account_session_active();
  RETURN public.restore_selected_business_days__session_guarded_impl(
    p_bin, p_snapshot, p_business_dates
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.restore_selected_business_days(text, jsonb, date[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_selected_business_days(text, jsonb, date[])
  TO authenticated, service_role;

-- Purchase-book identity resolution must not return an admin identity for a
-- stale or unregistered application session.
CREATE OR REPLACE FUNCTION public.current_purchase_admin_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin_id uuid;
BEGIN
  IF public.is_my_account_session_active() IS NOT TRUE
     OR to_regclass('public.admins') IS NULL THEN
    RETURN NULL;
  END IF;
  EXECUTE 'SELECT a.id FROM public.admins a WHERE a.auth_user_id = $1 AND a.is_active IS TRUE AND a.disabled_at IS NULL LIMIT 1'
    INTO v_admin_id
    USING auth.uid();
  RETURN v_admin_id;
END;
$function$;

-- First-owner bootstrap is the one intentional pre-admin path. It still
-- requires a freshly authenticated Supabase session, but registers that new
-- session before the legacy bootstrap implementation checks the strict guard.
DO $guard_first_owner_bootstrap$
DECLARE
  v_definition text;
BEGIN
  IF to_regprocedure('public.bootstrap_first_super_admin(text,text,text)') IS NULL THEN
    RETURN;
  END IF;

  v_definition := pg_get_functiondef(
    'public.bootstrap_first_super_admin(text,text,text)'::regprocedure
  );
  IF pg_catalog.strpos(v_definition, 'bootstrap_first_super_admin__session_guarded_impl') = 0 THEN
    v_definition := replace(
      v_definition,
      'FUNCTION public.bootstrap_first_super_admin(',
      'FUNCTION public.bootstrap_first_super_admin__session_guarded_impl('
    );
    IF v_definition NOT LIKE '%bootstrap_first_super_admin__session_guarded_impl%' THEN
      RAISE EXCEPTION 'Could not preserve first-owner bootstrap implementation';
    END IF;
    EXECUTE v_definition;
  END IF;

  EXECUTE 'REVOKE ALL ON FUNCTION public.bootstrap_first_super_admin__session_guarded_impl(text,text,text) FROM PUBLIC, anon, authenticated, service_role';

  EXECUTE $wrapper$
    CREATE OR REPLACE FUNCTION public.bootstrap_first_super_admin(
      p_username text,
      p_full_name text DEFAULT NULL,
      p_bin text DEFAULT NULL
    )
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $function$
    DECLARE
      v_email text;
      v_email_confirmed_at timestamptz;
      v_owner_email constant text := 'al.niser.0592314333@gmail.com';
    BEGIN
      IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
      END IF;

      SELECT u.email, u.email_confirmed_at
        INTO v_email, v_email_confirmed_at
      FROM auth.users u
      WHERE u.id = auth.uid();

      IF v_email IS NULL OR v_email_confirmed_at IS NULL
         OR lower(btrim(v_email)) <> lower(btrim(v_owner_email)) THEN
        RAISE EXCEPTION 'This identity is not eligible for first-owner bootstrap'
          USING ERRCODE = '42501';
      END IF;

      IF EXISTS (
        SELECT 1 FROM public.admins a
        WHERE a.role IN ('SUPER_ADMIN', 'Super Admin')
      ) THEN
        RETURN jsonb_build_object('success', false, 'code', 'ALREADY_BOOTSTRAPPED');
      END IF;

      IF EXISTS (
        SELECT 1 FROM public.admins a WHERE a.auth_user_id = auth.uid()
      ) THEN
        RAISE EXCEPTION 'This authenticated identity is already registered as an admin'
          USING ERRCODE = '42501';
      END IF;

      PERFORM public.register_my_account_session_v2(NULL, 'browser');
      RETURN public.bootstrap_first_super_admin__session_guarded_impl(
        p_username, p_full_name, p_bin
      );
    END;
    $function$;
  $wrapper$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.bootstrap_first_super_admin(text,text,text) FROM PUBLIC, anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.bootstrap_first_super_admin(text,text,text) TO authenticated';
END;
$guard_first_owner_bootstrap$;

-- The Jawwal Pay recipient is read by both admins and customer accounts.
-- Require the corresponding server-side session registry; Auth UID alone is
-- not sufficient to disclose account-facing payment configuration.
CREATE OR REPLACE FUNCTION public.get_jawwal_pay_recipient()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_phone text;
  v_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_allowed boolean := false;
BEGIN
  IF auth.uid() IS NULL OR v_session_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF to_regprocedure('public.is_active_admin_session()') IS NOT NULL THEN
    EXECUTE 'SELECT public.is_active_admin_session()' INTO v_allowed;
  END IF;

  IF NOT v_allowed AND to_regclass('public.customer_account_links') IS NOT NULL
     AND to_regclass('public.customers') IS NOT NULL
     AND to_regclass('auth.sessions') IS NOT NULL THEN
    -- This RPC returns only the global recipient number, not customer data.
    -- Require a live Supabase Auth session and an active customer link, but do
    -- not make older customers depend on the newer app-level session registry.
    EXECUTE $customer_session$
      SELECT EXISTS (
        SELECT 1
        FROM public.customer_account_links l
        JOIN public.customers c ON c.id = l.customer_id
        JOIN auth.sessions s
          ON s.id = $2
         AND s.user_id = $1
        WHERE l.auth_user_id = $1
          AND l.account_status = 'ACTIVE'
          AND c.is_active IS TRUE
          AND c.deleted_at IS NULL
          AND c.status <> 'DELETED'
          AND (s.not_after IS NULL OR s.not_after > now())
      )
    $customer_session$
    INTO v_allowed
    USING auth.uid(), v_session_id;
  END IF;

  IF v_allowed IS NOT TRUE THEN
    RAISE EXCEPTION 'Active admin or customer account session required'
      USING ERRCODE = '28000';
  END IF;

  SELECT recipient_phone INTO v_phone
  FROM public.jawwal_pay_settings
  WHERE singleton = true;

  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'Jawwal Pay recipient is not configured' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('recipient_phone', v_phone);
END;
$function$;

NOTIFY pgrst, 'reload schema';
