-- Make the active-account-session guard safe for read-only RPCs.
-- Guards called from SELECT-only RPCs must not mutate account_sessions.
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
  v_read_only boolean := current_setting('transaction_read_only', true) = 'on';
BEGIN
  IF v_user_id IS NULL OR v_session_id IS NULL THEN RETURN false; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM auth.sessions s
    WHERE s.id = v_session_id AND s.user_id = v_user_id
      AND (s.not_after IS NULL OR s.not_after > now())
  ) THEN RETURN false; END IF;

  SELECT * INTO v_account_session
  FROM public.account_sessions a
  WHERE a.session_id = v_session_id AND a.user_id = v_user_id;

  IF NOT FOUND THEN
    -- Legacy sessions remain tolerated during rollout; read-only guards cannot
    -- create registry rows. Writable calls can register them conservatively.
    IF v_read_only THEN RETURN true; END IF;

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
    IF NOT FOUND THEN RETURN false; END IF;
  END IF;

  IF v_account_session.revoked_at IS NOT NULL
     OR v_account_session.session_expires_at <= now() THEN RETURN false; END IF;

  -- No activity/expiry extension writes inside read-only authorization.
  IF NOT v_read_only
     AND (v_account_session.last_seen_at IS NULL
       OR v_account_session.last_seen_at < now() - interval '5 minutes') THEN
    UPDATE public.account_sessions
    SET last_seen_at = now(),
        session_expires_at = now() + CASE
          WHEN client_type IN ('native', 'installed_pwa') THEN interval '30 days'
          ELSE interval '7 days'
        END
    WHERE session_id = v_session_id AND user_id = v_user_id
      AND revoked_at IS NULL AND session_expires_at > now();
  END IF;

  RETURN true;
END;
$$;
NOTIFY pgrst, 'reload schema';
