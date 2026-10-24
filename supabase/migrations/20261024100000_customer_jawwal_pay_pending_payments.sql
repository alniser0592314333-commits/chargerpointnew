-- Customer Jawwal Pay submissions reuse the canonical QR payment review/allocation lifecycle.
-- A submission is pending only; approval runs the existing review RPC and FIFO allocation logic.

ALTER TABLE public.qr_payment_submissions
  DROP CONSTRAINT IF EXISTS qr_payment_submissions_submission_source_check;
ALTER TABLE public.qr_payment_submissions
  ADD CONSTRAINT qr_payment_submissions_submission_source_check
  CHECK (submission_source IN ('CUSTOMER_QR', 'ADMIN_MANUAL', 'CUSTOMER_JAWAL_PAY'));

CREATE OR REPLACE FUNCTION public.submit_customer_jawwal_pay_payment(p_amount_minor bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_customer_id uuid;
  v_submission_id uuid;
  v_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
BEGIN
  IF auth.uid() IS NULL OR v_session_id IS NULL THEN
    RAISE EXCEPTION 'Customer login required' USING ERRCODE = '28000';
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 OR p_amount_minor > 99999999999 THEN
    RAISE EXCEPTION 'Amount must be greater than zero' USING ERRCODE = '22023';
  END IF;

  SELECT l.customer_id INTO v_customer_id
  FROM public.customer_account_links l
  JOIN public.customers c ON c.id = l.customer_id
  JOIN public.customer_account_sessions s
    ON s.customer_id = l.customer_id
   AND s.auth_user_id = l.auth_user_id
   AND s.session_id = v_session_id
   AND s.revoked_at IS NULL
   AND s.expires_at > now()
  WHERE l.auth_user_id = auth.uid()
    AND l.account_status = 'ACTIVE'
    AND c.is_active IS TRUE
    AND c.deleted_at IS NULL
    AND c.status <> 'DELETED'
  LIMIT 1;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Active customer account session required' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('qr-payment:customer:' || v_customer_id::text, 0));

  IF EXISTS (
    SELECT 1 FROM public.qr_payment_submissions s
    WHERE s.customer_id = v_customer_id
      AND s.status = 'PENDING'
      AND s.submission_source IN ('CUSTOMER_QR', 'CUSTOMER_JAWAL_PAY')
  ) THEN
    RAISE EXCEPTION 'A customer payment is already awaiting review' USING ERRCODE = 'P0001';
  END IF;

  IF (
    SELECT count(*) FROM public.qr_payment_submissions s
    WHERE s.customer_id = v_customer_id
      AND s.submission_source = 'CUSTOMER_JAWAL_PAY'
      AND s.created_at > now() - interval '1 hour'
  ) >= 3 THEN
    RAISE EXCEPTION 'Too many Jawwal Pay submissions. Try again later.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.qr_payment_submissions (
    customer_id, amount_minor, receipt_url, note, status, reviewed_by, reviewed_at,
    order_id, payment_method, submission_source, created_at, updated_at, version
  ) VALUES (
    v_customer_id, p_amount_minor, NULL,
    'طلب دفع بواسطة جوال باي — بانتظار اعتماد الإدارة',
    'PENDING', NULL, NULL, NULL, 'JAWAL_PAY', 'CUSTOMER_JAWAL_PAY',
    clock_timestamp(), clock_timestamp(), 1
  )
  RETURNING id INTO v_submission_id;

  RETURN jsonb_build_object(
    'success', true,
    'submission_id', v_submission_id,
    'amount_minor', p_amount_minor,
    'status', 'PENDING'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_customer_jawwal_pay_payment(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_customer_jawwal_pay_payment(bigint) TO authenticated;

-- Include customer Jawwal Pay requests in the existing admin review list, without
-- creating a separate approval or accounting path.
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

  IF v_admin_id IS NULL OR (
    NOT EXISTS (
      SELECT 1 FROM public.get_effective_permissions(v_admin_id)
      WHERE permission IN ('finance:approve-payment', 'finance:create-payment')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.admins a
      WHERE a.id = v_admin_id AND a.role IN ('SUPER_ADMIN', 'Super Admin')
    )
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
    'reviewed_by_name', reviewer.full_name,
    'payment_method', s.payment_method,
    'submission_source', s.submission_source
  )
  FROM public.qr_payment_submissions s
  JOIN public.customers c ON c.id = s.customer_id
  LEFT JOIN public.admins reviewer ON reviewer.id = s.reviewed_by
  WHERE s.submission_source IN ('ADMIN_MANUAL', 'CUSTOMER_JAWAL_PAY')
  ORDER BY CASE WHEN s.status = 'PENDING' THEN 0 ELSE 1 END, s.created_at DESC
  LIMIT 200;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_admin_manual_customer_payments() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_admin_manual_customer_payments() TO authenticated;
