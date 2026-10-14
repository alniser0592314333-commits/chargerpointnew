\set ON_ERROR_STOP on
DO $unauthenticated$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', false);
  BEGIN
    PERFORM public.capture_sync_bootstrap_snapshot();
    RAISE EXCEPTION 'BOOTSTRAP_RPC_AUTH_GUARD_NOT_ENFORCED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'BOOTSTRAP_RPC_AUTH_GUARD_NOT_ENFORCED'
       OR SQLERRM NOT LIKE 'Authentication required%' THEN
      RAISE;
    END IF;
  END;
END;
$unauthenticated$;

DO $authenticated$
DECLARE
  snapshot jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
  snapshot := public.capture_sync_bootstrap_snapshot();
  IF (snapshot->>'schema_version')::integer <> 1
     OR (snapshot->>'server_reset_generation')::bigint <> 7
     OR (snapshot->>'max_change_sequence')::bigint <> 3
     OR jsonb_typeof(snapshot->'business_days') <> 'array'
     OR jsonb_typeof(snapshot->'customers') <> 'array'
     OR jsonb_typeof(snapshot->'device_types') <> 'array'
     OR jsonb_typeof(snapshot->'orders') <> 'array'
     OR jsonb_typeof(snapshot->'order_items') <> 'array'
     OR jsonb_typeof(snapshot->'financial_ledger') <> 'array'
     OR jsonb_typeof(snapshot->'payments') <> 'array'
     OR jsonb_typeof(snapshot->'payment_allocations') <> 'array'
     OR jsonb_typeof(snapshot->'order_number_reservations') <> 'array'
     OR jsonb_typeof(snapshot->'qr_tokens') <> 'array'
     OR jsonb_typeof(snapshot->'goals') <> 'array'
     OR jsonb_typeof(snapshot->'goal_requests') <> 'array'
     OR jsonb_array_length(snapshot->'customers') <> 1 THEN
    RAISE EXCEPTION 'BOOTSTRAP_RPC_RESPONSE_CONTRACT_FAILED: %', snapshot;
  END IF;
END;
$authenticated$;

DO $inactive$
BEGIN
  UPDATE public.admins SET is_active = false;
  BEGIN
    PERFORM public.capture_sync_bootstrap_snapshot();
    RAISE EXCEPTION 'BOOTSTRAP_RPC_INACTIVE_ADMIN_GUARD_NOT_ENFORCED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'BOOTSTRAP_RPC_INACTIVE_ADMIN_GUARD_NOT_ENFORCED'
       OR SQLERRM NOT LIKE 'Forbidden: admin account is inactive%' THEN
      RAISE;
    END IF;
  END;
END;
$inactive$;

DO $privileges$
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.capture_sync_bootstrap_snapshot()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.capture_sync_bootstrap_snapshot()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.capture_sync_bootstrap_snapshot()', 'EXECUTE') THEN
    RAISE EXCEPTION 'BOOTSTRAP_RPC_PRIVILEGE_CONTRACT_FAILED';
  END IF;
END;
$privileges$;
