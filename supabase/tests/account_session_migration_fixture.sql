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
