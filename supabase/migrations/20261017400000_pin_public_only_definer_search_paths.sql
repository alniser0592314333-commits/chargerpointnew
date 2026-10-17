-- Some legacy SECURITY DEFINER functions had a fixed search_path of only
-- public. PostgreSQL searches pg_temp ahead of configured schemas when pg_temp
-- is omitted, so explicitly put it last without changing the public/extension
-- resolution order of functions that already have a safe path.
DO $pin_public_only_definer_paths$
DECLARE
  v_function record;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND EXISTS (
        SELECT 1
        FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS cfg
        WHERE cfg = 'search_path=public'
      )
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %s SET search_path TO public, pg_temp',
      v_function.signature
    );
  END LOOP;
END
$pin_public_only_definer_paths$;

DO $assert_public_only_definer_paths_closed$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND EXISTS (
        SELECT 1
        FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS cfg
        WHERE cfg = 'search_path=public'
      )
  ) THEN
    RAISE EXCEPTION 'SECURITY DEFINER functions remain configured with search_path=public without pg_temp explicitly last';
  END IF;
END
$assert_public_only_definer_paths_closed$;
