-- Future SECURITY DEFINER/RPC functions must not become browser-callable by
-- default. The current project has explicit anon/authenticated function defaults
-- for public, so each new RPC needs an intentional GRANT after authorization review.
-- Revoke PUBLIC globally because PostgreSQL schema-specific defaults cannot cancel
-- a global PUBLIC EXECUTE grant; also remove explicit browser-role defaults in public.
DO $default_function_execute$
DECLARE
  v_role name;
  v_schema name;
BEGIN
  FOR v_role IN
    SELECT rolname FROM pg_roles WHERE rolname IN ('postgres', 'supabase_admin')
  LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
      v_role
    );
    FOREACH v_schema IN ARRAY ARRAY['public'::name, 'storage'::name, 'graphql_public'::name]
    LOOP
      IF to_regnamespace(v_schema::text) IS NOT NULL THEN
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated',
          v_role,
          v_schema
        );
      END IF;
    END LOOP;
  END LOOP;
END
$default_function_execute$;
