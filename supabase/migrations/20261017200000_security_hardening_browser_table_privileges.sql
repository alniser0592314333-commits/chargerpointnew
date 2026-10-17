-- Security hardening: remove TRUNCATE from browser-facing roles.
-- RLS does not protect TRUNCATE. This migration changes no row-level CRUD grants,
-- preserving the existing RPC and offline-sync contracts while removing the dangerous
-- table-wide privilege. It is safe to rerun.
DO $migration$
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
$migration$;

-- Prevent future tables created by this migration owner from inheriting TRUNCATE
-- for browser roles. Existing owner-specific default privilege configurations are
-- otherwise left untouched.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE TRUNCATE ON TABLES FROM anon, authenticated;
