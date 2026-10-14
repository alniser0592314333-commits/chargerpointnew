DO $verify$
DECLARE
  v_target regprocedure;
  v_definition text;
BEGIN
  v_target := to_regprocedure(
    'public.execute_canonical_sync_command_unlocked(uuid,text,jsonb,text,text,uuid)'
  );
  IF v_target IS NULL THEN
    v_target := to_regprocedure(
      'public.execute_canonical_sync_command(uuid,text,jsonb,text,text,uuid)'
    );
  END IF;

  IF v_target IS NULL THEN
    RAISE EXCEPTION 'UUID migration test could not find a dispatcher implementation';
  END IF;

  v_definition := pg_get_functiondef(v_target);
  IF position('array_agg(id ORDER BY id)' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'UUID delivery migration did not install the deterministic UUID aggregate in %', v_target;
  END IF;
  IF position('MIN(id)' IN v_definition) > 0 THEN
    RAISE EXCEPTION 'UUID delivery migration left the unsupported MIN(uuid) expression in %', v_target;
  END IF;
END;
$verify$;
