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

  INSERT INTO public.customers (id, name, is_active, status)
  VALUES ('11111111-1111-4111-8111-111111111111', 'Test Customer', true, 'ACTIVE');
  INSERT INTO auth.users (id) VALUES ('22222222-2222-4222-8222-222222222222');
  INSERT INTO public.customer_account_links (
    customer_id, auth_user_id, login_email, auth_provider, account_status,
    must_change_password, email_verified, terms_version, terms_accepted_at
  ) VALUES (
    '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
    'test@accounts.example', 'password', 'ACTIVE', false, false, '2026-10-18-v1', statement_timestamp()
  );
  INSERT INTO public.customer_account_sessions (
    customer_id, auth_user_id, session_id, auth_issued_at, expires_at
  ) VALUES (
    '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333', extract(epoch FROM statement_timestamp())::bigint,
    statement_timestamp() + interval '7 days'
  );
  INSERT INTO public.qr_tokens (public_token, target_id, token_type, is_active)
  VALUES ('customer-token-test-012345678901234567890', '11111111-1111-4111-8111-111111111111', 'CUSTOMER', true);
  INSERT INTO public.qr_payment_submissions (
    id, status, amount_minor, payment_method, created_at, updated_at, customer_id
  ) VALUES (
    '44444444-4444-4444-8444-444444444444', 'PENDING', 0, 'PALPAY',
    statement_timestamp(), statement_timestamp(), '11111111-1111-4111-8111-111111111111'
  );
  INSERT INTO public.orders (id, customer_id)
  VALUES ('55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111');
  INSERT INTO public.qr_tokens (public_token, target_id, token_type, is_active)
  VALUES ('order-token-test-012345678901234567890', '55555555-5555-4555-8555-555555555555', 'ORDER', true);
  INSERT INTO public.qr_payment_submissions (
    id, status, amount_minor, payment_method, created_at, updated_at, order_id, customer_id
  ) VALUES (
    '66666666-6666-4666-8666-666666666666', 'PENDING', 1000, 'PALPAY',
    statement_timestamp(), statement_timestamp(), '55555555-5555-4555-8555-555555555555',
    '11111111-1111-4111-8111-111111111111'
  );

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{}', true);
  IF public.public_resolve_qr_payment_submission('customer-token-test-012345678901234567890') IS NOT NULL THEN
    RAISE EXCEPTION 'anonymous customer QR payment status must be hidden';
  END IF;
  IF public.public_resolve_qr_payment_submission('order-token-test-012345678901234567890') ->> 'status' <> 'PENDING' THEN
    RAISE EXCEPTION 'public order QR payment status must remain available without customer account login';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
  PERFORM set_config('request.jwt.claims',
    '{"sub":"22222222-2222-4222-8222-222222222222","session_id":"33333333-3333-4333-8333-333333333333"}', true);
  IF public.public_resolve_qr_payment_submission('customer-token-test-012345678901234567890') ->> 'status' <> 'PENDING' THEN
    RAISE EXCEPTION 'active customer session should see its payment status';
  END IF;

  UPDATE public.customer_account_sessions SET revoked_at = statement_timestamp()
  WHERE customer_id = '11111111-1111-4111-8111-111111111111';
  IF public.public_resolve_qr_payment_submission('customer-token-test-012345678901234567890') IS NOT NULL THEN
    RAISE EXCEPTION 'revoked customer session must not see payment status';
  END IF;

END;
$test$;
