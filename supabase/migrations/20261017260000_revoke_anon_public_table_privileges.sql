-- The live project grants broad table privileges to anon through both existing
-- ACLs and default privileges. RLS has no anon/PUBLIC policies, but TRUNCATE
-- bypasses RLS entirely and the remaining grants are unnecessary for this
-- app's public flows, which use narrowly scoped SECURITY DEFINER RPCs.
--
-- Keep authenticated/service_role grants unchanged. This is a table ACL
-- hardening migration only; it does not modify or delete any business rows.

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- New public tables/sequences created by either known schema-owner role must
-- not inherit API access for anon.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon;

DO $verify_anon_acl$
DECLARE
  v_table record;
BEGIN
  FOR v_table IN
    SELECT c.oid::regclass AS relation_name
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  LOOP
    IF has_table_privilege('anon', v_table.relation_name, 'SELECT')
       OR has_table_privilege('anon', v_table.relation_name, 'INSERT')
       OR has_table_privilege('anon', v_table.relation_name, 'UPDATE')
       OR has_table_privilege('anon', v_table.relation_name, 'DELETE')
       OR has_table_privilege('anon', v_table.relation_name, 'TRUNCATE')
       OR has_table_privilege('anon', v_table.relation_name, 'REFERENCES')
       OR has_table_privilege('anon', v_table.relation_name, 'TRIGGER') THEN
      RAISE EXCEPTION 'Unexpected anon table privilege remains on %', v_table.relation_name;
    END IF;
  END LOOP;
END
$verify_anon_acl$;

NOTIFY pgrst, 'reload schema';
