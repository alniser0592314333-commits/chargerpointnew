-- Allow one account to stay signed in across multiple phones, browsers, PWAs and APK installs.
-- Session identity and authorization remain per Supabase Auth session_id.
-- Keep explicit per-device and revoke-other-sessions operations available to the account owner.
-- Remove only the automatic "new login revokes all previous admin sessions" behavior.

DROP TRIGGER IF EXISTS account_sessions_single_active_admin_login
  ON public.account_sessions;

COMMENT ON FUNCTION public.enforce_single_active_admin_session() IS
  'Historical compatibility only; intentionally detached so a new login does not revoke other account sessions.';
