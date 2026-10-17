\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.sessions(id, user_id, created_at, not_after)
VALUES ('11000000-0000-0000-0000-000000000009',
        '11000000-0000-0000-0000-000000000002', now(), NULL)
ON CONFLICT (id) DO UPDATE
SET user_id = EXCLUDED.user_id, created_at = now(), not_after = NULL;

SET LOCAL ROLE authenticated;
DO $rotate_and_create_qr$
DECLARE
  v_customer_first text;
  v_customer_second text;
  v_order_first text;
  v_order_second text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000002', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"11000000-0000-0000-0000-000000000002","session_id":"11000000-0000-0000-0000-000000000009"}',
    true
  );

  v_customer_first := public.rotate_customer_qr('20000000-0000-0000-0000-000000000001');
  v_customer_second := public.rotate_customer_qr('20000000-0000-0000-0000-000000000001');
  IF v_customer_first = v_customer_second THEN
    RAISE EXCEPTION 'QR rotation did not issue a new capability token';
  END IF;
  PERFORM set_config('test.qr_customer_first', v_customer_first, true);
  PERFORM set_config('test.qr_customer_second', v_customer_second, true);

  v_order_first := public.get_or_create_order_qr('30000000-0000-0000-0000-000000000001');
  v_order_second := public.get_or_create_order_qr('30000000-0000-0000-0000-000000000001');
  IF v_order_first IS DISTINCT FROM v_order_second THEN
    RAISE EXCEPTION 'Order QR get-or-create was not idempotent while its token was active';
  END IF;
  PERFORM set_config('test.qr_order_token_old', v_order_first, true);
END
$rotate_and_create_qr$;
RESET ROLE;

-- An expired-but-still-active order token must be deactivated and replaced.
UPDATE public.qr_tokens
SET expires_at = now() - interval '1 second'
WHERE public_token = current_setting('test.qr_order_token_old', true);

SET LOCAL ROLE authenticated;
DO $replace_expired_order_qr$
DECLARE
  v_new_token text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000002', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"11000000-0000-0000-0000-000000000002","session_id":"11000000-0000-0000-0000-000000000009"}',
    true
  );
  v_new_token := public.get_or_create_order_qr('30000000-0000-0000-0000-000000000001');
  IF v_new_token IS NULL OR v_new_token = current_setting('test.qr_order_token_old', true) THEN
    RAISE EXCEPTION 'Expired order QR token was returned instead of being replaced';
  END IF;
  PERFORM set_config('test.qr_order_token_new', v_new_token, true);
END
$replace_expired_order_qr$;
RESET ROLE;

DO $qr_single_active_invariant$
DECLARE
  v_count integer;
  v_current_token text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'qr_tokens_one_active_token_per_target_type'
  ) THEN
    RAISE EXCEPTION 'Unique active-QR index is missing';
  END IF;

  IF position('pg_advisory_xact_lock' IN pg_get_functiondef(
    'public.rotate_customer_qr__session_guarded_impl(uuid)'::regprocedure
  )) = 0 OR position('pg_advisory_xact_lock' IN pg_get_functiondef(
    'public.get_or_create_order_qr__session_guarded_impl(uuid)'::regprocedure
  )) = 0 THEN
    RAISE EXCEPTION 'Customer rotation/order creation is missing its transaction-scoped advisory lock';
  END IF;

  SELECT count(*), max(public_token)
    INTO v_count, v_current_token
  FROM public.qr_tokens
  WHERE target_id = '20000000-0000-0000-0000-000000000001'
    AND token_type = 'CUSTOMER'
    AND is_active IS TRUE;

  IF v_count <> 1 OR v_current_token IS DISTINCT FROM current_setting('test.qr_customer_second', true) THEN
    RAISE EXCEPTION 'Customer QR rotation left an invalid active-token state (count=%)', v_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.qr_tokens
    WHERE public_token = v_current_token
      AND token_hash = encode(public.digest(public_token, 'sha256'), 'hex')
  ) THEN
    RAISE EXCEPTION 'Rotated customer QR token hash does not match its capability token';
  END IF;

  SELECT count(*), max(public_token)
    INTO v_count, v_current_token
  FROM public.qr_tokens
  WHERE target_id = '30000000-0000-0000-0000-000000000001'
    AND token_type = 'ORDER'
    AND is_active IS TRUE;

  IF v_count <> 1 OR v_current_token IS DISTINCT FROM current_setting('test.qr_order_token_new', true) THEN
    RAISE EXCEPTION 'Order QR creation left an invalid active-token state (count=%)', v_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.qr_tokens
    WHERE public_token = v_current_token
      AND token_hash = encode(public.digest(public_token, 'sha256'), 'hex')
      AND (expires_at IS NULL OR expires_at > now())
  ) THEN
    RAISE EXCEPTION 'Replacement order QR token is expired or its hash is invalid';
  END IF;
END
$qr_single_active_invariant$;

ROLLBACK;
