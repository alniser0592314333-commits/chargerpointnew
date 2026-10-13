-- Runtime contract test for the authoritative snapshot timeout migration.
-- This test runs only against the isolated PostgreSQL service in GitHub Actions.
DO $verify$
DECLARE
  v_function_config text[];
  v_role_config text[];
BEGIN
  SELECT p.proconfig INTO v_function_config
  FROM pg_proc p
  WHERE p.oid = 'public.capture_authoritative_business_snapshot()'::regprocedure;

  IF v_function_config IS NULL
     OR NOT ('statement_timeout=120s' = ANY(v_function_config)) THEN
    RAISE EXCEPTION 'Snapshot RPC must have a function-scoped statement_timeout=120s; config=%', v_function_config;
  END IF;

  SELECT s.setconfig INTO v_role_config
  FROM pg_db_role_setting s
  JOIN pg_roles r ON r.oid = s.setrole
  WHERE r.rolname = 'authenticated' AND s.setdatabase = 0;

  IF v_role_config IS NULL OR NOT ('statement_timeout=8s' = ANY(v_role_config)) THEN
    RAISE EXCEPTION 'Migration must not change the authenticated role timeout; config=%', v_role_config;
  END IF;
END
$verify$;


-- Prove the function-scoped setting can outlive the caller's short timeout.
SET statement_timeout = '8s';
SELECT public.capture_authoritative_business_snapshot();
