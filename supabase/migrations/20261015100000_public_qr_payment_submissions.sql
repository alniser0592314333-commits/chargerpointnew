-- Public QR payment submissions: extend the existing submission flow without creating a second payment/allocation engine.
-- Approval delegates to the serialized canonical POST_PAYMENT command, preserving existing FIFO allocation and customer-credit behavior.

ALTER TABLE public.qr_payment_submissions
  ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES public.orders(id),
  ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS payment_id uuid REFERENCES public.payments(id),
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS balance_before_minor bigint,
  ADD COLUMN IF NOT EXISTS balance_after_minor bigint;

-- A pending receipt is not a payment amount. Keep the required column at zero until
-- an authorized reviewer enters the verified amount and approves the receipt.
ALTER TABLE public.qr_payment_submissions
  DROP CONSTRAINT IF EXISTS qr_payment_submissions_amount_minor_check;
ALTER TABLE public.qr_payment_submissions
  ADD CONSTRAINT qr_payment_submissions_amount_minor_check
  CHECK (amount_minor > 0 OR status IN ('PENDING', 'REJECTED'));

CREATE INDEX IF NOT EXISTS qr_payment_submissions_pending_order_created_idx
  ON public.qr_payment_submissions (order_id, created_at DESC)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS qr_payment_submissions_pending_customer_created_idx
  ON public.qr_payment_submissions (customer_id, created_at DESC)
  WHERE status = 'PENDING' AND order_id IS NULL;

ALTER TABLE public.qr_payment_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.qr_payment_submissions FROM PUBLIC, anon, authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'qr-payment-receipts',
  'qr-payment-receipts',
  false,
  2097152,
  ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = 2097152,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']::text[];

DROP POLICY IF EXISTS qr_payment_receipts_admin_read ON storage.objects;
CREATE POLICY qr_payment_receipts_admin_read
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'qr-payment-receipts'
    AND public.is_my_account_session_active()
    AND EXISTS (
      SELECT 1
      FROM public.admins a
      WHERE a.auth_user_id = (SELECT auth.uid())
        AND a.is_active = true
        AND EXISTS (
          SELECT 1
          FROM public.get_effective_permissions(a.id)
          WHERE permission = 'finance:approve-payment'
        )
    )
  );

-- Public QR order read model: safe presentation data only. No full customer UUID,
-- customer balance, phone, credentials, or admin/session information is exposed.
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
  WHERE c.id = v_order.customer_id AND c.status <> 'DELETED' AND c.is_active = true AND c.deleted_at IS NULL;

  IF v_customer.id IS NULL THEN RETURN; END IF;

  SELECT
    count(*)::integer,
    coalesce(sum(oi.final_charge_snapshot_minor) FILTER (WHERE oi.cancelled_at IS NULL), 0)::bigint,
    coalesce(sum(greatest(oi.final_charge_snapshot_minor - coalesce(pa.paid_minor, 0), 0)) FILTER (WHERE oi.cancelled_at IS NULL), 0)::bigint,
    coalesce(jsonb_agg(
      jsonb_build_object(
        'name', oi.device_name_snapshot,
        'status', oi.status,
        'operational_status', oi.operational_status,
        'payment_status', oi.payment_status,
        'has_charger', oi.has_charger,
        'quantity', 1,
        'unit_price_minor', oi.unit_price_minor,
        'total_price_minor', oi.final_charge_snapshot_minor,
        'paid_minor', coalesce(pa.paid_minor, 0),
        'due_minor', CASE WHEN oi.cancelled_at IS NULL
          THEN greatest(oi.final_charge_snapshot_minor - coalesce(pa.paid_minor, 0), 0)
          ELSE 0 END,
        'charger_fee_exempt', (oi.customer_charger_fee_exempt_snapshot AND oi.has_charger)
      ) ORDER BY oi.item_sequence
    ), '[]'::jsonb)
  INTO v_items_count, v_total_minor, v_due_minor, v_items
  FROM public.order_items oi
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
    'items', v_items,
    'order_total_minor', v_total_minor,
    'order_due_minor', v_due_minor
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.public_resolve_order_qr(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_resolve_order_qr(text) TO anon, authenticated, service_role;

-- The receipt path is generated by the server-side edge function and must point
-- to an already-uploaded object under the corresponding order or customer's private folder.
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

    -- Share the customer lock with direct customer-QR submissions to prevent cross-flow races.
    PERFORM pg_advisory_xact_lock(hashtextextended('qr-payment:customer:' || v_customer_id::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('qr-payment:order:' || v_order_id::text, 0));

    IF p_amount_minor IS NOT NULL THEN
      RAISE EXCEPTION 'Order payment amount is calculated by the server' USING ERRCODE = '22023';
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

    IF (
      SELECT count(*) FROM public.qr_payment_submissions s
      WHERE s.order_id = v_order_id AND s.created_at > now() - interval '1 hour'
    ) >= 3 THEN
      RAISE EXCEPTION 'Too many payment notifications for this order. Please try again later.' USING ERRCODE = 'P0001';
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
      AND oi.deleted_at IS NULL;

    IF v_due_minor <= 0 THEN
      RAISE EXCEPTION 'There is no remaining amount for this order' USING ERRCODE = 'P0001';
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

    v_due_minor := 0;
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

REVOKE ALL ON FUNCTION public.submit_qr_payment(text, text, text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_qr_payment(text, text, text, text, bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.list_pending_qr_payment_submissions()
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
    WHERE permission = 'finance:approve-payment'
  ) THEN
    RAISE EXCEPTION 'Missing payment review permission' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT jsonb_build_object(
    'id', s.id,
    'order_id', s.order_id,
    'order_number', o.display_number,
    'customer_id', s.customer_id,
    'customer_name', c.name,
    'amount_minor', s.amount_minor,
    'payment_method', s.payment_method,
    'receipt_path', s.receipt_url,
    'note', s.note,
    'status', s.status,
    'created_at', s.created_at
  )
  FROM public.qr_payment_submissions s
  LEFT JOIN public.orders o ON o.id = s.order_id
  JOIN public.customers c ON c.id = s.customer_id
  WHERE s.status = 'PENDING'
  ORDER BY s.created_at ASC;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_pending_qr_payment_submissions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_pending_qr_payment_submissions() TO authenticated;

CREATE OR REPLACE FUNCTION public.public_resolve_qr_payment_submission(p_public_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_target_id uuid;
  v_token_type text;
  v_result jsonb;
BEGIN
  IF p_public_token IS NULL OR length(p_public_token) < 20 OR length(p_public_token) > 128 THEN
    RETURN NULL;
  END IF;

  SELECT qt.target_id, qt.token_type INTO v_target_id, v_token_type
  FROM public.qr_tokens qt
  WHERE qt.public_token = p_public_token
    AND qt.token_type IN ('ORDER', 'CUSTOMER')
    AND qt.is_active = true
    AND (qt.expires_at IS NULL OR qt.expires_at > now())
  LIMIT 1;

  IF v_target_id IS NULL OR v_token_type IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_token_type = 'ORDER' THEN
    SELECT jsonb_build_object(
      'status', s.status,
      'amount_minor', CASE WHEN s.status = 'APPROVED' THEN coalesce(p.amount_minor, s.amount_minor) ELSE NULL END,
      'payment_method', s.payment_method,
      'created_at', s.created_at,
      'reviewed_at', s.reviewed_at,
      'balance_before_minor', CASE WHEN s.status = 'APPROVED' THEN s.balance_before_minor ELSE NULL END,
      'balance_after_minor', CASE WHEN s.status = 'APPROVED' THEN s.balance_after_minor ELSE NULL END
    ) INTO v_result
    FROM public.qr_payment_submissions s
    JOIN public.orders o ON o.id = s.order_id
    JOIN public.customers c ON c.id = s.customer_id
    LEFT JOIN public.payments p ON p.id = s.payment_id
    WHERE s.order_id = v_target_id
      AND o.deleted_at IS NULL
      AND o.cancelled_at IS NULL
      AND c.deleted_at IS NULL
      AND c.is_active = true
      AND c.status <> 'DELETED'
    ORDER BY s.created_at DESC, s.updated_at DESC, s.id DESC
    LIMIT 1;
  ELSE
    SELECT jsonb_build_object(
      'status', s.status,
      'amount_minor', CASE WHEN s.status = 'APPROVED' THEN coalesce(p.amount_minor, s.amount_minor) ELSE NULL END,
      'payment_method', s.payment_method,
      'created_at', s.created_at,
      'reviewed_at', s.reviewed_at,
      'balance_before_minor', CASE WHEN s.status = 'APPROVED' THEN s.balance_before_minor ELSE NULL END,
      'balance_after_minor', CASE WHEN s.status = 'APPROVED' THEN s.balance_after_minor ELSE NULL END
    ) INTO v_result
    FROM public.qr_payment_submissions s
    JOIN public.customers c ON c.id = s.customer_id
    LEFT JOIN public.payments p ON p.id = s.payment_id
    WHERE s.customer_id = v_target_id
      AND c.deleted_at IS NULL
      AND c.is_active = true
      AND c.status <> 'DELETED'
    ORDER BY s.created_at DESC, s.updated_at DESC, s.id DESC
    LIMIT 1;
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.public_resolve_qr_payment_submission(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_resolve_qr_payment_submission(text) TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.review_qr_payment_submission(uuid, text, text, text);

CREATE OR REPLACE FUNCTION public.review_qr_payment_submission(
  p_submission_id uuid,
  p_action text,
  p_bin text DEFAULT NULL,
  p_rejection_reason text DEFAULT NULL,
  p_approved_amount_minor bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin_id uuid;
  v_submission public.qr_payment_submissions%ROWTYPE;
  v_payment_id uuid;
  v_payload jsonb;
  v_command_result jsonb;
  v_balance_before_minor bigint;
  v_balance_after_minor bigint;
  v_action text := upper(trim(coalesce(p_action, '')));
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
    WHERE permission = 'finance:approve-payment'
  ) THEN
    RAISE EXCEPTION 'Missing payment review permission' USING ERRCODE = 'P0001';
  END IF;

  IF v_action NOT IN ('APPROVE', 'REJECT') THEN
    RAISE EXCEPTION 'Action must be APPROVE or REJECT' USING ERRCODE = '22023';
  END IF;

  IF v_action = 'APPROVE'
     AND (p_approved_amount_minor IS NULL OR p_approved_amount_minor <= 0 OR p_approved_amount_minor > 99999999999) THEN
    RAISE EXCEPTION 'A verified payment amount greater than zero is required for approval' USING ERRCODE = '22023';
  END IF;

  IF v_action = 'APPROVE' AND nullif(trim(coalesce(p_bin, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Admin PIN/BIN is required to approve a payment notification' USING ERRCODE = '22023';
  END IF;

  IF v_action = 'APPROVE'
     AND NOT EXISTS (
       SELECT 1 FROM public.get_effective_permissions(v_admin_id)
       WHERE permission = 'finance:create-payment'
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.admins a
       WHERE a.id = v_admin_id AND a.role IN ('SUPER_ADMIN', 'Super Admin')
     ) THEN
    RAISE EXCEPTION 'Missing payment creation permission required by the canonical POST_PAYMENT command' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_submission
  FROM public.qr_payment_submissions
  WHERE id = p_submission_id
  FOR UPDATE;

  IF v_submission.id IS NULL THEN
    RAISE EXCEPTION 'Payment notification not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_submission.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Payment notification already reviewed' USING ERRCODE = 'P0001';
  END IF;

  IF v_action = 'REJECT' THEN
    UPDATE public.qr_payment_submissions
    SET status = 'REJECTED',
        rejection_reason = nullif(left(trim(coalesce(p_rejection_reason, '')), 500), ''),
        reviewed_by = v_admin_id,
        reviewed_at = now(),
        updated_at = now(),
        version = version + 1
    WHERE id = v_submission.id AND status = 'PENDING';

    RETURN jsonb_build_object('success', true, 'status', 'REJECTED', 'submission_id', v_submission.id);
  END IF;

  -- Hold the same transaction-scoped commit-order lock as the canonical command wrapper
  -- so before/after balance snapshots bracket this payment without racing another financial command.
  PERFORM pg_advisory_xact_lock(hashtextextended('chargerpointnew:change_log:commit_order', 0));

  SELECT coalesce(sum(fl.amount_minor), 0)::bigint
  INTO v_balance_before_minor
  FROM public.financial_ledger fl
  WHERE fl.customer_id = v_submission.customer_id;

  v_payment_id := gen_random_uuid();
  v_payload := jsonb_build_object(
    'id', v_payment_id,
    'customerId', v_submission.customer_id,
    'amountMinor', p_approved_amount_minor,
    'paymentMethod', v_submission.payment_method,
    'reference', 'QR_PAYMENT_SUBMISSION:' || v_submission.id::text,
    'resetGeneration', coalesce((SELECT value_number FROM public.system_settings WHERE key = 'server_reset_generation'), 1),
    'bin', coalesce(p_bin, '')
  );

  v_command_result := public.execute_canonical_sync_command(
    v_submission.id,
    'POST_PAYMENT',
    v_payload,
    md5(v_payload::text),
    'qr-payment-review',
    v_admin_id
  );

  IF coalesce((v_command_result->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Canonical payment command failed; notification remains pending' USING ERRCODE = 'P0001';
  END IF;

  SELECT coalesce(sum(fl.amount_minor), 0)::bigint
  INTO v_balance_after_minor
  FROM public.financial_ledger fl
  WHERE fl.customer_id = v_submission.customer_id;

  UPDATE public.qr_payment_submissions
  SET status = 'APPROVED',
      amount_minor = p_approved_amount_minor,
      payment_id = v_payment_id,
      balance_before_minor = v_balance_before_minor,
      balance_after_minor = v_balance_after_minor,
      reviewed_by = v_admin_id,
      reviewed_at = now(),
      updated_at = now(),
      version = version + 1
  WHERE id = v_submission.id AND status = 'PENDING';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment notification review conflict' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'status', 'APPROVED',
    'submission_id', v_submission.id,
    'payment_id', v_payment_id,
    'amount_minor', p_approved_amount_minor,
    'balance_before_minor', v_balance_before_minor,
    'balance_after_minor', v_balance_after_minor
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.review_qr_payment_submission(uuid, text, text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_qr_payment_submission(uuid, text, text, text, bigint) TO authenticated;
