-- Additional fixture for the security-hardening migration. Run after
-- 20261014130000_account_session_management.sql in the isolated test database.
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
