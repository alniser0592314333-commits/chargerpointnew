-- Runtime assertions for the public QR payment migration. Run only against the isolated fixture DB.
INSERT INTO public.customers (id, name, status, is_active)
VALUES ('00000000-0000-0000-0000-000000000101', 'QR Test Customer', 'ACTIVE', true);
INSERT INTO public.admins (id, auth_user_id, is_active)
VALUES ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000201', true);

INSERT INTO public.orders (id, customer_id, display_number, status)
VALUES
  ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000101', 41, 'CHARGING'),
  ('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000101', 42, 'CHARGING');

INSERT INTO public.qr_tokens (public_token, token_type, target_id, is_active)
VALUES
  ('public-token-000000000000000000000001', 'ORDER', '00000000-0000-0000-0000-000000000301', true),
  ('public-token-000000000000000000000002', 'ORDER', '00000000-0000-0000-0000-000000000302', true);

INSERT INTO public.order_items (
  id, order_id, item_sequence, device_name_snapshot, status, financial_status, payment_status,
  has_charger, customer_charger_fee_exempt_snapshot, unit_price_minor, total_price_minor,
  final_charge_snapshot_minor, created_at
)
VALUES
  ('00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000301', 1, 'Samsung', 'CHARGING', 'PENDING', 'UNPAID', true, true, 4500, 5000, 5000, '2026-10-12T10:00:00Z'),
  ('00000000-0000-0000-0000-000000000402', '00000000-0000-0000-0000-000000000301', 2, 'Xiaomi', 'CHARGING', 'PENDING', 'UNPAID', false, false, 2500, 2500, 2500, '2026-10-12T10:01:00Z'),
  ('00000000-0000-0000-0000-000000000403', '00000000-0000-0000-0000-000000000301', 3, 'Cancelled item', 'CANCELLED', 'CANCELLED', 'UNPAID', false, false, 900, 900, 900, '2026-10-12T10:02:00Z'),
  ('00000000-0000-0000-0000-000000000411', '00000000-0000-0000-0000-000000000302', 1, 'iPhone', 'CHARGING', 'PENDING', 'UNPAID', true, false, 4000, 4000, 4000, '2026-10-12T11:00:00Z');

UPDATE public.order_items SET cancelled_at = now()
WHERE id = '00000000-0000-0000-0000-000000000403';

INSERT INTO public.payments (id, customer_id, amount_minor, payment_method, reference, command_id)
VALUES ('00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000101', 1000, 'CASH', 'fixture seed', '00000000-0000-0000-0000-000000000601');
INSERT INTO public.payment_allocations (id, payment_id, order_item_id, order_id, allocated_amount_minor)
VALUES ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000301', 1000);

INSERT INTO storage.objects (bucket_id, name, metadata)
VALUES
  ('qr-payment-receipts', '00000000-0000-0000-0000-000000000301/receipt.webp', '{"mimetype":"image/webp"}'),
  ('qr-payment-receipts', '00000000-0000-0000-0000-000000000302/receipt.webp', '{"mimetype":"image/webp"}');

DO $test$
DECLARE
  v_order jsonb;
  v_item jsonb;
  v_submission jsonb;
  v_submission_id uuid;
  v_second_submission jsonb;
  v_second_id uuid;
  v_rejected boolean := false;
  v_payment_count integer;
  v_duplicate boolean := false;
BEGIN
  SELECT resolved.order_json INTO v_order
  FROM public.public_resolve_order_qr('public-token-000000000000000000000001') AS resolved(order_json);

  IF v_order IS NULL THEN RAISE EXCEPTION 'Public QR resolver returned no order'; END IF;
  IF (v_order->>'order_number')::integer <> 41 THEN RAISE EXCEPTION 'Wrong order was resolved'; END IF;
  IF (v_order->>'order_total_minor')::bigint <> 7500 THEN RAISE EXCEPTION 'Order total should exclude cancelled items'; END IF;
  IF (v_order->>'order_due_minor')::bigint <> 6500 THEN RAISE EXCEPTION 'Remaining amount should subtract actual allocations'; END IF;
  IF (v_order->>'items_count')::integer <> 2 THEN RAISE EXCEPTION 'Cancelled items must not appear in public item count'; END IF;

  SELECT value INTO v_item
  FROM jsonb_array_elements(v_order->'items') AS item(value)
  WHERE value->>'name' = 'Samsung';
  IF v_item IS NULL OR (v_item->>'charger_fee_exempt')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Recorded charger fee exemption was not exposed for the correct item';
  END IF;
  SELECT value INTO v_item
  FROM jsonb_array_elements(v_order->'items') AS item(value)
  WHERE value->>'name' = 'Xiaomi';
  IF v_item IS NULL OR (v_item->>'charger_fee_exempt')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'Charger fee exemption was incorrectly inferred';
  END IF;

  v_submission := public.submit_qr_payment(
    'public-token-000000000000000000000001', 'PALPAY',
    '00000000-0000-0000-0000-000000000301/receipt.webp', 'test note'
  );
  v_submission_id := (v_submission->>'submission_id')::uuid;
  IF (v_submission->>'amount_minor')::bigint <> 6500 THEN
    RAISE EXCEPTION 'Submitted amount must be derived from the order, not caller input';
  END IF;
  IF (SELECT status FROM public.qr_payment_submissions WHERE id = v_submission_id) <> 'PENDING' THEN
    RAISE EXCEPTION 'New submission must be pending';
  END IF;

  BEGIN
    PERFORM public.submit_qr_payment(
      'public-token-000000000000000000000001', 'PALPAY',
      '00000000-0000-0000-0000-000000000301/receipt.webp', NULL
    );
  EXCEPTION WHEN OTHERS THEN
    v_duplicate := true;
  END;
  IF NOT v_duplicate THEN RAISE EXCEPTION 'A duplicate pending submission was accepted'; END IF;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000201', true);
  v_submission := public.review_qr_payment_submission(v_submission_id, 'APPROVE', '1234', NULL);
  IF v_submission->>'status' <> 'APPROVED' THEN RAISE EXCEPTION 'Approval did not return APPROVED'; END IF;
  IF (SELECT status FROM public.qr_payment_submissions WHERE id = v_submission_id) <> 'APPROVED' THEN
    RAISE EXCEPTION 'Approval did not persist submission status';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.payments
    WHERE id = (v_submission->>'payment_id')::uuid
      AND amount_minor = 6500 AND payment_method = 'PALPAY'
  ) THEN RAISE EXCEPTION 'Approval did not create the expected payment'; END IF;

  SELECT count(*) INTO v_payment_count FROM public.payments;
  v_duplicate := false;
  BEGIN
    PERFORM public.review_qr_payment_submission(v_submission_id, 'APPROVE', '1234', NULL);
  EXCEPTION WHEN OTHERS THEN
    v_duplicate := true;
  END;
  IF NOT v_duplicate THEN RAISE EXCEPTION 'Double approval was not blocked'; END IF;
  IF (SELECT count(*) FROM public.payments) <> v_payment_count THEN
    RAISE EXCEPTION 'Double approval created a duplicate payment';
  END IF;

  v_second_submission := public.submit_qr_payment(
    'public-token-000000000000000000000002', 'JAWAL_PAY',
    '00000000-0000-0000-0000-000000000302/receipt.webp', NULL
  );
  v_second_id := (v_second_submission->>'submission_id')::uuid;

  v_rejected := false;
  BEGIN
    PERFORM public.review_qr_payment_submission(v_second_id, 'APPROVE', 'FAIL', NULL);
  EXCEPTION WHEN OTHERS THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Simulated canonical payment failure was not propagated'; END IF;
  IF (SELECT status FROM public.qr_payment_submissions WHERE id = v_second_id) <> 'PENDING' THEN
    RAISE EXCEPTION 'Failed approval must leave submission pending';
  END IF;
  IF (SELECT count(*) FROM public.payments) <> v_payment_count THEN
    RAISE EXCEPTION 'Failed approval created a partial payment';
  END IF;

  v_submission := public.review_qr_payment_submission(v_second_id, 'REJECT', NULL, 'Receipt unreadable');
  IF v_submission->>'status' <> 'REJECTED' THEN RAISE EXCEPTION 'Rejection did not return REJECTED'; END IF;
  IF (SELECT status FROM public.qr_payment_submissions WHERE id = v_second_id) <> 'REJECTED' THEN
    RAISE EXCEPTION 'Rejection did not persist status';
  END IF;
  IF (SELECT count(*) FROM public.payments) <> v_payment_count THEN
    RAISE EXCEPTION 'Rejection must not create a payment';
  END IF;
END;
$test$;

SELECT 'public QR payment migration runtime tests passed' AS result;
