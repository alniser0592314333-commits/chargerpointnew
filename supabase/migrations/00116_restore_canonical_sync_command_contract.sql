-- Migration 00116: keep one business-logic authority for sync commands.
-- execute_sync_command is the authoritative processor used by the runtime.
-- execute_canonical_sync_command is compatibility-only and delegates to it.
-- This migration intentionally contains no duplicate business logic.

DROP FUNCTION IF EXISTS public.execute_canonical_sync_command(UUID,VARCHAR(100),JSONB,TEXT,TEXT,TEXT);
DROP FUNCTION IF EXISTS public.execute_canonical_sync_command(UUID,VARCHAR(100),JSONB,TEXT,TEXT,UUID);
DROP FUNCTION IF EXISTS public.execute_canonical_sync_command(UUID,TEXT,JSONB,TEXT,TEXT,TEXT);
DROP FUNCTION IF EXISTS public.execute_canonical_sync_command(UUID,TEXT,JSONB,TEXT,TEXT,UUID);

CREATE OR REPLACE FUNCTION public.execute_canonical_sync_command(
    p_command_id UUID,
    p_command_type TEXT,
    p_payload JSONB,
    p_payload_hash TEXT DEFAULT 'no_hash',
    p_device_id TEXT DEFAULT 'default_device',
    p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
    RETURN public.execute_sync_command(
        p_command_id,
        p_command_type,
        'canonical_sync',
        NULL,
        COALESCE(p_payload, '{}'::jsonb),
        NULL
    );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.execute_canonical_sync_command(UUID,TEXT,JSONB,TEXT,TEXT,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.execute_canonical_sync_command(UUID,TEXT,JSONB,TEXT,TEXT,UUID) TO authenticated;
