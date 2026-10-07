-- Migration 00117: finalize the authoritative execute_sync_command wrapper.
-- The implementation remains in execute_sync_command_impl; this wrapper adds
-- reset-generation protection and preserves expected-version forwarding.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'execute_sync_command_impl'
          AND pg_get_function_identity_arguments(p.oid) =
              'p_command_id uuid, p_command_type text, p_aggregate_type text, p_aggregate_id uuid, p_payload jsonb, p_expected_version integer'
    ) THEN
        ALTER FUNCTION public.execute_sync_command(
            uuid, text, text, uuid, jsonb, integer
        ) RENAME TO execute_sync_command_impl;
    END IF;
END
$$;

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
SET search_path = public, pg_temp
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

    RETURN public.execute_sync_command_impl(
        p_command_id,
        p_command_type,
        p_aggregate_type,
        p_aggregate_id,
        v_payload,
        p_expected_version
    );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.execute_sync_command(uuid,text,text,uuid,jsonb,integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.execute_sync_command_impl(uuid,text,text,uuid,jsonb,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.execute_sync_command(uuid,text,text,uuid,jsonb,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.execute_sync_command_impl(uuid,text,text,uuid,jsonb,integer) TO authenticated;
