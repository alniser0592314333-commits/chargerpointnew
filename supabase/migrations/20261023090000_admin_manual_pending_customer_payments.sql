-- Manual customer payments stay pending until an authorized administrator approves them.
-- Reuse qr_payment_submissions so the existing customer portal, review lifecycle and native-push trigger remain canonical.
ALTER TABLE public.qr_payment_submissions
  ADD COLUMN IF NOT EXISTS submission_source text NOT NULL DEFAULT 'CUSTOMER_QR';

ALTER TABLE public.qr_payment_submissions
  DROP CONSTRAINT IF EXISTS qr_payment_submissions_submission_source_check;
ALTER TABLE public.qr_payment_submissions
  ADD CONSTRAINT qr_payment_submissions_submission_source_check
  CHECK (submission_source IN ('CUSTOMER_QR', 'ADMIN_MANUAL'));

CREATE INDEX IF NOT EXISTS qr_payment_submissions_manual_status_created_idx
  ON public.qr_payment_submissions (submission_source, status, created_at DESC);

CREATE OR REPLACE FUNCTION public.create_admin_pending_customer_payment(
  p_customer_id uuid,
  p_amount_minor bigint,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_submission_id uuid;
BEGIN
  IF auth.uid() IS NULL OR public.is_my_account_session_active() IS NOT TRUE THEN
    RAISE EXCEPTION 'Active admin session required' USING ERRCODE = 'P0001';
  END IF;

  SELECT a.id INTO v_admin_id
  FROM public.admins a
  WHERE a.auth_user_id = auth.uid() AND a.is_active = true
  LIMIT 1;

  IF v_admin_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.get_effective_permissions(v_admin_id)
    WHERE permission = 'finance:create-payment'
  ) THEN
    RAISE EXCEPTION 'Missing payment creation permission' USING ERRCODE = 'P0001';
  END IF;

  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'Customer is required' USING ERRCODE = '22023';
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 OR p_amount_minor > 99999999999 THEN
    RAISE EXCEPTION 'Amount must be greater than zero and within supported range' USING ERRCODE = '22023';
  END IF;
  IF length(trim(coalesce(p_note, ''))) > 500 THEN
    RAISE EXCEPTION 'Note is too long' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.customers c
    WHERE c.id = p_customer_id AND c.is_active IS TRUE
      AND c.deleted_at IS NULL AND c.status <> 'DELETED'
  ) THEN
    RAISE EXCEPTION 'Customer not found or inactive' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.qr_payment_submissions (
    customer_id, amount_minor, receipt_url, note, status, reviewed_by, reviewed_at,
    order_id, payment_method, submission_source
  ) VALUES (
    p_customer_id, p_amount_minor, NULL, nullif(left(trim(coalesce(p_note, '')), 500), ''),
    'PENDING', NULL, NULL, NULL, 'CASH', 'ADMIN_MANUAL'
  )
  RETURNING id INTO v_submission_id;

  RETURN jsonb_build_object(
    'success', true,
    'id', v_submission_id,
    'customer_id', p_customer_id,
    'amount_minor', p_amount_minor,
    'status', 'PENDING'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_admin_manual_customer_payments()
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
BEGIN
  IF auth.uid() IS NULL OR public.is_my_account_session_active() IS NOT TRUE THEN
    RAISE EXCEPTION 'Active admin session required' USING ERRCODE = 'P0001';
  END IF;

  SELECT a.id INTO v_admin_id
  FROM public.admins a
  WHERE a.auth_user_id = auth.uid() AND a.is_active = true
  LIMIT 1;

  IF v_admin_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.get_effective_permissions(v_admin_id)
    WHERE permission IN ('finance:approve-payment', 'finance:create-payment')
  ) THEN
    RAISE EXCEPTION 'Missing finance payment permission' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT jsonb_build_object(
    'id', s.id,
    'customer_id', s.customer_id,
    'customer_name', c.name,
    'customer_code', public.derive_customer_code(c.id)::text,
    'amount_minor', s.amount_minor,
    'note', s.note,
    'status', s.status,
    'rejection_reason', s.rejection_reason,
    'created_at', s.created_at,
    'reviewed_at', s.reviewed_at,
    'reviewed_by_name', reviewer.full_name
  )
  FROM public.qr_payment_submissions s
  JOIN public.customers c ON c.id = s.customer_id
  LEFT JOIN public.admins reviewer ON reviewer.id = s.reviewed_by
  WHERE s.submission_source = 'ADMIN_MANUAL'
  ORDER BY CASE WHEN s.status = 'PENDING' THEN 0 ELSE 1 END, s.created_at DESC
  LIMIT 200;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_admin_pending_customer_payment(uuid, bigint, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_admin_manual_customer_payments() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_admin_pending_customer_payment(uuid, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_admin_manual_customer_payments() TO authenticated;

-- Keep manual admin entries separate from customer QR duplicate/rate-limit checks.
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
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_target_id uuid; v_customer_id uuid; v_order_id uuid; v_token_type text;
  v_due_minor bigint; v_customer_balance_minor bigint; v_submission_id uuid;
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
  WHERE qt.public_token = p_public_token AND qt.token_type IN ('ORDER', 'CUSTOMER')
    AND qt.is_active = true AND (qt.expires_at IS NULL OR qt.expires_at > now())
  LIMIT 1;
  IF v_target_id IS NULL OR v_token_type IS NULL THEN
    RAISE EXCEPTION 'QR not found or inactive' USING ERRCODE = 'P0002';
  END IF;

  IF v_token_type = 'ORDER' THEN
    SELECT o.id, o.customer_id INTO v_order_id, v_customer_id
    FROM public.orders o JOIN public.customers c ON c.id = o.customer_id
    WHERE o.id = v_target_id AND o.deleted_at IS NULL AND o.cancelled_at IS NULL
      AND c.deleted_at IS NULL AND c.is_active = true AND c.status <> 'DELETED';
    IF v_order_id IS NULL THEN RAISE EXCEPTION 'Order QR not found or inactive' USING ERRCODE = 'P0002'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('qr-payment:customer:' || v_customer_id::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('qr-payment:order:' || v_order_id::text, 0));
    IF p_amount_minor IS NOT NULL THEN RAISE EXCEPTION 'Order payment amount is calculated by the server' USING ERRCODE = '22023'; END IF;
    SELECT coalesce(sum(fl.amount_minor), 0)::bigint INTO v_customer_balance_minor
    FROM public.financial_ledger fl WHERE fl.customer_id = v_customer_id;
    IF p_receipt_path IS NULL OR length(p_receipt_path) > 300
      OR p_receipt_path NOT LIKE 'orders/' || v_order_id::text || '/%'
      OR p_receipt_path LIKE '%..%'
      OR NOT EXISTS (SELECT 1 FROM storage.objects so WHERE so.bucket_id = 'qr-payment-receipts' AND so.name = p_receipt_path) THEN
      RAISE EXCEPTION 'Receipt upload is missing or invalid' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.qr_payment_submissions s
      WHERE s.customer_id = v_customer_id AND s.status = 'PENDING'
        AND s.submission_source = 'CUSTOMER_QR'
        AND (s.order_id = v_order_id OR s.order_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'A payment notification for this customer account or order is already awaiting review' USING ERRCODE = 'P0001';
    END IF;
    IF (SELECT count(*) FROM public.qr_payment_submissions s WHERE s.order_id = v_order_id AND s.submission_source = 'CUSTOMER_QR') >= 3 THEN
      RAISE EXCEPTION 'Maximum of three payment notifications reached for this order QR' USING ERRCODE = 'P0001';
    END IF;
    SELECT coalesce(sum(greatest(oi.final_charge_snapshot_minor - coalesce(pa.paid_minor, 0), 0)), 0)::bigint INTO v_due_minor
    FROM public.order_items oi
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(pal.allocated_amount_minor), 0)::bigint AS paid_minor
      FROM public.payment_allocations pal WHERE pal.order_item_id = oi.id
    ) pa ON true
    WHERE oi.order_id = v_order_id AND oi.cancelled_at IS NULL AND oi.deleted_at IS NULL
      AND oi.financial_status = 'RECOGNIZED' AND oi.financially_recognized_at IS NOT NULL;
    v_due_minor := greatest(v_due_minor - greatest(v_customer_balance_minor, 0), 0);
    IF v_due_minor <= 0 THEN
      RAISE EXCEPTION 'There is no remaining amount on financially recognized order items' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT c.id INTO v_customer_id FROM public.customers c
    WHERE c.id = v_target_id AND c.deleted_at IS NULL AND c.is_active = true AND c.status <> 'DELETED';
    IF v_customer_id IS NULL THEN RAISE EXCEPTION 'Customer QR not found or inactive' USING ERRCODE = 'P0002'; END IF;
    IF p_amount_minor IS NOT NULL THEN
      RAISE EXCEPTION 'Customer-provided payment amount is not accepted; reviewer determines the amount' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('qr-payment:customer:' || v_customer_id::text, 0));
    IF p_receipt_path IS NULL OR length(p_receipt_path) > 300
      OR p_receipt_path NOT LIKE 'customers/' || v_customer_id::text || '/%'
      OR p_receipt_path LIKE '%..%'
      OR NOT EXISTS (SELECT 1 FROM storage.objects so WHERE so.bucket_id = 'qr-payment-receipts' AND so.name = p_receipt_path) THEN
      RAISE EXCEPTION 'Receipt upload is missing or invalid' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.qr_payment_submissions s
      WHERE s.customer_id = v_customer_id AND s.status = 'PENDING' AND s.submission_source = 'CUSTOMER_QR'
    ) THEN
      RAISE EXCEPTION 'A payment notification for this customer account is already awaiting review' USING ERRCODE = 'P0001';
    END IF;
    IF (
      SELECT count(*) FROM public.qr_payment_submissions s
      WHERE s.customer_id = v_customer_id AND s.submission_source = 'CUSTOMER_QR'
        AND s.created_at > now() - interval '1 hour'
    ) >= 3 THEN
      RAISE EXCEPTION 'Too many payment notifications for this customer account. Please try again later.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.qr_payment_submissions (
    id, order_id, customer_id, amount_minor, payment_method, receipt_url, note, status,
    created_at, updated_at, version, submission_source
  ) VALUES (
    gen_random_uuid(), v_order_id, v_customer_id, 0, v_method, p_receipt_path, v_note, 'PENDING',
    clock_timestamp(), clock_timestamp(), 1, 'CUSTOMER_QR'
  )
  RETURNING id INTO v_submission_id;

  RETURN jsonb_build_object('success', true, 'submission_id', v_submission_id, 'amount_minor', NULL, 'status', 'PENDING');
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_qr_payment(text, text, text, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_qr_payment(text, text, text, text, bigint) TO authenticated;
