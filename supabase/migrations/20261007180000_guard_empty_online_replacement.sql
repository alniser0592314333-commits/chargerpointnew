-- Safety hardening: never allow Local -> Online replacement to purge the cloud
-- when the captured local business payload is empty.
-- The explicit Online Reset workflow remains the only intentional empty-cloud operation.

CREATE OR REPLACE FUNCTION public._cp_guard_nonempty_replacement_payload(p_payload JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total BIGINT;
BEGIN
  v_total :=
    COALESCE(jsonb_array_length(COALESCE(p_payload->'device_types', p_payload->'deviceTypes', '[]'::jsonb)), 0) +
    COALESCE(jsonb_array_length(COALESCE(p_payload->'business_days', p_payload->'businessDays', '[]'::jsonb)), 0) +
    COALESCE(jsonb_array_length(COALESCE(p_payload->'customers', '[]'::jsonb)), 0) +
    COALESCE(jsonb_array_length(COALESCE(p_payload->'qr_tokens', p_payload->'qrTokens', '[]'::jsonb)), 0) +
    COALESCE(jsonb_array_length(COALESCE(p_payload->'orders', '[]'::jsonb)), 0) +
    COALESCE(jsonb_array_length(COALESCE(p_payload->'order_items', p_payload->'orderItems', '[]'::jsonb)), 0) +
    COALESCE(jsonb_array_length(COALESCE(p_payload->'payments', '[]'::jsonb)), 0) +
    COALESCE(jsonb_array_length(COALESCE(p_payload->'financial_ledger', p_payload->'financialLedger', '[]'::jsonb)), 0) +
    COALESCE(jsonb_array_length(COALESCE(p_payload->'payment_allocations', p_payload->'paymentAllocations', '[]'::jsonb)), 0);

  IF v_total = 0 THEN
    RAISE EXCEPTION 'SAFE_REPLACE_BLOCKED: local replacement payload is empty; cloud data was not modified';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public._cp_guard_nonempty_replacement_payload(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._cp_guard_nonempty_replacement_payload(JSONB) TO authenticated;

DO $$
DECLARE
  v_def TEXT;
  v_marker TEXT := E'    v_bin_verified := verify_admin_bin(p_entered_bin);\n    IF v_bin_verified IS NOT TRUE THEN\n        RAISE EXCEPTION ''Invalid BIN: Security verification failed for Online Replacement'';\n    END IF;\n';
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'replace_online_business_data'
     AND pg_get_function_identity_arguments(p.oid) = 'p_entered_bin text, p_payload jsonb';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'replace_online_business_data function not found';
  END IF;

  IF position('PERFORM public._cp_guard_nonempty_replacement_payload(p_payload);' IN v_def) = 0 THEN
    IF position(v_marker IN v_def) = 0 THEN
      RAISE EXCEPTION 'Expected BIN verification marker not found';
    END IF;

    v_def := replace(
      v_def,
      v_marker,
      v_marker || E'\n    PERFORM public._cp_guard_nonempty_replacement_payload(p_payload);\n'
    );

    EXECUTE v_def;
  END IF;
END $$;
