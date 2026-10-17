-- Security hardening: bind authenticated table reads to active administrator identities
-- and remove TRUNCATE from browser-facing roles.
--
-- The existing authenticated_read policies only checked that an Auth session was
-- active. They did not verify that auth.uid() belonged to an active admin. The app's
-- customer portal remains capability-QR based; customer Auth is not enabled by this
-- migration. This preserves existing administrator reads while rejecting arbitrary
-- authenticated users from these admin-data policies.
CREATE OR REPLACE FUNCTION public.is_active_admin_session()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT auth.uid() IS NOT NULL
     AND public.is_my_account_session_active() IS TRUE
     AND EXISTS (
       SELECT 1
       FROM public.admins AS a
       WHERE a.auth_user_id = auth.uid()
         AND a.is_active = TRUE
     );
$function$;

REVOKE ALL ON FUNCTION public.is_active_admin_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_admin_session() TO authenticated, service_role;

-- Replace the shared policy only where the current policy has the known name and
-- role. Preserve each table's other policies and grants.
DO $policies$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname = 'authenticated_read'
      AND cmd = 'SELECT'
      AND roles::text LIKE '%authenticated%'
  LOOP
    EXECUTE format(
      'DROP POLICY %I ON %I.%I',
      v_policy.policyname, v_policy.schemaname, v_policy.tablename
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I FOR SELECT TO authenticated USING (public.is_active_admin_session())',
      v_policy.policyname, v_policy.schemaname, v_policy.tablename
    );
  END LOOP;
END
$policies$;

-- RLS does not protect TRUNCATE. This changes no row-level CRUD grants, preserving
-- existing RPC and offline-sync contracts while removing the table-wide privilege.
DO $truncate$
DECLARE
  v_table record;
BEGIN
  FOR v_table IN
    SELECT format('%I.%I', n.nspname, c.relname) AS qualified_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format(
      'REVOKE TRUNCATE ON TABLE %s FROM anon, authenticated',
      v_table.qualified_name
    );
  END LOOP;
END
$truncate$;

-- Prevent future tables created by this migration owner from inheriting TRUNCATE
-- for browser roles. Existing owner-specific default privilege configurations are
-- otherwise left untouched.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE TRUNCATE ON TABLES FROM anon, authenticated;
