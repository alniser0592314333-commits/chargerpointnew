-- Keep the deployed canonical command processor compatible with Supabase's
-- standard auth.role() claim accessor for trusted service-role auto-delivery.
DO $migration$
DECLARE
  v_definition text;
  v_old text := $old$IF COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role'$old$;
  v_new text := $new$IF COALESCE(auth.role(), '') = 'service_role'$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'execute_canonical_sync_command_unlocked'
    AND pg_get_function_identity_arguments(p.oid) LIKE 'p_command_id uuid, p_command_type text, p_payload jsonb%';

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'Canonical command processor not found; refusing migration';
  END IF;

  IF position(v_old IN v_definition) > 0 THEN
    EXECUTE replace(v_definition, v_old, v_new);
  ELSIF position(v_new IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Expected service-role guard not found; refusing migration';
  END IF;
END
$migration$;
NOTIFY pgrst, 'reload schema';
