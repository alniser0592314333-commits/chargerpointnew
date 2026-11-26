-- Minimal isolated Supabase-like fixture for the Sarah AI provider migration.
-- This fixture is disposable CI-only PostgreSQL and never connects to production.

DO $roles$
BEGIN
  CREATE ROLE anon;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$roles$;

DO $roles$
BEGIN
  CREATE ROLE authenticated;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$roles$;

DO $roles$
BEGIN
  CREATE ROLE service_role BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$roles$;

CREATE SCHEMA auth;
CREATE SCHEMA vault;

CREATE TABLE public.permissions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  code varchar UNIQUE NOT NULL,
  description text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.role_permissions (
  role varchar NOT NULL,
  permission varchar NOT NULL,
  PRIMARY KEY (role, permission)
);

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'role', pg_catalog.current_setting('request.jwt.claim.role', true),
    'sub', pg_catalog.current_setting('request.jwt.claim.sub', true),
    'session_id', pg_catalog.current_setting('request.jwt.claim.session_id', true)
  );
$function$;

CREATE TABLE vault.secrets (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  secret text NOT NULL,
  name text NOT NULL,
  description text
);

CREATE VIEW vault.decrypted_secrets AS
SELECT id, secret AS decrypted_secret
FROM vault.secrets;

CREATE OR REPLACE FUNCTION vault.create_secret(
  new_secret text,
  new_name text,
  new_description text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO vault.secrets (secret, name, description)
  VALUES (new_secret, new_name, new_description)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION vault.update_secret(
  secret_id uuid,
  new_secret text,
  new_name text DEFAULT NULL,
  new_description text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  UPDATE vault.secrets
  SET secret = new_secret,
      name = COALESCE(new_name, name),
      description = COALESCE(new_description, description)
  WHERE id = secret_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Secret not found';
  END IF;
END;
$function$;

GRANT USAGE ON SCHEMA public, auth, vault TO service_role;
GRANT EXECUTE ON FUNCTION auth.jwt() TO service_role;
GRANT EXECUTE ON FUNCTION vault.create_secret(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION vault.update_secret(uuid, text, text, text) TO service_role;
GRANT SELECT ON vault.decrypted_secrets TO service_role;
GRANT DELETE ON vault.secrets TO service_role;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid;
$function$;

CREATE TABLE auth.users (id uuid PRIMARY KEY);

CREATE TABLE auth.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  not_after timestamptz,
  user_agent text
);

CREATE TABLE public.admins (
  id uuid PRIMARY KEY,
  auth_user_id uuid UNIQUE NOT NULL,
  role text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  disabled_at timestamptz
);

CREATE TABLE public.account_sessions (
  session_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  revoked_at timestamptz,
  session_expires_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION public.get_current_admin_profile()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'authenticated', true,
    'is_admin', true,
    'is_active', a.is_active,
    'admin_id', a.id,
    'auth_user_id', a.auth_user_id,
    'role', a.role,
    'permissions', COALESCE((
      SELECT pg_catalog.jsonb_agg(rp.permission)
      FROM public.role_permissions rp
      WHERE rp.role = a.role
    ), '[]'::jsonb)
  )
  FROM public.admins a
  JOIN public.account_sessions app_session
    ON app_session.user_id = a.auth_user_id
   AND app_session.session_id = NULLIF(auth.jwt()->>'session_id','')::uuid
   AND app_session.revoked_at IS NULL
   AND app_session.session_expires_at > now()
  JOIN auth.sessions auth_session
    ON auth_session.id = app_session.session_id
   AND auth_session.user_id = a.auth_user_id
   AND (auth_session.not_after IS NULL OR auth_session.not_after > now())
  WHERE a.auth_user_id = auth.uid()
    AND a.is_active IS TRUE
  LIMIT 1;
$function$;
GRANT EXECUTE ON FUNCTION public.get_current_admin_profile() TO authenticated;

INSERT INTO auth.users(id) VALUES
 ('10000000-0000-4000-8000-000000000001'),
 ('10000000-0000-4000-8000-000000000002'),
 ('10000000-0000-4000-8000-000000000003'),
 ('10000000-0000-4000-8000-000000000004');

INSERT INTO public.admins(id,auth_user_id,role,is_active,disabled_at) VALUES
 ('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','SUPER_ADMIN',true,NULL),
 ('00000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','MANAGER',true,NULL),
 ('00000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003','SUPER_ADMIN',false,NULL),
 ('00000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000004','SUPER_ADMIN',true,NULL),
 ('00000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000006','SUPER_ADMIN',true,now());

INSERT INTO auth.sessions(id,user_id,created_at,not_after,user_agent) VALUES
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',now(),NULL,'super admin'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002',now(),NULL,'manager'),
 ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003',now(),NULL,'inactive admin'),
 ('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000004',now(),NULL,'unregistered admin'),
 ('20000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000006',now(),NULL,'disabled admin');

INSERT INTO public.account_sessions(session_id,user_id,revoked_at,session_expires_at) VALUES
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',NULL,now()+interval '7 days'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002',NULL,now()+interval '7 days'),
 ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003',NULL,now()+interval '7 days'),
 ('20000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000006',NULL,now()+interval '7 days');
