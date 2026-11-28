\set ON_ERROR_STOP on
CREATE SCHEMA auth;
CREATE TABLE auth.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  not_after timestamptz,
  user_agent text
);
CREATE TABLE auth.refresh_tokens (
  user_id text NOT NULL,
  session_id uuid NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
CREATE TABLE public.admins (
  id uuid PRIMARY KEY,
  auth_user_id uuid NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  disabled_at timestamptz
);
CREATE TABLE public.account_sessions (
  session_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_session_id uuid,
  client_type text NOT NULL DEFAULT 'browser',
  session_expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days')
);
CREATE OR REPLACE FUNCTION public.is_my_account_session_active()
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
INSERT INTO public.admins(id,auth_user_id,is_active)
VALUES
 ('90000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',true),
 ('90000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002',true);
INSERT INTO auth.sessions(id,user_id,created_at,user_agent)
VALUES
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',now()-interval '1 day','Old Android session'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002',now()-interval '1 day','Other admin session');
INSERT INTO auth.refresh_tokens(user_id,session_id,revoked)
VALUES
 ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',false),
 ('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002',false);
INSERT INTO public.account_sessions(session_id,user_id,user_agent)
VALUES
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Old Android session'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Other admin session');
