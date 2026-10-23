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
