-- Additional fixture for the security-hardening migration. Run after
-- 20261014130000_account_session_management.sql in the isolated test database.
CREATE TABLE public.admins (
  id uuid PRIMARY KEY,
  auth_user_id uuid UNIQUE NOT NULL,
  is_active boolean NOT NULL DEFAULT true
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
CREATE POLICY authenticated_read ON public.customer_requests
  FOR SELECT TO authenticated USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.customers TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.financial_ledger TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.customer_requests TO anon, authenticated;

INSERT INTO auth.users(id, email) VALUES
  ('10000000-0000-0000-0000-000000000001', 'admin-fixture@example.invalid'),
  ('10000000-0000-0000-0000-000000000002', 'nonadmin-fixture@example.invalid');
INSERT INTO auth.sessions(id, user_id, not_after) VALUES
  ('11000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', now() + interval '1 hour'),
  ('11000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', now() + interval '1 hour');
INSERT INTO public.account_sessions(session_id, user_id) VALUES
  ('11000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001'),
  ('11000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002');
INSERT INTO public.admins(id, auth_user_id, is_active) VALUES
  ('12000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', true);
