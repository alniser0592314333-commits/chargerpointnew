-- Strict account-session registry enforcement.
-- Auth session validity is necessary but not sufficient: every application
-- request must also have a matching, unrevoked, unexpired account_sessions row.
-- The guard is read-only and never auto-registers legacy sessions.
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


-- Legacy registration endpoint delegates to the same strict policy; it cannot
-- silently register an old Auth session or bypass the client-type invariant.
CREATE OR REPLACE FUNCTION public.register_my_account_session(p_user_agent text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $
BEGIN
  RETURN public.register_my_account_session_v2(p_user_agent, 'browser');
END;
$;

-- Listing sessions is a read-only operation. It must not create registry rows
-- for every Auth session or extend the current session's expiry as a side effect.
CREATE OR REPLACE FUNCTION public.get_my_account_sessions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $
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
$;

NOTIFY pgrst, 'reload schema';
