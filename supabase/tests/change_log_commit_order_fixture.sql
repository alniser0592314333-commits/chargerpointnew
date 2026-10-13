-- Minimal schema for testing the commit-order lock migration in isolated PostgreSQL.
CREATE TABLE public.change_log (
  sequence_id bigserial PRIMARY KEY,
  entity_type varchar(50) NOT NULL,
  entity_id uuid NOT NULL,
  action varchar(20) NOT NULL,
  payload jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.system_settings (key text PRIMARY KEY, value_number bigint);
INSERT INTO public.system_settings(key, value_number) VALUES ('server_reset_generation', 1);
CREATE TABLE public.orders (id uuid PRIMARY KEY, name text NOT NULL);

-- Minimal authenticated-admin identity used by the bootstrap RPC contract test.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE
AS $auth_uid$ SELECT '00000000-0000-0000-0000-000000000009'::uuid $auth_uid$;
CREATE TABLE public.admins (
  id uuid PRIMARY KEY,
  auth_user_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);
INSERT INTO public.admins(id, auth_user_id, is_active)
VALUES ('00000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000009', true);

-- Snapshot collections need only the identity column for the isolated RPC test.
CREATE TABLE public.customers (id uuid PRIMARY KEY);
CREATE TABLE public.business_days (id uuid PRIMARY KEY);
CREATE TABLE public.device_types (id uuid PRIMARY KEY);
CREATE TABLE public.order_items (id uuid PRIMARY KEY);
CREATE TABLE public.financial_ledger (id uuid PRIMARY KEY);
CREATE TABLE public.payments (id uuid PRIMARY KEY);
CREATE TABLE public.payment_allocations (id uuid PRIMARY KEY);
CREATE TABLE public.order_number_reservations (id uuid PRIMARY KEY);
CREATE TABLE public.qr_tokens (id uuid PRIMARY KEY);
CREATE TABLE public.goals (id uuid PRIMARY KEY);
CREATE TABLE public.goal_requests (id uuid PRIMARY KEY);

-- Minimal dispatcher fixtures prove the migration wraps both RPC entry
-- points before their original implementations can acquire row locks.
CREATE OR REPLACE FUNCTION public.execute_canonical_sync_command(
  p_command_id uuid,
  p_command_type text,
  p_payload jsonb,
  p_payload_hash text DEFAULT 'no_hash'::text,
  p_device_id text DEFAULT 'default_device'::text,
  p_actor_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
AS $function$
BEGIN
  IF p_payload ? 'lockId' THEN
    PERFORM 1 FROM public.orders WHERE id = (p_payload->>'lockId')::uuid FOR UPDATE;
  END IF;
  IF p_payload ? 'sleepSeconds' THEN
    PERFORM pg_sleep(LEAST(5, GREATEST(0, (p_payload->>'sleepSeconds')::double precision)));
  END IF;
  INSERT INTO public.orders(id, name)
  VALUES (COALESCE((p_payload->>'id')::uuid, p_command_id), COALESCE(p_payload->>'name', p_command_type))
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
  RETURN jsonb_build_object('success', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.execute_sync_command_impl(
  p_command_id uuid,
  p_command_type text,
  p_aggregate_type text DEFAULT NULL::text,
  p_aggregate_id uuid DEFAULT NULL::uuid,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_expected_version integer DEFAULT NULL::integer
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
AS $function$
BEGIN
  IF p_aggregate_id IS NOT NULL THEN
    PERFORM 1 FROM public.orders WHERE id = p_aggregate_id FOR UPDATE;
  END IF;
  INSERT INTO public.orders(id, name)
  VALUES (COALESCE((p_payload->>'id')::uuid, p_command_id), p_command_type)
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
  RETURN jsonb_build_object('success', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_canonical_change(
  p_entity_type varchar(50), p_entity_id uuid, p_action varchar(20), p_payload jsonb, p_version integer DEFAULT 1
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_seq bigint;
BEGIN
  INSERT INTO public.change_log(entity_type, entity_id, action, payload, version, changed_at)
  VALUES (p_entity_type, p_entity_id, p_action, p_payload, COALESCE(p_version,1), now())
  RETURNING sequence_id INTO v_seq;
  RETURN v_seq;
END; $$;

CREATE OR REPLACE FUNCTION public.trg_change_capture()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_row jsonb; v_id uuid; v_action text;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := to_jsonb(OLD); v_id := OLD.id; v_action := 'DELETE';
  ELSE v_row := to_jsonb(NEW); v_id := NEW.id; v_action := CASE WHEN TG_OP='INSERT' THEN 'INSERT' ELSE 'UPDATE' END;
  END IF;
  PERFORM public.record_canonical_change(TG_TABLE_NAME, v_id, v_action, v_row, 1);
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;

CREATE TRIGGER trg_change_capture
AFTER INSERT OR UPDATE OR DELETE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.trg_change_capture();
