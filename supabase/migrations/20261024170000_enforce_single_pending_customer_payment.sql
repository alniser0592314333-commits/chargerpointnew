-- Allow at most three customer-originated Jawwal Pay payments awaiting review per customer.
-- This is deliberately limited to CUSTOMER_JAWAL_PAY; other payment methods are unaffected.
DROP INDEX IF EXISTS public.qr_payment_one_pending_customer_submission_idx;

CREATE OR REPLACE FUNCTION public.enforce_max_three_pending_jawwal_payments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  pending_count integer;
BEGIN
  IF NEW.status = 'PENDING'
     AND NEW.submission_source = 'CUSTOMER_JAWAL_PAY'
     AND (
       TG_OP = 'INSERT'
       OR OLD.status IS DISTINCT FROM NEW.status
       OR OLD.submission_source IS DISTINCT FROM NEW.submission_source
       OR OLD.customer_id IS DISTINCT FROM NEW.customer_id
     )
  THEN
    -- Serialize concurrent submissions for the same customer.
    PERFORM 1 FROM public.customers WHERE id = NEW.customer_id FOR UPDATE;

    SELECT count(*) INTO pending_count
    FROM public.qr_payment_submissions
    WHERE customer_id = NEW.customer_id
      AND status = 'PENDING'
      AND submission_source = 'CUSTOMER_JAWAL_PAY'
      AND (TG_OP = 'INSERT' OR id IS DISTINCT FROM NEW.id);

    IF pending_count >= 3 THEN
      RAISE EXCEPTION 'Jawwal Pay already has three payments awaiting review'
        USING ERRCODE = '23514',
              CONSTRAINT = 'max_three_pending_jawwal_payments';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_max_three_pending_jawwal_payments
  ON public.qr_payment_submissions;

CREATE TRIGGER enforce_max_three_pending_jawwal_payments
BEFORE INSERT OR UPDATE OF status, submission_source, customer_id
ON public.qr_payment_submissions
FOR EACH ROW
EXECUTE FUNCTION public.enforce_max_three_pending_jawwal_payments();

COMMENT ON FUNCTION public.enforce_max_three_pending_jawwal_payments() IS
  'Allows up to three pending CUSTOMER_JAWAL_PAY submissions per customer; other payment methods are not restricted.';
