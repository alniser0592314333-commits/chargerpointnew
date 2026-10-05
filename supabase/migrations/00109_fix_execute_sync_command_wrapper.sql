-- MIGRATION 00109: Fix execute_sync_command Wrapper Contract Drift
-- Updates public.execute_sync_command to pass auth.uid() (UUID) as the 6th argument (p_actor_id)
-- to public.execute_canonical_sync_command, while forwarding p_payload (containing bin) unchanged.

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
        p_payload,
        COALESCE(p_payload->>'payloadHash', 'no_hash'),
        COALESCE(p_payload->>'deviceId', 'default_device'),
        auth.uid()
    );
END;
$function$;

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('00109', 'fix_execute_sync_command_wrapper')
ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name;
