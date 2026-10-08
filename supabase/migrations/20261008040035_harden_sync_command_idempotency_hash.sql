-- Compute a server-authoritative payload hash for the sync command wrapper.
-- This closes the idempotency gap when clients omit payloadHash.
CREATE OR REPLACE FUNCTION public.execute_sync_command(p_command_id uuid, p_command_type text, p_aggregate_type text DEFAULT NULL::text, p_aggregate_id uuid DEFAULT NULL::uuid, p_payload jsonb DEFAULT '{}'::jsonb, p_expected_version integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    RETURN public.execute_canonical_sync_command(
        p_command_id,
        p_command_type,
        p_payload || CASE WHEN p_expected_version IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('expectedVersion',p_expected_version) END,
        encode(digest(
            (
                p_payload || CASE WHEN p_expected_version IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('expectedVersion',p_expected_version) END
            ) - 'payloadHash',
            'sha256'
        ), 'hex'),
        COALESCE(p_payload->>'deviceId','default_device'),
        auth.uid()
    );
END;
$function$
