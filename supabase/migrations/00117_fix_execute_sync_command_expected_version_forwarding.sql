-- MIGRATION 00117: close the optimistic-concurrency contract gap in execute_sync_command.
-- The canonical processor reads expectedVersion from p_payload, while the legacy
-- wrapper previously accepted p_expected_version but silently discarded it.
-- Keep the wrapper backward-compatible and inject the transport-level version
-- into the canonical payload when the caller did not already provide one.

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
    v_payload jsonb;
BEGIN
    v_payload := COALESCE(p_payload, '{}'::jsonb);

    IF p_expected_version IS NOT NULL AND NOT (v_payload ? 'expectedVersion') THEN
        v_payload := jsonb_set(v_payload, '{expectedVersion}', to_jsonb(p_expected_version), true);
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

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('00117', 'fix_execute_sync_command_expected_version_forwarding')
ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name;