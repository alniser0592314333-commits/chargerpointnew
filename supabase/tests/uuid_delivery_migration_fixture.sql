-- Minimal dispatcher fixture for the UUID delivery migration contract.
CREATE TABLE public.financial_ledger (
  id uuid PRIMARY KEY,
  amount_minor bigint NOT NULL
);

CREATE OR REPLACE FUNCTION public.execute_canonical_sync_command(
  p_command_id uuid,
  p_command_type text,
  p_payload jsonb,
  p_payload_hash text DEFAULT 'no_hash'::text,
  p_device_id text DEFAULT 'default_device'::text,
  p_actor_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_count bigint;
  v_id uuid;
  v_amount bigint;
BEGIN
  SELECT COUNT(*), MIN(id), MIN(amount_minor)
    INTO v_count, v_id, v_amount
  FROM public.financial_ledger;

  RETURN jsonb_build_object('count', v_count, 'id', v_id, 'amount', v_amount);
END;
$function$;
