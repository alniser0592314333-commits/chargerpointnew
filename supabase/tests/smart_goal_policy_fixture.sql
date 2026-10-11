-- Minimal isolated schema for executing the real smart-goal policy migration.
-- This is test-only and must never be applied to a production database.

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.role', true), '') $$;

CREATE TABLE public.admins (
  id uuid PRIMARY KEY,
  auth_user_id uuid NOT NULL UNIQUE,
  role text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE public.customers (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'ACTIVE',
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE public.business_days (
  id uuid PRIMARY KEY,
  business_date date
);
CREATE TABLE public.orders (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  day_id uuid,
  display_number integer NOT NULL DEFAULT 1,
  internal_sequence bigint NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'charging',
  notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id),
  item_sequence integer NOT NULL DEFAULT 1,
  final_charge_snapshot_minor bigint NOT NULL DEFAULT 0,
  payment_status text NOT NULL DEFAULT 'UNPAID',
  status text NOT NULL DEFAULT 'charging',
  operational_status text NOT NULL DEFAULT 'CHARGING',
  financial_status text NOT NULL DEFAULT 'UNRECOGNIZED',
  delivered_at timestamptz,
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE TABLE public.financial_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  amount_minor bigint NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  reference_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  order_id uuid,
  order_item_id uuid,
  actor_admin_id uuid,
  linked_ledger_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.payments (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  payment_method text NOT NULL,
  reference text,
  actor_admin_id uuid,
  command_id uuid NOT NULL UNIQUE,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.payment_allocations (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES public.payments(id),
  order_item_id uuid NOT NULL REFERENCES public.order_items(id),
  order_id uuid NOT NULL REFERENCES public.orders(id),
  allocated_amount_minor bigint NOT NULL CHECK (allocated_amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.goals (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  target_quantity integer NOT NULL,
  current_progress integer NOT NULL DEFAULT 0,
  bonus_amount_minor bigint NOT NULL,
  duration_days integer NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  bonus_ledger_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.system_settings (
  key text PRIMARY KEY,
  value_type text,
  value_string text,
  value_number bigint,
  value_boolean boolean,
  value_json jsonb,
  updated_at timestamptz,
  updated_by uuid
);
CREATE TABLE public.processed_commands (
  command_id uuid PRIMARY KEY,
  command_type text NOT NULL,
  actor_admin_id uuid NOT NULL,
  payload_hash text NOT NULL,
  result_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.test_change_events (
  entity_table text NOT NULL,
  entity_id uuid NOT NULL,
  operation text NOT NULL,
  payload jsonb NOT NULL,
  version integer NOT NULL
);
CREATE FUNCTION public.record_canonical_change(
  p_table text, p_id uuid, p_operation text, p_payload jsonb, p_version integer
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.test_change_events(entity_table, entity_id, operation, payload, version)
  VALUES (p_table, p_id, p_operation, p_payload, p_version);
END;
$$;
CREATE FUNCTION public.get_effective_permissions(p_admin_id uuid)
RETURNS TABLE(permission text) LANGUAGE sql STABLE AS $$
  SELECT NULL::text WHERE FALSE
$$;
CREATE FUNCTION public.verify_admin_bin(p_bin text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT p_bin = '123456' $$;
CREATE FUNCTION public.evaluate_customer_active_goal(p_customer_id uuid)
RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('legacyStub', true) $$;
