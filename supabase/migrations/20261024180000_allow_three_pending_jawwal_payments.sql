-- Correct the original single-pending rule: permit up to three concurrent
-- customer-originated Jawwal Pay submissions awaiting administrator review.
-- The trigger migration separately enforces the same limit against direct writes
-- and concurrent requests. Other customer payment methods remain unaffected.

CREATE OR REPLACE FUNCTION public.submit_customer_jawwal_pay_payment(
  p_amount_minor bigint,
  p_biometric_authorization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_customer_id uuid;
  v_submission_id uuid;
  v_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_pending_count integer;
BEGIN
  IF auth.uid() IS NULL OR v_session_id IS NULL THEN
    RAISE EXCEPTION 'Customer login required' USING ERRCODE = '28000';
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 OR p_amount_minor > 99999999999 THEN
    RAISE EXCEPTION 'Amount must be greater than zero' USING ERRCODE = '22023';
  END IF;
  IF p_biometric_authorization_id IS NULL THEN
    RAISE EXCEPTION 'Biometric payment authorization required' USING ERRCODE = '28000';
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

  -- Serialize submissions for this customer and count only pending Jawwal Pay.
  PERFORM pg_advisory_xact_lock(hashtextextended('qr-payment:customer:' || v_customer_id::text, 0));

  SELECT count(*) INTO v_pending_count
  FROM public.qr_payment_submissions s
  WHERE s.customer_id = v_customer_id
    AND s.status = 'PENDING'
    AND s.submission_source = 'CUSTOMER_JAWAL_PAY';

  IF v_pending_count >= 3 THEN
    RAISE EXCEPTION 'Jawwal Pay already has three payments awaiting review'
      USING ERRCODE = '23514',
            CONSTRAINT = 'max_three_pending_jawwal_payments';
  END IF;

  -- Validate and consume the existing one-time biometric authorization.
  -- This delegates proof ownership/expiry/replay checks to the established guard.
  IF NOT EXISTS (
    SELECT 1
    FROM public.customer_jawwal_biometric_authorizations a
    WHERE a.id = p_biometric_authorization_id
      AND a.customer_id = v_customer_id
      AND a.consumed_at IS NULL
      AND a.expires_at > now()
  ) THEN
    RAISE EXCEPTION 'Valid biometric payment authorization required'
      USING ERRCODE = '28000';
  END IF;

  UPDATE public.customer_jawwal_biometric_authorizations
  SET consumed_at = clock_timestamp()
  WHERE id = p_biometric_authorization_id
    AND customer_id = v_customer_id
    AND consumed_at IS NULL
    AND expires_at > now();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Biometric payment authorization already used or expired'
      USING ERRCODE = '28000';
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

REVOKE ALL ON FUNCTION public.submit_customer_jawwal_pay_payment(bigint, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_customer_jawwal_pay_payment(bigint, uuid) TO authenticated;
