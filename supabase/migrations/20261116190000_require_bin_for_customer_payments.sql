-- Require an administrator BIN for every canonical customer payment command.
-- Keep the guard in the shared canonical RPC wrapper so all callers (including
-- queued offline commands and server-side review flows) pass through one boundary.
CREATE OR REPLACE FUNCTION public.execute_canonical_sync_command(
  p_command_id uuid,
  p_command_type text,
  p_payload jsonb,
  p_payload_hash text,
  p_device_id text,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_bin text;
BEGIN
  IF p_command_type IN ('POST_PAYMENT', 'CREATE_PAYMENT', 'CREATE_CUSTOMER_CREDIT') THEN
    v_bin := NULLIF(
      pg_catalog.btrim(COALESCE(p_payload->>'bin', p_payload->>'adminBin', '')),
      ''
    );

    IF v_bin IS NULL OR v_bin !~ '^[0-9]{4,}$' THEN
      RAISE EXCEPTION 'Authorization required: BIN is required for %', p_command_type
        USING ERRCODE = 'P4004';
    END IF;

    IF public.verify_admin_bin(v_bin) IS NOT TRUE THEN
      RAISE EXCEPTION 'Invalid BIN: Security verification failed'
        USING ERRCODE = 'P0003';
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('chargerpointnew:change_log:commit_order', 0)
  );

  RETURN public.execute_canonical_sync_command_unlocked(
    p_command_id,
    p_command_type,
    p_payload,
    p_payload_hash,
    p_device_id,
    p_actor_id
  );
END;
$function$;

COMMENT ON FUNCTION public.execute_canonical_sync_command(uuid, text, jsonb, text, text, uuid)
IS 'Canonical sync boundary. Enforces BIN verification for customer payment and credit mutations before execution.';
