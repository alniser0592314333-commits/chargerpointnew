\set ON_ERROR_STOP on
BEGIN;

SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);

DO $test$
DECLARE
  v_manifest jsonb;
  v_first jsonb;
  v_second jsonb;
  v_purchase jsonb;
  v_order_id uuid := '30000000-0000-4000-8000-000000000001';
BEGIN
  v_manifest := public.begin_sync_bootstrap();
  IF (v_manifest->>'schema_version')::integer <> 2
     OR v_manifest->>'admin_id' <> '00000000-0000-4000-8000-000000000001'
     OR (v_manifest->>'server_reset_generation')::bigint <> 17
     OR (v_manifest->>'max_change_sequence')::bigint <> 23
     OR (v_manifest->>'page_size')::integer <> 500
     OR jsonb_array_length(v_manifest->'collections') <> 20 THEN
    RAISE EXCEPTION 'Manifest did not pin the expected checkpoint: %', v_manifest;
  END IF;

  v_first := public.read_sync_bootstrap_page('customers', NULL, 500);
  IF jsonb_array_length(v_first->'rows') <> 500
     OR (v_first->>'has_more')::boolean IS NOT TRUE
     OR v_first->>'next_cursor' IS NULL THEN
    RAISE EXCEPTION 'First customer page is not bounded/continuable: %', v_first;
  END IF;

  v_second := public.read_sync_bootstrap_page('customers', v_first->>'next_cursor', 500);
  IF jsonb_array_length(v_second->'rows') <> 1
     OR (v_second->>'has_more')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'Second customer page did not finish the keyset scan: %', v_second;
  END IF;

  v_purchase := public.read_sync_bootstrap_page('purchase_orders', NULL, 500);
  IF jsonb_array_length(v_purchase->'rows') <> 1
     OR v_purchase->'rows'->0->>'admin_id' <> '00000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'Purchase page leaked or omitted another admin record: %', v_purchase;
  END IF;
  UPDATE public.system_settings SET value_number = 18 WHERE key = 'server_reset_generation';
  PERFORM public.record_canonical_change(
    'system_settings'::character varying,
    '20000000-0000-4000-8000-000000000001'::uuid,
    'UPDATE'::character varying,
    jsonb_build_object('key', 'server_reset_generation', 'value_number', 18),
    1
  );
  IF (SELECT count(*) FROM public.change_log
      WHERE entity_type='system_settings' AND action='UPDATE'
        AND payload->>'key'='server_reset_generation') <> 1 THEN
    RAISE EXCEPTION 'System-setting trigger and canonical command produced duplicate or missing events';
  END IF;

  DELETE FROM public.system_settings WHERE key = 'server_reset_generation';
  IF (SELECT count(*) FROM public.change_log
      WHERE entity_type='system_settings' AND action='DELETE'
        AND payload->>'key'='server_reset_generation') <> 1 THEN
    RAISE EXCEPTION 'System-setting delete was not captured';
  END IF;
  PERFORM public.record_canonical_change(
    'orders'::text, v_order_id, 'UPDATE'::text,
    jsonb_build_object('id', v_order_id, 'status', 'READY', 'version', 2), 2
  );
  PERFORM public.record_canonical_change(
    'orders'::character varying, v_order_id, 'UPDATE'::character varying,
    jsonb_build_object('id', v_order_id, 'status', 'READY', 'version', 2), 2
  );
  IF (SELECT count(*) FROM public.change_log
      WHERE entity_type='orders' AND entity_id=v_order_id AND action='UPDATE') <> 1 THEN
    RAISE EXCEPTION 'Trigger/command event deduplication failed for orders';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.begin_sync_bootstrap()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.begin_sync_bootstrap()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.read_sync_bootstrap_page(text,text,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.read_sync_bootstrap_page(text,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Bootstrap RPC grants are not restricted to authenticated users';
  END IF;
END;
$test$;

ROLLBACK;
