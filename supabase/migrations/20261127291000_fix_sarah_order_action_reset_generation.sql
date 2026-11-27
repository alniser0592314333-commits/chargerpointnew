DO $migration$
DECLARE
  v_definition text;
  v_old text := 'v_payload:=pg_catalog.jsonb_strip_nulls(jsonb_build_object(';
  v_new text := 'v_payload:=pg_catalog.jsonb_strip_nulls(jsonb_build_object(''resetGeneration'',(SELECT COALESCE(s.value_number,1) FROM public.system_settings s WHERE s.key=''server_reset_generation''),';
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(
    'public.sarah_ai_execute_order_action(uuid,text,text,uuid,text,text,text)'::regprocedure
  );
  v_count := (pg_catalog.length(v_definition) - pg_catalog.length(pg_catalog.replace(v_definition, v_old, '')))
    / pg_catalog.length(v_old);
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'Expected exactly two Sarah order-action payload builders, found %; migration aborted', v_count;
  END IF;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  EXECUTE v_definition;
END
$migration$;
