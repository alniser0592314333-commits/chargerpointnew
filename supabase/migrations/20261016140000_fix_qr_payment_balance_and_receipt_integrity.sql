-- Correct public QR payment eligibility at the database boundary.
-- A positive ledger balance is customer credit; only financially recognized (delivered) items
-- are payable through an order QR. The public QR exposes only the sign of the balance, not its amount.

CREATE OR REPLACE FUNCTION public.public_resolve_order_qr(p_public_token text)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order_id uuid;
  v_order record;
  v_customer record;
  v_items jsonb;
  v_items_count integer;
  v_total_minor bigint;
  v_due_minor bigint;
  v_customer_balance_minor bigint;
BEGIN
  IF p_public_token IS NULL OR length(p_public_token) < 20 OR length(p_public_token) > 128 THEN
    RETURN;
  END IF;

  SELECT qt.target_id INTO v_order_id
  FROM public.qr_tokens qt
  WHERE qt.public_token = p_public_token
    AND qt.token_type = 'ORDER'
    AND qt.is_active = true
    AND (qt.expires_at IS NULL OR qt.expires_at > now())
  LIMIT 1;

  IF v_order_id IS NULL THEN RETURN; END IF;

  SELECT o.id, o.display_number, o.status, o.customer_id, o.created_at
  INTO v_order
  FROM public.orders o
  WHERE o.id = v_order_id AND o.deleted_at IS NULL AND o.cancelled_at IS NULL;

  IF v_order.id IS NULL THEN RETURN; END IF;

  SELECT c.id, c.name INTO v_customer
  FROM public.customers c
  WHERE c.id = v_order.customer_id
    AND c.status <> 'DELETED'
    AND c.is_active = true
    AND c.deleted_at IS NULL;

  IF v_customer.id IS NULL THEN RETURN; END IF;

  SELECT coalesce(sum(fl.amount_minor), 0)::bigint
  INTO v_customer_balance_minor
  FROM public.financial_ledger fl
  WHERE fl.customer_id = v_customer.id;

  SELECT
    count(*)::integer,
    coalesce(sum(oi.final_charge_snapshot_minor) FILTER (WHERE oi.cancelled_at IS NULL), 0)::bigint,
    coalesce(sum(greatest(oi.final_charge_snapshot_minor - coalesce(pa.paid_minor, 0), 0))
      FILTER (
        WHERE oi.cancelled_at IS NULL
          AND oi.financial_status = 'RECOGNIZED'
          AND oi.financially_recognized_at IS NOT NULL
      ), 0)::bigint,
    coalesce(jsonb_agg(
      jsonb_build_object(
        'name', oi.device_name_snapshot,
        'name_ar', coalesce(dt.name_ar, dt.name, oi.device_name_snapshot),
        'name_en', dt.name_en,
        'device_type_id', oi.device_type_id,
        'status', oi.status,
        'operational_status', oi.operational_status,
        'payment_status', CASE
          WHEN oi.financial_status = 'RECOGNIZED' AND oi.financially_recognized_at IS NOT NULL
          THEN oi.payment_status
          ELSE 'NOT_DUE'
        END,
        'has_charger', oi.has_charger,
        'quantity', 1,
        'unit_price_minor', oi.unit_price_minor,
        'total_price_minor', oi.final_charge_snapshot_minor,
        'paid_minor', coalesce(pa.paid_minor, 0),
        'due_minor', CASE
          WHEN oi.cancelled_at IS NULL
            AND oi.financial_status = 'RECOGNIZED'
            AND oi.financially_recognized_at IS NOT NULL
          THEN greatest(oi.final_charge_snapshot_minor - coalesce(pa.paid_minor, 0), 0)
          ELSE 0
        END,
        'charger_fee_exempt', (oi.customer_charger_fee_exempt_snapshot AND oi.has_charger)
      ) ORDER BY oi.item_sequence
    ), '[]'::jsonb)
  INTO v_items_count, v_total_minor, v_due_minor, v_items
  FROM public.order_items oi
  LEFT JOIN public.device_types dt ON dt.id = oi.device_type_id
  LEFT JOIN LATERAL (
    SELECT coalesce(sum(pal.allocated_amount_minor), 0)::bigint AS paid_minor
    FROM public.payment_allocations pal
    WHERE pal.order_item_id = oi.id
  ) pa ON true
  WHERE oi.order_id = v_order.id
    AND oi.deleted_at IS NULL;

  RETURN NEXT jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.display_number,
    'customer_name', v_customer.name,
    'customer_code', left(replace(v_customer.id::text, '-', ''), 4),
    'status', v_order.status,
    'created_at', v_order.created_at,
    'items_count', v_items_count,
    'order_total_minor', v_total_minor,
    'order_due_minor', v_due_minor,
    'customer_has_positive_credit', (v_customer_balance_minor > 0),
    'items', v_items
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.public_resolve_order_qr(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.public_resolve_order_qr(text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.submit_qr_payment(
  p_public_token text,
  p_payment_method text,
  p_receipt_path text,
  p_note text DEFAULT NULL,
  p_amount_minor bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_target_id uuid;
  v_customer_id uuid;
  v_order_id uuid;
  v_token_type text;
  v_due_minor bigint;
  v_customer_balance_minor bigint;
  v_submission_id uuid;
  v_method text := upper(trim(coalesce(p_payment_method, '')));
  v_note text := nullif(left(trim(coalesce(p_note, '')), 500), '');
BEGIN
  IF v_method NOT IN ('JAWAL_PAY', 'PALPAY', 'BANK_OF_PALESTINE') THEN
    RAISE EXCEPTION 'Unsupported payment method' USING ERRCODE = '22023';
  END IF;

  IF p_public_token IS NULL OR length(p_public_token) < 20 OR length(p_public_token) > 128 THEN
    RAISE EXCEPTION 'Invalid QR token' USING ERRCODE = '22023';
  END IF;

  SELECT qt.target_id, qt.token_type INTO v_target_id, v_token_type
  FROM public.qr_tokens qt
  WHERE qt.public_token = p_public_token
    AND qt.token_type IN ('ORDER', 'CUSTOMER')
    AND qt.is_active = true
    AND (qt.expires_at IS NULL OR qt.expires_at > now())
  LIMIT 1;

  IF v_target_id IS NULL OR v_token_type IS NULL THEN
    RAISE EXCEPTION 'QR not found or inactive' USING ERRCODE = 'P0002';
  END IF;

  IF v_token_type = 'ORDER' THEN
    SELECT o.id, o.customer_id INTO v_order_id, v_customer_id
    FROM public.orders o
    JOIN public.customers c ON c.id = o.customer_id
    WHERE o.id = v_target_id
      AND o.deleted_at IS NULL
      AND o.cancelled_at IS NULL
      AND c.deleted_at IS NULL
      AND c.is_active = true
      AND c.status <> 'DELETED';

    IF v_order_id IS NULL THEN
      RAISE EXCEPTION 'Order QR not found or inactive' USING ERRCODE = 'P0002';
    END IF;

    -- Serialize order and customer QR submissions, including simultaneous requests.
    PERFORM pg_advisory_xact_lock(hashtextextended('qr-payment:customer:' || v_customer_id::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('qr-payment:order:' || v_order_id::text, 0));

    IF p_amount_minor IS NOT NULL THEN
      RAISE EXCEPTION 'Order payment amount is calculated by the server' USING ERRCODE = '22023';
    END IF;

    SELECT coalesce(sum(fl.amount_minor), 0)::bigint
    INTO v_customer_balance_minor
    FROM public.financial_ledger fl
    WHERE fl.customer_id = v_customer_id;

    IF v_customer_balance_minor > 0 THEN
      RAISE EXCEPTION 'Customer has positive credit; an order QR payment is not required' USING ERRCODE = 'P0001';
    END IF;

    IF p_receipt_path IS NULL
       OR length(p_receipt_path) > 300
       OR p_receipt_path NOT LIKE 'orders/' || v_order_id::text || '/%'
       OR p_receipt_path LIKE '%..%'
       OR NOT EXISTS (
         SELECT 1 FROM storage.objects so
         WHERE so.bucket_id = 'qr-payment-receipts' AND so.name = p_receipt_path
       ) THEN
      RAISE EXCEPTION 'Receipt upload is missing or invalid' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.qr_payment_submissions s
      WHERE s.customer_id = v_customer_id
        AND s.status = 'PENDING'
        AND (s.order_id = v_order_id OR s.order_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'A payment notification for this customer account or order is already awaiting review' USING ERRCODE = 'P0001';
    END IF;

    -- One order QR may accept no more than three notifications in total, not three per hour.
    IF (
      SELECT count(*) FROM public.qr_payment_submissions s
      WHERE s.order_id = v_order_id
    ) >= 3 THEN
      RAISE EXCEPTION 'Maximum of three payment notifications reached for this order QR' USING ERRCODE = 'P0001';
    END IF;

    SELECT coalesce(sum(greatest(oi.final_charge_snapshot_minor - coalesce(pa.paid_minor, 0), 0)), 0)::bigint
    INTO v_due_minor
    FROM public.order_items oi
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(pal.allocated_amount_minor), 0)::bigint AS paid_minor
      FROM public.payment_allocations pal
      WHERE pal.order_item_id = oi.id
    ) pa ON true
    WHERE oi.order_id = v_order_id
      AND oi.cancelled_at IS NULL
      AND oi.deleted_at IS NULL
      AND oi.financial_status = 'RECOGNIZED'
      AND oi.financially_recognized_at IS NOT NULL;

    IF v_due_minor <= 0 THEN
      RAISE EXCEPTION 'There is no remaining amount on financially recognized order items' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT c.id INTO v_customer_id
    FROM public.customers c
    WHERE c.id = v_target_id
      AND c.deleted_at IS NULL
      AND c.is_active = true
      AND c.status <> 'DELETED';

    IF v_customer_id IS NULL THEN
      RAISE EXCEPTION 'Customer QR not found or inactive' USING ERRCODE = 'P0002';
    END IF;

    IF p_amount_minor IS NOT NULL THEN
      RAISE EXCEPTION 'Customer-provided payment amount is not accepted; reviewer determines the amount' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('qr-payment:customer:' || v_customer_id::text, 0));

    IF p_receipt_path IS NULL
       OR length(p_receipt_path) > 300
       OR p_receipt_path NOT LIKE 'customers/' || v_customer_id::text || '/%'
       OR p_receipt_path LIKE '%..%'
       OR NOT EXISTS (
         SELECT 1 FROM storage.objects so
         WHERE so.bucket_id = 'qr-payment-receipts' AND so.name = p_receipt_path
       ) THEN
      RAISE EXCEPTION 'Receipt upload is missing or invalid' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.qr_payment_submissions s
      WHERE s.customer_id = v_customer_id AND s.status = 'PENDING'
    ) THEN
      RAISE EXCEPTION 'A payment notification for this customer account is already awaiting review' USING ERRCODE = 'P0001';
    END IF;

    IF (
      SELECT count(*) FROM public.qr_payment_submissions s
      WHERE s.customer_id = v_customer_id
        AND s.created_at > now() - interval '1 hour'
    ) >= 3 THEN
      RAISE EXCEPTION 'Too many payment notifications for this customer account. Please try again later.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.qr_payment_submissions (
    id, order_id, customer_id, amount_minor, payment_method, receipt_url,
    note, status, created_at, updated_at, version
  )
  VALUES (
    gen_random_uuid(), v_order_id, v_customer_id, 0, v_method,
    p_receipt_path, v_note, 'PENDING', clock_timestamp(), clock_timestamp(), 1
  )
  RETURNING id INTO v_submission_id;

  RETURN jsonb_build_object(
    'success', true,
    'submission_id', v_submission_id,
    'amount_minor', NULL,
    'status', 'PENDING'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_qr_payment(text, text, text, text, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_qr_payment(text, text, text, text, bigint)
  TO service_role;

NOTIFY pgrst, 'reload schema';
