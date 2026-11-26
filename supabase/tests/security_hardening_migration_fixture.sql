-- Additional fixture for the security-hardening migration. Run after
-- 20261014130000_account_session_management.sql in the isolated test database.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
-- Supabase can create objects as either postgres or supabase_admin.
CREATE ROLE supabase_admin NOLOGIN;

-- Reproduce the production default-ACL drift for both object creators.
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS graphql_public;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA graphql_public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA storage
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid UNIQUE NOT NULL,
  username varchar(64) UNIQUE,
  full_name varchar(200),
  email varchar(255) UNIQUE,
  role text NOT NULL DEFAULT 'OPERATOR',
  permissions text[] NOT NULL DEFAULT '{}'::text[],
  bin_hash varchar(255),
  is_active boolean NOT NULL DEFAULT true,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

-- The account-session runtime fixture may have already created a minimal
-- admins table in this shared isolated database. Extend it to the production
-- fixture shape instead of assuming a pristine database.
ALTER TABLE public.admins
  ADD COLUMN IF NOT EXISTS permissions text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS bin_hash varchar(255),
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX IF NOT EXISTS admins_fixture_username_uidx
  ON public.admins(username) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS admins_fixture_email_uidx
  ON public.admins(email) WHERE email IS NOT NULL;

-- The preceding account-session fixture seeds a temporary Super Admin for
-- login-gate assertions. Remove only that known fixture row before testing
-- first-owner bootstrap against an unbootstrapped installation.
DELETE FROM public.admins
WHERE id = '99999999-9999-4999-8999-999999999999';

-- Minimal production-shaped profile RPC so the migration's session guard can
-- wrap it in this isolated fixture exactly as it wraps the deployed function.
CREATE OR REPLACE FUNCTION public.get_current_admin_profile()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_profile jsonb;
BEGIN
  PERFORM public.assert_my_account_session_active();
  SELECT jsonb_build_object(
    'authenticated', true,
    'is_admin', true,
    'is_active', a.is_active AND a.disabled_at IS NULL,
    'admin_id', a.id,
    'auth_user_id', a.auth_user_id,
    'role', a.role
  )
  INTO v_profile
  FROM public.admins a
  WHERE a.auth_user_id = auth.uid()
  LIMIT 1;
  RETURN v_profile;
END;
$function$;


-- Minimal Storage fixture reproducing the deployed public-write policy drift.
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text NOT NULL,
  name text NOT NULL
);
INSERT INTO storage.objects(bucket_id, name) VALUES ('app-identity', 'existing.png');
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated;
CREATE POLICY "Public Read Access" ON storage.objects
  FOR SELECT TO public USING (bucket_id = 'app-identity');
CREATE POLICY "Public Upload App Identity Logos" ON storage.objects
  FOR INSERT TO public WITH CHECK (bucket_id = 'app-identity');
CREATE POLICY "Public Update App Identity Logos" ON storage.objects
  FOR UPDATE TO public USING (bucket_id = 'app-identity') WITH CHECK (bucket_id = 'app-identity');
CREATE POLICY "Public Delete App Identity Logos" ON storage.objects
  FOR DELETE TO public USING (bucket_id = 'app-identity');
CREATE POLICY "Admin Insert Access" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'app-identity' AND EXISTS (
      SELECT 1 FROM public.admins WHERE auth_user_id = auth.uid()
    )
  );
CREATE POLICY "Admin Update Access" ON storage.objects
  FOR UPDATE TO authenticated USING (
    bucket_id = 'app-identity' AND EXISTS (
      SELECT 1 FROM public.admins WHERE auth_user_id = auth.uid()
    )
  );
CREATE POLICY "Admin Delete Access" ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id = 'app-identity' AND EXISTS (
      SELECT 1 FROM public.admins WHERE auth_user_id = auth.uid()
    )
  );

CREATE TABLE public.customers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  status text NOT NULL DEFAULT 'ACTIVE'
);
CREATE TABLE public.customer_account_links (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  auth_user_id uuid NOT NULL,
  account_status text NOT NULL DEFAULT 'ACTIVE'
);
CREATE TABLE public.jawwal_pay_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  recipient_phone text NOT NULL
);
CREATE TABLE public.financial_ledger (
  id uuid PRIMARY KEY,
  amount_minor bigint NOT NULL
);
CREATE TABLE public.customer_requests (
  id uuid PRIMARY KEY,
  request_type text NOT NULL
);

INSERT INTO public.customers VALUES
  ('20000000-0000-0000-0000-000000000001', 'Fixture customer', true, NULL, 'ACTIVE');
INSERT INTO public.customer_account_links(id,customer_id,auth_user_id,account_status) VALUES
  ('21000000-0000-0000-0000-000000000005','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000005','ACTIVE');
INSERT INTO public.jawwal_pay_settings(singleton,recipient_phone) VALUES (true, '+970599000001');
INSERT INTO public.financial_ledger VALUES
  ('30000000-0000-0000-0000-000000000001', 100);
INSERT INTO public.customer_requests VALUES
  ('40000000-0000-0000-0000-000000000001', 'Fixture request');

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY authenticated_read ON public.customers
  FOR SELECT TO authenticated USING (true);
CREATE POLICY authenticated_read ON public.financial_ledger
  FOR SELECT TO authenticated USING (true);
-- Deliberately use a nonstandard policy name to prove the follow-up migration
-- hardens all authenticated-only policies, not just the legacy authenticated_read name.
CREATE POLICY "Allow authenticated read of customer requests" ON public.customer_requests
  FOR SELECT TO authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.customers TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.financial_ledger TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.customer_requests TO anon, authenticated;

-- The shared minimal auth fixture intentionally omits optional GoTrue columns.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;

INSERT INTO auth.users(id, email, email_confirmed_at) VALUES
  ('10000000-0000-0000-0000-000000000001', 'admin-fixture@example.invalid', now()),
  ('10000000-0000-0000-0000-000000000002', 'nonadmin-fixture@example.invalid', now()),
  ('10000000-0000-0000-0000-000000000003', 'al.niser.0592314333@gmail.com', now()),
  ('10000000-0000-0000-0000-000000000004', 'backfill-admin@example.invalid', now()),
  ('10000000-0000-0000-0000-000000000005', 'unregistered-nonadmin@example.invalid', now());
INSERT INTO auth.sessions(id, user_id, not_after) VALUES
  ('11000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', now() + interval '1 hour'),
  ('11000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', now() + interval '1 hour'),
  ('11000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000004', now() + interval '1 hour'),
  ('11000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000005', now() + interval '1 hour');
INSERT INTO public.account_sessions(session_id, user_id) VALUES
  ('11000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001'),
  ('11000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002');
INSERT INTO public.admins(id, auth_user_id, username, email, role, is_active) VALUES
  ('12000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'fixture_admin', 'admin-fixture@example.invalid', 'OPERATOR', true),
  ('12000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000004', 'backfill_admin', 'backfill-admin@example.invalid', 'OPERATOR', true);

INSERT INTO auth.sessions(id, user_id, not_after) VALUES
  ('11000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', now() + interval '1 hour');


-- Minimal existing function signatures for migration replacement in this isolated fixture.
CREATE FUNCTION public.get_or_create_customer_qr(uuid)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS 'SELECT NULL::text';
CREATE FUNCTION public.get_or_create_customer_qr__session_guarded_impl(uuid)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS 'SELECT NULL::text';
CREATE FUNCTION public.adopt_customer_qr_token(uuid, text)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS 'SELECT NULL::text';


-- Representative trigger-only SECURITY DEFINER functions. They must remain
-- invocable by PostgreSQL triggers but not directly through exposed API roles.
CREATE FUNCTION public.protect_super_admin_account()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.trg_change_capture()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN NEW;
END;
$$;


-- Representative SECURITY DEFINER function with the search_path drift observed
-- in production. It is internal-only and intentionally starts without proconfig.
CREATE FUNCTION public.calculate_customer_authoritative_balance__session_guarded_impl(p_customer_id uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER AS 'SELECT 0::bigint';
REVOKE ALL ON FUNCTION public.calculate_customer_authoritative_balance__session_guarded_impl(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Existing browser-visible username resolver; the hardening migration must revoke
-- API execution while leaving no browser-side dependency on it.
CREATE FUNCTION public.get_email_by_username(p_username text)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS 'SELECT NULL::text';


-- Minimal pre-session BIN implementation used to verify that the strict
-- session migration preserves the one intentional Super Admin login gate.
CREATE OR REPLACE FUNCTION public.verify_admin_bin_with_attempt_tracking__session_guarded_impl(p_bin text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'success', p_bin = '1234',
    'status', 'ACTIVE',
    'is_locked', false,
    'remaining_attempts', CASE WHEN p_bin = '1234' THEN 3 ELSE 2 END,
    'failed_attempts', CASE WHEN p_bin = '1234' THEN 0 ELSE 1 END
  );
$function$;

CREATE OR REPLACE FUNCTION public.verify_admin_bin_with_attempt_tracking(p_bin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.assert_my_account_session_active();
  RETURN public.verify_admin_bin_with_attempt_tracking__session_guarded_impl(p_bin);
END;
$function$;
REVOKE ALL ON FUNCTION public.verify_admin_bin_with_attempt_tracking(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.verify_admin_bin_with_attempt_tracking(text) TO authenticated;
REVOKE ALL ON FUNCTION public.verify_admin_bin_with_attempt_tracking__session_guarded_impl(text)
  FROM PUBLIC, anon, authenticated, service_role;
