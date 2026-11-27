CREATE OR REPLACE FUNCTION public.execute_customer_top_up_atomic__session_guarded_impl(
  p_command_id uuid,
  p_customer_id uuid,
  p_amount_minor bigint,
  p_bin text,
  p_note text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_balance bigint;
  v_server_generation bigint;
BEGIN
  SELECT COALESCE(value_number, 1)
    INTO v_server_generation
  FROM public.system_settings
  WHERE key = 'server_reset_generation';
  v_server_generation := COALESCE(v_server_generation, 1);

  v_result := public.execute_sync_command(
    p_command_id,
    'CREATE_CUSTOMER_CREDIT',
    'financial_ledger',
    p_customer_id,
    jsonb_build_object(
      'resetGeneration', v_server_generation,
      'customerId', p_customer_id,
      'amountMinor', p_amount_minor,
      'bin', p_bin,
      'note', p_note
    ),
    NULL
  );

  SELECT COALESCE(sum(amount_minor), 0)
    INTO v_balance
  FROM public.financial_ledger
  WHERE customer_id = p_customer_id;

  RETURN jsonb_build_object(
    'success', true,
    'transactionId', p_command_id,
    'newBalanceMinor', v_balance,
    'result', v_result
  );
END;
$function$;
