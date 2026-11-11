BEGIN;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text LANGUAGE sql STABLE
AS $ SELECT current_setting('request.jwt.claim.role', true) $;

-- The production canonical processor depends on the existing BIN verifier.
-- This isolated migration fixture supplies its authenticated-success contract.
CREATE OR REPLACE FUNCTION public.verify_admin_bin(p_bin text)
RETURNS boolean LANGUAGE sql STABLE
AS $ SELECT p_bin IS NOT NULL AND length(trim(p_bin)) >= 4 $;

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
CREATE TABLE public.purchase_test_change_events (
  entity_table text NOT NULL,
  entity_id uuid NOT NULL,
  operation text NOT NULL,
  payload jsonb NOT NULL,
  version integer NOT NULL
);
CREATE OR REPLACE FUNCTION public.record_canonical_change(
  p_table text, p_id uuid, p_operation text, p_payload jsonb, p_version integer
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.purchase_test_change_events
    (entity_table, entity_id, operation, payload, version)
  VALUES (p_table, p_id, p_operation, p_payload, p_version);
END;
$$;

INSERT INTO public.admins(id,auth_user_id,role,is_active)
VALUES (
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  'SUPER_ADMIN',
  true
);
INSERT INTO public.system_settings(key,value_number)
VALUES ('server_reset_generation',1);
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);

SELECT public.execute_canonical_sync_command_unlocked(
  '20000000-0000-4000-8000-000000000001','SAVE_PURCHASE_SUPPLIER',
  jsonb_build_object('id','30000000-0000-4000-8000-000000000001','name','Test supplier','isActive',true),
  'supplier-hash','purchase-test-device',NULL
);
SELECT public.execute_canonical_sync_command_unlocked(
  '20000000-0000-4000-8000-000000000002','SAVE_PURCHASE_ITEM',
  jsonb_build_object('id','30000000-0000-4000-8000-000000000002','name','Test item','isActive',true),
  'item-hash','purchase-test-device',NULL
);
SELECT public.execute_canonical_sync_command_unlocked(
  '20000000-0000-4000-8000-000000000003','SAVE_PURCHASE_PAYMENT_METHOD',
  jsonb_build_object('id','30000000-0000-4000-8000-000000000003','name','Cash','isActive',true),
  'method-hash','purchase-test-device',NULL
);
SELECT public.execute_canonical_sync_command_unlocked(
  '20000000-0000-4000-8000-000000000004','SAVE_PURCHASE_MONTH',
  jsonb_build_object('id','40000000-0000-4000-8000-000000000001','year',2026,'month',11,'startDate','2026-11-01','endDate','2026-11-30'),
  'month-hash','purchase-test-device',NULL
);
SELECT public.execute_canonical_sync_command_unlocked(
  '20000000-0000-4000-8000-000000000005','SAVE_PURCHASE_WEEK',
  jsonb_build_object('id','40000000-0000-4000-8000-000000000002','monthId','40000000-0000-4000-8000-000000000001','startDate','2026-11-07','endDate','2026-11-13'),
  'week-hash','purchase-test-device',NULL
);
SELECT public.execute_canonical_sync_command_unlocked(
  '20000000-0000-4000-8000-000000000006','SAVE_PURCHASE_DAY',
  jsonb_build_object('id','40000000-0000-4000-8000-000000000003','weekId','40000000-0000-4000-8000-000000000002','purchaseDate','2026-11-11'),
  'day-hash','purchase-test-device',NULL
);
SELECT public.execute_canonical_sync_command_unlocked(
  '20000000-0000-4000-8000-000000000007','SAVE_PURCHASE_ORDER',
  jsonb_build_object(
    'id','50000000-0000-4000-8000-000000000001',
    'purchaseDayId','40000000-0000-4000-8000-000000000003',
    'supplierId','30000000-0000-4000-8000-000000000001',
    'itemId','30000000-0000-4000-8000-000000000002',
    'amountMinor',12345,'currency','ILS','paymentStatus','UNPAID',
    'purchasedAt','2026-11-11T08:00:00Z'
  ),
  'order-hash','purchase-test-device',NULL
);
SELECT public.execute_canonical_sync_command_unlocked(
  '20000000-0000-4000-8000-000000000008','MARK_PURCHASE_ORDER_PAID',
  jsonb_build_object('id','50000000-0000-4000-8000-000000000001','paymentMethodId','30000000-0000-4000-8000-000000000003','expectedVersion',1),
  'paid-hash','purchase-test-device',NULL
);

SELECT public.execute_canonical_sync_command_unlocked(
  '20000000-0000-4000-8000-000000000011','SAVE_PURCHASE_ORDER',
  jsonb_build_object(
    'id','50000000-0000-4000-8000-000000000002',
    'purchaseDayId','40000000-0000-4000-8000-000000000003',
    'supplierId','30000000-0000-4000-8000-000000000001',
    'itemId','30000000-0000-4000-8000-000000000002',
    'amountMinor',12345,'currency','USD','paymentStatus','UNPAID'
  ),
  'usd-order-hash','purchase-test-device',NULL
);
SELECT public.execute_canonical_sync_command_unlocked(
  '20000000-0000-4000-8000-000000000012','SAVE_PURCHASE_ORDER',
  jsonb_build_object(
    'id','50000000-0000-4000-8000-000000000003',
    'purchaseDayId','40000000-0000-4000-8000-000000000003',
    'supplierId','30000000-0000-4000-8000-000000000001',
    'itemId','30000000-0000-4000-8000-000000000002',
    'amountMinor',12345,'currency','JOD','paymentStatus','UNPAID'
  ),
  'jod-order-hash','purchase-test-device',NULL
);

DO $purchase_assertions$
DECLARE v_events integer;
BEGIN
  IF (SELECT payment_status FROM public.purchase_orders WHERE id='50000000-0000-4000-8000-000000000001') <> 'PAID'
     OR (SELECT currency FROM public.purchase_orders WHERE id='50000000-0000-4000-8000-000000000001') <> 'ILS'
     OR (SELECT amount_minor FROM public.purchase_orders WHERE id='50000000-0000-4000-8000-000000000001') <> 12345 THEN
    RAISE EXCEPTION 'Purchase order save/payment transition failed';
  END IF;
  SELECT COUNT(*) INTO v_events FROM public.purchase_test_change_events;
  IF v_events <> 10 THEN
    RAISE EXCEPTION 'Expected ten canonical purchase change events, got %',v_events;
  END IF;
  IF (SELECT COUNT(*) FROM public.purchase_orders WHERE currency IN ('ILS','USD','JOD')) <> 3 THEN
    RAISE EXCEPTION 'ILS, USD and JOD purchases were not all accepted';
  END IF;
  IF has_table_privilege('anon','public.purchase_orders','SELECT')
     OR has_table_privilege('authenticated','public.purchase_orders','SELECT') THEN
    RAISE EXCEPTION 'Browser roles must not read purchase tables directly';
  END IF;
END;
$purchase_assertions$;

DO $invalid_currency$
DECLARE v_rejected boolean := false;
BEGIN
  BEGIN
    PERFORM public.execute_canonical_sync_command_unlocked(
      '20000000-0000-4000-8000-000000000009','SAVE_PURCHASE_ORDER',
      jsonb_build_object(
        'id','50000000-0000-4000-8000-000000000002',
        'purchaseDayId','40000000-0000-4000-8000-000000000003',
        'supplierId','30000000-0000-4000-8000-000000000001',
        'itemId','30000000-0000-4000-8000-000000000002',
        'amountMinor',100,'currency','EUR','paymentStatus','UNPAID'
      ),
      'invalid-currency-hash','purchase-test-device',NULL
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Unsupported purchase currency was accepted'; END IF;
END;
$invalid_currency$;

DO $missing_method$
DECLARE v_rejected boolean := false;
BEGIN
  BEGIN
    PERFORM public.execute_canonical_sync_command_unlocked(
      '20000000-0000-4000-8000-000000000010','SAVE_PURCHASE_ORDER',
      jsonb_build_object(
        'id','50000000-0000-4000-8000-000000000003',
        'purchaseDayId','40000000-0000-4000-8000-000000000003',
        'supplierId','30000000-0000-4000-8000-000000000001',
        'itemId','30000000-0000-4000-8000-000000000002',
        'amountMinor',100,'currency','USD','paymentStatus','PAID'
      ),
      'missing-method-hash','purchase-test-device',NULL
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Paid purchase without a method was accepted'; END IF;
END;
$missing_method$;

ROLLBACK;
