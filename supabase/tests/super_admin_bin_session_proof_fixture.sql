-- Isolated fixture for the Super Admin BIN-to-Auth-session proof migration.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END;
$roles$;

CREATE SCHEMA auth;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text,
  email_confirmed_at timestamptz
);
CREATE TABLE auth.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  not_after timestamptz
);
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

CREATE TABLE public.admins (
  id uuid PRIMARY KEY,
  auth_user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id),
  role text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  disabled_at timestamptz
);
CREATE TABLE public.account_sessions (
  session_id uuid PRIMARY KEY REFERENCES auth.sessions(id),
  user_id uuid NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  client_type text NOT NULL DEFAULT 'browser',
  session_expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE FUNCTION public.is_my_account_session_active()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.account_sessions s
    JOIN public.admins a ON a.auth_user_id=s.user_id
    WHERE s.session_id=NULLIF(auth.jwt()->>'session_id','')::uuid
      AND s.user_id=auth.uid()
      AND s.revoked_at IS NULL
      AND s.session_expires_at > now()
      AND a.is_active IS TRUE AND a.disabled_at IS NULL
  )
$$;
CREATE FUNCTION public.assert_my_account_session_active()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT public.is_my_account_session_active() THEN
    RAISE EXCEPTION 'Inactive application session' USING ERRCODE='28000';
  END IF;
END
$$;
CREATE FUNCTION public.assert_my_admin_session_actor(p_allow_first_owner_bootstrap boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.admins a
    WHERE a.auth_user_id=auth.uid() AND a.is_active IS TRUE AND a.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Active administrator required' USING ERRCODE='42501';
  END IF;
END
$$;
CREATE FUNCTION public.assert_my_fresh_super_admin_login_session()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth.sessions s
    JOIN public.admins a ON a.auth_user_id=s.user_id
    WHERE s.id=NULLIF(auth.jwt()->>'session_id','')::uuid
      AND s.user_id=auth.uid()
      AND s.created_at >= now()-interval '5 minutes'
      AND (s.not_after IS NULL OR s.not_after > now())
      AND a.role IN ('SUPER_ADMIN','Super Admin')
      AND a.is_active IS TRUE AND a.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Fresh Super Admin Auth session required' USING ERRCODE='28000';
  END IF;
END
$$;

-- The migration clones these exact guarded registration functions and injects
-- the one-time BIN proof consumption only in their fresh-session branches.
CREATE FUNCTION public.register_my_account_session_v2(
  p_user_agent text DEFAULT NULL,
  p_client_type text DEFAULT 'browser'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_session_id uuid := NULLIF(auth.jwt()->>'session_id','')::uuid;
  v_auth_session auth.sessions%ROWTYPE;
  v_existing public.account_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_auth_session
  FROM auth.sessions s
  WHERE s.id=v_session_id AND s.user_id=v_user_id
    AND (s.not_after IS NULL OR s.not_after > now());
  IF NOT FOUND THEN RAISE EXCEPTION 'Auth session missing' USING ERRCODE='28000'; END IF;
  PERFORM public.assert_my_admin_session_actor(false);
  SELECT * INTO v_existing FROM public.account_sessions s
  WHERE s.session_id=v_session_id AND s.user_id=v_user_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.revoked_at IS NOT NULL OR v_existing.session_expires_at <= now() THEN
      RAISE EXCEPTION 'SESSION_IDLE_EXPIRED_OR_REVOKED' USING ERRCODE='28000';
    END IF;
  ELSE
    IF v_auth_session.created_at IS NULL
       OR v_auth_session.created_at < now() - interval '5 minutes' THEN
      RAISE EXCEPTION 'SESSION_REGISTRATION_REQUIRES_FRESH_AUTH' USING ERRCODE = '28000';
    END IF;
    INSERT INTO public.account_sessions(session_id,user_id,user_agent,client_type,session_expires_at)
    VALUES(v_session_id,v_user_id,p_user_agent,COALESCE(p_client_type,'browser'),now()+interval '7 days');
  END IF;
  RETURN jsonb_build_object('success',true,'session_id',v_session_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.register_my_account_session_v2(text,text) TO authenticated,service_role;

CREATE FUNCTION public.reactivate_my_account_session(p_client_type text DEFAULT 'native')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_session_id uuid := NULLIF(auth.jwt()->>'session_id','')::uuid;
  v_auth_session auth.sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_auth_session FROM auth.sessions s
  WHERE s.id=v_session_id AND s.user_id=v_user_id
    AND (s.not_after IS NULL OR s.not_after > now());
  IF NOT FOUND THEN RAISE EXCEPTION 'Auth session missing' USING ERRCODE='28000'; END IF;
  PERFORM public.assert_my_admin_session_actor(false);
  IF NOT EXISTS (SELECT 1 FROM public.account_sessions s WHERE s.session_id=v_session_id AND s.user_id=v_user_id) THEN
    IF v_auth_session.created_at IS NULL
       OR v_auth_session.created_at < now() - interval '5 minutes' THEN
      RAISE EXCEPTION 'SESSION_REACTIVATION_REQUIRES_FRESH_AUTH' USING ERRCODE = '28000';
    END IF;
    INSERT INTO public.account_sessions(session_id,user_id,client_type,session_expires_at)
    VALUES(v_session_id,v_user_id,COALESCE(p_client_type,'native'),now()+interval '7 days');
  END IF;
  RETURN jsonb_build_object('success',true,'session_id',v_session_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.reactivate_my_account_session(text) TO authenticated,service_role;

CREATE FUNCTION public.verify_admin_bin_with_attempt_tracking__session_guarded_impl(p_bin text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('success',p_bin='correct','status','ACTIVE','failed_attempts',0)
$$;
CREATE FUNCTION public.verify_admin_bin_with_attempt_tracking(p_bin text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  RETURN public.verify_admin_bin_with_attempt_tracking__session_guarded_impl(p_bin);
END
$$;
GRANT EXECUTE ON FUNCTION public.verify_admin_bin_with_attempt_tracking(text) TO authenticated,service_role;

CREATE FUNCTION public.verify_admin_bin__session_guarded_impl(p_bin text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT p_bin='correct' $$;
CREATE FUNCTION public.verify_admin_bin(p_bin text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT public.verify_admin_bin__session_guarded_impl(p_bin)
$$;
GRANT EXECUTE ON FUNCTION public.verify_admin_bin(text) TO authenticated,service_role;

-- Test-only SECURITY DEFINER probes let authenticated test calls verify that
-- private tables remain unreadable without weakening the production ACLs.
CREATE FUNCTION public.fixture_account_session_exists(p_session_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.account_sessions WHERE session_id=p_session_id)
$$;
CREATE FUNCTION public.fixture_bin_proof_state(p_session_id uuid,p_state text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_bin_session_proofs
    WHERE auth_session_id=p_session_id
      AND CASE p_state
        WHEN 'unconsumed' THEN consumed_at IS NULL
        WHEN 'consumed' THEN consumed_at IS NOT NULL
        ELSE true
      END
  )
$$;
GRANT EXECUTE ON FUNCTION public.fixture_account_session_exists(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fixture_bin_proof_state(uuid,text) TO authenticated;
