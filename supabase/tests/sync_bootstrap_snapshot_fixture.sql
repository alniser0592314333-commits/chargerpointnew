CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS 'SELECT NULLIF(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';

CREATE TABLE public.admins (
  id uuid PRIMARY KEY,
  auth_user_id uuid NOT NULL,
  is_active boolean NOT NULL
);
CREATE TABLE public.system_settings (key text PRIMARY KEY, value_number bigint);
CREATE TABLE public.change_log (sequence_id bigint PRIMARY KEY);
CREATE TABLE public.business_days (id uuid PRIMARY KEY);
CREATE TABLE public.customers (id uuid PRIMARY KEY);
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

INSERT INTO public.admins(id, auth_user_id, is_active)
VALUES ('00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000001', true);
INSERT INTO public.system_settings(key, value_number)
VALUES ('server_reset_generation', 7);
INSERT INTO public.change_log(sequence_id) VALUES (1), (2), (3);
INSERT INTO public.customers(id)
VALUES ('00000000-0000-0000-0000-000000000002');
