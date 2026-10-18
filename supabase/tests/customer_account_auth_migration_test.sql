DO $test$
DECLARE
  i integer;
  allowed boolean;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.customer_account_links'::regclass) THEN
    RAISE EXCEPTION 'customer_account_links must have RLS enabled';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.customer_account_sessions'::regclass) THEN
    RAISE EXCEPTION 'customer_account_sessions must have RLS enabled';
  END IF;
  IF has_table_privilege('anon', 'public.customer_account_links', 'SELECT')
     OR has_table_privilege('authenticated', 'public.customer_account_links', 'SELECT') THEN
    RAISE EXCEPTION 'customer account link table must not be directly readable by browser roles';
  END IF;
  IF has_function_privilege('anon', 'public.public_resolve_customer_portal(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.public_resolve_customer_portal(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'customer portal projection must not be directly executable by browser roles';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.public_resolve_customer_portal(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must retain access to customer portal projection';
  END IF;

  FOR i IN 1..3 LOOP
    allowed := public.customer_account_consume_rate_limit('test-customer-123456', 'LOGIN', 3, 900, false);
    IF NOT allowed THEN RAISE EXCEPTION 'rate limiter blocked before the configured attempt limit'; END IF;
  END LOOP;
  IF public.customer_account_consume_rate_limit('test-customer-123456', 'LOGIN', 3, 900, false) THEN
    RAISE EXCEPTION 'rate limiter allowed an attempt over the configured limit';
  END IF;
  IF NOT public.customer_account_consume_rate_limit('test-customer-123456', 'LOGIN', 3, 900, true) THEN
    RAISE EXCEPTION 'rate limiter reset failed';
  END IF;
  IF NOT public.customer_account_consume_rate_limit('test-customer-123456', 'LOGIN', 3, 900, false) THEN
    RAISE EXCEPTION 'rate limiter did not permit an attempt after reset';
  END IF;
END;
$test$;
