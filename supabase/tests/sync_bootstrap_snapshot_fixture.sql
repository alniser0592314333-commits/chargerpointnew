CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $function$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$function$;

CREATE TABLE public.admins (
  id uuid PRIMARY KEY,
  auth_user_id uuid NOT NULL,
  role text NOT NULL,
  is_active boolean NOT NULL
);
CREATE TABLE public.change_log (
  sequence_id bigint PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL,
  version integer,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.system_settings (key text PRIMARY KEY, value_number bigint);
CREATE TABLE public.business_days (id uuid PRIMARY KEY);
CREATE TABLE public.customers (id uuid PRIMARY KEY, name text);
CREATE TABLE public.device_types (id uuid PRIMARY KEY);
CREATE TABLE public.orders (id uuid PRIMARY KEY);
CREATE TABLE public.order_items (id uuid PRIMARY KEY);
CREATE TABLE public.financial_ledger (id uuid PRIMARY KEY);
CREATE TABLE public.payments (id uuid PRIMARY KEY);
CREATE TABLE public.payment_allocations (id uuid PRIMARY KEY);
CREATE TABLE public.order_number_reservations (id uuid PRIMARY KEY);
CREATE TABLE public.qr_tokens (id uuid PRIMARY KEY);
CREATE TABLE public.goals (id uuid PRIMARY KEY);
CREATE TABLE public.goal_requests (id uuid PRIMARY KEY);

INSERT INTO public.admins VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'ADMIN', true),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'ADMIN', false);
INSERT INTO public.system_settings VALUES ('server_reset_generation', 7);
INSERT INTO public.change_log(sequence_id, entity_type, entity_id, action, payload, version)
VALUES (41, 'customers', '00000000-0000-0000-0000-000000000003', 'UPSERT', '{}'::jsonb, 1);
INSERT INTO public.customers VALUES ('00000000-0000-0000-0000-000000000003', 'Snapshot customer');
