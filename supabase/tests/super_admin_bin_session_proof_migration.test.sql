\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
 ('10000000-0000-4000-8000-000000000001','super@example.test',now()),
 ('10000000-0000-4000-8000-000000000002','admin@example.test',now());
INSERT INTO public.admins(id,auth_user_id,role,is_active,disabled_at) VALUES
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','SUPER_ADMIN',true,NULL),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','ADMIN',true,NULL);
INSERT INTO auth.sessions(id,user_id,created_at,not_after) VALUES
 ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',now(),NULL),
 ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',now(),NULL),
 ('30000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002',now(),NULL);

DO $acl$
BEGIN
  IF has_table_privilege('authenticated','public.admin_bin_session_proofs','SELECT')
     OR has_table_privilege('anon','public.admin_bin_session_proofs','SELECT')
     OR has_table_privilege('service_role','public.admin_bin_session_proofs','SELECT') THEN
    RAISE EXCEPTION 'BIN session proof table is directly readable by a client/service role';
  END IF;
  IF has_function_privilege('authenticated','public.consume_my_super_admin_bin_session_proof()','EXECUTE')
     OR has_function_privilege('service_role','public.consume_my_super_admin_bin_session_proof()','EXECUTE')
     OR has_function_privilege('authenticated','public.register_my_account_session_v2__bin_proof_impl(text,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.reactivate_my_account_session__bin_proof_impl(text)','EXECUTE')
     OR has_function_privilege('authenticated','public.verify_admin_bin(text)','EXECUTE')
     OR has_function_privilege('service_role','public.register_my_account_session_v2(text,text)','EXECUTE')
     OR has_function_privilege('service_role','public.reactivate_my_account_session(text)','EXECUTE') THEN
    RAISE EXCEPTION 'A private BIN/session implementation or legacy/service-role path remains executable';
  END IF;
  IF NOT has_function_privilege('authenticated','public.register_my_account_session_v2(text,text)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.reactivate_my_account_session(text)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.verify_admin_bin_with_attempt_tracking(text)','EXECUTE') THEN
    RAISE EXCEPTION 'Authenticated application RPC grants were not preserved';
  END IF;
END
$acl$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000001","session_id":"30000000-0000-4000-8000-000000000001"}',true);

-- A Super Admin cannot register a new application session without first
-- verifying the BIN in this exact Auth session.
DO $missing_proof$
BEGIN
  BEGIN
    PERFORM public.register_my_account_session_v2('test','native');
    RAISE EXCEPTION 'Super Admin registered a new app session without BIN proof';
  EXCEPTION WHEN SQLSTATE '28000' THEN NULL;
  END;
END
$missing_proof$;

RESET ROLE;
DO $rejected_registration_no_row$
BEGIN
  IF public.fixture_account_session_exists('30000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'Rejected registration created an account_sessions row';
  END IF;
END
$rejected_registration_no_row$;
SET LOCAL ROLE authenticated;

-- The attempt-tracked verifier creates a proof only after a successful BIN
-- result, and the proof is tied to the current Auth session.
DO $issue_proof$
DECLARE v_result jsonb;
BEGIN
  v_result := public.verify_admin_bin_with_attempt_tracking('wrong');
  IF v_result->>'success' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'Incorrect BIN unexpectedly verified';
  END IF;
  IF public.fixture_bin_proof_state('30000000-0000-4000-8000-000000000001','any') THEN
    RAISE EXCEPTION 'Incorrect BIN attempt issued a session proof';
  END IF;
  v_result := public.verify_admin_bin_with_attempt_tracking('correct');
  IF v_result->>'success' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Correct BIN was not accepted';
  END IF;
  IF NOT public.fixture_bin_proof_state('30000000-0000-4000-8000-000000000001','unconsumed') THEN
    RAISE EXCEPTION 'Successful BIN verification did not create a fresh session-bound proof';
  END IF;
END
$issue_proof$;

-- A different fresh session for the same Auth user cannot consume this proof.
SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000001","session_id":"30000000-0000-4000-8000-000000000002"}',true);
DO $cross_session$
BEGIN
  BEGIN
    PERFORM public.register_my_account_session_v2('test','native');
    RAISE EXCEPTION 'A second Auth session reused another session\x27s BIN proof';
  EXCEPTION WHEN SQLSTATE '28000' THEN NULL;
  END;
END
$cross_session$;

-- The original session can consume its own proof exactly once.
SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000001","session_id":"30000000-0000-4000-8000-000000000001"}',true);
SELECT public.register_my_account_session_v2('test','native');
DO $consumed$
BEGIN
  IF NOT public.fixture_bin_proof_state('30000000-0000-4000-8000-000000000001','consumed') THEN
    RAISE EXCEPTION 'Successful session registration did not consume its BIN proof';
  END IF;
  IF NOT public.is_my_account_session_active() THEN
    RAISE EXCEPTION 'Registered Super Admin session did not become active';
  END IF;
END
$consumed$;

-- A regular active administrator is not forced through the Super Admin BIN
-- gate, while still using the same authenticated session registry.
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"10000000-0000-4000-8000-000000000002","session_id":"30000000-0000-4000-8000-000000000003"}',true);
SELECT public.register_my_account_session_v2('test','browser');
DO $regular_admin$
BEGIN
  IF NOT public.fixture_account_session_exists('30000000-0000-4000-8000-000000000003') THEN
    RAISE EXCEPTION 'Regular active administrator could not register without Super Admin BIN proof';
  END IF;
  IF public.fixture_bin_proof_state('30000000-0000-4000-8000-000000000003','any') THEN
    RAISE EXCEPTION 'Regular administrator unexpectedly received a Super Admin BIN proof';
  END IF;
END
$regular_admin$;

RESET ROLE;
ROLLBACK;
