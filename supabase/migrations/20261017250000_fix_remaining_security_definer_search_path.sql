-- Supabase's security advisor identified one SECURITY DEFINER function in
-- public without a function-level search_path. Pin it explicitly to prevent
-- object resolution from depending on caller/session configuration.
DO $fix_search_path$
DECLARE
  v_function record;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS cfg
        WHERE cfg LIKE 'search_path=%'
      )
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %s SET search_path TO public, pg_temp',
      v_function.signature
    );
  END LOOP;
END
$fix_search_path$;
