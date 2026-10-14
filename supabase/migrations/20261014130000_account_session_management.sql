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

  -- Require the underlying Supabase Auth session to still exist and be unexpired.
  -- This also rejects stale access tokens whose Auth session was deleted/expired.
  IF NOT EXISTS (
    SELECT 1 FROM auth.sessions s
    WHERE s.id = v_session_id
      AND s.user_id = v_user_id
      AND (s.not_after IS NULL OR s.not_after > now())
  ) THEN
    RETURN false;
  END IF;

  -- Sessions not yet registered are allowed briefly so older clients can upgrade,
  -- but a registered session is never allowed after explicit revocation.
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



-- Central server-side gate used by the exposed table policies and guarded RPC
-- wrappers below. A valid but not-yet-registered Auth session is tolerated for
-- rollout compatibility; missing/expired Auth sessions and explicitly revoked
-- registry rows are rejected.
CREATE OR REPLACE FUNCTION public.assert_my_account_session_active()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $sessionguard$
BEGIN
  -- Trusted service-role workflows are not browser sessions and must retain
  -- their existing server-to-server behavior. Client roles are checked below.
  IF COALESCE(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) = 'service_role' THEN
    RETURN;
  END IF;

  IF public.is_my_account_session_active() IS NOT TRUE THEN
    RAISE EXCEPTION 'Authentication session is revoked, expired, or unavailable'
      USING ERRCODE = '28000';
  END IF;
END;
$sessionguard$;
REVOKE ALL ON FUNCTION public.assert_my_account_session_active() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_my_account_session_active() TO authenticated, service_role;

-- Legacy tables that had RLS disabled and broad PUBLIC/anon/authenticated
-- CRUD grants are not used by the current client code. Keep any trusted
-- server-side routines working, but remove direct Data API access so these
-- tables cannot bypass session revocation (or be modified anonymously).
DO $legacy_table_lockdown$
DECLARE
  v_table_name text;
BEGIN
  FOREACH v_table_name IN ARRAY ARRAY[
    'roles',
    'permissions',
    'role_permissions',
    'qr_payment_submissions',
    'v_email',
    'rpc_log'
  ]
  LOOP
    IF to_regclass(format('public.%I', v_table_name)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table_name);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', v_table_name);
      EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', v_table_name);
    END IF;
  END LOOP;
END;
$legacy_table_lockdown$;

-- Add the session gate to existing authenticated-only RLS policies without
-- changing their business predicates. Public/anon policies are deliberately
-- untouched (e.g. public QR resolution).
DO $policies$
DECLARE
  p record;
  v_using text;
  v_check text;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, cmd, roles, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND array_length(roles, 1) = 1
      AND roles[1] = 'authenticated'::name
      AND tablename <> 'account_sessions'
  LOOP
    IF p.cmd IN ('SELECT', 'UPDATE', 'DELETE', 'ALL') THEN
      v_using := COALESCE(p.qual, 'true');
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I USING ((%s) AND public.is_my_account_session_active())',
        p.policyname, p.schemaname, p.tablename, v_using
      );
    END IF;

    IF p.cmd IN ('INSERT', 'UPDATE', 'ALL') THEN
      -- For UPDATE/ALL with no explicit WITH CHECK, PostgreSQL normally
      -- inherits USING. Preserve that effective predicate before adding gate.
      v_check := COALESCE(p.with_check, p.qual, 'true');
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I WITH CHECK ((%s) AND public.is_my_account_session_active())',
        p.policyname, p.schemaname, p.tablename, v_check
      );
    END IF;
  END LOOP;
END;
$policies$;

-- SECURITY DEFINER bypasses table RLS, so protect callable authenticated RPCs
-- independently. Rename the existing implementation (preserving its body and
-- internal dependencies), then install a same-signature gate wrapper. Public
-- login/bootstrap/branding and public QR resolver RPCs are intentionally
-- excluded because they must work before an authenticated app session exists.
DO $rpc_guards$
DECLARE
  v_func record;
  v_impl_name text;
  v_identity_args text;
  v_full_args text;
  v_result_type text;
  v_call_args text;
  v_body text;
  v_create_sql text;
BEGIN
  FOR v_func IN
    SELECT proc.oid, proc.proname, proc.proargnames, proc.pronargs, proc.proretset,
           proc.prorettype, oidvectortypes(proc.proargtypes) AS identity_args,
           pg_get_function_arguments(proc.oid) AS full_args,
           pg_get_function_result(proc.oid) AS result_type
    FROM pg_proc proc
    JOIN pg_namespace n ON n.oid = proc.pronamespace
    WHERE n.nspname = 'public'
      AND proc.prokind = 'f'
      AND proc.prosecdef
      AND proc.prorettype <> 'trigger'::regtype
      AND has_function_privilege('authenticated', proc.oid, 'EXECUTE')
      AND proc.proname NOT IN (
        'is_my_account_session_active',
        'assert_my_account_session_active',
        'register_my_account_session',
        'get_my_account_sessions',
        'revoke_my_account_session',
        'revoke_other_account_sessions',
        'revoke_all_account_sessions',
        'execute_canonical_sync_command',
        'check_system_bootstrapped',
        'is_system_bootstrapped',
        'bootstrap_first_super_admin',
        'get_email_by_username',
        'get_global_app_identity',
        'public_resolve_customer_qr',
        'public_resolve_order_qr'
      )
      AND position('__session_guarded_impl' in proc.proname) = 0
  LOOP
    v_impl_name := left(v_func.proname || '__session_guarded_impl', 63);
    v_identity_args := v_func.identity_args;
    v_full_args := v_func.full_args;
    v_result_type := v_func.result_type;
    v_call_args := '';
    IF v_func.pronargs > 0 THEN
      SELECT string_agg(chr(36) || g.i::text, ', ' ORDER BY g.i)
      INTO v_call_args
      FROM generate_series(1, v_func.pronargs) AS g(i);
    END IF;

    EXECUTE format(
      'ALTER FUNCTION public.%I(%s) RENAME TO %I',
      v_func.proname, v_identity_args, v_impl_name
    );

    IF v_func.proretset THEN
      v_body := format(
        'BEGIN PERFORM public.assert_my_account_session_active(); RETURN QUERY SELECT * FROM public.%I(%s); RETURN; END;',
        v_impl_name, v_call_args
      );
    ELSIF v_result_type = 'void' THEN
      v_body := format(
        'BEGIN PERFORM public.assert_my_account_session_active(); PERFORM public.%I(%s); RETURN; END;',
        v_impl_name, v_call_args
      );
    ELSE
      v_body := format(
        'BEGIN PERFORM public.assert_my_account_session_active(); RETURN public.%I(%s); END;',
        v_impl_name, v_call_args
      );
    END IF;

    v_create_sql := format(
      'CREATE FUNCTION public.%I(%s) RETURNS %s LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS %L',
      v_func.proname, v_full_args, v_result_type, v_body
    );
    EXECUTE v_create_sql;

    EXECUTE format(
      'REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated, service_role',
      v_impl_name, v_identity_args
    );
    EXECUTE format(
      'REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon',
      v_func.proname, v_identity_args
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.%I(%s) TO authenticated, service_role',
      v_func.proname, v_identity_args
    );
  END LOOP;
END;
$rpc_guards$;

-- Direct calls to the canonical implementation are not needed by clients:
-- execute_sync_command is the public entry point and its SECURITY DEFINER owner
-- can invoke this function internally. This closes the dispatcher bypass.
DO $dispatch_privileges$
BEGIN
  -- The isolated migration fixture does not install the application's dispatcher.
  -- In the real app schema, keep direct client access closed; the guarded
  -- execute_sync_command wrapper invokes it as its SECURITY DEFINER owner.
  IF to_regprocedure('public.execute_canonical_sync_command(uuid,text,jsonb,text,text,uuid)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.execute_canonical_sync_command(uuid, text, jsonb, text, text, uuid) FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.execute_canonical_sync_command(uuid, text, jsonb, text, text, uuid) TO service_role';
  END IF;
END;
$dispatch_privileges$;

NOTIFY pgrst, 'reload schema';
