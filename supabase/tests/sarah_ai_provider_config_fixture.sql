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

CREATE OR REPLACE FUNCTION public._cp_assert_active_admin_permission(p_required_permission text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_profile jsonb;
  v_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authenticated admin session required' USING ERRCODE = '28000';
  END IF;
  v_profile := public.get_current_admin_profile();
  IF COALESCE(v_profile->>'authenticated','false') <> 'true'
     OR COALESCE(v_profile->>'is_admin','false') <> 'true'
     OR COALESCE(v_profile->>'is_active','false') <> 'true'
     OR (v_profile->>'auth_user_id')::uuid IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Active admin session required' USING ERRCODE = '28000';
  END IF;
  v_role := pg_catalog.upper(pg_catalog.replace(COALESCE(v_profile->>'role',''),' ','_'));
  IF v_role <> 'SUPER_ADMIN' AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements_text(
      COALESCE(v_profile->'permissions','[]'::jsonb)
    ) AS permission_item(permission)
    WHERE permission_item.permission = p_required_permission
  ) THEN
    RAISE EXCEPTION 'Required business permission missing' USING ERRCODE = '42501';
  END IF;
  RETURN auth.uid();
END;
$function$;
REVOKE ALL ON FUNCTION public._cp_assert_active_admin_permission(text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.customers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  phone text,
  balance numeric,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  status text NOT NULL DEFAULT 'ACTIVE'
);
INSERT INTO public.customers(id,name,phone,balance,is_active,deleted_at,status) VALUES
 ('aaaa0000-0000-4000-8000-000000000001','أحمد علي','0599000001',125,true,NULL,'ACTIVE'),
 ('aaaa0000-0000-4000-8000-000000000002','أحمد محمود','0599000002',240,true,NULL,'ACTIVE'),
 ('aaaa0000-0000-4000-8000-000000000003','أحمد سمير','0599000003',50,true,NULL,'ACTIVE'),
 ('aaaa0000-0000-4000-8000-000000000004','أحمد خالد','0599000004',0,true,NULL,'ACTIVE'),
 ('aaaa0000-0000-4000-8000-000000000005','أحمد حسن','0599000005',99,true,NULL,'ACTIVE'),
 ('aaaa0000-0000-4000-8000-000000000006','أحمد يوسف','0599000006',77,true,NULL,'ACTIVE'),
 ('bbbb0000-0000-4000-8000-000000000001','محمود سمير','0599000007',10,true,NULL,'ACTIVE'),
 ('cccc0000-0000-4000-8000-000000000001','أحمد غير نشط','0599000008',5,false,NULL,'ACTIVE'),
 ('dddd0000-0000-4000-8000-000000000001','أحمد محذوف','0599000009',5,true,now(),'DELETED');

INSERT INTO public.permissions(code,description)
VALUES ('customers:view','View active customer names and codes')
ON CONFLICT(code) DO NOTHING;
INSERT INTO public.role_permissions(role,permission)
VALUES ('SUPER_ADMIN','customers:view')
ON CONFLICT(role,permission) DO NOTHING;

INSERT INTO auth.users(id) VALUES
 ('10000000-0000-4000-8000-000000000001'),
 ('10000000-0000-4000-8000-000000000002'),
 ('10000000-0000-4000-8000-000000000003'),
 ('10000000-0000-4000-8000-000000000004'),
 ('10000000-0000-4000-8000-000000000006');

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
