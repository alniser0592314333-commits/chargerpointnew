-- Minimal isolated schema for the customer QR portal RPC contract.
-- Contains synthetic records only; never connects to production.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END
$roles$;

CREATE TABLE public.customers (
  id uuid PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'ACTIVE',
  is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz
);
CREATE TABLE public.qr_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), public_token text NOT NULL,
  token_type text NOT NULL, target_id uuid NOT NULL, is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.financial_ledger (
  id uuid PRIMARY KEY, customer_id uuid NOT NULL, amount_minor bigint NOT NULL
);
CREATE TABLE public.orders (
  id uuid PRIMARY KEY, customer_id uuid NOT NULL, display_number integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL,
  deleted_at timestamptz, cancelled_at timestamptz
);
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY, order_id uuid NOT NULL, device_type_id uuid,
  item_sequence integer NOT NULL, operational_status text, financial_status text,
  financially_recognized_at timestamptz, payment_status text, device_name_snapshot text NOT NULL,
  has_charger boolean NOT NULL DEFAULT false, final_charge_snapshot_minor bigint NOT NULL DEFAULT 0,
  cancelled_at timestamptz, deleted_at timestamptz
);
CREATE TABLE public.device_types (id uuid PRIMARY KEY, name text, name_ar text, name_en text);
CREATE TABLE public.payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_item_id uuid NOT NULL,
  allocated_amount_minor bigint NOT NULL
);
CREATE TABLE public.payments (id uuid PRIMARY KEY, amount_minor bigint NOT NULL);
CREATE TABLE public.qr_payment_submissions (
  id uuid PRIMARY KEY, customer_id uuid NOT NULL, order_id uuid, status text NOT NULL,
  payment_method text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz, amount_minor bigint, payment_id uuid
);
CREATE TABLE public.goals (
  id uuid PRIMARY KEY, customer_id uuid NOT NULL, target_quantity integer NOT NULL,
  current_progress integer NOT NULL, status text NOT NULL, expires_at timestamptz,
  completed_at timestamptz, bonus_ledger_id uuid, bonus_amount_minor bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.derive_customer_code(p_customer_id uuid)
RETURNS text LANGUAGE sql IMMUTABLE
AS $$ SELECT left(replace(p_customer_id::text, '-', ''), 4) $$;
