DO $test$
DECLARE
  v_snapshot jsonb;
BEGIN
  IF has_function_privilege('anon', 'public.capture_sync_bootstrap_snapshot()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute the bootstrap snapshot RPC';
  END IF;
  IF has_function_privilege('service_role', 'public.capture_sync_bootstrap_snapshot()', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must not execute the bootstrap snapshot RPC';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.capture_sync_bootstrap_snapshot()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must execute the bootstrap snapshot RPC';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM public.capture_sync_bootstrap_snapshot();
    RAISE EXCEPTION 'BOOTSTRAP_AUTH_GUARD_NOT_ENFORCED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'BOOTSTRAP_AUTH_GUARD_NOT_ENFORCED'
       OR SQLERRM NOT LIKE 'Authentication required%' THEN
      RAISE;
    END IF;
  END;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
  BEGIN
    PERFORM public.capture_sync_bootstrap_snapshot();
    RAISE EXCEPTION 'BOOTSTRAP_INACTIVE_ADMIN_GUARD_NOT_ENFORCED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'BOOTSTRAP_INACTIVE_ADMIN_GUARD_NOT_ENFORCED'
       OR SQLERRM NOT LIKE 'Forbidden: admin account is inactive%' THEN
      RAISE;
    END IF;
  END;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
  v_snapshot := public.capture_sync_bootstrap_snapshot();
  IF (v_snapshot->>'schema_version')::integer <> 1 THEN
    RAISE EXCEPTION 'Unexpected bootstrap schema version';
  END IF;
  IF (v_snapshot->>'server_reset_generation')::bigint <> 7 THEN
    RAISE EXCEPTION 'Bootstrap reset generation was not captured';
  END IF;
  IF (v_snapshot->>'max_change_sequence')::bigint <> 41 THEN
    RAISE EXCEPTION 'Bootstrap high-water mark was not captured';
  END IF;
  IF jsonb_array_length(v_snapshot->'customers') <> 1
     OR v_snapshot->'customers'->0->>'name' <> 'Snapshot customer' THEN
    RAISE EXCEPTION 'Bootstrap customer rows are incomplete';
  END IF;
  IF jsonb_array_length(v_snapshot->'business_days') <> 0
     OR jsonb_array_length(v_snapshot->'orders') <> 0
     OR jsonb_array_length(v_snapshot->'order_items') <> 0
     OR jsonb_array_length(v_snapshot->'financial_ledger') <> 0
     OR jsonb_array_length(v_snapshot->'payments') <> 0
     OR jsonb_array_length(v_snapshot->'payment_allocations') <> 0
     OR jsonb_array_length(v_snapshot->'device_types') <> 0
     OR jsonb_array_length(v_snapshot->'order_number_reservations') <> 0
     OR jsonb_array_length(v_snapshot->'qr_tokens') <> 0
     OR jsonb_array_length(v_snapshot->'goals') <> 0
     OR jsonb_array_length(v_snapshot->'goal_requests') <> 0 THEN
    RAISE EXCEPTION 'Bootstrap response omitted a required empty collection';
  END IF;
END;
$test$;
