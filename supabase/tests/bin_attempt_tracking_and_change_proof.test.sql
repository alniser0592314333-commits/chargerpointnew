BEGIN;

DO $bin_rpc_acl_contract$
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.verify_admin_bin_with_attempt_tracking(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.verify_admin_bin(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.issue_bin_change_proof(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.change_admin_bin(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Required authenticated BIN RPC contract is missing';
  END IF;

  IF has_function_privilege('anon', 'public.verify_admin_bin_with_attempt_tracking(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.verify_admin_bin(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.verify_admin_bin_with_attempt_tracking__session_guarded_impl(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.set_admin_bin(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.set_admin_bin(text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A legacy or internal BIN RPC remains executable by browser roles';
  END IF;
END
$bin_rpc_acl_contract$;

UPDATE public.admins
SET bin_hash = crypt('1234', gen_salt('bf', 10)),
    bin_failed_attempts = 0,
    bin_status = 'ACTIVE',
    bin_locked_at = NULL
WHERE id = '10000000-0000-0000-0000-000000000002';

UPDATE auth.users
SET encrypted_password = crypt('test-password', gen_salt('bf', 10))
WHERE id = '11000000-0000-0000-0000-000000000002';

INSERT INTO auth.sessions(id, user_id, created_at, not_after)
VALUES (
  '11000000-0000-0000-0000-000000000009',
  '11000000-0000-0000-0000-000000000002',
  now(),
  NULL
)
ON CONFLICT (id) DO UPDATE
SET user_id = EXCLUDED.user_id, created_at = now(), not_after = NULL;

-- A second fresh session for the same Auth user must not be able to redeem
-- a proof issued to the first session.
INSERT INTO auth.sessions(id, user_id, created_at, not_after)
VALUES (
  '11000000-0000-0000-0000-000000000010',
  '11000000-0000-0000-0000-000000000002',
  now(),
  NULL
)
ON CONFLICT (id) DO UPDATE
SET user_id = EXCLUDED.user_id, created_at = now(), not_after = NULL;

SET LOCAL ROLE authenticated;

DO $bin_attempt_tracking$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000002', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"11000000-0000-0000-0000-000000000002","session_id":"11000000-0000-0000-0000-000000000009"}',
    true
  );

  v_result := public.verify_admin_bin_with_attempt_tracking('0000');
  IF v_result->>'success' IS DISTINCT FROM 'false'
     OR v_result->>'status' IS DISTINCT FROM 'ACTIVE'
     OR (v_result->>'failed_attempts')::integer <> 1
     OR (v_result->>'remaining_attempts')::integer <> 2 THEN
    RAISE EXCEPTION 'First incorrect BIN attempt was not recorded atomically: %', v_result;
  END IF;

  v_result := public.verify_admin_bin_with_attempt_tracking('0001');
  IF v_result->>'success' IS DISTINCT FROM 'false'
     OR (v_result->>'failed_attempts')::integer <> 2
     OR (v_result->>'remaining_attempts')::integer <> 1 THEN
    RAISE EXCEPTION 'Second incorrect BIN attempt was not recorded atomically: %', v_result;
  END IF;

  v_result := public.verify_admin_bin_with_attempt_tracking('0002');
  IF v_result->>'success' IS DISTINCT FROM 'false'
     OR v_result->>'status' IS DISTINCT FROM 'LOCKED'
     OR v_result->>'is_locked' IS DISTINCT FROM 'true'
     OR (v_result->>'failed_attempts')::integer <> 3
     OR (v_result->>'remaining_attempts')::integer <> 0 THEN
    RAISE EXCEPTION 'Third incorrect BIN attempt did not lock the account: %', v_result;
  END IF;

  v_result := public.verify_admin_bin_with_attempt_tracking('1234');
  IF v_result->>'success' IS DISTINCT FROM 'false'
     OR v_result->>'status' IS DISTINCT FROM 'LOCKED' THEN
    RAISE EXCEPTION 'A correct BIN bypassed an existing lock: %', v_result;
  END IF;
END
$bin_attempt_tracking$;

RESET ROLE;

UPDATE public.admins
SET bin_failed_attempts = 0, bin_status = 'ACTIVE', bin_locked_at = NULL
WHERE id = '10000000-0000-0000-0000-000000000002';

SET LOCAL ROLE authenticated;

DO $boolean_bin_contract$
DECLARE
  v_success boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000002', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"11000000-0000-0000-0000-000000000002","session_id":"11000000-0000-0000-0000-000000000009"}',
    true
  );
  v_success := public.verify_admin_bin('0000');
  IF v_success IS TRUE THEN
    RAISE EXCEPTION 'Boolean BIN RPC unexpectedly accepted an incorrect BIN';
  END IF;
END
$boolean_bin_contract$;

RESET ROLE;

DO $boolean_attempt_count$
DECLARE
  v_failed_attempts integer;
BEGIN
  SELECT bin_failed_attempts INTO v_failed_attempts
  FROM public.admins
  WHERE id = '10000000-0000-0000-0000-000000000002';
  IF v_failed_attempts <> 1 THEN
    RAISE EXCEPTION 'Boolean BIN RPC bypassed the shared attempt counter: %', v_failed_attempts;
  END IF;
END
$boolean_attempt_count$;

UPDATE public.admins
SET bin_failed_attempts = 0, bin_status = 'ACTIVE', bin_locked_at = NULL
WHERE id = '10000000-0000-0000-0000-000000000002';

UPDATE auth.sessions
SET created_at = now() - interval '10 minutes'
WHERE id = '11000000-0000-0000-0000-000000000009';

SET LOCAL ROLE authenticated;

DO $stale_session_rejected$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000002', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"11000000-0000-0000-0000-000000000002","session_id":"11000000-0000-0000-0000-000000000009"}',
    true
  );
  v_result := public.issue_bin_change_proof('1234');
  IF v_result->>'success' IS DISTINCT FROM 'false'
     OR v_result->>'error' NOT LIKE 'RECENT_REAUTH_REQUIRED%' THEN
    RAISE EXCEPTION 'A stale session obtained a BIN change proof: %', v_result;
  END IF;
END
$stale_session_rejected$;

RESET ROLE;

UPDATE auth.sessions
SET created_at = now()
WHERE id = '11000000-0000-0000-0000-000000000009';

SET LOCAL ROLE authenticated;

DO $bin_change_proof_flow$
DECLARE
  v_result jsonb;
  v_proof text;
  v_change jsonb;
  v_replay jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000002', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"11000000-0000-0000-0000-000000000002","session_id":"11000000-0000-0000-0000-000000000009"}',
    true
  );

  v_result := public.issue_bin_change_proof('1234');
  IF v_result->>'success' IS DISTINCT FROM 'true'
     OR length(v_result->>'proof_token') < 64
     OR v_result->>'purpose' IS DISTINCT FROM 'BIN_CHANGE' THEN
    RAISE EXCEPTION 'Current BIN verification did not issue a valid change proof: %', v_result;
  END IF;

  v_proof := v_result->>'proof_token';

  -- The same user on a different Auth session cannot redeem the proof.
  PERFORM set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"11000000-0000-0000-0000-000000000002","session_id":"11000000-0000-0000-0000-000000000010"}',
    true
  );
  v_change := public.change_admin_bin('5678', v_proof);
  IF v_change->>'success' IS DISTINCT FROM 'false'
     OR v_change->>'error' NOT LIKE 'INVALID_OR_EXPIRED_PROOF%' THEN
    RAISE EXCEPTION 'A different Auth session redeemed a BIN change proof: %', v_change;
  END IF;

  -- Restore the issuing session and confirm the proof remains usable there.
  PERFORM set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"11000000-0000-0000-0000-000000000002","session_id":"11000000-0000-0000-0000-000000000009"}',
    true
  );
  v_change := public.change_admin_bin('5678', v_proof);
  IF v_change->>'success' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Valid BIN change proof was rejected: %', v_change;
  END IF;

  v_replay := public.change_admin_bin('9999', v_proof);
  IF v_replay->>'success' IS DISTINCT FROM 'false'
     OR v_replay->>'error' NOT LIKE 'INVALID_OR_EXPIRED_PROOF%' THEN
    RAISE EXCEPTION 'A consumed BIN change proof was replayed: %', v_replay;
  END IF;

  v_result := public.verify_admin_bin_with_attempt_tracking('5678');
  IF v_result->>'success' IS DISTINCT FROM 'true'
     OR v_result->>'status' IS DISTINCT FROM 'ACTIVE'
     OR (v_result->>'failed_attempts')::integer <> 0 THEN
    RAISE EXCEPTION 'The newly configured BIN did not verify correctly: %', v_result;
  END IF;
END
$bin_change_proof_flow$;

RESET ROLE;

DO $bin_change_audit$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_audit_logs
    WHERE actor_admin_id = '10000000-0000-0000-0000-000000000002'
      AND target_admin_id = '10000000-0000-0000-0000-000000000002'
      AND action = 'ADMIN_BIN_SELF_CHANGE'
  ) THEN
    RAISE EXCEPTION 'Successful BIN change was not audited';
  END IF;
END
$bin_change_audit$;

ROLLBACK;
