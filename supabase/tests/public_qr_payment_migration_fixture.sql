-- Isolated minimal Supabase-shaped schema for the public QR payment migration runtime test.
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE SCHEMA storage;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean NOT NULL DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text NOT NULL,
  name text NOT NULL,
  metadata jsonb,
  UNIQUE (bucket_id, name)
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.admins (
  id uuid PRIMARY KEY,
  auth_user_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  role text NOT NULL DEFAULT 'SUPER_ADMIN'
);
CREATE TABLE public.system_settings (
  key text PRIMARY KEY,
  value_number bigint
);
INSERT INTO public.system_settings (key, value_number) VALUES ('server_reset_generation', 49);
CREATE FUNCTION public.get_effective_permissions(p_admin_id uuid)
RETURNS TABLE(permission text)
LANGUAGE sql STABLE
AS $$ SELECT 'finance:approve-payment'::text WHERE p_admin_id IS NOT NULL $$;
CREATE FUNCTION public.is_my_account_session_active()
RETURNS boolean
LANGUAGE sql STABLE
AS $$ SELECT auth.uid() IS NOT NULL $$;

CREATE TABLE public.customers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz
);
CREATE TABLE public.orders (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  display_number integer NOT NULL,
  status text NOT NULL DEFAULT 'CHARGING',
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  deleted_at timestamptz
);
CREATE TABLE public.qr_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_token text NOT NULL UNIQUE,
  token_hash text NOT NULL DEFAULT '',
  token_type text NOT NULL,
  target_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  payment_method text NOT NULL,
  reference text,
  actor_admin_id uuid,
  command_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id),
  item_sequence integer NOT NULL,
  device_name_snapshot text NOT NULL,
  status text NOT NULL DEFAULT 'CHARGING',
  operational_status text NOT NULL DEFAULT 'CHARGING',
  financial_status text NOT NULL DEFAULT 'PENDING',
  payment_status text NOT NULL DEFAULT 'UNPAID',
  has_charger boolean NOT NULL DEFAULT false,
  customer_charger_fee_exempt_snapshot boolean NOT NULL DEFAULT false,
  unit_price_minor bigint NOT NULL DEFAULT 0,
  total_price_minor bigint NOT NULL DEFAULT 0,
  final_charge_snapshot_minor bigint NOT NULL DEFAULT 0,
  cancelled_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES public.payments(id),
  order_item_id uuid REFERENCES public.order_items(id),
  order_id uuid REFERENCES public.orders(id),
  allocated_amount_minor bigint NOT NULL CHECK (allocated_amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (order_item_id IS NOT NULL OR order_id IS NOT NULL)
);

-- Match the production wrapper: serialize canonical change-log writes, then delegate.
CREATE FUNCTION public.execute_canonical_sync_command(
  p_command_id uuid,
  p_command_type text,
  p_payload jsonb,
  p_payload_hash text,
  p_device_id text,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('chargerpointnew:change_log:commit_order', 0));
  RETURN public.execute_canonical_sync_command_unlocked(
    p_command_id, p_command_type, p_payload, p_payload_hash, p_device_id, p_actor_id
  );
END;
$;

CREATE TABLE public.qr_payment_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  receipt_url text,
  note text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_by uuid REFERENCES public.admins(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

-- Test double: the real function is the existing canonical command engine. This
-- fixture simulates its transaction boundary and deliberately supports a failure case.
CREATE FUNCTION public.execute_canonical_sync_command_unlocked(
  p_command_id uuid,
  p_command_type text,
  p_payload jsonb,
  p_payload_hash text,
  p_device_id text,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_command_type <> 'POST_PAYMENT' THEN
    RAISE EXCEPTION 'Expected review to use existing POST_PAYMENT FIFO branch, got %', p_command_type;
  END IF;
  IF p_payload->>'resetGeneration' <> '49' THEN
    RAISE EXCEPTION 'Review must forward the current server reset generation';
  END IF;
  IF p_payload->>'bin' = 'FAIL' THEN
    RETURN jsonb_build_object('success', false);
  END IF;
  INSERT INTO public.payments (
    id, customer_id, amount_minor, payment_method, reference, actor_admin_id, command_id
  )
  VALUES (
    (p_payload->>'id')::uuid,
    (p_payload->>'customerId')::uuid,
    (p_payload->>'amountMinor')::bigint,
    p_payload->>'paymentMethod',
    p_payload->>'reference',
    p_actor_id,
    p_command_id
  );
  RETURN jsonb_build_object('success', true, 'result', jsonb_build_object('paymentId', (p_payload->>'id')::uuid));
END;
$$;
