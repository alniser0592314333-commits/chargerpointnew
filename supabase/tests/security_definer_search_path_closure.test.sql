\set ON_ERROR_STOP on
DO $assert_no_public_only_security_definer_paths$
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
    RAISE EXCEPTION 'A SECURITY DEFINER function still has a public-only search_path';
  END IF;
END
$assert_no_public_only_security_definer_paths$;
