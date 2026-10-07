-- Migration 00117: finalize the runtime execute_sync_command contract.
-- The canonical processor in 00116 owns business logic. This wrapper adds the
-- transport expected-version forwarding and stale-reset protection.

CREATE OR REPLACE FUNCTION public.execute_sync_command(
    p_command_id uuid,
    p_command_type text,
    p_aggregate_type text DEFAULT NULL::text,
    p_aggregate_id uuid DEFAULT NULL::uuid,
    p_payload jsonb DEFAULT '{}'::jsonb,
    p_expected_version integer DEFAULT NULL::integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_server_gen BIGINT;
    v_cmd_gen BIGINT;
    v_payload JSONB;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required: caller must be signed in via Supabase Auth'
            USING ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(value_number, 1)
      INTO v_server_gen
      FROM public.system_settings
     WHERE key = 'server_reset_generation';

    v_server_gen := COALESCE(v_server_gen, 1);
    v_payload := COALESCE(p_payload, '{}'::jsonb);

    v_cmd_gen := COALESCE(
        (v_payload->>'resetGeneration')::BIGINT,
        (v_payload->>'reset_generation')::BIGINT,
        1
    );

    IF v_cmd_gen < v_server_gen THEN
        RAISE EXCEPTION
            'RESET_GENERATION_MISMATCH: command generation % is older than server reset generation %',
            v_cmd_gen, v_server_gen
            USING ERRCODE = 'P0002';
    END IF;

    IF p_expected_version IS NOT NULL
       AND NOT (v_payload ? 'expectedVersion') THEN
        v_payload := jsonb_set(
            v_payload,
            '{expectedVersion}',
            to_jsonb(p_expected_version),
            true
        );
    END IF;

    RETURN public.execute_canonical_sync_command(
        p_command_id,
        p_command_type,
        v_payload,
        COALESCE(v_payload->>'payloadHash', 'no_hash'),
        COALESCE(v_payload->>'deviceId', 'default_device'),
        auth.uid()
    );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.execute_sync_command(uuid,text,text,uuid,jsonb,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.execute_sync_command(uuid,text,text,uuid,jsonb,integer) TO authenticated;
