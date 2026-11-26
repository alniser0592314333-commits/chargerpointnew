-- Fix: client_type supplied by the caller must not extend an idle-expired session.
-- Reactivation is only allowed for a newly authenticated Auth session with no expired
-- registration; an existing expired session requires fresh Auth sign-in (new session ID).
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
  v_client_type text := CASE WHEN p_client_type IN ('native', 'installed_pwa') THEN p_client_type ELSE 'browser' END;
  v_idle_window interval := CASE WHEN p_client_type IN ('native', 'installed_pwa') THEN interval '30 days' ELSE interval '7 days' END;
BEGIN
  IF v_user_id IS NULL OR v_session_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated Supabase session required' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_auth_session FROM auth.sessions s
  WHERE s.id = v_session_id AND s.user_id = v_user_id
    AND (s.not_after IS NULL OR s.not_after > now());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Underlying Auth session is no longer active' USING ERRCODE = '28000';
  END IF;

  IF EXISTS (SELECT 1 FROM public.account_sessions a
    WHERE a.session_id = v_session_id AND a.user_id = v_user_id AND a.revoked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Revoked sessions cannot be reactivated' USING ERRCODE = '28000';
  END IF;

  -- A client cannot claim native/PWA to bypass idle expiration. Fresh Auth
  -- sign-in creates a new session ID; the old expired session remains rejected.
  IF EXISTS (SELECT 1 FROM public.account_sessions a
    WHERE a.session_id = v_session_id AND a.user_id = v_user_id
      AND a.session_expires_at <= now()) THEN
    RAISE EXCEPTION 'SESSION_IDLE_EXPIRED_REQUIRES_FRESH_AUTH' USING ERRCODE = '28000';
  END IF;

  INSERT INTO public.account_sessions(session_id,user_id,user_agent,created_at,last_seen_at,client_type,session_expires_at)
  VALUES (v_session_id,v_user_id,v_auth_session.user_agent,COALESCE(v_auth_session.created_at,now()),now(),v_client_type,now()+v_idle_window)
  ON CONFLICT (session_id) DO UPDATE
  SET last_seen_at=now(), client_type=EXCLUDED.client_type, session_expires_at=now()+v_idle_window
  WHERE public.account_sessions.user_id=EXCLUDED.user_id AND public.account_sessions.revoked_at IS NULL
    AND public.account_sessions.session_expires_at > now();

  IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_REACTIVATION_FAILED' USING ERRCODE = '28000'; END IF;
  RETURN jsonb_build_object('success',true,'session_id',v_session_id,'client_type',v_client_type,'session_expires_at',now()+v_idle_window);
END;
$$;
