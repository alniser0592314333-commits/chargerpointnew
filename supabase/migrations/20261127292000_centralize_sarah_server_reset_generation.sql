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
  v_direct_functions integer := 0;
  v_direct_calls integer := 0;
  v_bridge_functions integer := 0;
  v_bridge_calls integer := 0;
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
    ORDER BY p.proname, p.oid
  LOOP
    v_definition := pg_get_functiondef(r.oid);
    v_count := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
    IF v_count > 0 THEN
      v_definition := replace(v_definition, v_old, v_new);
      EXECUTE v_definition;
      v_direct_functions := v_direct_functions + 1;
      v_direct_calls := v_direct_calls + v_count;
    ELSE
      v_count := (length(v_definition) - length(replace(v_definition, v_new, ''))) / length(v_new);
      IF v_count > 0 THEN
        v_bridge_functions := v_bridge_functions + 1;
        v_bridge_calls := v_bridge_calls + v_count;
      END IF;
    END IF;
  END LOOP;

  IF v_direct_functions = 11 AND v_direct_calls = 15 THEN
    NULL; -- All expected RPCs have just been rewritten.
  ELSIF v_direct_functions = 0 AND v_direct_calls = 0
        AND v_bridge_functions = 11 AND v_bridge_calls = 15 THEN
    NULL; -- Already applied through the production migration runner.
  ELSE
    RAISE EXCEPTION 'Unexpected Sarah executor inventory: direct %/% calls, bridged %/% calls; migration aborted',
      v_direct_functions, v_direct_calls, v_bridge_functions, v_bridge_calls;
  END IF;
END
$migration$;
