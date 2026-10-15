-- Tighten explicit role grants on QR payment SECURITY DEFINER RPCs.
-- Existing per-role grants can survive REVOKE FROM PUBLIC, so revoke each role explicitly.
REVOKE ALL ON FUNCTION public.submit_qr_payment(text, text, text, text, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_qr_payment(text, text, text, text, bigint)
  TO service_role;

REVOKE ALL ON FUNCTION public.list_pending_qr_payment_submissions()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_pending_qr_payment_submissions()
  TO authenticated;

REVOKE ALL ON FUNCTION public.review_qr_payment_submission(uuid, text, text, text, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_qr_payment_submission(uuid, text, text, text, bigint)
  TO authenticated;

-- Public status and order details are intentionally available by possession of a valid QR token.
REVOKE ALL ON FUNCTION public.public_resolve_qr_payment_submission(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.public_resolve_qr_payment_submission(text)
  TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.public_resolve_order_qr(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.public_resolve_order_qr(text)
  TO anon, authenticated, service_role;
