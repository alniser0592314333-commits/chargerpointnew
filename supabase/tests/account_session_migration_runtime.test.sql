\set ON_ERROR_STOP on

-- Guard wrappers must preserve the volatility contract of their original RPC.
DO $assert$
BEGIN
  IF (SELECT p.provolatile FROM pg_proc p
      WHERE p.oid = 'public.fixture_sensitive_read()'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'Stable SECURITY DEFINER RPC wrapper lost STABLE volatility';
  END IF;
END $assert$;
INSERT INTO auth.users(id,email) VALUES
 ('11111111-1111-4111-8111-111111111111','one@example.test'),
 ('22222222-2222-4222-8222-222222222222','two@example.test');

INSERT INTO auth.sessions(id,user_id,created_at,updated_at,user_agent) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111',now()-interval '2 days',now()-interval '1 hour','Windows Chrome'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111',now()-interval '1 day',now()-interval '2 hours','Android Samsung Internet'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','22222222-2222-4222-8222-222222222222',now()-interval '1 day',now(),'Other account');
INSERT INTO auth.refresh_tokens(user_id,session_id,revoked) VALUES
 ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false),
 ('11111111-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',false),
 ('22222222-2222-4222-8222-222222222222','cccccccc-cccc-4ccc-8ccc-cccccccccccc',false);

-- User one sees only own sessions, and the current one is marked correctly.
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
SELECT set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","session_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}',false);
SELECT public.register_my_account_session('Browser-provided UA');
DO $assert$
DECLARE v_sessions jsonb;
BEGIN
  v_sessions := public.get_my_account_sessions();
  IF jsonb_array_length(v_sessions) <> 2 THEN RAISE EXCEPTION 'Expected exactly two sessions for user one, got %', v_sessions; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_sessions) s WHERE s->>'session_id'='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND (s->>'is_current')::boolean) THEN
    RAISE EXCEPTION 'Current session was not marked';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_sessions) s WHERE s->>'session_id'='cccccccc-cccc-4ccc-8ccc-cccccccccccc') THEN
    RAISE EXCEPTION 'Session belonging to another account leaked';
  END IF;
END $assert$;

-- Revoking the other session expires the auth session and its refresh tokens.
SELECT public.revoke_my_account_session('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.account_sessions WHERE session_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' AND revoked_at IS NOT NULL) THEN RAISE EXCEPTION 'Session registry did not record revocation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.sessions WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' AND not_after <= now()) THEN RAISE EXCEPTION 'Auth session was not expired'; END IF;
  IF EXISTS (SELECT 1 FROM auth.refresh_tokens WHERE session_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' AND revoked=false) THEN RAISE EXCEPTION 'Refresh token was not revoked'; END IF;
  IF public.is_my_account_session_active() IS NOT TRUE THEN RAISE EXCEPTION 'Revoking another session revoked the current one'; END IF;
END $assert$;

-- The owner cannot revoke a session from another account.
DO $assert$
BEGIN
  BEGIN
    PERFORM public.revoke_my_account_session('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    RAISE EXCEPTION 'Cross-account revocation unexpectedly succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'Cross-account revocation unexpectedly succeeded' THEN RAISE; END IF;
  END;
END $assert$;

-- "Other sessions" preserves the current session; "all" records and expires every session.
SELECT public.revoke_other_account_sessions();
DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.sessions WHERE id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND (not_after IS NULL OR not_after > now())) THEN RAISE EXCEPTION 'Current session was not preserved'; END IF;
  IF public.is_my_account_session_active() IS NOT TRUE THEN RAISE EXCEPTION 'Current session should remain active'; END IF;
END $assert$;
SELECT public.revoke_all_account_sessions();
DO $assert$
BEGIN
  IF public.is_my_account_session_active() IS NOT FALSE THEN RAISE EXCEPTION 'All-session revoke did not mark current session inactive'; END IF;
  IF EXISTS (SELECT 1 FROM auth.refresh_tokens WHERE user_id='11111111-1111-4111-8111-111111111111' AND revoked=false) THEN RAISE EXCEPTION 'All-session revoke left a refresh token active'; END IF;
END $assert$;

-- Direct browser roles have no table access and anonymous callers cannot execute RPCs.
DO $assert$
BEGIN
  IF has_table_privilege('authenticated','public.account_sessions','SELECT') THEN RAISE EXCEPTION 'Authenticated role can read the private session table directly'; END IF;
  IF has_function_privilege('anon','public.get_my_account_sessions()','EXECUTE') THEN RAISE EXCEPTION 'Anonymous role can call account session RPC'; END IF;
END $assert$;

-- A still-unregistered session is tolerated during rollout only while its Auth
-- session row exists and is unexpired. A stale JWT must fail this client gate
-- after its underlying Auth session has disappeared.
INSERT INTO auth.sessions(id,user_id,created_at,updated_at,not_after,user_agent)
VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','11111111-1111-4111-8111-111111111111',now(),now(),NULL,'Test session');
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
SELECT set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","session_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}',false);
DO $assert$
BEGIN
  IF public.is_my_account_session_active() IS NOT TRUE THEN
    RAISE EXCEPTION 'A valid unregistered Auth session should be tolerated during rollout';
  END IF;
END $assert$;
DELETE FROM auth.sessions WHERE id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
DO $assert$
BEGIN
  IF public.is_my_account_session_active() IS NOT FALSE THEN
    RAISE EXCEPTION 'A missing underlying Auth session must not be reported active';
  END IF;
END $assert$;


-- Server-side enforcement regression: a valid unregistered Auth session may
-- read business data during rollout; after expiry the same stale JWT must be
-- denied by both the table RLS policy and an exposed SECURITY DEFINER RPC.
INSERT INTO auth.sessions(id,user_id,created_at,updated_at,not_after,user_agent)
VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','11111111-1111-4111-8111-111111111111',now(),now(),NULL,'Gate test');
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
SELECT set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","session_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"}',true);
DO $assert$
DECLARE v_count integer; v_secret text;
BEGIN
  SELECT count(*) INTO v_count FROM public.session_guard_fixture;
  IF v_count <> 1 THEN RAISE EXCEPTION 'Active Auth session should retain existing authenticated RLS read'; END IF;
  SELECT public.fixture_sensitive_read() INTO v_secret;
  IF v_secret <> 'fixture-secret' THEN RAISE EXCEPTION 'Active session SECURITY DEFINER RPC returned an unexpected result'; END IF;
  IF (SELECT count(*) FROM public.fixture_sensitive_setof()) <> 1 THEN
    RAISE EXCEPTION 'Active session SETOF SECURITY DEFINER RPC was not wrapped correctly';
  END IF;
  PERFORM public.fixture_sensitive_void('active-session');
  IF (SELECT count(*) FROM public.session_guard_fixture_audit WHERE marker = 'active-session') <> 1 THEN
    RAISE EXCEPTION 'Active session VOID SECURITY DEFINER RPC was not executed';
  END IF;
  IF (public.execute_sync_command(
      '99999999-9999-4999-8999-999999999999',
      'TEST_COMMAND', NULL, NULL, '{}'::jsonb, NULL
    )->>'success') <> 'true' THEN
    RAISE EXCEPTION 'Active session sync wrapper did not reach the canonical dispatcher';
  END IF;
END $assert$;
COMMIT;

UPDATE auth.sessions SET not_after = now(), updated_at = now()
WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
SELECT set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","session_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"}',true);
DO $assert$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.session_guard_fixture;
  IF v_count <> 0 THEN RAISE EXCEPTION 'Expired Auth session still reads a protected table through RLS'; END IF;
  BEGIN
    PERFORM public.fixture_sensitive_read();
    RAISE EXCEPTION 'Expired Auth session unexpectedly executed protected SECURITY DEFINER RPC';
  EXCEPTION WHEN SQLSTATE '28000' THEN
    NULL;
  END;
  BEGIN
    PERFORM public.fixture_sensitive_setof();
    RAISE EXCEPTION 'Expired Auth session unexpectedly executed protected SETOF RPC';
  EXCEPTION WHEN SQLSTATE '28000' THEN
    NULL;
  END;
  BEGIN
    PERFORM public.fixture_sensitive_void('expired-session');
    RAISE EXCEPTION 'Expired Auth session unexpectedly executed protected VOID RPC';
  EXCEPTION WHEN SQLSTATE '28000' THEN
    NULL;
  END;
  BEGIN
    PERFORM public.execute_sync_command(
      '99999999-9999-4999-8999-999999999999',
      'TEST_COMMAND', NULL, NULL, '{}'::jsonb, NULL
    );
    RAISE EXCEPTION 'Expired Auth session unexpectedly reached the canonical dispatcher';
  EXCEPTION WHEN SQLSTATE '28000' THEN
    NULL;
  END;
END $assert$;
COMMIT;

-- Legacy tables with disabled RLS and broad public grants are locked down
-- without deleting or rewriting their data.
DO $assert$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.permissions'::regclass) THEN
    RAISE EXCEPTION 'Legacy permissions table must have RLS enabled';
  END IF;
  IF has_table_privilege('anon', 'public.permissions', 'SELECT')
     OR has_table_privilege('anon', 'public.permissions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.permissions', 'SELECT')
     OR has_table_privilege('authenticated', 'public.permissions', 'INSERT') THEN
    RAISE EXCEPTION 'Legacy permissions table remains directly accessible to client roles';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.permissions', 'SELECT') THEN
    RAISE EXCEPTION 'Trusted service role access was not preserved';
  END IF;
  IF has_function_privilege('authenticated', 'public.execute_canonical_sync_command(uuid,text,jsonb,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Authenticated clients must not bypass the guarded sync wrapper';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.execute_canonical_sync_command(uuid,text,jsonb,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Trusted service-role dispatcher access was not preserved';
  END IF;
END $assert$;
