-- Runtime contract tests for public_resolve_customer_portal, isolated from production.
DO $test$
DECLARE
  v_customer uuid := '11111111-1111-4111-8111-111111111111';
  v_other uuid := '22222222-2222-4222-8222-222222222222';
  v_order uuid := '33333333-3333-4333-8333-333333333333';
  v_item uuid := '44444444-4444-4444-8444-444444444444';
  v_bonus_ledger uuid := '55555555-5555-4555-8555-555555555555';
  v_pending uuid := '66666666-6666-4666-8666-666666666666';
  v_approved uuid := '77777777-7777-4777-8777-777777777777';
  v_payment uuid := '88888888-8888-4888-8888-888888888888';
  v_result jsonb;
BEGIN
  INSERT INTO public.customers(id, name) VALUES (v_customer, 'Synthetic Customer'), (v_other, 'Must Never Leak');
  INSERT INTO public.qr_tokens(public_token, token_type, target_id, is_active)
    VALUES ('CustomerToken-0123456789ABCDEF', 'CUSTOMER', v_customer, true),
           ('OrderToken-0123456789ABCDEF', 'ORDER', v_order, true),
           ('RevokedToken-0123456789ABCDEF', 'CUSTOMER', v_customer, false),
           ('ExpiredToken-0123456789ABCDEF', 'CUSTOMER', v_customer, true);
  UPDATE public.qr_tokens SET expires_at = now() - interval '1 minute' WHERE public_token = 'ExpiredToken-0123456789ABCDEF';
  INSERT INTO public.financial_ledger(id, customer_id, amount_minor)
    VALUES ('99999999-9999-4999-8999-999999999999', v_customer, -500),
           (v_bonus_ledger, v_customer, 150),
           ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', v_other, -9000);
  INSERT INTO public.orders(id, customer_id, display_number, status)
    VALUES (v_order, v_customer, 17, 'قيد الشحن');
  INSERT INTO public.device_types(id, name, name_ar, name_en)
    VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Phone', 'هاتف', 'Phone');
  INSERT INTO public.order_items(
    id, order_id, device_type_id, item_sequence, operational_status, financial_status,
    financially_recognized_at, payment_status, device_name_snapshot, has_charger, final_charge_snapshot_minor
  ) VALUES (
    v_item, v_order, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1, 'CHARGING', 'RECOGNIZED',
    now(), 'PARTIAL', 'Phone', true, 1200
  );
  INSERT INTO public.payment_allocations(order_item_id, allocated_amount_minor) VALUES (v_item, 200);
  INSERT INTO public.payments(id, amount_minor) VALUES (v_payment, 400);
  INSERT INTO public.qr_payment_submissions(id, customer_id, order_id, status, payment_method, created_at, amount_minor, payment_id)
    VALUES (v_pending, v_customer, v_order, 'PENDING', 'PALPAY', now(), 0, NULL),
           (v_approved, v_customer, v_order, 'APPROVED', 'PALPAY', now() - interval '1 day', 400, v_payment);
  INSERT INTO public.goals(id, customer_id, target_quantity, current_progress, status, completed_at, bonus_ledger_id, bonus_amount_minor)
    VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', v_customer, 10, 10, 'COMPLETED', now(), v_bonus_ledger, 150);

  v_result := public.public_resolve_customer_portal('CustomerToken-0123456789ABCDEF');
  IF v_result IS NULL THEN RAISE EXCEPTION 'valid customer QR did not resolve'; END IF;
  IF v_result->>'customer_name' <> 'Synthetic Customer' THEN RAISE EXCEPTION 'wrong customer identity'; END IF;
  IF (v_result->>'balance_minor')::bigint <> -350 THEN RAISE EXCEPTION 'incorrect authoritative balance'; END IF;
  IF jsonb_array_length(v_result->'orders') <> 1 THEN RAISE EXCEPTION 'wrong customer order scope'; END IF;
  IF (v_result->'orders'->0->>'order_number')::integer <> 17 THEN RAISE EXCEPTION 'wrong order returned'; END IF;
  IF (v_result->'orders'->0->>'total_minor')::bigint <> 1200 THEN RAISE EXCEPTION 'wrong order total'; END IF;
  IF (v_result->'orders'->0->>'due_minor')::bigint <> 1000 THEN RAISE EXCEPTION 'wrong order due'; END IF;
  IF jsonb_array_length(v_result->'payment_submissions') <> 2 THEN RAISE EXCEPTION 'payment history missing'; END IF;
  IF v_result->'payment_submissions'->0->>'status' <> 'PENDING'
     OR v_result->'payment_submissions'->0->'amount_minor' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'pending receipt must not be presented as an approved payment';
  END IF;
  IF (v_result->'goals'->0->>'bonus_recorded')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'ledger-confirmed goal bonus not exposed';
  END IF;
  IF v_result ?| ARRAY['customer_id','phone','notes','receipt_url','admin_id','bin_hash'] THEN
    RAISE EXCEPTION 'private field leaked in customer portal projection';
  END IF;

  IF public.public_resolve_customer_portal('OrderToken-0123456789ABCDEF') IS NOT NULL THEN
    RAISE EXCEPTION 'order QR must not resolve customer portal';
  END IF;
  IF public.public_resolve_customer_portal('RevokedToken-0123456789ABCDEF') IS NOT NULL THEN
    RAISE EXCEPTION 'revoked QR must not resolve';
  END IF;
  IF public.public_resolve_customer_portal('ExpiredToken-0123456789ABCDEF') IS NOT NULL THEN
    RAISE EXCEPTION 'expired QR must not resolve';
  END IF;
  IF public.public_resolve_customer_portal('InvalidToken') IS NOT NULL THEN
    RAISE EXCEPTION 'invalid QR must not resolve';
  END IF;
  IF has_table_privilege('anon', 'public.customers', 'SELECT') THEN
    RAISE EXCEPTION 'anon must not gain direct customer table access';
  END IF;
  IF NOT has_function_privilege('anon', 'public.public_resolve_customer_portal(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'explicit scoped RPC grant missing';
  END IF;
END
$test$;
