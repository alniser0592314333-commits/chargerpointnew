\set ON_ERROR_STOP on
BEGIN;

UPDATE auth.sessions
SET created_at = now(), not_after = NULL
WHERE id = '11000000-0000-0000-0000-000000000009';

SET LOCAL ROLE authenticated;
DO $rotate_customer_qr_twice$
DECLARE
  v_first text;
  v_second text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000002', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"11000000-0000-0000-0000-000000000002","session_id":"11000000-0000-0000-0000-000000000009"}',
    true
  );

  v_first := public.rotate_customer_qr('20000000-0000-0000-0000-000000000001');
  v_second := public.rotate_customer_qr('20000000-0000-0000-0000-000000000001');
  IF v_first = v_second THEN
    RAISE EXCEPTION 'QR rotation did not issue a new capability token';
  END IF;

  PERFORM set_config('test.qr_token_first', v_first, true);
  PERFORM set_config('test.qr_token_second', v_second, true);
END
$rotate_customer_qr_twice$;
RESET ROLE;

DO $qr_single_active_invariant$
DECLARE
  v_count integer;
  v_current_token text;
BEGIN
  IF current_setting('test.qr_token_first', true) = current_setting('test.qr_token_second', true) THEN
    RAISE EXCEPTION 'QR token values were not rotated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'qr_tokens_one_active_token_per_target_type'
  ) THEN
    RAISE EXCEPTION 'Unique active-QR index is missing';
  END IF;

  IF position('pg_advisory_xact_lock' IN pg_get_functiondef(
    'public.rotate_customer_qr__session_guarded_impl(uuid)'::regprocedure
  )) = 0 THEN
    RAISE EXCEPTION 'Customer QR rotation is missing its transaction-scoped advisory lock';
  END IF;

  SELECT count(*), max(public_token)
    INTO v_count, v_current_token
  FROM public.qr_tokens
  WHERE target_id = '20000000-0000-0000-0000-000000000001'
    AND token_type = 'CUSTOMER'
    AND is_active IS TRUE;

  IF v_count <> 1 OR v_current_token IS DISTINCT FROM current_setting('test.qr_token_second', true) THEN
    RAISE EXCEPTION 'QR rotation left an invalid active-token state (count=%)', v_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.qr_tokens
    WHERE public_token = v_current_token
      AND token_hash = encode(public.digest(public_token, 'sha256'), 'hex')
  ) THEN
    RAISE EXCEPTION 'Rotated QR token hash does not match its capability token';
  END IF;
END
$qr_single_active_invariant$;

ROLLBACK;
