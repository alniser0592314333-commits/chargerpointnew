-- Minimal Supabase Auth schema fixture for account session migration tests.
CREATE SCHEMA auth;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text
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
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;


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
