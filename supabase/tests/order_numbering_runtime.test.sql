BEGIN;

-- Minimal isolated schema needed to execute the real canonical renumber command.
CREATE TABLE public.admins (
  id uuid PRIMARY KEY,
  auth_user_id uuid NOT NULL UNIQUE,
  role text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE public.system_settings (
  key text PRIMARY KEY,
  value_number bigint
);
CREATE TABLE public.processed_commands (
  command_id uuid PRIMARY KEY,
  command_type text NOT NULL,
  actor_admin_id uuid NOT NULL,
  payload_hash text NOT NULL,
  result_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE public.business_days (
  id uuid PRIMARY KEY
);
CREATE SEQUENCE public.order_internal_sequence_seq START 104;
CREATE TABLE public.customers (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'ACTIVE'
);
CREATE TABLE public.orders (
  id uuid PRIMARY KEY,
  day_id uuid NOT NULL REFERENCES public.business_days(id),
  customer_id uuid,
  display_number integer NOT NULL CHECK (display_number > 0),
  status text NOT NULL DEFAULT 'charging',
  notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  internal_sequence bigint NOT NULL DEFAULT nextval('public.order_internal_sequence_seq')
);
CREATE TABLE public.test_change_events (
  entity_table text NOT NULL,
  entity_id uuid NOT NULL,
  operation text NOT NULL,
  payload jsonb NOT NULL,
  version integer NOT NULL
);
CREATE FUNCTION public.record_canonical_change(
  p_table text,
  p_id uuid,
  p_operation text,
  p_payload jsonb,
  p_version integer
) RETURNS void
LANGUAGE plpgsql
AS $record_change$
BEGIN
  INSERT INTO public.test_change_events(entity_table, entity_id, operation, payload, version)
  VALUES (p_table, p_id, p_operation, p_payload, p_version);
END;
$record_change$;

CREATE FUNCTION public.get_effective_permissions(p_admin_id uuid)
RETURNS TABLE(permission text)
LANGUAGE sql
STABLE
AS $get_effective_permissions$
  SELECT NULL::text WHERE FALSE;
$get_effective_permissions$;

CREATE FUNCTION public.verify_admin_bin(p_bin text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS 'SELECT TRUE';

INSERT INTO public.admins(id, auth_user_id, role, is_active)
VALUES (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'SUPER_ADMIN',
  TRUE
),
(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'ADMIN',
  TRUE
);
INSERT INTO public.system_settings(key, value_number)
VALUES ('server_reset_generation', 1);
INSERT INTO public.business_days(id)
VALUES ('33333333-3333-4333-8333-333333333333');
INSERT INTO public.orders(id, day_id, display_number, version, internal_sequence)
VALUES
  ('44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333', 1, 1, 101),
  ('55555555-5555-4555-8555-555555555555', '33333333-3333-4333-8333-333333333333', 2, 1, 102),
  ('66666666-6666-4666-8666-666666666666', '33333333-3333-4333-8333-333333333333', 3, 1, 103);

CREATE FUNCTION public.capture_order_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $capture_order_change$
BEGIN
  PERFORM public.record_canonical_change('orders', NEW.id, 'UPDATE', to_jsonb(NEW), NEW.version);
  RETURN NEW;
END;
$capture_order_change$;
CREATE TRIGGER trg_change_capture
AFTER UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.capture_order_change();

SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
SET ROLE authenticated;
SELECT public.execute_canonical_sync_command(
  '77777777-7777-4777-8777-777777777777'::uuid,
  'RENUMBER_DAY_ORDERS',
  jsonb_build_object(
    'dayId', '33333333-3333-4333-8333-333333333333',
    'changes', jsonb_build_array(
      jsonb_build_object('id', '44444444-4444-4444-8444-444444444444', 'expectedVersion', 1, 'oldNumber', 1, 'newNumber', 2),
      jsonb_build_object('id', '55555555-5555-4555-8555-555555555555', 'expectedVersion', 1, 'oldNumber', 2, 'newNumber', 3),
      jsonb_build_object('id', '66666666-6666-4666-8666-666666666666', 'expectedVersion', 1, 'oldNumber', 3, 'newNumber', 1)
    )
  )
);
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = '44444444-4444-4444-8444-444444444444'
      AND display_number = 2 AND version = 2 AND internal_sequence = 101
  ) OR NOT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = '55555555-5555-4555-8555-555555555555'
      AND display_number = 3 AND version = 2 AND internal_sequence = 102
  ) OR NOT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = '66666666-6666-4666-8666-666666666666'
      AND display_number = 1 AND version = 2 AND internal_sequence = 103
  ) THEN
    RAISE EXCEPTION 'Renumber did not apply the requested permutation, increment each version once, and preserve internal_sequence';
  END IF;

  IF (SELECT COUNT(*) FROM public.order_renumber_audit
      WHERE command_id = '77777777-7777-4777-8777-777777777777') <> 3 THEN
    RAISE EXCEPTION 'Expected one audit row per renumbered order';
  END IF;

  IF (SELECT COUNT(*) FROM public.test_change_events
      WHERE entity_table = 'orders' AND operation = 'UPDATE') <> 3 THEN
    RAISE EXCEPTION 'Expected one canonical change event per renumbered order';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.test_change_events e
    JOIN public.orders o ON o.id = e.entity_id
    WHERE e.entity_table = 'orders' AND e.operation = 'UPDATE'
      AND ((e.payload->>'display_number')::INTEGER <> o.display_number
           OR (e.payload->>'version')::INTEGER <> o.version)
  ) THEN
    RAISE EXCEPTION 'Change feed exposed an intermediate or stale order number/version';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.processed_commands
    WHERE command_id = '77777777-7777-4777-8777-777777777777'
      AND command_type = 'RENUMBER_DAY_ORDERS'
  ) THEN
    RAISE EXCEPTION 'Expected successful renumber command to be recorded for idempotency';
  END IF;
END;
$$;

-- A regular admin without the new permission must be rejected before any writes.
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
SET ROLE authenticated;
DO $$
DECLARE
  rejected_as_forbidden boolean := FALSE;
BEGIN
  BEGIN
    PERFORM public.execute_canonical_sync_command(
      'aaaaaaaa-0000-4000-8000-000000000001'::uuid,
      'RENUMBER_DAY_ORDERS',
      jsonb_build_object(
        'dayId', '33333333-3333-4333-8333-333333333333',
        'changes', jsonb_build_array(
          jsonb_build_object('id', '44444444-4444-4444-8444-444444444444', 'expectedVersion', 2, 'oldNumber', 2, 'newNumber', 1),
          jsonb_build_object('id', '55555555-5555-4555-8555-555555555555', 'expectedVersion', 2, 'oldNumber', 3, 'newNumber', 2),
          jsonb_build_object('id', '66666666-6666-4666-8666-666666666666', 'expectedVersion', 2, 'oldNumber', 1, 'newNumber', 3)
        )
      )
    );
    RAISE EXCEPTION 'Expected unauthorized renumber to be rejected';
  EXCEPTION WHEN SQLSTATE 'P4003' THEN
    rejected_as_forbidden := TRUE;
  END;
  IF NOT rejected_as_forbidden THEN
    RAISE EXCEPTION 'Renumber was not rejected for an admin lacking orders:renumber-day';
  END IF;
END;
$$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM public.order_renumber_audit) <> 3
     OR (SELECT COUNT(*) FROM public.test_change_events WHERE entity_table = 'orders') <> 3
     OR EXISTS (
       SELECT 1 FROM public.processed_commands
       WHERE command_id = 'aaaaaaaa-0000-4000-8000-000000000001'
     ) THEN
    RAISE EXCEPTION 'Unauthorized renumber changed data, audit, change events, or idempotency state';
  END IF;
END;
$$;

-- A stale expected version must fail before writes and leave order numbers/audit unchanged.
DO $$
DECLARE
  rejected_as_stale boolean := false;
BEGIN
  BEGIN
    PERFORM public.execute_canonical_sync_command(
      '88888888-8888-4888-8888-888888888888'::uuid,
      'RENUMBER_DAY_ORDERS',
      jsonb_build_object(
        'dayId', '33333333-3333-4333-8333-333333333333',
        'changes', jsonb_build_array(
          jsonb_build_object('id', '44444444-4444-4444-8444-444444444444', 'expectedVersion', 1, 'oldNumber', 1, 'newNumber', 1),
          jsonb_build_object('id', '55555555-5555-4555-8555-555555555555', 'expectedVersion', 1, 'oldNumber', 2, 'newNumber', 2),
          jsonb_build_object('id', '66666666-6666-4666-8666-666666666666', 'expectedVersion', 1, 'oldNumber', 3, 'newNumber', 3)
        )
      )
    );
    RAISE EXCEPTION 'Expected stale renumber command to be rejected';
  EXCEPTION WHEN SQLSTATE 'P0409' THEN
    rejected_as_stale := TRUE;
  END;

  IF NOT rejected_as_stale THEN
    RAISE EXCEPTION 'Stale renumber command was not rejected with the conflict contract';
  END IF;

  IF (SELECT COUNT(*) FROM public.order_renumber_audit) <> 3
     OR (SELECT COUNT(*) FROM public.test_change_events WHERE entity_table = 'orders') <> 3
     OR EXISTS (
       SELECT 1 FROM public.orders
       WHERE (id = '44444444-4444-4444-8444-444444444444' AND display_number <> 2)
          OR (id = '55555555-5555-4555-8555-555555555555' AND display_number <> 3)
          OR (id = '66666666-6666-4666-8666-666666666666' AND display_number <> 1)
     ) THEN
    RAISE EXCEPTION 'Rejected stale command changed orders, audit, or canonical events';
  END IF;
END;
$$;


-- A stale offline reservation that now collides must be reconciled, not rejected,
-- and the server-assigned number must be the one published to every client.
INSERT INTO public.customers(id, status)
VALUES ('99999999-9999-4999-8999-999999999999', 'ACTIVE');

SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
SET ROLE authenticated;
SELECT public.execute_canonical_sync_command(
  'aaaaaaaa-1111-4111-8111-111111111111'::uuid,
  'CREATE_ORDER',
  jsonb_build_object(
    'id', 'aaaaaaaa-2222-4222-8222-222222222222',
    'dayId', '33333333-3333-4333-8333-333333333333',
    'customerId', '99999999-9999-4999-8999-999999999999',
    'displayNumber', 2,
    'notes', 'offline order with a stale reserved number'
  )
);
RESET ROLE;

DO $offline_collision$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = 'aaaaaaaa-2222-4222-8222-222222222222'
      AND display_number = 4
  ) THEN
    RAISE EXCEPTION 'A stale offline order number collision was not reassigned to the next free number';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.test_change_events
    WHERE entity_table = 'orders'
      AND entity_id = 'aaaaaaaa-2222-4222-8222-222222222222'
      AND operation = 'INSERT'
      AND (payload->>'displayNumber')::INTEGER = 4
      AND (payload->>'display_number')::INTEGER = 4
  ) THEN
    RAISE EXCEPTION 'The canonical change event did not publish the authoritative reassigned number';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.processed_commands
    WHERE command_id = 'aaaaaaaa-1111-4111-8111-111111111111'
      AND result_payload->>'displayNumber' = '4'
  ) THEN
    RAISE EXCEPTION 'The successful CREATE_ORDER result did not report the authoritative number';
  END IF;
END;
$;

ROLLBACK;
