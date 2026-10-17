\set ON_ERROR_STOP on
BEGIN;

-- Prepare both active Auth sessions and a locked account. All data is synthetic.
INSERT INTO auth.users(id, email, email_confirmed_at)
VALUES ('11000000-0000-0000-0000-000000000001', 'super@example.test', now())
ON CONFLICT (id) DO UPDATE
SET email = EXCLUDED.email, email_confirmed_at = EXCLUDED.email_confirmed_at;

UPDATE auth.users
SET encrypted_password = crypt('test-password', gen_salt('bf', 10))
WHERE id = '11000000-0000-0000-0000-000000000002';

INSERT INTO auth.sessions(id, user_id, created_at, not_after)
VALUES
  ('11000000-0000-0000-0000-000000000009', '11000000-0000-0000-0000-000000000002', now(), NULL),
  ('11000000-0000-0000-0000-000000000010', '11000000-0000-0000-0000-000000000002', now(), NULL)
ON CONFLICT (id) DO UPDATE
SET user_id = EXCLUDED.user_id, created_at = now(), not_after = NULL;

INSERT INTO auth.sessions(id, user_id, created_at, not_after)
VALUES ('11000000-0000-0000-0000-000000000011',
        '11000000-0000-0000-0000-000000000001', now(), NULL)
ON CONFLICT (id) DO UPDATE
SET user_id = EXCLUDED.user_id, created_at = now(), not_after = NULL;

UPDATE public.admins
SET bin_status = 'LOCKED', bin_failed_attempts = 3, bin_locked_at = now()
WHERE id IN (
  '10000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002'
);

SET LOCAL ROLE authenticated;
DO $recovery_proof_session_binding$
DECLARE
  v_issued jsonb;
  v_proof text;
  v_result jsonb;
  v_bin_check jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000002', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"11000000-0000-0000-0000-000000000002","session_id":"11000000-0000-0000-0000-000000000009"}',
    true
  );

  v_issued := public.issue_bin_recovery_proof('test-password');
  IF v_issued->>'success' IS DISTINCT FROM 'true'
     OR v_issued->>'purpose' IS DISTINCT FROM 'BIN_RECOVERY'
     OR length(v_issued->>'proof_token') < 64 THEN
    RAISE EXCEPTION 'Fresh password re-authentication did not issue a recovery proof: %', v_issued;
  END IF;
  v_proof := v_issued->>'proof_token';

  -- A second live session for the same user must not redeem the proof.
  PERFORM set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"11000000-0000-0000-0000-000000000002","session_id":"11000000-0000-0000-0000-000000000010"}',
    true
  );
  v_result := public.recover_and_reset_admin_bin('5678', v_proof);
  IF v_result->>'success' IS DISTINCT FROM 'false'
     OR v_result->>'error' NOT LIKE 'INVALID_OR_EXPIRED_PROOF%' THEN
    RAISE EXCEPTION 'A different session for the same user redeemed a recovery proof: %', v_result;
  END IF;

  -- A different active user with its own locked admin account cannot redeem it either.
  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000001', true);
  PERFORM set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"11000000-0000-0000-0000-000000000001","session_id":"11000000-0000-0000-0000-000000000011"}',
    true
  );
  v_result := public.recover_and_reset_admin_bin('5678', v_proof);
  IF v_result->>'success' IS DISTINCT FROM 'false'
     OR v_result->>'error' NOT LIKE 'INVALID_OR_EXPIRED_PROOF%' THEN
    RAISE EXCEPTION 'A different Auth user redeemed a recovery proof: %', v_result;
  END IF;

  -- Restore the issuing identity and exact session; the proof should still work.
  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000002', true);
  PERFORM set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"11000000-0000-0000-0000-000000000002","session_id":"11000000-0000-0000-0000-000000000009"}',
    true
  );
  v_result := public.recover_and_reset_admin_bin('5678', v_proof);
  IF v_result->>'success' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'The issuing session could not redeem its valid recovery proof: %', v_result;
  END IF;

  v_result := public.recover_and_reset_admin_bin('9999', v_proof);
  IF v_result->>'success' IS DISTINCT FROM 'false'
     OR v_result->>'error' NOT LIKE 'INVALID_OR_EXPIRED_PROOF%' THEN
    RAISE EXCEPTION 'A consumed recovery proof was replayed: %', v_result;
  END IF;

  v_bin_check := public.verify_admin_bin_with_attempt_tracking('5678');
  IF v_bin_check->>'success' IS DISTINCT FROM 'true'
     OR v_bin_check->>'status' IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'Recovered BIN did not verify or account did not unlock: %', v_bin_check;
  END IF;
END
$recovery_proof_session_binding$;

RESET ROLE;
DO $recovery_audit$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.admin_audit_logs
    WHERE actor_admin_id = '10000000-0000-0000-0000-000000000002'
      AND target_admin_id = '10000000-0000-0000-0000-000000000002'
      AND action = 'ADMIN_BIN_RECOVERY'
      AND metadata->>'proofPurpose' = 'BIN_RECOVERY'
  ) THEN
    RAISE EXCEPTION 'Successful BIN recovery was not audited';
  END IF;
END
$recovery_audit$;

ROLLBACK;
