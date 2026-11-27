-- Session-bound customer reads and atomic Sarah order creation.
-- Run after the provider, quota, lookup, profile, and admin-read migrations plus fixture.

-- Device catalog read requires devices:view and returns only a bounded projection.
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000001';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000001',false);
DO $device_catalog_read$
DECLARE v_result jsonb;
BEGIN
  v_result:=public.sarah_ai_get_device_catalog();
  IF v_result->>'ok'<>'true' OR (v_result->>'count')::integer<1
     OR jsonb_array_length(v_result->'devices')>100 THEN
    RAISE EXCEPTION 'Device catalog read did not return the bounded catalog projection: %',v_result;
  END IF;
END;
$device_catalog_read$;
RESET ROLE;

-- Permissions are re-evaluated on every database capability call, even within
-- one still-valid account session: grant, use, revoke, then immediately deny.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000009';
INSERT INTO public.admin_custom_permissions(admin_id,permission,is_grant)
VALUES('00000000-0000-4000-8000-000000000009','devices:view',true)
ON CONFLICT(admin_id,permission) DO UPDATE SET is_grant=EXCLUDED.is_grant;
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000009',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000009',false);
DO $live_permission_grant$
DECLARE v_result jsonb;
BEGIN
  v_result:=public.sarah_ai_get_device_catalog();
  IF v_result->>'ok'<>'true' THEN
    RAISE EXCEPTION 'Freshly granted device permission was not honored: %',v_result;
  END IF;
END;
$live_permission_grant$;
RESET ROLE;
DELETE FROM public.admin_custom_permissions
WHERE admin_id='00000000-0000-4000-8000-000000000009'
  AND permission='devices:view';
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000009';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000009',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000009',false);
DO $live_permission_revocation$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_get_device_catalog();
    RAISE EXCEPTION 'Sarah retained devices:view after it was revoked in the same session';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$live_permission_revocation$;
RESET ROLE;

-- An ordinary admin without devices:view cannot use Sarah to read the catalog.
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000009';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000009',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000009',false);
DO $device_catalog_permission_gate$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_get_device_catalog();
    RAISE EXCEPTION 'Admin without devices:view unexpectedly read the device catalog';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$device_catalog_permission_gate$;
RESET ROLE;

-- Each isolated SQL test run starts with clean quota buckets for its fixed actors.
DELETE FROM public.sarah_ai_usage_windows
WHERE actor_auth_user_id IN (
 '10000000-0000-4000-8000-000000000001',
 '10000000-0000-4000-8000-000000000002',
 '10000000-0000-4000-8000-000000000003',
 '10000000-0000-4000-8000-000000000004',
 '10000000-0000-4000-8000-000000000005',
 '10000000-0000-4000-8000-000000000006',
 '10000000-0000-4000-8000-000000000007',
 '10000000-0000-4000-8000-000000000008',
 '10000000-0000-4000-8000-000000000009',
 '10000000-0000-4000-8000-000000000010'
);

-- Customer creation is idempotent and uses the original customers:create permission.
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000001';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000001',false);
DO $customer_create$
DECLARE
  v_result jsonb;
  v_replay jsonb;
BEGIN
  v_result:=public.sarah_ai_create_customer(
    '70000000-0000-4000-8000-000000000001','عميل اختبار سارة',NULL
  );
  IF v_result->>'ok'<>'true'
     OR v_result->>'customer_name'<>'عميل اختبار سارة'
     OR v_result->>'customer_code' IS NULL
     OR (v_result->>'debt_limit_minor')::bigint<>2000
     OR (v_result->>'charger_fee_exempt')::boolean IS TRUE THEN
    RAISE EXCEPTION 'Sarah customer creation did not follow the app defaults: %',v_result;
  END IF;
  v_replay:=public.sarah_ai_create_customer(
    '70000000-0000-4000-8000-000000000001','عميل اختبار سارة',NULL
  );
  IF v_replay->>'idempotent_replay'<>'true'
     THEN
    RAISE EXCEPTION 'Customer creation retry was not idempotent: %',v_replay;
  END IF;
END;
$customer_create$;
RESET ROLE;

-- Verify persisted rows as the migration-test owner, not as the restricted app role.
DO $customer_create_persisted$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM public.customers
    WHERE name='عميل اختبار سارة'
      AND debt_limit_minor=2000 AND charger_fee_exempt IS FALSE
  ) OR (SELECT count(*) FROM public.customers WHERE name='عميل اختبار سارة')<>1 THEN
    RAISE EXCEPTION 'Canonical customer creation did not persist exactly one row with app defaults';
  END IF;
END;
$customer_create_persisted$;

-- Basic customer edits require customers:view + customers:edit and a same-session lookup proof.
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000001';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000001',false);
DO $customer_profile_update$
DECLARE
  v_lookup jsonb;
  v_result jsonb;
  v_replay jsonb;
  v_code text;
BEGIN
  v_lookup:=public.sarah_ai_lookup_customers('عميل اختبار سارة');
  IF v_lookup->>'match_count'<>'1' THEN
    RAISE EXCEPTION 'New customer lookup failed before profile edit: %',v_lookup;
  END IF;
  v_code:=v_lookup->'matches'->0->>'customer_code';
  v_result:=public.sarah_ai_update_customer_profile(
    '70000000-0000-4000-8000-000000000003',
    v_code,'عميل اختبار سارة',
    'عميل اختبار سارة معدل','0591234567','تم التعديل عبر سارة'
  );
  IF v_result->>'ok'<>'true'
     OR v_result->>'customer_name'<>'عميل اختبار سارة معدل'
     OR v_result->>'phone'<>'0591234567'
     OR v_result->>'notes'<>'تم التعديل عبر سارة' THEN
    RAISE EXCEPTION 'Customer profile edit did not return the canonical updated values: %',v_result;
  END IF;
  v_replay:=public.sarah_ai_update_customer_profile(
    '70000000-0000-4000-8000-000000000003',
    v_code,'عميل اختبار سارة معدل',
    'عميل اختبار سارة معدل','0591234567','تم التعديل عبر سارة'
  );
  IF v_replay->>'idempotent_replay'<>'true'
     OR (public.test_sarah_customer_snapshot('عميل اختبار سارة معدل')->>'count')::integer<>1 THEN
    RAISE EXCEPTION 'Customer profile update retry was not idempotent: %',v_replay;
  END IF;
END;
$customer_profile_update$;
RESET ROLE;

-- Protected customer settings require their granular permission and separate BIN.
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000001';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000001',false);
DO $customer_protected_settings$
DECLARE
  v_lookup jsonb;
  v_result jsonb;
  v_replay jsonb;
  v_code text;
  v_customer_id uuid;
  v_payload jsonb;
BEGIN
  v_lookup:=public.sarah_ai_lookup_customers('عميل اختبار سارة معدل');
  IF v_lookup->>'match_count'<>'1' THEN
    RAISE EXCEPTION 'Protected customer setting lookup failed: %',v_lookup;
  END IF;
  v_code:=v_lookup->'matches'->0->>'customer_code';
  v_customer_id:=(public.test_sarah_customer_snapshot('عميل اختبار سارة معدل')->>'id')::uuid;

  BEGIN
    PERFORM public.sarah_ai_update_customer_protected_settings(
      '70000000-0000-4000-8000-000000000004',
      v_code,'عميل اختبار سارة معدل',-5000,true,NULL
    );
    RAISE EXCEPTION 'Protected customer settings unexpectedly succeeded without BIN';
  EXCEPTION WHEN SQLSTATE 'P4004' THEN NULL;
  END;

  v_result:=public.sarah_ai_update_customer_protected_settings(
    '70000000-0000-4000-8000-000000000004',
    v_code,'عميل اختبار سارة معدل',-5000,true,'1234'
  );
  IF v_result->>'ok'<>'true'
     OR (v_result->>'debt_limit_minor')::bigint<>-5000
     OR (v_result->>'charger_fee_exempt')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Protected customer settings did not apply through the canonical path: %',v_result;
  END IF;

  v_payload:=public.test_sarah_customer_change_payload(v_customer_id);
  IF v_payload ? 'bin'
     OR v_payload->>'debtLimitMinor'<>'-5000'
     OR v_payload->>'chargerFeeExempt'<>'true' THEN
    RAISE EXCEPTION 'Protected customer change-log payload was not safely redacted: %',v_payload;
  END IF;
  v_replay:=public.sarah_ai_update_customer_protected_settings(
    '70000000-0000-4000-8000-000000000004',
    v_code,'عميل اختبار سارة معدل',-5000,true,NULL
  );
  IF v_replay->>'idempotent_replay'<>'true' THEN
    RAISE EXCEPTION 'Protected customer setting replay did not use the saved result: %',v_replay;
  END IF;
END;
$customer_protected_settings$;
RESET ROLE;

DO $protected_settings_privacy$
BEGIN
  IF EXISTS(
    SELECT 1 FROM public.sarah_ai_action_idempotency
    WHERE request_id='70000000-0000-4000-8000-000000000004'
      AND request_payload ? 'bin'
  ) THEN
    RAISE EXCEPTION 'Raw BIN was persisted in Sarah action idempotency';
  END IF;
END;
$protected_settings_privacy$;

-- An admin with customers:edit but without granular debt-limit permission is denied.
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000002';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000002',false);
DO $customer_protected_permission_gate$
DECLARE v_lookup jsonb; v_code text;
BEGIN
  v_lookup:=public.sarah_ai_lookup_customers('عميل اختبار سارة معدل');
  v_code:=v_lookup->'matches'->0->>'customer_code';
  BEGIN
    PERFORM public.sarah_ai_update_customer_protected_settings(
      '70000000-0000-4000-8000-000000000005',
      v_code,'عميل اختبار سارة معدل',-6000,NULL,'1234'
    );
    RAISE EXCEPTION 'Admin without customers:debt-limit unexpectedly changed a protected setting';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$customer_protected_permission_gate$;
RESET ROLE;

-- Account status lookup includes inactive customers; activation/deactivation uses exact proof and both original permissions.
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000001';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000001',false);
DO $customer_account_status$
DECLARE
  v_lookup jsonb;
  v_result jsonb;
  v_code text;
  v_customer_id uuid;
BEGIN
  v_lookup:=public.sarah_ai_lookup_customer_accounts('أحمد غير نشط');
  IF v_lookup->>'match_count'<>'1'
     OR (v_lookup->'matches'->0->>'is_active')<>'false' THEN
    RAISE EXCEPTION 'Inactive customer account was not discoverable through the dedicated lookup: %',v_lookup;
  END IF;
  v_code:=v_lookup->'matches'->0->>'customer_code';
  v_customer_id:=(public.test_sarah_customer_snapshot('أحمد غير نشط')->>'id')::uuid;

  v_result:=public.sarah_ai_set_customer_active_status(
    '70000000-0000-4000-8000-000000000006',v_code,'أحمد غير نشط',true
  );
  IF v_result->>'ok'<>'true' OR v_result->>'is_active'<>'true'
     OR (public.test_sarah_customer_snapshot('أحمد غير نشط')->>'is_active')<>'true' THEN
    RAISE EXCEPTION 'Customer reactivation did not use the canonical update path: %',v_result;
  END IF;

  v_lookup:=public.sarah_ai_lookup_customer_accounts('أحمد غير نشط');
  v_result:=public.sarah_ai_set_customer_active_status(
    '70000000-0000-4000-8000-000000000007',
    v_lookup->'matches'->0->>'customer_code','أحمد غير نشط',false
  );
  IF v_result->>'ok'<>'true' OR v_result->>'is_active'<>'false'
     OR (public.test_sarah_customer_snapshot('أحمد غير نشط')->>'is_active')<>'false' THEN
    RAISE EXCEPTION 'Customer deactivation did not use the canonical update path: %',v_result;
  END IF;
END;
$customer_account_status$;
RESET ROLE;

-- Admin with customers:view/edit but without customers:deactivate cannot even look up inactive accounts.
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000002';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000002',false);
DO $customer_account_status_permission_gate$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_lookup_customer_accounts('أحمد غير نشط');
    RAISE EXCEPTION 'Admin without customers:deactivate unexpectedly looked up inactive customer accounts';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$customer_account_status_permission_gate$;
RESET ROLE;

-- An ordinary admin without customers:create cannot create a customer through Sarah.
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000009';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000009',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000009',false);
DO $customer_create_permission_gate$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_create_customer(
      '70000000-0000-4000-8000-000000000002','غير مصرح',NULL
    );
    RAISE EXCEPTION 'Admin without customers:create unexpectedly created a customer';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$customer_create_permission_gate$;
RESET ROLE;


-- Seed financial balances as the fixture owner; browser roles never write these tables directly.
INSERT INTO public.financial_ledger(customer_id,amount_minor)
VALUES
 ('aaaa0000-0000-4000-8000-000000000001',1234),
 ('aaaa0000-0000-4000-8000-000000000003',-1500);
UPDATE public.customers SET debt_limit_minor=-1000
WHERE id='aaaa0000-0000-4000-8000-000000000003';

-- Manager has ai:use + customer/order permissions, but no settings:manage.
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000002';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000002',false);
DO $manager_no_day$
DECLARE
  v_lookup jsonb;
  v_result jsonb;
  v_items jsonb := '[{"device_name":"شاومي","has_charger":true},{"device_name":"سماعة","has_charger":true}]'::jsonb;
  v_request uuid := '40000000-0000-4000-8000-000000000001';
BEGIN
  v_lookup:=public.sarah_ai_lookup_customers('أحمد علي');
  IF v_lookup->>'match_count'<>'1' OR v_lookup->'matches'->0->>'customer_code'<>'AAAA' THEN
    RAISE EXCEPTION 'Customer lookup did not produce the expected same-session proof';
  END IF;
  v_result:=public.sarah_ai_create_order_with_items(
    v_request,'AAAA','أحمد علي',v_items,'manager test order'
  );
  IF v_result->>'error'<>'NO_OPEN_BUSINESS_DAY' THEN
    RAISE EXCEPTION 'Manager without settings:manage unexpectedly opened a business day: %',v_result;
  END IF;
END;
$manager_no_day$;
RESET ROLE;

-- Super Admin opens today's Palestine business day through the server-owned
-- business-day path and creates an order through the canonical command boundary.
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000001';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000001',false);
DO $super_admin_create$
DECLARE
  v_lookup jsonb;
  v_result jsonb;
BEGIN
  v_lookup:=public.sarah_ai_lookup_customers('محمود سمير');
  IF v_lookup->>'match_count'<>'1' OR v_lookup->'matches'->0->>'customer_code'<>'BBBB' THEN
    RAISE EXCEPTION 'Super Admin customer lookup failed';
  END IF;

  v_result:=public.sarah_ai_get_device_catalog();
  IF v_result->>'ok'<>'true'
     OR (v_result->>'count')::integer<3
     OR NOT EXISTS(
       SELECT 1 FROM jsonb_array_elements(v_result->'devices') device
       WHERE device->>'name_ar'='فشل اختبار' AND device->>'is_active'='true'
     ) THEN
    RAISE EXCEPTION 'Permission-checked device catalog read failed: %',v_result;
  END IF;
  v_result:=public.sarah_ai_create_order_with_items(
    '40000000-0000-4000-8000-000000000002',
    'BBBB','محمود سمير',
    '[{"device_name":"شاومي","has_charger":true}]'::jsonb,
    'Super Admin day bootstrap'
  );
  IF v_result->>'ok'<>'true'
     OR v_result->>'item_count'<>'1'
     OR v_result->>'total_charge_minor'<>'10000' THEN
    RAISE EXCEPTION 'Super Admin order/day creation failed: %',v_result;
  END IF;
  -- The successful canonical order result proves the server opened the day.
END;
$super_admin_create$;
RESET ROLE;

-- The original manager retries the exact same queued request ID and payload.
-- It succeeds now that a day exists; a second replay returns the saved result.
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000002';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000002',false);
DO $manager_retry$
DECLARE
  v_items jsonb := '[{"device_name":"شاومي","has_charger":true},{"device_name":"سماعة","has_charger":true}]'::jsonb;
  v_result jsonb;
  v_replay jsonb;
  v_orders integer;
BEGIN
  v_result:=public.sarah_ai_create_order_with_items(
    '40000000-0000-4000-8000-000000000001',
    'AAAA','أحمد علي',v_items,'manager test order'
  );
  IF v_result->>'ok'<>'true'
     OR v_result->>'item_count'<>'2'
     OR v_result->>'total_charge_minor'<>'15000' THEN
    RAISE EXCEPTION 'Manager order creation did not use canonical item pricing: %',v_result;
  END IF;
  v_replay:=public.sarah_ai_create_order_with_items(
    '40000000-0000-4000-8000-000000000001',
    'AAAA','أحمد علي',v_items,'manager test order'
  );
  IF v_replay->>'ok'<>'true' OR v_replay->>'idempotent_replay'<>'true' THEN
    RAISE EXCEPTION 'Same request ID did not replay the saved successful result: %',v_replay;
  END IF;
  v_result:=public.sarah_ai_get_customer_orders('AAAA','أحمد علي',10);
  IF v_result->>'order_count'<>'1' THEN
    RAISE EXCEPTION 'Idempotent replay duplicated the order: %',v_result;
  END IF;

  v_result:=public.sarah_ai_create_order_with_items(
    '40000000-0000-4000-8000-000000000003',
    'AAAA','أحمد علي',v_items,'duplicate request'
  );
  IF v_result->>'error'<>'ORDER_ALREADY_EXISTS' THEN
    RAISE EXCEPTION 'Same-customer/day duplicate order was not blocked: %',v_result;
  END IF;

  v_result:=public.sarah_ai_get_customer_profile('AAAA','أحمد علي');
  IF v_result->>'match_count'<>'1'
     OR v_result->'matches'->0->>'customer_name'<>'أحمد علي' THEN
    RAISE EXCEPTION 'Same-session lookup proof did not permit bounded profile read';
  END IF;

  v_result:=public.sarah_ai_get_customer_financial_summary('AAAA','أحمد علي');
  IF v_result->>'balance_minor'<>'1234' OR v_result->>'currency'<>'ILS' THEN
    RAISE EXCEPTION 'Authoritative customer balance read failed: %',v_result;
  END IF;

  v_result:=public.sarah_ai_get_customer_financial_history('AAAA','أحمد علي',20);
  IF v_result->>'match_count'<>'1'
     OR (v_result->>'entry_count')::integer<1
     OR v_result->'entries'->0->>'event_type'<>'PAYMENT'
     OR v_result->'entries'->0->>'amount_minor'<>'1234'
     OR v_result->>'currency'<>'ILS' THEN
    RAISE EXCEPTION 'Bounded authoritative financial history read failed: %',v_result;
  END IF;

  v_result:=public.sarah_ai_get_customer_orders('AAAA','أحمد علي',10);
  IF v_result->>'order_count'<>'1'
     OR v_result->'orders'->0->>'order_number' IS NULL
     OR jsonb_array_length(v_result->'orders'->0->'items')<>2
     OR v_result->'orders'->0->>'order_id' IS NULL
     OR v_result->'orders'->0->'items'->0->>'item_id' IS NULL
     OR v_result->'orders'->0->'items'->0->>'item_version' IS NULL THEN
    RAISE EXCEPTION 'Bounded customer order read did not expose verified lifecycle target IDs: %',v_result;
  END IF;

  v_result:=public.sarah_ai_execute_order_action(
    '40000000-0000-4000-8000-000000000011',
    'AAAA','أحمد علي',
    (v_result->'orders'->0->'items'->0->>'item_id')::uuid,
    'DELIVER_ITEM','1234',NULL
  );
  IF v_result->>'ok'<>'true'
     OR v_result->>'action'<>'DELIVER_ITEM'
     OR NOT EXISTS(
       SELECT 1 FROM public.sarah_ai_test_order_actions
       WHERE command_id='40000000-0000-4000-8000-000000000011'
         AND command_type='DELIVER_ORDER_ITEM'
         AND payload->>'bin'='1234'
     ) THEN
    RAISE EXCEPTION 'Sarah delivery action did not invoke canonical command with separate BIN: %',v_result;
  END IF;

  v_result:=public.sarah_ai_execute_order_action(
    '40000000-0000-4000-8000-000000000012',
    'AAAA','أحمد علي',
    (v_result->>'target_id')::uuid,
    'CANCEL_ITEM','1234','customer requested cancellation'
  );
  IF v_result->>'ok'<>'true' THEN
    RAISE EXCEPTION 'Sarah item cancellation did not invoke canonical command: %',v_result;
  END IF;

  v_result:=public.sarah_ai_get_customer_orders('AAAA','أحمد علي',10);
  v_result:=public.sarah_ai_execute_order_action(
    '40000000-0000-4000-8000-000000000013',
    'AAAA','أحمد علي',
    (v_result->'orders'->0->>'order_id')::uuid,
    'CANCEL_ORDER','1234','cancel whole order'
  );
  IF v_result->>'ok'<>'true' THEN
    RAISE EXCEPTION 'Sarah whole-order cancellation did not invoke canonical command: %',v_result;
  END IF;
END;
$manager_retry$;
RESET ROLE;

-- Payment entry and review stay inside the existing pending-submission workflow.
INSERT INTO public.qr_payment_submissions(
  id,customer_id,amount_minor,status,payment_method,submission_source,note
)
VALUES(
  '50000000-0000-4000-8000-000000000001',
  'aaaa0000-0000-4000-8000-000000000001',
  3000,'PENDING','JAWALPAY','CUSTOMER_JAWAL_PAY','pending test submission'
);

-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000002';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000002',false);
DO $payment_record_and_approve$
DECLARE
  v_result jsonb;
  v_replay jsonb;
BEGIN
  PERFORM public.sarah_ai_lookup_customers('أحمد علي');
  v_result:=public.sarah_ai_record_and_approve_payment(
    '40000000-0000-4000-8000-000000000008','AAAA','أحمد علي',2000,'manual cash payment',NULL
  );
  IF v_result->>'requires_bin'<>'true' OR v_result->>'status'<>'AWAITING_BIN' THEN
    RAISE EXCEPTION 'Payment did not persist a pending secure-confirmation intent: %',v_result;
  END IF;

  BEGIN
    PERFORM public.sarah_ai_record_and_approve_payment(
      '40000000-0000-4000-8000-000000000008','AAAA','أحمد علي',2500,'manual cash payment','1234'
    );
    RAISE EXCEPTION 'Payment confirmation unexpectedly accepted changed amount';
  EXCEPTION WHEN SQLSTATE 'P0409' THEN NULL;
  END;

  BEGIN
    PERFORM public.sarah_ai_record_and_approve_payment(
      '40000000-0000-4000-8000-000000000008','AAAA','أحمد علي',2000,'manual cash payment','0000'
    );
    RAISE EXCEPTION 'Payment creation unexpectedly accepted invalid BIN';
  EXCEPTION WHEN SQLSTATE 'P0003' THEN NULL;
  END;

  v_result:=public.sarah_ai_record_and_approve_payment(
    '40000000-0000-4000-8000-000000000008','AAAA','أحمد علي',2000,'manual cash payment','1234'
  );
  IF v_result->>'ok'<>'true'
     OR v_result->>'status'<>'APPROVED'
     OR v_result->>'amount_minor'<>'2000'
     OR v_result->>'balance_after_minor'<>'3234' THEN
    RAISE EXCEPTION 'BIN-gated payment record/approval failed: %',v_result;
  END IF;

  v_replay:=public.sarah_ai_record_and_approve_payment(
    '40000000-0000-4000-8000-000000000008','AAAA','أحمد علي',2000,'manual cash payment','9999'
  );
  IF v_replay->>'ok'<>'true' OR v_replay->>'idempotent_replay'<>'true' THEN
    RAISE EXCEPTION 'Successful payment was not safely replayed: %',v_replay;
  END IF;

  v_result:=public.sarah_ai_review_payment_submission(
    '40000000-0000-4000-8000-000000000009',
    '50000000-0000-4000-8000-000000000001',
    'REJECT',NULL,'receipt mismatch',NULL
  );
  IF v_result->>'ok'<>'true' OR v_result->>'status'<>'REJECTED' THEN
    RAISE EXCEPTION 'Payment rejection did not use the canonical review path: %',v_result;
  END IF;
END;
$payment_record_and_approve$;
RESET ROLE;

DO $payment_storage_privacy$
BEGIN
  IF (SELECT count(*) FROM public.qr_payment_submissions
      WHERE customer_id='aaaa0000-0000-4000-8000-000000000001'
        AND status='APPROVED' AND amount_minor=2000)<>1 THEN
    RAISE EXCEPTION 'Payment retry created more than one approved submission';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.sarah_ai_action_idempotency
    WHERE request_id='40000000-0000-4000-8000-000000000008'
      AND request_payload ? 'bin'
  ) THEN
    RAISE EXCEPTION 'Raw BIN must never be persisted in action idempotency data';
  END IF;
  IF (SELECT status FROM public.qr_payment_submissions
      WHERE id='50000000-0000-4000-8000-000000000001')<>'REJECTED' THEN
    RAISE EXCEPTION 'Rejected payment submission status was not persisted';
  END IF;
END;
$payment_storage_privacy$;

-- Goal actions reuse the app's 28-day activity-based proposal generator and canonical goal commands.
UPDATE public.order_items
SET status='delivered',operational_status='DELIVERED',financial_status='RECOGNIZED',delivered_at=now()
WHERE id=(SELECT id FROM public.order_items ORDER BY item_sequence,id LIMIT 1);

INSERT INTO public.goal_requests(id,customer_id,requested_target,status)
VALUES
 ('60000000-0000-4000-8000-000000000003','aaaa0000-0000-4000-8000-000000000003',12,'PENDING'),
 ('60000000-0000-4000-8000-000000000005','aaaa0000-0000-4000-8000-000000000004',10,'PENDING');

-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000008';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000008',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000008',false);

DO $goal_capability_reads$
DECLARE
  v_proposal jsonb;
BEGIN
  v_proposal:=public.sarah_ai_get_goal_proposal('aaaa0000-0000-4000-8000-000000000001');
  IF (v_proposal->>'target_quantity')::integer<10
     OR (v_proposal->>'duration_days')::integer NOT BETWEEN 5 AND 15
     OR (v_proposal->>'bonus_amount_minor')::bigint<150
     OR (v_proposal->>'bonus_amount_minor')::bigint>
        (v_proposal->>'target_quantity')::bigint*20
     OR v_proposal->>'profile_days'<>'28' THEN
    RAISE EXCEPTION 'Server goal proposal does not match the app goal generator policy: %',v_proposal;
  END IF;
END;
$goal_capability_reads$;

DO $goal_capability_actions$
DECLARE
  v_result jsonb;
  v_created_goal_id uuid;
  v_approved_goal_id uuid;
  v_request_id uuid := '60000000-0000-4000-8000-000000000001';
BEGIN
  v_result:=public.sarah_ai_execute_goal_action(
    '60000000-0000-4000-8000-000000000002','CREATE_GOAL',
    'aaaa0000-0000-4000-8000-000000000001',NULL,NULL,NULL,NULL,NULL,NULL,NULL
  );
  IF v_result->>'ok'<>'true'
     OR v_result->>'target_quantity' IS NULL
     OR v_result->>'duration_days' IS NULL
     OR v_result->>'bonus_amount_minor' IS NULL THEN
    RAISE EXCEPTION 'Sarah did not create a generated customer goal through the canonical command: %',v_result;
  END IF;
  v_created_goal_id:=(v_result->>'goal_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.goals WHERE id=v_created_goal_id AND status='ACTIVE') THEN
    RAISE EXCEPTION 'Generated goal was not persisted as ACTIVE';
  END IF;

  v_result:=public.sarah_ai_execute_goal_action(
    '60000000-0000-4000-8000-000000000004','APPROVE_GOAL_REQUEST',
    NULL,'60000000-0000-4000-8000-000000000003',NULL,NULL,NULL,NULL,NULL,NULL
  );
  IF v_result->>'ok'<>'true'
     OR v_result->>'action'<>'APPROVE_GOAL_REQUEST'
     OR NOT EXISTS(SELECT 1 FROM public.goal_requests WHERE id='60000000-0000-4000-8000-000000000003' AND status='APPROVED') THEN
    RAISE EXCEPTION 'Sarah did not approve the goal request through the canonical command: %',v_result;
  END IF;
  SELECT resulting_goal_id INTO v_approved_goal_id FROM public.goal_requests
  WHERE id='60000000-0000-4000-8000-000000000003';

  v_result:=public.sarah_ai_execute_goal_action(
    '60000000-0000-4000-8000-000000000006','REJECT_GOAL_REQUEST',
    NULL,'60000000-0000-4000-8000-000000000005',NULL,NULL,NULL,NULL,'not suitable',NULL
  );
  IF v_result->>'ok'<>'true'
     OR NOT EXISTS(SELECT 1 FROM public.goal_requests WHERE id='60000000-0000-4000-8000-000000000005' AND status='REJECTED') THEN
    RAISE EXCEPTION 'Sarah did not reject the goal request through the canonical command: %',v_result;
  END IF;

  v_result:=public.sarah_ai_execute_goal_action(
    '60000000-0000-4000-8000-000000000007','UPDATE_GOAL_CONFIG',
    NULL,v_created_goal_id,15,10,200,1,NULL,NULL
  );
  IF v_result->>'ok'<>'true'
     OR NOT EXISTS(SELECT 1 FROM public.goals WHERE id=v_created_goal_id AND target_quantity=15 AND duration_days=10 AND bonus_amount_minor=200) THEN
    RAISE EXCEPTION 'Sarah did not update goal configuration through the canonical command: %',v_result;
  END IF;

  v_result:=public.sarah_ai_execute_goal_action(
    '60000000-0000-4000-8000-000000000008','CANCEL_GOAL',
    NULL,v_created_goal_id,NULL,NULL,NULL,NULL,'admin cancellation',NULL
  );
  IF v_result->>'ok'<>'true'
     OR NOT EXISTS(SELECT 1 FROM public.goals WHERE id=v_created_goal_id AND status='CANCELLED') THEN
    RAISE EXCEPTION 'Sarah did not cancel the goal through the existing admin RPC: %',v_result;
  END IF;

  v_result:=public.sarah_ai_execute_goal_action(
    '60000000-0000-4000-8000-000000000009','REVIEW_GOAL_CANCELLATION',
    NULL,v_approved_goal_id,NULL,NULL,NULL,NULL,'review test',true
  );
  IF v_result->>'ok'<>'true' THEN
    RAISE EXCEPTION 'Sarah did not route cancellation review to the existing admin RPC: %',v_result;
  END IF;
END;
$goal_capability_actions$;
RESET ROLE;

-- Ordinary admin without goals:manage cannot use Sarah to create a goal.
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000007';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000007',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000007',false);
DO $goal_permission_gate$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_execute_goal_action(
      '60000000-0000-4000-8000-000000000010','CREATE_GOAL',
      'aaaa0000-0000-4000-8000-000000000001',NULL,NULL,NULL,NULL,NULL,NULL,NULL
    );
    RAISE EXCEPTION 'Admin without goals:manage unexpectedly created a goal';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$goal_permission_gate$;
RESET ROLE;

-- A live financial/order permission does not replace customers:view.
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000008';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000008',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000008',false);
DO $customer_visibility_gate$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_get_customer_financial_summary('AAAA','أحمد علي');
    RAISE EXCEPTION 'Financial visibility permission bypassed missing customers:view';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.sarah_ai_get_customer_orders('AAAA','أحمد علي',10);
    RAISE EXCEPTION 'Order view permission bypassed missing customers:view';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.sarah_ai_execute_order_action(
      '70000000-0000-4000-8000-000000000001',
      'AAAA','أحمد علي',
      '30000000-0000-4000-8000-000000000001',
      'DELIVER_ITEM','1234',NULL
    );
    RAISE EXCEPTION 'Order lifecycle permission bypassed missing customers:view';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$customer_visibility_gate$;
RESET ROLE;

-- A different Auth session for the same user cannot reuse the old lookup proof.
UPDATE public.account_sessions
SET revoked_at=now()
WHERE session_id='20000000-0000-4000-8000-000000000002';
INSERT INTO auth.sessions(id,user_id,created_at,not_after,user_agent)
VALUES('20000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000002',now(),NULL,'second session');
INSERT INTO public.account_sessions(session_id,user_id,revoked_at,session_expires_at)
VALUES('20000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000002',NULL,now()+interval '7 days');
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000002';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000010',false);
DO $session_proof_isolation$
DECLARE v_result jsonb;
BEGIN
  v_result:=public.sarah_ai_get_customer_profile('AAAA','أحمد علي');
  IF v_result->>'match_count'<>'0' THEN
    RAISE EXCEPTION 'A different Auth session reused another session lookup proof';
  END IF;

  v_result:=public.sarah_ai_record_and_approve_payment(
    '40000000-0000-4000-8000-000000000008',
    'AAAA','أحمد علي',2000,'manual cash payment',NULL
  );
  IF v_result->>'ok'<>'true' OR v_result->>'idempotent_replay'<>'true' THEN
    RAISE EXCEPTION 'Same-account session renewal did not safely replay the completed payment: %',v_result;
  END IF;
END;
$session_proof_isolation$;
RESET ROLE;

-- Ordinary admin cannot create orders without every original permission.
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000007';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000007',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000007',false);
DO $missing_order_edit$
BEGIN
  PERFORM public.sarah_ai_lookup_customers('أحمد يوسف');
  BEGIN
    PERFORM public.sarah_ai_create_order_with_items(
      '40000000-0000-4000-8000-000000000007',
      'AAAA','أحمد يوسف',
      '[{"device_name":"شاومي","has_charger":true}]'::jsonb,
      NULL
    );
    RAISE EXCEPTION 'Admin without orders:edit unexpectedly created an order';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$missing_order_edit$;
RESET ROLE;

-- Debt-limit enforcement remains server-side and the original override permission
-- is honored only after it is granted.
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000002';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000010',false);
DO $debt_limit$
DECLARE v_result jsonb;
BEGIN
  PERFORM public.sarah_ai_lookup_customers('أحمد سمير');
  v_result:=public.sarah_ai_create_order_with_items(
    '40000000-0000-4000-8000-000000000004',
    'AAAA','أحمد سمير',
    '[{"device_name":"شاومي","has_charger":true}]'::jsonb,
    NULL
  );
  IF v_result->>'error'<>'DEBT_LIMIT_EXCEEDED' THEN
    RAISE EXCEPTION 'Debt limit was not enforced: %',v_result;
  END IF;
END;
$debt_limit$;
RESET ROLE;
INSERT INTO public.admin_custom_permissions(admin_id,permission,is_grant)
VALUES('00000000-0000-4000-8000-000000000002','orders:override-debt-limit',true);
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000002';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000010',false);
DO $debt_override$
DECLARE v_result jsonb;
BEGIN
  v_result:=public.sarah_ai_create_order_with_items(
    '40000000-0000-4000-8000-000000000004',
    'AAAA','أحمد سمير',
    '[{"device_name":"شاومي","has_charger":true}]'::jsonb,
    NULL
  );
  IF v_result->>'ok'<>'true' THEN
    RAISE EXCEPTION 'Granted debt-limit override was not honored: %',v_result;
  END IF;
END;
$debt_override$;
RESET ROLE;

-- Failure in a later item must roll back the order and every earlier item.
-- Isolate this scenario from earlier test actors' hourly tool quota.
DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000009';
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000009',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000009',false);
DO $atomic_rollback$
DECLARE
  v_result jsonb;
  v_order_id uuid := '40000000-0000-4000-8000-000000000005';
BEGIN
  PERFORM public.sarah_ai_lookup_customers('أحمد حسن');
  BEGIN
    v_result:=public.sarah_ai_create_order_with_items(
      v_order_id,'AAAA','أحمد حسن',
      '[{"device_name":"شاومي","has_charger":true},{"device_name":"FAIL","has_charger":true}]'::jsonb,
      NULL
    );
    RAISE EXCEPTION 'Order creation returned without simulated item failure: %',v_result;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='Simulated canonical item failure' THEN
      NULL;
    ELSE
      RAISE;
    END IF;
  END;
  v_result:=public.sarah_ai_get_customer_orders('AAAA','أحمد حسن',10);
  IF v_result->>'order_count'<>'0' THEN
    RAISE EXCEPTION 'Partial order/item data survived a failed atomic create: %',v_result;
  END IF;
END;
$atomic_rollback$;
RESET ROLE;

DO $admin_read_privileges$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.sarah_ai_customer_lookup_proofs'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.sarah_ai_action_idempotency'::regclass) THEN
    RAISE EXCEPTION 'Sarah proof/idempotency tables must have RLS enabled';
  END IF;
  IF has_table_privilege('authenticated','public.sarah_ai_customer_lookup_proofs','SELECT')
     OR has_table_privilege('authenticated','public.sarah_ai_action_idempotency','SELECT')
     OR has_table_privilege('service_role','public.sarah_ai_action_idempotency','SELECT') THEN
    RAISE EXCEPTION 'Internal proof/idempotency tables must not be directly readable';
  END IF;
  IF NOT has_function_privilege('authenticated','public.sarah_ai_get_customer_financial_summary(text,text)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.sarah_ai_get_customer_orders(text,text,integer)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.sarah_ai_create_order_with_items(uuid,text,text,jsonb,text)','EXECUTE')
     OR has_function_privilege('anon','public.sarah_ai_create_order_with_items(uuid,text,text,jsonb,text)','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_create_order_with_items(uuid,text,text,jsonb,text)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.sarah_ai_record_and_approve_payment(uuid,text,text,bigint,text,text)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.sarah_ai_review_payment_submission(uuid,uuid,text,bigint,text,text)','EXECUTE')
     OR has_function_privilege('anon','public.sarah_ai_record_and_approve_payment(uuid,text,text,bigint,text,text)','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_record_and_approve_payment(uuid,text,text,bigint,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Sarah admin read/order RPC grants are incorrect';
  END IF;
END;
$admin_read_privileges$;


-- A short name fragment and a shared four-character code must never select an arbitrary customer.
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000001',false);
DO $customer_target_ambiguity$
DECLARE
  v_lookup jsonb;
  v_code text;
BEGIN
  v_lookup:=public.sarah_ai_lookup_customers('أحمد');
  IF COALESCE((v_lookup->>'match_count')::integer,0)<2 THEN
    RAISE EXCEPTION 'Ambiguity fixture must contain multiple Ahmed matches: %',v_lookup;
  END IF;
  v_code:=v_lookup->'matches'->0->>'customer_code';

  BEGIN
    PERFORM public.sarah_ai_update_customer_profile(
      '70000000-0000-4000-8000-000000000008',v_code,'أحمد',NULL,NULL,'must not be applied'
    );
    RAISE EXCEPTION 'Ambiguous basic profile target unexpectedly selected';
  EXCEPTION WHEN SQLSTATE 'P0409' THEN NULL;
  END;

  BEGIN
    PERFORM public.sarah_ai_update_customer_protected_settings(
      '70000000-0000-4000-8000-000000000009',v_code,'أحمد',-3000,NULL,'1234'
    );
    RAISE EXCEPTION 'Ambiguous protected settings target unexpectedly selected';
  EXCEPTION WHEN SQLSTATE 'P0409' THEN NULL;
  END;

  v_lookup:=public.sarah_ai_lookup_customer_accounts('أحمد');
  v_code:=v_lookup->'matches'->0->>'customer_code';
  BEGIN
    PERFORM public.sarah_ai_set_customer_active_status(
      '70000000-0000-4000-8000-000000000010',v_code,'أحمد',true
    );
    RAISE EXCEPTION 'Ambiguous account status target unexpectedly selected';
  EXCEPTION WHEN SQLSTATE 'P0409' THEN NULL;
  END;
END;
$customer_target_ambiguity$;
RESET ROLE;

-- Canonical change-log writes and existing rows must never retain credentials.
DO $change_log_redaction$
DECLARE
  v_payload jsonb;
  v_new_id uuid := '99000000-0000-4000-8000-000000000002';
BEGIN
  SELECT payload INTO v_payload
  FROM public.change_log
  WHERE entity_id='99000000-0000-4000-8000-000000000001'
    AND action='UPDATE'
  ORDER BY sequence_id DESC LIMIT 1;
  IF v_payload ? 'bin' OR v_payload ? 'apiKey'
     OR COALESCE(v_payload->'meta' ? 'adminBin',false)
     OR v_payload->'meta'->>'safe'<>'keep' THEN
    RAISE EXCEPTION 'Historical change-log secret redaction failed: %',v_payload;
  END IF;

  PERFORM public.record_canonical_change(
    'customers',v_new_id,'UPDATE',
    '{"name":"future redaction fixture","bin":"9999","meta":{"password":"do-not-keep","safe":"preserved"}}'::jsonb,
    1
  );
  SELECT payload INTO v_payload
  FROM public.change_log
  WHERE entity_id=v_new_id AND action='UPDATE'
  ORDER BY sequence_id DESC LIMIT 1;
  IF v_payload ? 'bin'
     OR COALESCE(v_payload->'meta' ? 'password',false)
     OR v_payload->'meta'->>'safe'<>'preserved' THEN
    RAISE EXCEPTION 'New canonical change-log secret redaction failed: %',v_payload;
  END IF;
END;
$change_log_redaction$;
