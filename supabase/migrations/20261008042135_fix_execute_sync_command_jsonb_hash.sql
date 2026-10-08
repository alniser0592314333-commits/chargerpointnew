-- Fix JSONB hashing in the sync command wrapper.
-- PostgreSQL pgcrypto digest() accepts text/bytea, not jsonb.
-- The previous definition passed jsonb directly and caused SQLSTATE 42883:
-- function digest(jsonb, unknown) does not exist.

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
  v_payload := p_payload
    || CASE
         WHEN p_expected_version IS NULL THEN '{}'::jsonb
         ELSE jsonb_build_object('expectedVersion', p_expected_version)
       END;

  RETURN public.execute_canonical_sync_command(
    p_command_id,
    p_command_type,
    v_payload,
    encode(
      digest(
        convert_to((v_payload - 'payloadHash')::text, 'UTF8'),
        'sha256'
      ),
      'hex'
    ),
    COALESCE(p_payload->>'deviceId','default_device'),
    auth.uid()
  );
END;
$function$;
