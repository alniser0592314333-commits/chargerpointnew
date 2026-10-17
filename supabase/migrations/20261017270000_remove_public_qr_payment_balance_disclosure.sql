-- The public capability-QR payment status endpoint must never disclose the
-- customer's account balance before/after a payment. Those values are private
-- account-wide financial data, not necessary to confirm the submitted payment.
-- Preserve the existing status/amount/method/timestamp contract and token checks.

CREATE OR REPLACE FUNCTION public.public_resolve_qr_payment_submission(p_public_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
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
      'reviewed_at', s.reviewed_at
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
      'reviewed_at', s.reviewed_at
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
