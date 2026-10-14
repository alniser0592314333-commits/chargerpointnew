-- Account session inventory and revocation controls.
-- The browser never receives access to auth.sessions or auth.refresh_tokens directly.
-- All operations are exposed through caller-scoped SECURITY DEFINER RPCs.

CREATE TABLE IF NOT EXISTS public.account_sessions (
  session_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_session_id uuid
);

CREATE INDEX IF NOT EXISTS account_sessions_user_created_idx
  ON public.account_sessions (user_id, created_at DESC);

ALTER TABLE public.account_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_sessions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.register_my_account_session(p_user_agent text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_auth_session auth.sessions%ROWTYPE;
BEGIN
  IF v_user_id IS NULL OR v_session_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated Supabase session required';
  END IF;

  SELECT * INTO v_auth_session
  FROM auth.sessions s
  WHERE s.id = v_session_id AND s.user_id = v_user_id
    AND (s.not_after IS NULL OR s.not_after > now());

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current authentication session is no longer active';
  END IF;

  INSERT INTO public.account_sessions(session_id, user_id, user_agent, created_at, last_seen_at)
  VALUES (
    v_session_id,
    v_user_id,
    COALESCE(v_auth_session.user_agent, NULLIF(left(p_user_agent, 1000), '')),
    COALESCE(v_auth_session.created_at, now()),
    now()
  )
  ON CONFLICT (session_id) DO UPDATE
  SET user_agent = COALESCE(public.account_sessions.user_agent, EXCLUDED.user_agent),
      last_seen_at = now()
  WHERE public.account_sessions.user_id = EXCLUDED.user_id
    AND public.account_sessions.revoked_at IS NULL;

  IF EXISTS (
    SELECT 1 FROM public.account_sessions s
    WHERE s.session_id = v_session_id AND s.user_id = v_user_id AND s.revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Current authentication session has been revoked';
  END IF;

  RETURN jsonb_build_object('success', true, 'session_id', v_session_id);
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

  -- Backfill sessions that existed before this feature, but never resurrect revoked rows.
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
  SET last_seen_at = now()
  WHERE session_id = v_current_session_id
    AND user_id = v_user_id
    AND revoked_at IS NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'session_id', a.session_id,
    'user_agent', COALESCE(a.user_agent, s.user_agent),
    'created_at', a.created_at,
    'last_seen_at', GREATEST(a.last_seen_at, COALESCE(s.updated_at, a.last_seen_at)),
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

CREATE OR REPLACE FUNCTION public.is_my_account_session_active()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
BEGIN
  IF v_user_id IS NULL OR v_session_id IS NULL THEN
    RETURN false;
  END IF;

  -- Sessions not yet registered are allowed briefly so older clients can upgrade.
  RETURN NOT EXISTS (
    SELECT 1 FROM public.account_sessions a
    WHERE a.session_id = v_session_id
      AND a.user_id = v_user_id
      AND a.revoked_at IS NOT NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_my_account_session(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_current_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
BEGIN
  IF v_user_id IS NULL OR p_session_id IS NULL THEN
    RAISE EXCEPTION 'Authentication and target session are required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM auth.sessions s
    WHERE s.id = p_session_id AND s.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Session not found for this account';
  END IF;

  INSERT INTO public.account_sessions(session_id, user_id, user_agent, created_at, last_seen_at, revoked_at, revoked_by_session_id)
  SELECT s.id, s.user_id, s.user_agent, COALESCE(s.created_at, now()), now(), now(), v_current_session_id
  FROM auth.sessions s
  WHERE s.id = p_session_id AND s.user_id = v_user_id
  ON CONFLICT (session_id) DO UPDATE
  SET revoked_at = COALESCE(public.account_sessions.revoked_at, now()),
      revoked_by_session_id = COALESCE(public.account_sessions.revoked_by_session_id, EXCLUDED.revoked_by_session_id)
  WHERE public.account_sessions.user_id = EXCLUDED.user_id;

  UPDATE auth.refresh_tokens SET revoked = true, updated_at = now()
  WHERE session_id = p_session_id AND user_id = v_user_id::text;
  UPDATE auth.sessions SET not_after = LEAST(COALESCE(not_after, now()), now()), updated_at = now()
  WHERE id = p_session_id AND user_id = v_user_id;

  RETURN jsonb_build_object('success', true, 'revoked_session_id', p_session_id, 'revoked_current', p_session_id = v_current_session_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_other_account_sessions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_current_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_count integer := 0;
BEGIN
  IF v_user_id IS NULL OR v_current_session_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated current session required';
  END IF;

  WITH targets AS (
    SELECT s.id, s.user_id, s.user_agent, s.created_at
    FROM auth.sessions s
    WHERE s.user_id = v_user_id AND s.id <> v_current_session_id
      AND (s.not_after IS NULL OR s.not_after > now())
  ), recorded AS (
    INSERT INTO public.account_sessions(session_id, user_id, user_agent, created_at, last_seen_at, revoked_at, revoked_by_session_id)
    SELECT id, user_id, user_agent, COALESCE(created_at, now()), now(), now(), v_current_session_id FROM targets
    ON CONFLICT (session_id) DO UPDATE
    SET revoked_at = COALESCE(public.account_sessions.revoked_at, now()),
        revoked_by_session_id = COALESCE(public.account_sessions.revoked_by_session_id, EXCLUDED.revoked_by_session_id)
    WHERE public.account_sessions.user_id = EXCLUDED.user_id
    RETURNING session_id
  )
  SELECT count(*) INTO v_count FROM recorded;

  UPDATE auth.refresh_tokens SET revoked = true, updated_at = now()
  WHERE session_id IN (SELECT s.id FROM auth.sessions s WHERE s.user_id = v_user_id AND s.id <> v_current_session_id)
    AND user_id = v_user_id::text;
  UPDATE auth.sessions SET not_after = LEAST(COALESCE(not_after, now()), now()), updated_at = now()
  WHERE user_id = v_user_id AND id <> v_current_session_id
    AND (not_after IS NULL OR not_after > now());

  RETURN jsonb_build_object('success', true, 'revoked_count', v_count, 'kept_current', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_all_account_sessions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_current_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_count integer := 0;
BEGIN
  IF v_user_id IS NULL OR v_current_session_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated current session required';
  END IF;

  WITH targets AS (
    SELECT s.id, s.user_id, s.user_agent, s.created_at
    FROM auth.sessions s WHERE s.user_id = v_user_id
      AND (s.not_after IS NULL OR s.not_after > now())
  ), recorded AS (
    INSERT INTO public.account_sessions(session_id, user_id, user_agent, created_at, last_seen_at, revoked_at, revoked_by_session_id)
    SELECT id, user_id, user_agent, COALESCE(created_at, now()), now(), now(), v_current_session_id FROM targets
    ON CONFLICT (session_id) DO UPDATE
    SET revoked_at = COALESCE(public.account_sessions.revoked_at, now()),
        revoked_by_session_id = COALESCE(public.account_sessions.revoked_by_session_id, EXCLUDED.revoked_by_session_id)
    WHERE public.account_sessions.user_id = EXCLUDED.user_id
    RETURNING session_id
  )
  SELECT count(*) INTO v_count FROM recorded;

  UPDATE auth.refresh_tokens SET revoked = true, updated_at = now()
  WHERE user_id = v_user_id::text;
  UPDATE auth.sessions SET not_after = LEAST(COALESCE(not_after, now()), now()), updated_at = now()
  WHERE user_id = v_user_id;

  RETURN jsonb_build_object('success', true, 'revoked_count', v_count, 'revoked_current', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.register_my_account_session(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_my_account_sessions() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_my_account_session_active() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.revoke_my_account_session(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.revoke_other_account_sessions() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.revoke_all_account_sessions() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.register_my_account_session(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_account_sessions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_my_account_session_active() TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_my_account_session(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_other_account_sessions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_all_account_sessions() TO authenticated;

NOTIFY pgrst, 'reload schema';
