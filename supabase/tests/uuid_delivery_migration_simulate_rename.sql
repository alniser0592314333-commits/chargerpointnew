-- Mirror the production wrapper/implementation split without business writes.
ALTER FUNCTION public.execute_canonical_sync_command(
  uuid, text, jsonb, text, text, uuid
) RENAME TO execute_canonical_sync_command_unlocked;

CREATE FUNCTION public.execute_canonical_sync_command(
  p_command_id uuid,
  p_command_type text,
  p_payload jsonb,
  p_payload_hash text DEFAULT 'no_hash'::text,
  p_device_id text DEFAULT 'default_device'::text,
  p_actor_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
AS $function$
  SELECT public.execute_canonical_sync_command_unlocked(
    p_command_id, p_command_type, p_payload, p_payload_hash, p_device_id, p_actor_id
  );
$function$;
