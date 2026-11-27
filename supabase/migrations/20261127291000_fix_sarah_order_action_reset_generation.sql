DO $migration$
DECLARE
  v_definition text;
  v_old text := 'v_payload:=pg_catalog.jsonb_strip_nulls(jsonb_build_object(';
  v_new text := 'v_payload:=pg_catalog.jsonb_strip_nulls(jsonb_build_object(''resetGeneration'',(SELECT COALESCE(s.value_number,1) FROM public.system_settings s WHERE s.key=''server_reset_generation''),';
  v_count integer;
  v_reset_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(
    'public.sarah_ai_execute_order_action(uuid,text,text,uuid,text,text,text)'::regprocedure
  );
  v_count := (pg_catalog.length(v_definition) - pg_catalog.length(pg_catalog.replace(v_definition, v_old, '')))
    / pg_catalog.length(v_old);
  v_reset_count := (pg_catalog.length(v_definition) - pg_catalog.length(pg_catalog.replace(v_definition, '''resetGeneration''', '')))
    / pg_catalog.length('''resetGeneration''');

  IF v_count = 2 AND v_reset_count = 0 THEN
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
    EXECUTE v_definition;
  ELSIF v_count = 0 AND v_reset_count = 2 THEN
    -- Already applied through the production migration runner.
    NULL;
  ELSE
    RAISE EXCEPTION 'Unexpected Sarah order-action payload state: builders %, reset fields %; migration aborted',
      v_count, v_reset_count;
  END IF;
END
$migration$;
