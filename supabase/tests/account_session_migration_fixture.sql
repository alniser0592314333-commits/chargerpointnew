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
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT secret FROM public.session_guard_fixture WHERE id = 1
$$;
REVOKE ALL ON FUNCTION public.fixture_sensitive_read() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fixture_sensitive_read() TO authenticated;
