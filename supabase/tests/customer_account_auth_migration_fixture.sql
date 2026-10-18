CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE public.customers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'ACTIVE',
  deleted_at timestamptz
);
CREATE TABLE public.admins (id uuid PRIMARY KEY);
CREATE FUNCTION public.public_resolve_customer_portal(text)
RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;

CREATE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt()
RETURNS jsonb LANGUAGE sql STABLE
AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
CREATE TABLE public.qr_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_token text NOT NULL UNIQUE,
  target_id uuid NOT NULL,
  token_type text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz
);
CREATE TABLE public.orders (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL,
  deleted_at timestamptz,
  cancelled_at timestamptz
);
CREATE TABLE public.payments (
  id uuid PRIMARY KEY,
  amount_minor bigint
);
CREATE TABLE public.qr_payment_submissions (
  id uuid PRIMARY KEY,
  status text NOT NULL,
  amount_minor bigint,
  payment_method text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  reviewed_at timestamptz,
  order_id uuid,
  customer_id uuid NOT NULL,
  payment_id uuid
);
