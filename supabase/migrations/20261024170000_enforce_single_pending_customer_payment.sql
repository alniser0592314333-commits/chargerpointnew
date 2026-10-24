-- Enforce one customer-originated payment awaiting review per customer at the database level.
-- The unique index closes any race between separate payment requests, even if a caller
-- bypasses the UI or the RPC guard is reached concurrently.

CREATE UNIQUE INDEX IF NOT EXISTS qr_payment_one_pending_customer_submission_idx
ON public.qr_payment_submissions (customer_id)
WHERE status = 'PENDING'
  AND submission_source IN ('CUSTOMER_QR', 'CUSTOMER_JAWAL_PAY');

COMMENT ON INDEX public.qr_payment_one_pending_customer_submission_idx IS
  'Prevents a customer from creating a second QR/Jawwal Pay submission while an earlier customer-originated payment is pending review.';
