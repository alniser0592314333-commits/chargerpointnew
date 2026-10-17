-- Run after 20261017193000_fix_customer_qr_resolution_contract.sql.
DO $test$
DECLARE
  v_result record;
  v_count integer;
  v_result_type text;
  v_token text;
  v_token_again text;
  v_created_token text;
BEGIN
  INSERT INTO public.customers (id, name, status, is_active, deleted_at) VALUES
    ('a1b2c3d4-1111-4111-8111-111111111111', 'Active Customer', 'ACTIVE', true, NULL),
    ('b2c3d4e5-2222-4222-8222-222222222222', 'Inactive Customer', 'INACTIVE', false, NULL),
    ('c3d4e5f6-3333-4333-8333-333333333333', 'Deleted Customer', 'ACTIVE', true, now()),
    ('d4e5f6a7-4444-4444-8444-444444444444', 'Legacy QR Customer', 'ACTIVE', true, NULL),
    ('e5f6a7b8-5555-4555-8555-555555555555', 'Expired QR Customer', 'ACTIVE', true, NULL);

  INSERT INTO public.qr_tokens (id, token_hash, public_token, token_type, target_id, is_active, expires_at) VALUES
    ('11111111-aaaa-4111-8111-111111111111', 'hash-active', 'valid-customer-token-000000000001', 'CUSTOMER', 'a1b2c3d4-1111-4111-8111-111111111111', true, NULL),
    ('22222222-bbbb-4222-8222-222222222222', 'hash-inactive', 'inactive-customer-token-00000000002', 'CUSTOMER', 'b2c3d4e5-2222-4222-8222-222222222222', true, NULL),
    ('33333333-cccc-4333-8333-333333333333', 'hash-deleted', 'deleted-customer-token-00000000003', 'CUSTOMER', 'c3d4e5f6-3333-4333-8333-333333333333', true, NULL),
    ('44444444-dddd-4444-8444-444444444444', 'hash-expired', 'expired-customer-token-000000000004', 'CUSTOMER', 'e5f6a7b8-5555-4555-8555-555555555555', true, now() - interval '1 minute'),
    ('55555555-eeee-4555-8555-555555555555', 'hash-order', 'order-token-not-customer-000000001', 'ORDER', 'a1b2c3d4-1111-4111-8111-111111111111', true, NULL);

  SELECT * INTO v_result
  FROM public.public_resolve_customer_qr('valid-customer-token-000000000001');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'A valid active customer QR did not resolve';
  END IF;
  IF v_result.customer_name <> 'Active Customer' THEN
    RAISE EXCEPTION 'Unexpected customer name: %', v_result.customer_name;
  END IF;
  IF v_result.customer_code <> 'A1B2' THEN
    RAISE EXCEPTION 'Unexpected customer code: %', v_result.customer_code;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.public_resolve_customer_qr('inactive-customer-token-00000000002');
  IF v_count <> 0 THEN RAISE EXCEPTION 'Inactive customer QR must not resolve'; END IF;

  SELECT count(*) INTO v_count
  FROM public.public_resolve_customer_qr('deleted-customer-token-00000000003');
  IF v_count <> 0 THEN RAISE EXCEPTION 'Soft-deleted customer QR must not resolve'; END IF;

  SELECT count(*) INTO v_count
  FROM public.public_resolve_customer_qr('expired-customer-token-000000000004');
  IF v_count <> 0 THEN RAISE EXCEPTION 'Expired customer QR must not resolve'; END IF;

  SELECT count(*) INTO v_count
  FROM public.public_resolve_customer_qr('order-token-not-customer-000000001');
  IF v_count <> 0 THEN RAISE EXCEPTION 'Order QR must not resolve through customer resolver'; END IF;

  SELECT count(*) INTO v_count
  FROM public.public_resolve_customer_qr('unknown-customer-token-000000000000');
  IF v_count <> 0 THEN RAISE EXCEPTION 'Unknown QR token must return no rows'; END IF;

  SELECT pg_get_function_result('public.public_resolve_customer_qr(text)'::regprocedure)
    INTO v_result_type;
  IF v_result_type <> 'TABLE(customer_name text, customer_code text)' THEN
    RAISE EXCEPTION 'Unexpected resolver result contract: %', v_result_type;
  END IF;

  IF NOT has_function_privilege('anon', 'public.public_resolve_customer_qr(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must be able to resolve public customer QR links';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.public_resolve_customer_qr(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must be able to resolve public customer QR links';
  END IF;

  IF has_function_privilege('anon', 'public.adopt_customer_qr_token(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not be able to adopt legacy customer QR tokens';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.adopt_customer_qr_token(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must be able to adopt legacy customer QR tokens';
  END IF;

  -- The old local-only link is preserved if it has never been registered.
  SELECT public.adopt_customer_qr_token(
    'd4e5f6a7-4444-4444-8444-444444444444',
    'legacy-customer-token-0000000001'
  ) INTO v_token;
  IF v_token <> 'legacy-customer-token-0000000001' THEN
    RAISE EXCEPTION 'Legacy QR token was not preserved: %', v_token;
  END IF;

  SELECT * INTO v_result
  FROM public.public_resolve_customer_qr(v_token);
  IF NOT FOUND OR v_result.customer_name <> 'Legacy QR Customer' OR v_result.customer_code <> 'D4E5' THEN
    RAISE EXCEPTION 'Adopted legacy QR did not resolve to its customer';
  END IF;

  -- Repeated adoption is idempotent and never overwrites a current central token.
  SELECT public.adopt_customer_qr_token(
    'd4e5f6a7-4444-4444-8444-444444444444',
    'another-legacy-token-00000000002'
  ) INTO v_token_again;
  IF v_token_again <> v_token THEN
    RAISE EXCEPTION 'Legacy QR adoption replaced the canonical token';
  END IF;

  -- get-or-create must retire an expired active row instead of returning its dead link.
  SELECT public.get_or_create_customer_qr('e5f6a7b8-5555-4555-8555-555555555555')
    INTO v_created_token;
  IF v_created_token IS NULL OR v_created_token = 'expired-customer-token-000000000004' THEN
    RAISE EXCEPTION 'get_or_create returned an expired customer QR token';
  END IF;
  SELECT count(*) INTO v_count
  FROM public.qr_tokens
  WHERE public_token = 'expired-customer-token-000000000004' AND is_active = TRUE;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Expired customer QR token remained active';
  END IF;
  SELECT * INTO v_result FROM public.public_resolve_customer_qr(v_created_token);
  IF NOT FOUND OR v_result.customer_name <> 'Expired QR Customer' THEN
    RAISE EXCEPTION 'New customer QR token did not resolve after expiry repair';
  END IF;
END;
$test$;
