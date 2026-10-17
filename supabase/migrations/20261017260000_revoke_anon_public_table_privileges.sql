-- The live project grants broad table privileges to anon through both existing
-- ACLs and default privileges. RLS has no anon/PUBLIC policies, but TRUNCATE
-- bypasses RLS entirely and the remaining grants are unnecessary for this
-- app's public flows, which use narrowly scoped SECURITY DEFINER RPCs.
--
-- Keep authenticated/service_role grants unchanged. This is an ACL hardening
-- migration only; it does not modify or delete any business rows.

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- Some isolated PostgreSQL fixtures do not define Supabase's supabase_admin
-- role. Apply default-privilege hardening only for schema-owner roles that
-- actually exist in the current database.
DO $default_anon_acl$
DECLARE
  v_role name;
BEGIN
  -- Hosted Supabase's postgres migration role is not necessarily a member of
  -- supabase_admin. PostgreSQL rejects ALTER DEFAULT PRIVILEGES FOR ROLE when
  -- the migration role lacks membership, which would abort this entire migration.
  -- Harden the current owner and any other owner this migration role can legally
  -- manage; never attempt an unauthorized cross-role change.
  FOR v_role IN
    SELECT rolname
    FROM pg_roles
    WHERE rolname IN ('postgres', 'supabase_admin')
      AND (
        rolname = current_user
        OR rolsuper
        OR pg_has_role(current_user, oid, 'MEMBER')
      )
  LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM anon',
      v_role
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon',
      v_role
    );
  END LOOP;
END
$default_anon_acl$;

DO $verify_anon_acl$
DECLARE
  v_relation record;
BEGIN
  FOR v_relation IN
    SELECT c.oid::regclass AS relation_name, c.relkind
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  LOOP
    IF v_relation.relkind = 'S' THEN
      IF has_sequence_privilege('anon', v_relation.relation_name, 'USAGE')
         OR has_sequence_privilege('anon', v_relation.relation_name, 'SELECT')
         OR has_sequence_privilege('anon', v_relation.relation_name, 'UPDATE') THEN
        RAISE EXCEPTION 'Unexpected anon sequence privilege remains on %', v_relation.relation_name;
      END IF;
    ELSIF has_table_privilege('anon', v_relation.relation_name, 'SELECT')
       OR has_table_privilege('anon', v_relation.relation_name, 'INSERT')
       OR has_table_privilege('anon', v_relation.relation_name, 'UPDATE')
       OR has_table_privilege('anon', v_relation.relation_name, 'DELETE')
       OR has_table_privilege('anon', v_relation.relation_name, 'TRUNCATE')
       OR has_table_privilege('anon', v_relation.relation_name, 'REFERENCES')
       OR has_table_privilege('anon', v_relation.relation_name, 'TRIGGER') THEN
      RAISE EXCEPTION 'Unexpected anon table privilege remains on %', v_relation.relation_name;
    END IF;
  END LOOP;
END
$verify_anon_acl$;

NOTIFY pgrst, 'reload schema';


DO $anon_maintain_acl$
BEGIN
  -- PostgreSQL 17 added MAINTAIN. Inspect ACL entries rather than calling
  -- has_table_privilege('MAINTAIN'), which is not recognized on PostgreSQL 16.
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r'::"char", c.relowner))) AS acl
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND acl.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname = 'anon'))
      AND acl.privilege_type = 'MAINTAIN'
  ) THEN
    RAISE EXCEPTION 'PUBLIC or anon retains MAINTAIN on a public table';
  END IF;
END
$anon_maintain_acl$;
