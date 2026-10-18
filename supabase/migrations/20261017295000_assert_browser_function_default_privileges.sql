-- Fail closed when the role actually applying application migrations grants
-- browser EXECUTE on newly-created functions by default.
--
-- Supabase's platform-managed supabase_admin role has separate defaults that the
-- project migration role (postgres) cannot alter without elevated role membership.
-- Do not make ordinary application migrations permanently un-runnable because of
-- that externally-managed ACL: audit it separately with the platform owner/support.
-- This check is intentionally scoped to current_user, which owns functions created
-- by this migration execution. The portal RPC itself still has explicit grants.
DO $assert_migration_owner_function_defaults$
DECLARE
  v_exposed record;
BEGIN
  SELECT
    COALESCE(NULLIF(n.nspname, ''), '<all schemas>') AS schema_name,
    d.defaclrole::regrole::text AS owner_role,
    COALESCE(grantee.rolname, 'PUBLIC') AS grantee_role,
    acl.privilege_type
  INTO v_exposed
  FROM pg_default_acl d
  LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
  LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
  WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    AND d.defaclobjtype = 'f'
    AND (d.defaclnamespace = 0 OR n.nspname IN ('public', 'graphql_public', 'storage'))
    AND acl.privilege_type = 'EXECUTE'
    AND (acl.grantee = 0 OR grantee.rolname IN ('anon', 'authenticated'))
  ORDER BY schema_name, grantee_role
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Unsafe default function EXECUTE remains for migration owner: owner=%, schema=%, grantee=%, privilege=%. Revoke browser/PUBLIC default EXECUTE for the migration role before deploying.',
      v_exposed.owner_role, v_exposed.schema_name,
      v_exposed.grantee_role, v_exposed.privilege_type;
  END IF;
END
$assert_migration_owner_function_defaults$;
