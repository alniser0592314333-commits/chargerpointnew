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

-- The minimal login gate resolves role/active status without exposing permissions.
-- Create the admins relation transactionally so the migration fixture remains
-- compatible with the later, richer security-hardening fixture.
BEGIN;
CREATE TABLE public.admins (
  id uuid PRIMARY KEY,
  auth_user_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  disabled_at timestamptz,
  role text,
  email text,
  username text,
  full_name text
);
INSERT INTO public.admins(id,auth_user_id,is_active,role,email,username,full_name)
VALUES ('99999999-9999-4999-8999-999999999999',
        '11111111-1111-4111-8111-111111111111',true,'SUPER_ADMIN',
        'one@example.test','owner','Owner');
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
DO $assert$
DECLARE v_gate jsonb;
BEGIN
  v_gate := public.get_my_admin_login_gate();
  IF v_gate->>'authenticated' <> 'true'
     OR v_gate->>'is_admin' <> 'true'
     OR v_gate->>'role' <> 'SUPER_ADMIN'
     OR v_gate ? 'permissions' THEN
    RAISE EXCEPTION 'Minimal login gate returned an invalid or over-broad payload: %', v_gate;
  END IF;
END $assert$;
ROLLBACK;

-- Seed the two already-registered sessions. Listing sessions must not create
-- registry rows as a side effect.
INSERT INTO public.account_sessions(
  session_id,user_id,user_agent,created_at,last_seen_at,client_type,session_expires_at
)
SELECT id,user_id,user_agent,created_at,updated_at,'browser',now()+interval '7 days'
FROM auth.sessions
WHERE user_id='11111111-1111-4111-8111-111111111111';

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

-- A caller cannot upgrade an already registered browser session by
-- changing the client_type argument to native/PWA.
SELECT public.register_my_account_session_v2('Android WebView', 'native');
DO $assert$
DECLARE v_expiry timestamptz; v_type text;
BEGIN
  SELECT session_expires_at, client_type INTO v_expiry, v_type
  FROM public.account_sessions
  WHERE session_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  IF v_type <> 'browser' OR v_expiry > now() + interval '7 days' THEN
    RAISE EXCEPTION 'Client-supplied native type upgraded an existing browser session';
  END IF;
END $assert$;

-- The explicit reactivation RPC must also preserve the stored browser class.
SELECT public.reactivate_my_account_session('native');
DO $assert$
DECLARE v_expiry timestamptz; v_type text;
BEGIN
  SELECT session_expires_at, client_type INTO v_expiry, v_type
  FROM public.account_sessions
  WHERE session_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  IF v_type <> 'browser' OR v_expiry > now() + interval '7 days' THEN
    RAISE EXCEPTION 'Reactivation RPC upgraded an existing browser session';
  END IF;
END $assert$;

SELECT set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","session_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}',false);
SELECT public.register_my_account_session_v2('Windows Chrome', 'browser');
DO $assert$
DECLARE v_expiry timestamptz; v_type text;
BEGIN
  SELECT session_expires_at, client_type INTO v_expiry, v_type
  FROM public.account_sessions
  WHERE session_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  IF v_type <> 'browser' OR v_expiry > now() + interval '7 days' THEN
    RAISE EXCEPTION 'Browser session did not receive the seven-day idle window';
  END IF;
END $assert$;

SELECT set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","session_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}',false);
UPDATE public.account_sessions
SET session_expires_at = now() - interval '1 second'
WHERE session_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
DO $assert$
BEGIN
  IF public.is_my_account_session_active() IS NOT FALSE THEN
    RAISE EXCEPTION 'Idle-expired native session remained active';
  END IF;
END $assert$;
DO $assert$
BEGIN
  BEGIN
    PERFORM public.reactivate_my_account_session('native');
    RAISE EXCEPTION 'An expired application session was reactivated by spoofing native client_type';
  EXCEPTION WHEN SQLSTATE '28000' THEN
    NULL;
  END;
  IF public.is_my_account_session_active() IS NOT FALSE THEN
    RAISE EXCEPTION 'Expired application session became active after rejected reactivation';
  END IF;
END $assert$;

-- A newly issued Auth session can be registered through the explicit
-- reactivation path after biometric/password authentication.
INSERT INTO auth.sessions(id,user_id,created_at,updated_at,not_after,user_agent)
VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','11111111-1111-4111-8111-111111111111',now(),now(),NULL,'Android native fresh login');
SELECT set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","session_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}',false);
SELECT public.reactivate_my_account_session('native');
DO $assert$
DECLARE v_type text; v_expiry timestamptz;
BEGIN
  IF public.is_my_account_session_active() IS NOT TRUE THEN
    RAISE EXCEPTION 'Freshly authenticated native session was not registered';
  END IF;
  SELECT client_type, session_expires_at INTO v_type, v_expiry
  FROM public.account_sessions
  WHERE session_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  IF v_type <> 'native' OR v_expiry < now() + interval '29 days' THEN
    RAISE EXCEPTION 'Fresh native session did not receive its expected idle window';
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
  IF NOT EXISTS (SELECT 1 FROM auth.sessions WHERE id='dddddddd-dddd-4ddd-8ddd-dddddddddddd' AND (not_after IS NULL OR not_after > now())) THEN RAISE EXCEPTION 'Current session was not preserved'; END IF;
  IF public.is_my_account_session_active() IS NOT TRUE THEN RAISE EXCEPTION 'Current session should remain active'; END IF;
END $assert$;
SELECT public.revoke_all_account_sessions();
DO $assert$
BEGIN
  IF public.is_my_account_session_active() IS NOT FALSE THEN RAISE EXCEPTION 'All-session revoke did not mark current session inactive'; END IF;
  IF EXISTS (SELECT 1 FROM auth.refresh_tokens WHERE user_id='11111111-1111-4111-8111-111111111111' AND revoked=false) THEN RAISE EXCEPTION 'All-session revoke left a refresh token active'; END IF;
END $assert$;

-- Preserve service_role execute grants exactly: a guarded wrapper must not
-- accidentally broaden server-role access to an RPC that did not grant it.
DO $assert$
BEGIN
  IF has_function_privilege('service_role', 'public.fixture_sensitive_read()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Migration unexpectedly granted service_role access to an authenticated-only RPC';
  END IF;
END $assert$;

-- Direct browser roles have no table access and anonymous callers cannot execute RPCs.
DO $assert$
BEGIN
  IF has_table_privilege('authenticated','public.account_sessions','SELECT') THEN RAISE EXCEPTION 'Authenticated role can read the private session table directly'; END IF;
  IF has_function_privilege('anon','public.get_my_account_sessions()','EXECUTE') THEN RAISE EXCEPTION 'Anonymous role can call account session RPC'; END IF;
  IF has_function_privilege('service_role','public.get_my_admin_login_gate()','EXECUTE')
     OR has_function_privilege('service_role','public.get_current_admin_profile()','EXECUTE')
     OR has_function_privilege('service_role','public.current_admin_id()','EXECUTE')
     OR has_function_privilege('service_role','public.is_my_account_session_active()','EXECUTE')
     OR has_function_privilege('service_role','public.is_active_admin_session()','EXECUTE')
     OR has_function_privilege('service_role','public.register_my_account_session(text)','EXECUTE')
     OR has_function_privilege('service_role','public.register_my_account_session_v2(text,text)','EXECUTE')
     OR has_function_privilege('service_role','public.reactivate_my_account_session(text)','EXECUTE')
     OR has_function_privilege('service_role','public.get_my_account_sessions()','EXECUTE')
     OR has_function_privilege('service_role','public.revoke_my_account_session(uuid)','EXECUTE')
     OR has_function_privilege('service_role','public.revoke_other_account_sessions()','EXECUTE')
     OR has_function_privilege('service_role','public.revoke_all_account_sessions()','EXECUTE') THEN
    RAISE EXCEPTION 'Service role can execute a user-scoped session RPC';
  END IF;
  IF has_function_privilege('anon','public.touch_my_account_session()','EXECUTE')
     OR has_function_privilege('service_role','public.touch_my_account_session()','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.touch_my_account_session()','EXECUTE') THEN
    RAISE EXCEPTION 'Session heartbeat RPC grants are incorrect';
  END IF;
END $assert$;

-- An Auth session without an account_sessions registry row is never an
-- active application session, including inside a read-only transaction. The
-- session-list RPC must also be read-only and must not auto-register other rows.
INSERT INTO auth.sessions(id,user_id,created_at,updated_at,not_after,user_agent)
VALUES
 ('ffffffff-ffff-4fff-8fff-ffffffffffff','11111111-1111-4111-8111-111111111111',now(),now(),NULL,'Unregistered session'),
 ('12121212-1212-4121-8121-121212121212','11111111-1111-4111-8111-111111111111',now(),now(),NULL,'Fresh active session');
SELECT set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","session_id":"12121212-1212-4121-8121-121212121212"}',false);
SELECT public.reactivate_my_account_session('browser');
SELECT public.get_my_account_sessions();
DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM public.account_sessions WHERE session_id='ffffffff-ffff-4fff-8fff-ffffffffffff') THEN
    RAISE EXCEPTION 'Session listing auto-registered another Auth session';
  END IF;
END $assert$;

SELECT set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","session_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"}',false);
DO $assert$
BEGIN
  IF public.is_my_account_session_active() IS NOT FALSE THEN
    RAISE EXCEPTION 'A valid but unregistered Auth session must fail closed';
  END IF;
  BEGIN
    PERFORM public.restore_selected_business_days('0000', '{}'::jsonb, ARRAY[CURRENT_DATE]);
    RAISE EXCEPTION 'Sensitive day restore unexpectedly bypassed the registered-session guard';
  EXCEPTION WHEN SQLSTATE '28000' THEN
    NULL;
  END;
  BEGIN
    PERFORM public.get_my_account_sessions();
    RAISE EXCEPTION 'An unregistered session unexpectedly listed account sessions';
  EXCEPTION WHEN SQLSTATE '28000' THEN
    NULL;
  END;
  IF public.touch_my_account_session() IS NOT FALSE THEN
    RAISE EXCEPTION 'An unregistered session unexpectedly passed the session heartbeat';
  END IF;
  IF EXISTS (SELECT 1 FROM public.account_sessions WHERE session_id='ffffffff-ffff-4fff-8fff-ffffffffffff') THEN
    RAISE EXCEPTION 'Session listing unexpectedly auto-registered the current session';
  END IF;
END $assert$;
BEGIN;
SET TRANSACTION READ ONLY;
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
SELECT set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","session_id":"ffffffff-ffff-4fff-8fff-ffffffffffff"}',true);
DO $assert$
BEGIN
  IF public.is_my_account_session_active() IS NOT FALSE THEN
    RAISE EXCEPTION 'Read-only authorization accepted a missing account_sessions row';
  END IF;
END $assert$;
ROLLBACK;

-- Both the current and legacy registration RPCs reject stale unregistered Auth
-- sessions, preventing an alternate registration path around the strict guard.
INSERT INTO auth.sessions(id,user_id,created_at,updated_at,not_after,user_agent)
VALUES ('abababab-abab-4bab-8bab-abababababab','11111111-1111-4111-8111-111111111111',now()-interval '1 day',now(),NULL,'Old unregistered session');
SELECT set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","session_id":"abababab-abab-4bab-8bab-abababababab"}',false);
DO $assert$
BEGIN
  BEGIN
    PERFORM public.register_my_account_session_v2('Browser', 'native');
    RAISE EXCEPTION 'A stale unregistered Auth session unexpectedly registered itself through v2';
  EXCEPTION WHEN SQLSTATE '28000' THEN
    NULL;
  END;
  BEGIN
    PERFORM public.register_my_account_session('Browser');
    RAISE EXCEPTION 'A stale unregistered Auth session unexpectedly registered itself through the legacy RPC';
  EXCEPTION WHEN SQLSTATE '28000' THEN
    NULL;
  END;
  BEGIN
    PERFORM public.reactivate_my_account_session('native');
    RAISE EXCEPTION 'A stale unregistered Auth session unexpectedly reactivated through the legacy session RPC';
  EXCEPTION WHEN SQLSTATE '28000' THEN
    NULL;
  END;
  IF EXISTS (
    SELECT 1 FROM public.account_sessions
    WHERE session_id='abababab-abab-4bab-8bab-abababababab'
  ) THEN
    RAISE EXCEPTION 'Rejected stale registration or reactivation created an account session row';
  END IF;
END $assert$;


-- Server-side enforcement regression: a valid unregistered Auth session may
-- read business data during rollout; after expiry the same stale JWT must be
-- denied by both the table RLS policy and an exposed SECURITY DEFINER RPC.
INSERT INTO auth.sessions(id,user_id,created_at,updated_at,not_after,user_agent)
VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','11111111-1111-4111-8111-111111111111',now(),now(),NULL,'Gate test');
SELECT set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","session_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"}',false);
SELECT public.register_my_account_session_v2('Gate test','browser');
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
