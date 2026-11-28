\set ON_ERROR_STOP on
BEGIN;

-- A fresh sign-in for admin A revokes only A's older application sessions.
INSERT INTO auth.sessions(id,user_id,created_at,updated_at,user_agent)
VALUES ('20000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000001',now(),now(),'New Android session');
INSERT INTO public.account_sessions(session_id,user_id,user_agent,client_type,session_expires_at)
VALUES ('20000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000001','New Android session','native',now()+interval '30 days');

DO $assert_single_admin_session$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.account_sessions
    WHERE session_id='20000000-0000-4000-8000-000000000001'
      AND revoked_at IS NOT NULL
      AND revoked_by_session_id='20000000-0000-4000-8000-000000000003'
      AND revocation_reason='new_login'
  ) THEN
    RAISE EXCEPTION 'Previous session for admin A was not revoked with new-login reason';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.account_sessions
    WHERE session_id='20000000-0000-4000-8000-000000000003'
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'New session for admin A must remain active';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.account_sessions
    WHERE session_id='20000000-0000-4000-8000-000000000002'
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Admin A login must not revoke admin B session';
  END IF;
END
$assert_single_admin_session$;

-- A refresh/resume uses the same session_id and updates the existing row;
-- it does not run the INSERT trigger or change the active-session count.
UPDATE public.account_sessions
SET last_seen_at=now()
WHERE session_id='20000000-0000-4000-8000-000000000003';

DO $assert_refresh_is_not_new_login$
BEGIN
  IF (SELECT count(*) FROM public.account_sessions
      WHERE user_id='10000000-0000-4000-8000-000000000001'
        AND revoked_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'Same-session refresh changed the active-session count';
  END IF;
END
$assert_refresh_is_not_new_login$;

SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000001","session_id":"20000000-0000-4000-8000-000000000003"}',true);

DO $assert_history$
DECLARE v_rows jsonb;
BEGIN
  v_rows := public.get_my_account_sessions();
  IF jsonb_array_length(v_rows) <> 2 THEN
    RAISE EXCEPTION 'Expected current session and one revoked history row, got %', v_rows;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_rows) AS item
    WHERE item->>'revocation_reason' = 'new_login'
  ) THEN
    RAISE EXCEPTION 'Session history does not expose the new-login revocation reason';
  END IF;
END
$assert_history$;

ROLLBACK;
