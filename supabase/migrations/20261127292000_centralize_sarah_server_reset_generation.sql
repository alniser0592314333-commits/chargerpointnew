CREATE OR REPLACE FUNCTION public.sarah_ai_execute_sync_command(
  p_command_id uuid,
  p_command_type text,
  p_aggregate_type text,
  p_aggregate_id uuid,
  p_payload jsonb,
  p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_server_generation bigint;
  v_payload jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();

  SELECT COALESCE(s.value_number, 1)
    INTO v_server_generation
  FROM public.system_settings s
  WHERE s.key = 'server_reset_generation';
  v_server_generation := COALESCE(v_server_generation, 1);

  -- Private server-only bridge for Sarah SECURITY DEFINER RPCs.
  -- Always overwrite caller data with the current server generation.
  v_payload := COALESCE(p_payload, '{}'::jsonb)
    || jsonb_build_object('resetGeneration', v_server_generation);

  RETURN public.execute_sync_command(
    p_command_id,
    p_command_type,
    p_aggregate_type,
    p_aggregate_id,
    v_payload,
    p_expected_version
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_execute_sync_command(uuid,text,text,uuid,jsonb,integer)
  FROM PUBLIC, anon, authenticated, service_role;

DO $migration$
DECLARE
  r record;
  v_definition text;
  v_old text := 'public.execute_sync_command(';
  v_new text := 'public.sarah_ai_execute_sync_command(';
  v_total_functions integer := 0;
  v_total_calls integer := 0;
  v_count integer;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname LIKE 'sarah_ai_%'
      AND p.proname <> 'sarah_ai_execute_sync_command'
      AND p.prokind = 'f'
      AND pg_get_functiondef(p.oid) LIKE '%public.execute_sync_command(%'
    ORDER BY p.proname, p.oid
  LOOP
    v_definition := pg_get_functiondef(r.oid);
    v_count := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
    IF v_count < 1 THEN
      RAISE EXCEPTION 'Unexpected empty Sarah executor reference in %', r.proname;
    END IF;
    v_definition := replace(v_definition, v_old, v_new);
    EXECUTE v_definition;
    v_total_functions := v_total_functions + 1;
    v_total_calls := v_total_calls + v_count;
  END LOOP;

  IF v_total_functions <> 11 OR v_total_calls <> 15 THEN
    RAISE EXCEPTION 'Expected 11 Sarah RPCs / 15 canonical calls to be bridged, got % RPCs / % calls; transaction aborted',
      v_total_functions, v_total_calls;
  END IF;
END
$migration$;
