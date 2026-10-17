-- Fail closed if any function creator still grants browser EXECUTE by default.
-- The preceding hardening migration revokes defaults for owners the migration role
-- can manage. This assertion prevents a hosted role with unmanaged defaults from
-- silently leaving future public RPCs callable by anon/authenticated.
DO $assert_browser_function_defaults$
DECLARE
  v_exposed record;
BEGIN
  SELECT
    COALESCE(NULLIF(n.nspname, ''), '<all schemas>') AS schema_name,
    d.defaclrole::regrole::text AS owner_role,
    grantee.rolname AS grantee_role,
    acl.privilege_type
  INTO v_exposed
  FROM pg_default_acl d
  LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
  LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
  WHERE d.defaclobjtype = 'f'
    AND (d.defaclnamespace = 0 OR n.nspname IN ('public', 'graphql_public', 'storage'))
    AND acl.privilege_type = 'EXECUTE'
    AND (acl.grantee = 0 OR grantee.rolname IN ('anon', 'authenticated'))
  ORDER BY owner_role, schema_name, grantee_role
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Unsafe default function EXECUTE remains: owner=%, schema=%, grantee=%, privilege=%. Revoke browser/PUBLIC default EXECUTE for this function owner before deploying.',
      v_exposed.owner_role, v_exposed.schema_name,
      COALESCE(v_exposed.grantee_role, 'PUBLIC'), v_exposed.privilege_type;
  END IF;
END
$assert_browser_function_defaults$;
