-- MIGRATION 00117: Keep the public sync wrapper aligned with the canonical processor.
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
BEGIN
    RETURN public.execute_canonical_sync_command(
        p_command_id,
        p_command_type,
        p_payload || jsonb_build_object('expectedVersion', p_expected_version),
        COALESCE(p_payload->>'payloadHash', 'no_hash'),
        COALESCE(p_payload->>'deviceId', 'default_device'),
        auth.uid()
    );
END;
$function$;

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('00117', 'sync_wrapper_expected_version_contract')
ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name;
