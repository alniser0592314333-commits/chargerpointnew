-- Session-bound customer reads and atomic Sarah order creation.
-- Run after the provider, quota, lookup, profile, and admin-read migrations plus fixture.

-- Seed financial balances as the fixture owner; browser roles never write these tables directly.
INSERT INTO public.financial_ledger(customer_id,amount_minor)
VALUES
 ('aaaa0000-0000-4000-8000-000000000001',1234),
 ('aaaa0000-0000-4000-8000-000000000003',-1500);
UPDATE public.customers SET debt_limit_minor=-1000
WHERE id='aaaa0000-0000-4000-8000-000000000003';

-- Manager has ai:use + customer/order permissions, but no settings:manage.
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
  IF NOT EXISTS (
    SELECT 1 FROM public.business_days
    WHERE business_date=(now() AT TIME ZONE 'Asia/Jerusalem')::date
      AND status='OPEN' AND is_closed IS FALSE
  ) THEN
    RAISE EXCEPTION 'Current Palestine business day was not opened';
  END IF;
END;
$super_admin_create$;
RESET ROLE;

-- The original manager retries the exact same queued request ID and payload.
-- It succeeds now that a day exists; a second replay returns the saved result.
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
  SELECT count(*) INTO v_orders FROM public.orders WHERE customer_id='aaaa0000-0000-4000-8000-000000000001';
  IF v_orders<>1 THEN RAISE EXCEPTION 'Expected exactly one order for this customer/day'; END IF;

  v_replay:=public.sarah_ai_create_order_with_items(
    '40000000-0000-4000-8000-000000000001',
    'AAAA','أحمد علي',v_items,'manager test order'
  );
  IF v_replay->>'ok'<>'true' OR v_replay->>'idempotent_replay'<>'true' THEN
    RAISE EXCEPTION 'Same request ID did not replay the saved successful result: %',v_replay;
  END IF;
  SELECT count(*) INTO v_orders FROM public.orders WHERE customer_id='aaaa0000-0000-4000-8000-000000000001';
  IF v_orders<>1 THEN RAISE EXCEPTION 'Idempotent replay duplicated the order'; END IF;

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

  v_result:=public.sarah_ai_get_customer_orders('AAAA','أحمد علي',10);
  IF v_result->>'order_count'<>'1'
     OR v_result->'orders'->0->>'order_number' IS NULL
     OR jsonb_array_length(v_result->'orders'->0->'items')<>2 THEN
    RAISE EXCEPTION 'Bounded customer order read failed: %',v_result;
  END IF;
END;
$manager_retry$;
RESET ROLE;

-- A different Auth session for the same user cannot reuse the old lookup proof.
INSERT INTO auth.sessions(id,user_id,created_at,not_after,user_agent)
VALUES('20000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000002',now(),NULL,'second session');
INSERT INTO public.account_sessions(session_id,user_id,revoked_at,session_expires_at)
VALUES('20000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000002',NULL,now()+interval '7 days');
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
END;
$session_proof_isolation$;
RESET ROLE;

-- Ordinary admin cannot create orders without every original permission.
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
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000002',false);
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
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000002',false);
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
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000002',false);
DO $atomic_rollback$
DECLARE
  v_result jsonb;
  v_order_id uuid := '40000000-0000-4000-8000-000000000005';
BEGIN
  PERFORM public.sarah_ai_lookup_customers('أحمد خالد');
  BEGIN
    PERFORM public.sarah_ai_create_order_with_items(
      v_order_id,'AAAA','أحمد خالد',
      '[{"device_name":"شاومي","has_charger":true},{"device_name":"فشل اختبار","has_charger":true}]'::jsonb,
      NULL
    );
    RAISE EXCEPTION 'Simulated canonical item failure did not abort the order';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='Simulated canonical item failure' THEN
      NULL;
    ELSE
      RAISE;
    END IF;
  END;
  IF EXISTS(SELECT 1 FROM public.orders WHERE id=v_order_id)
     OR EXISTS(SELECT 1 FROM public.order_items WHERE order_id=v_order_id) THEN
    RAISE EXCEPTION 'Partial order/item data survived a failed atomic create';
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
     OR has_function_privilege('service_role','public.sarah_ai_create_order_with_items(uuid,text,text,jsonb,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Sarah admin read/order RPC grants are incorrect';
  END IF;
END;
$admin_read_privileges$;
