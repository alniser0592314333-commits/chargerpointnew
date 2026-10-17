-- Runtime regression for admin-bound SELECT policies and TRUNCATE revocation.
\set ON_ERROR_STOP on

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', false);
SELECT set_config('request.jwt.claims', '{"session_id":"11000000-0000-0000-0000-000000000001"}', false);
DO $admin_read$
BEGIN
  IF (SELECT count(*) FROM public.customers) <> 1 THEN
    RAISE EXCEPTION 'Active admin must retain customer read access';
  END IF;
  IF (SELECT count(*) FROM public.financial_ledger) <> 1 THEN
    RAISE EXCEPTION 'Active admin must retain financial ledger read access';
  END IF;
END
$admin_read$;

SELECT set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', false);
SELECT set_config('request.jwt.claims', '{"session_id":"11000000-0000-0000-0000-000000000002"}', false);
DO $nonadmin_read$
BEGIN
  IF (SELECT count(*) FROM public.customers) <> 0 THEN
    RAISE EXCEPTION 'Authenticated non-admin must not read customers';
  END IF;
  IF (SELECT count(*) FROM public.financial_ledger) <> 0 THEN
    RAISE EXCEPTION 'Authenticated non-admin must not read financial ledger';
  END IF;
  IF (SELECT count(*) FROM public.customer_requests) <> 0 THEN
    RAISE EXCEPTION 'Authenticated non-admin must not read customer requests';
  END IF;
END
$nonadmin_read$;
RESET ROLE;

DO $public_qr_contract$
DECLARE
  v_definition text := pg_get_functiondef('public.public_resolve_qr_payment_submission(text)'::regprocedure);
BEGIN
  IF position('balance_before_minor' IN v_definition) > 0
     OR position('balance_after_minor' IN v_definition) > 0 THEN
    RAISE EXCEPTION 'Public QR payment resolver exposes account balance before/after';
  END IF;
  IF NOT has_function_privilege('anon', 'public.public_resolve_qr_payment_submission(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.public_resolve_qr_payment_submission(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Public QR payment resolver execute contract was not preserved';
  END IF;
END
$public_qr_contract$;

DO $truncate_check$
BEGIN
  IF has_table_privilege('anon', 'public.customers', 'TRUNCATE') THEN
    RAISE EXCEPTION 'anon retains TRUNCATE on customers';
  END IF;
  IF has_table_privilege('authenticated', 'public.financial_ledger', 'TRUNCATE') THEN
    RAISE EXCEPTION 'authenticated retains TRUNCATE on financial_ledger';
  END IF;
  IF has_table_privilege('anon', 'public.customer_requests', 'TRUNCATE') THEN
    RAISE EXCEPTION 'anon retains TRUNCATE on customer_requests';
  END IF;
END
$truncate_check$;
