-- Minimal Supabase Auth schema fixture for account session migration tests.
CREATE SCHEMA auth;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text,
  email_confirmed_at timestamptz
);
CREATE TABLE auth.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  not_after timestamptz,
  user_agent text,
  ip inet,
  refreshed_at timestamp
);
CREATE TABLE auth.refresh_tokens (
  id bigserial PRIMARY KEY,
  user_id varchar,
  session_id uuid,
  revoked boolean DEFAULT false,
  updated_at timestamptz DEFAULT now()
);
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $jwt$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$jwt$;

-- Existing production admin-session predicate whose ACL is tightened by
-- the migration. Keep it in the isolated fixture so grant assertions exercise
-- the same conditional migration path as production.
CREATE FUNCTION public.is_active_super_admin_session()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $super_admin$
  SELECT false
$super_admin$;

-- Existing caller-scoped identity helper; the strict migration must remove
-- service_role execution while preserving authenticated application access.
CREATE FUNCTION public.current_admin_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $current_admin$
  SELECT auth.uid()
$current_admin$;


-- Representative exposed business table and SECURITY DEFINER RPC used to prove
-- that the migration enforces session validity beyond the client UI.
CREATE TABLE public.session_guard_fixture (
  id integer PRIMARY KEY,
  secret text NOT NULL
);
INSERT INTO public.session_guard_fixture VALUES (1, 'fixture-secret');
ALTER TABLE public.session_guard_fixture ENABLE ROW LEVEL SECURITY;
CREATE POLICY session_guard_fixture_authenticated_read
  ON public.session_guard_fixture FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.session_guard_fixture TO authenticated;

CREATE FUNCTION public.fixture_sensitive_read()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT secret FROM public.session_guard_fixture WHERE id = 1
$$;
REVOKE ALL ON FUNCTION public.fixture_sensitive_read() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fixture_sensitive_read() TO authenticated;

-- Model a legacy public table whose old broad grants must be removed by the
-- account-session migration without requiring that table in minimal fixtures.
CREATE TABLE public.permissions (
  id uuid PRIMARY KEY,
  code text NOT NULL
);
GRANT ALL ON TABLE public.permissions TO anon, authenticated;

-- Minimal representative application RPCs: one guarded public entry point and
-- its internal canonical SECURITY DEFINER implementation.
CREATE FUNCTION public.execute_canonical_sync_command(
  p_command_id uuid,
  p_command_type text,
  p_payload jsonb,
  p_payload_hash text DEFAULT 'no_hash',
  p_device_id text DEFAULT 'default_device',
  p_actor_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $canonical$
  SELECT jsonb_build_object('success', true, 'actor', p_actor_id, 'command', p_command_type)
$canonical$;
REVOKE ALL ON FUNCTION public.execute_canonical_sync_command(uuid,text,jsonb,text,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.execute_canonical_sync_command(uuid,text,jsonb,text,text,uuid) TO authenticated, service_role;

CREATE FUNCTION public.execute_sync_command(
  p_command_id uuid,
  p_command_type text,
  p_aggregate_type text DEFAULT NULL,
  p_aggregate_id uuid DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_expected_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $sync$
BEGIN
  RETURN public.execute_canonical_sync_command(
    p_command_id, p_command_type, COALESCE(p_payload, '{}'::jsonb),
    'no_hash', 'default_device', auth.uid()
  );
END;
$sync$;
REVOKE ALL ON FUNCTION public.execute_sync_command(uuid,text,text,uuid,jsonb,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.execute_sync_command(uuid,text,text,uuid,jsonb,integer) TO authenticated;

CREATE TABLE public.session_guard_fixture_audit (marker text NOT NULL);
ALTER TABLE public.session_guard_fixture_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY session_guard_fixture_audit_read
  ON public.session_guard_fixture_audit FOR SELECT TO authenticated USING (true);
GRANT SELECT ON TABLE public.session_guard_fixture_audit TO authenticated;
CREATE FUNCTION public.fixture_sensitive_void(p_marker text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $void$
BEGIN
  INSERT INTO public.session_guard_fixture_audit(marker) VALUES (p_marker);
END;
$void$;
REVOKE ALL ON FUNCTION public.fixture_sensitive_void(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fixture_sensitive_void(text) TO authenticated;

CREATE FUNCTION public.fixture_sensitive_setof()
RETURNS SETOF jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $setof$
  SELECT jsonb_build_object('id', id, 'secret', secret)
  FROM public.session_guard_fixture
$setof$;
REVOKE ALL ON FUNCTION public.fixture_sensitive_setof() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fixture_sensitive_setof() TO authenticated;

-- Stub the destructive day-restore RPC so the session migration test can prove
-- that its public wrapper rejects stale/unregistered callers before delegation.
CREATE FUNCTION public.restore_selected_business_days(
  p_bin text, p_snapshot jsonb, p_business_dates date[]
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object('success', true);
$$;
REVOKE ALL ON FUNCTION public.restore_selected_business_days(text,jsonb,date[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_selected_business_days(text,jsonb,date[]) TO authenticated, service_role;
