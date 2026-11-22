-- Server-enforced sliding idle expiry for administrator sessions.
-- Native APK and installed PWA receive a 30-day idle window; ordinary browser
-- sessions receive 7 days. This is a session-lifetime policy, not a role grant.
-- Client mode is informational and never bypasses account, role, permission,
-- Auth-session, or explicit-revocation checks.

ALTER TABLE public.account_sessions
  ADD COLUMN IF NOT EXISTS client_type text NOT NULL DEFAULT 'browser',
  ADD COLUMN IF NOT EXISTS session_expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days');

ALTER TABLE public.account_sessions
  DROP CONSTRAINT IF EXISTS account_sessions_client_type_check;

ALTER TABLE public.account_sessions
  ADD CONSTRAINT account_sessions_client_type_check
  CHECK (client_type IN ('browser', 'installed_pwa', 'native'));

CREATE INDEX IF NOT EXISTS account_sessions_expiry_idx
  ON public.account_sessions (session_expires_at)
  WHERE revoked_at IS NULL;

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
  v_client_type text := CASE
    WHEN p_client_type IN ('native', 'installed_pwa') THEN p_client_type
    ELSE 'browser'
  END;
  v_idle_window interval := CASE
    WHEN p_client_type IN ('native', 'installed_pwa') THEN interval '30 days'
    ELSE interval '7 days'
  END;
BEGIN
  IF v_user_id IS NULL OR v_session_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated Supabase session required';
  END IF;

  SELECT * INTO v_auth_session
  FROM auth.sessions s
  WHERE s.id = v_session_id AND s.user_id = v_user_id
    AND (s.not_after IS NULL OR s.not_after > now());

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current authentication session is no longer active'
      USING ERRCODE = '28000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.account_sessions a
    WHERE a.session_id = v_session_id AND a.user_id = v_user_id
      AND a.revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Current authentication session has been revoked'
      USING ERRCODE = '28000';
  END IF;

  -- An idle-expired session cannot silently renew itself through app startup.
  -- Saved native quick sign-in has a separate, explicit reactivation RPC below.
  IF EXISTS (
    SELECT 1 FROM public.account_sessions a
    WHERE a.session_id = v_session_id AND a.user_id = v_user_id
      AND a.session_expires_at <= now()
  ) THEN
    RAISE EXCEPTION 'SESSION_IDLE_EXPIRED'
      USING ERRCODE = '28000';
  END IF;

  INSERT INTO public.account_sessions(
    session_id, user_id, user_agent, created_at, last_seen_at, client_type, session_expires_at
  )
  VALUES (
    v_session_id,
    v_user_id,
    COALESCE(v_auth_session.user_agent, NULLIF(left(p_user_agent, 1000), '')),
    COALESCE(v_auth_session.created_at, now()),
    now(),
    v_client_type,
    now() + v_idle_window
  )
  ON CONFLICT (session_id) DO UPDATE
  SET user_agent = COALESCE(public.account_sessions.user_agent, EXCLUDED.user_agent),
      last_seen_at = now(),
      client_type = EXCLUDED.client_type,
      session_expires_at = now() + v_idle_window
  WHERE public.account_sessions.user_id = EXCLUDED.user_id
    AND public.account_sessions.revoked_at IS NULL
    AND public.account_sessions.session_expires_at > now();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_IDLE_EXPIRED_OR_REVOKED'
      USING ERRCODE = '28000';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'session_id', v_session_id,
    'client_type', v_client_type,
    'session_expires_at', now() + v_idle_window
  );
END;
$$;

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
  v_client_type text := CASE
    WHEN p_client_type IN ('native', 'installed_pwa') THEN p_client_type
    ELSE 'browser'
  END;
  v_idle_window interval := CASE
    WHEN p_client_type IN ('native', 'installed_pwa') THEN interval '30 days'
    ELSE interval '7 days'
  END;
BEGIN
  IF v_user_id IS NULL OR v_session_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated Supabase session required';
  END IF;

  SELECT * INTO v_auth_session
  FROM auth.sessions s
  WHERE s.id = v_session_id AND s.user_id = v_user_id
    AND (s.not_after IS NULL OR s.not_after > now());

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Underlying Auth session is no longer active'
      USING ERRCODE = '28000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.account_sessions a
    WHERE a.session_id = v_session_id AND a.user_id = v_user_id
      AND a.revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Revoked sessions cannot be reactivated'
      USING ERRCODE = '28000';
  END IF;

  -- Browser sessions must authenticate with a fresh password after idle expiry.
  -- Native/PWA saved-login reactivation is a separate explicit credential flow.
  IF v_client_type = 'browser' AND EXISTS (
    SELECT 1 FROM public.account_sessions a
    WHERE a.session_id = v_session_id AND a.user_id = v_user_id
      AND a.session_expires_at <= now()
  ) THEN
    RAISE EXCEPTION 'SESSION_IDLE_EXPIRED'
      USING ERRCODE = '28000';
  END IF;

  INSERT INTO public.account_sessions(
    session_id, user_id, user_agent, created_at, last_seen_at, client_type, session_expires_at
  )
  VALUES (
    v_session_id,
    v_user_id,
    v_auth_session.user_agent,
    COALESCE(v_auth_session.created_at, now()),
    now(),
    v_client_type,
    now() + v_idle_window
  )
  ON CONFLICT (session_id) DO UPDATE
  SET last_seen_at = now(),
      client_type = EXCLUDED.client_type,
      session_expires_at = now() + v_idle_window
  WHERE public.account_sessions.user_id = EXCLUDED.user_id
    AND public.account_sessions.revoked_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_REACTIVATION_FAILED'
      USING ERRCODE = '28000';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'session_id', v_session_id,
    'client_type', v_client_type,
    'session_expires_at', now() + v_idle_window
  );
END;
$$;

-- Minimal identity gate for pre-session and pre-BIN authentication flows.
-- It returns no permissions or business data and is intentionally not wrapped by
-- the active-session guard so a saved credential can determine whether BIN is needed.
CREATE OR REPLACE FUNCTION public.get_my_admin_login_gate()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('authenticated', false, 'is_admin', false);
  END IF;

  -- Resolve the optional admin relation at execution time. Production always has
  -- this table; keeping the lookup dynamic lets the migration compile against
  -- minimal isolated Auth fixtures and still fails closed if the relation is absent.
  IF to_regclass('public.admins') IS NULL THEN
    RETURN jsonb_build_object('authenticated', true, 'is_admin', false);
  END IF;

  EXECUTE $admin_gate$
    SELECT jsonb_build_object(
      'authenticated', true,
      'is_admin', true,
      'is_active', COALESCE(a.is_active, false),
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
$$;

CREATE OR REPLACE FUNCTION public.is_my_account_session_active()
RETURNS boolean
LANGUAGE plpgsql
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
    SELECT 1 FROM auth.sessions s
    WHERE s.id = v_session_id
      AND s.user_id = v_user_id
      AND (s.not_after IS NULL OR s.not_after > now())
  ) THEN
    RETURN false;
  END IF;

  SELECT * INTO v_account_session
  FROM public.account_sessions a
  WHERE a.session_id = v_session_id AND a.user_id = v_user_id;

  -- Register a valid legacy session once with the conservative browser policy.
  -- This prevents unregistered sessions from bypassing the idle-expiry guard forever.
  IF NOT FOUND THEN
    INSERT INTO public.account_sessions(
      session_id, user_id, user_agent, created_at, last_seen_at, client_type, session_expires_at
    )
    SELECT s.id, s.user_id, s.user_agent, COALESCE(s.created_at, now()), now(),
      'browser', now() + interval '7 days'
    FROM auth.sessions s
    WHERE s.id = v_session_id AND s.user_id = v_user_id
    ON CONFLICT (session_id) DO NOTHING;

    SELECT * INTO v_account_session
    FROM public.account_sessions a
    WHERE a.session_id = v_session_id AND a.user_id = v_user_id;

    IF NOT FOUND THEN
      RETURN false;
    END IF;
  END IF;

  IF v_account_session.revoked_at IS NOT NULL
     OR v_account_session.session_expires_at <= now() THEN
    RETURN false;
  END IF;

  -- Throttle activity writes to one update per five minutes per active session.
  -- This keeps the expiry sliding without writing on every protected RPC.
  IF v_account_session.last_seen_at IS NULL OR v_account_session.last_seen_at < now() - interval '5 minutes' THEN
    UPDATE public.account_sessions
    SET last_seen_at = now(),
        session_expires_at = now() + CASE
          WHEN client_type IN ('native', 'installed_pwa') THEN interval '30 days'
          ELSE interval '7 days'
        END
    WHERE session_id = v_session_id
      AND user_id = v_user_id
      AND revoked_at IS NULL
      AND session_expires_at > now();
  END IF;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_account_sessions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_current_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  INSERT INTO public.account_sessions(session_id, user_id, user_agent, created_at, last_seen_at)
  SELECT s.id, s.user_id, s.user_agent, COALESCE(s.created_at, now()), COALESCE(s.updated_at, now())
  FROM auth.sessions s
  WHERE s.user_id = v_user_id
    AND (s.not_after IS NULL OR s.not_after > now())
  ON CONFLICT (session_id) DO UPDATE
  SET user_agent = COALESCE(public.account_sessions.user_agent, EXCLUDED.user_agent),
      last_seen_at = GREATEST(public.account_sessions.last_seen_at, EXCLUDED.last_seen_at)
  WHERE public.account_sessions.user_id = EXCLUDED.user_id
    AND public.account_sessions.revoked_at IS NULL;

  UPDATE public.account_sessions
  SET last_seen_at = now(),
      session_expires_at = now() + CASE
        WHEN client_type IN ('native', 'installed_pwa') THEN interval '30 days'
        ELSE interval '7 days'
      END
  WHERE session_id = v_current_session_id
    AND user_id = v_user_id
    AND revoked_at IS NULL
    AND session_expires_at > now();

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
$$;

REVOKE ALL ON FUNCTION public.get_my_admin_login_gate() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_admin_login_gate() TO authenticated;
REVOKE ALL ON FUNCTION public.register_my_account_session_v2(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_my_account_session_v2(text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.reactivate_my_account_session(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reactivate_my_account_session(text) TO authenticated;
REVOKE ALL ON FUNCTION public.is_my_account_session_active() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_my_account_session_active() TO authenticated;
REVOKE ALL ON FUNCTION public.get_my_account_sessions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_account_sessions() TO authenticated;

NOTIFY pgrst, 'reload schema';
