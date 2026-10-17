-- Additional fixture for the security-hardening migration. Run after
-- 20261014130000_account_session_management.sql in the isolated test database.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE TABLE public.admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid UNIQUE NOT NULL,
  username varchar(64) UNIQUE,
  full_name varchar(200),
  email varchar(255) UNIQUE,
  role text NOT NULL DEFAULT 'OPERATOR',
  permissions text[] NOT NULL DEFAULT '{}'::text[],
  bin_hash varchar(255),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);


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
  name text NOT NULL
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
  ('20000000-0000-0000-0000-000000000001', 'Fixture customer');
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
  ('10000000-0000-0000-0000-000000000003', 'al.niser.0592314333@gmail.com', now());
INSERT INTO auth.sessions(id, user_id, not_after) VALUES
  ('11000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', now() + interval '1 hour'),
  ('11000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', now() + interval '1 hour');
INSERT INTO public.account_sessions(session_id, user_id) VALUES
  ('11000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001'),
  ('11000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002');
INSERT INTO public.admins(id, auth_user_id, username, email, role, is_active) VALUES
  ('12000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'fixture_admin', 'admin-fixture@example.invalid', 'OPERATOR', true);

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
