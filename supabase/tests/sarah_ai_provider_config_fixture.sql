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
  disabled_at timestamptz,
  permissions text[] NOT NULL DEFAULT '{}'::text[]
);

CREATE TABLE public.admin_custom_permissions (
  admin_id uuid NOT NULL REFERENCES public.admins(id) ON DELETE CASCADE,
  permission text NOT NULL,
  is_grant boolean NOT NULL,
  PRIMARY KEY (admin_id, permission)
);

CREATE OR REPLACE FUNCTION public.get_effective_permissions(p_admin_id uuid)
RETURNS TABLE(permission text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH custom AS (
    SELECT DISTINCT pg_catalog.btrim(p.permission) AS permission
    FROM public.admin_custom_permissions p
    JOIN public.admins a ON a.id = p.admin_id
    WHERE p.admin_id = p_admin_id
      AND a.is_active IS TRUE
      AND p.is_grant IS TRUE
      AND pg_catalog.btrim(p.permission) <> ''
  ),
  custom_state AS (
    SELECT EXISTS (
      SELECT 1 FROM public.admin_custom_permissions p WHERE p.admin_id = p_admin_id
    ) AS has_custom_state
  )
  SELECT c.permission FROM custom c
  WHERE (SELECT has_custom_state FROM custom_state)
  UNION
  SELECT DISTINCT pg_catalog.unnest(COALESCE(a.permissions, '{}'::text[]))
  FROM public.admins a
  WHERE a.id = p_admin_id
    AND a.is_active IS TRUE
    AND NOT (SELECT has_custom_state FROM custom_state);
$function$;
REVOKE ALL ON FUNCTION public.get_effective_permissions(uuid) FROM PUBLIC, anon, authenticated, service_role;

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
      SELECT pg_catalog.jsonb_agg(ep.permission ORDER BY ep.permission)
      FROM public.get_effective_permissions(a.id) ep
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

CREATE OR REPLACE FUNCTION public.is_active_admin_session()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
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
      AND a.disabled_at IS NULL
  );
$function$;
REVOKE ALL ON FUNCTION public.is_active_admin_session() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.assert_my_account_session_active()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF public.is_active_admin_session() IS NOT TRUE THEN
    RAISE EXCEPTION 'Authentication session is revoked, expired, or unavailable'
      USING ERRCODE = '28000';
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.assert_my_account_session_active() FROM PUBLIC, anon, authenticated, service_role;


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
 ('dddd0000-0000-4000-8000-000000000001','أحمد محذوف','0599000009',5,true,now(),'DELETED'),
 ('eeee0000-0000-4000-8000-000000000001',E'اسم\\nاختبار','0599000010',5,true,NULL,'ACTIVE');

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
