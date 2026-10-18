BEGIN;

DO $test$
DECLARE
  v_customer_id uuid := gen_random_uuid();
  v_order_id uuid := gen_random_uuid();
  v_item_id uuid := gen_random_uuid();
  v_payment_id uuid := gen_random_uuid();
  v_token text := repeat('q', 32);
  v_result jsonb;
BEGIN
  INSERT INTO public.customers (id, name, status, is_active)
  VALUES (v_customer_id, 'QR partial payment regression', 'ACTIVE', true);

  INSERT INTO public.orders (id, customer_id, display_number, status)
  VALUES (v_order_id, v_customer_id, 987654, 'DELIVERED');

  INSERT INTO public.qr_tokens (public_token, token_type, target_id, is_active)
  VALUES (v_token, 'ORDER', v_order_id, true);

  INSERT INTO public.order_items (
    id, order_id, item_sequence, device_name_snapshot, status, operational_status,
    financial_status, financially_recognized_at, payment_status, final_charge_snapshot_minor
  ) VALUES (
    v_item_id, v_order_id, 1, 'Regression device', 'DELIVERED', 'DELIVERED',
    'RECOGNIZED', now(), 'PARTIALLY_PAID', 5000
  );

  INSERT INTO public.payments (
    id, customer_id, amount_minor, payment_method, command_id
  ) VALUES (
    v_payment_id, v_customer_id, 2000, 'BANK_OF_PALESTINE', gen_random_uuid()
  );

  INSERT INTO public.payment_allocations (
    payment_id, order_item_id, order_id, allocated_amount_minor
  ) VALUES (v_payment_id, v_item_id, v_order_id, 2000);

  -- Deliberately positive account ledger balance must not be counted as payment
  -- against this order without an order-specific allocation.
  INSERT INTO public.financial_ledger (event_type, amount_minor, customer_id)
  VALUES ('REGRESSION_CREDIT_FIXTURE', 10000, v_customer_id);

  SELECT result_json INTO v_result
  FROM public.public_resolve_order_qr(v_token) AS resolver(result_json);

  IF (v_result->>'order_due_minor')::bigint <> 3000 THEN
    RAISE EXCEPTION 'Expected order due 3000 from its own allocations, got %', v_result->>'order_due_minor';
  END IF;
  IF (v_result->>'order_paid_minor')::bigint <> 2000 THEN
    RAISE EXCEPTION 'Expected order paid amount 2000 from its own allocations, got %', v_result->>'order_paid_minor';
  END IF;

  UPDATE public.payments SET amount_minor = 5000 WHERE id = v_payment_id;
  INSERT INTO public.payment_allocations (
    payment_id, order_item_id, order_id, allocated_amount_minor
  ) VALUES (v_payment_id, v_item_id, v_order_id, 3000);

  SELECT result_json INTO v_result
  FROM public.public_resolve_order_qr(v_token) AS resolver(result_json);

  IF (v_result->>'order_due_minor')::bigint <> 0
     OR (v_result->>'order_paid_minor')::bigint <> 5000 THEN
    RAISE EXCEPTION 'Expected fully allocated order to report paid 5000 and due 0, got paid %, due %',
      v_result->>'order_paid_minor', v_result->>'order_due_minor';
  END IF;
END
$test$;

ROLLBACK;
