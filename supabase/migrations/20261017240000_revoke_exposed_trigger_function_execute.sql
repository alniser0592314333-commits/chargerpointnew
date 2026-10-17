-- Trigger functions are invoked by PostgreSQL through their attached triggers.
-- They are not RPC entry points and must not be directly executable by API roles.
-- Revoke direct execution for every trigger-returning function in the exposed
-- public schema, including SECURITY DEFINER trigger functions. Trigger firing
-- itself is unaffected by EXECUTE grants to the caller.
DO $revoke_trigger_functions$
DECLARE
  v_function record;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prorettype = 'pg_catalog.trigger'::regtype
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
      v_function.signature
    );
  END LOOP;
END
$revoke_trigger_functions$;

NOTIFY pgrst, 'reload schema';
