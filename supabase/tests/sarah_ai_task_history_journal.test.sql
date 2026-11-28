-- Historical task journal is account-isolated, sanitized, and independent
-- from the seven-day resumable checkpoint retention window.
BEGIN;

SET ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);

DO $task_history_capture$
DECLARE
  v_actor uuid := '10000000-0000-4000-8000-000000000001';
  v_session uuid := '20000000-0000-4000-8000-000000000001';
  v_request uuid := '70000000-0000-4000-8000-000000000097';
  v_hash text := repeat('f',64);
  v_result jsonb;
  v_tasks jsonb;
  v_steps jsonb;
BEGIN
  PERFORM public.sarah_ai_task_gateway_load_or_create(
    v_actor, v_session, v_request, v_hash, '{"phase":"INITIAL"}'::jsonb
  );

  PERFORM public.sarah_ai_task_gateway_checkpoint(
    v_actor, v_session, v_request, 1, 'FAILED',
    '{
      "phase":"EXECUTING_TOOLS",
      "requestedCalls":[
        {"name":"lookup_customers","args":{"query":"PRIVATE CUSTOMER NAME"}},
        {"name":"record_customer_payment","args":{"customer_name":"PRIVATE CUSTOMER NAME","phone":"0599999999","amount":999}},
        {"name":"deliver_order_item","args":{"order_id":"PRIVATE-ORDER-ID"}}
      ],
      "resultsByIndex":{
        "0":{"ok":true,"result":{"name":"PRIVATE CUSTOMER NAME"}},
        "1":{"ok":false,"error":"PAYMENT_FAILED","result":{"phone":"0599999999","amount":999}},
        "2":{"ok":false,"executed":false,"retry_after_prerequisites":true,"error":"NOT_EXECUTED"}
      }
    }'::jsonb
  );

  v_result := public.sarah_ai_task_history_list(v_actor, v_session, 20, true, NULL);
  v_tasks := v_result -> 'tasks';
  IF jsonb_array_length(v_tasks) <> 1 THEN
    RAISE EXCEPTION 'Expected one failed historical task, got %', v_result;
  END IF;
  v_steps := v_tasks -> 0 -> 'steps';
  IF jsonb_array_length(v_steps) <> 3
     OR v_tasks -> 0 ->> 'failed_count' <> '1'
     OR v_tasks -> 0 ->> 'succeeded_count' <> '1'
     OR v_tasks -> 0 ->> 'not_executed_count' <> '1' THEN
    RAISE EXCEPTION 'Historical step outcomes were not recorded accurately: %', v_result;
  END IF;
  IF v_steps::text ILIKE '%PRIVATE%'
     OR v_steps::text ILIKE '%phone%'
     OR v_steps::text ILIKE '%amount%'
     OR v_steps::text ILIKE '%order_id%' THEN
    RAISE EXCEPTION 'Historical journal leaked task arguments or tool results: %', v_steps;
  END IF;
  IF v_steps -> 0 ->> 'capability' <> 'lookup_customers'
     OR v_steps -> 0 ->> 'status' <> 'succeeded'
     OR v_steps -> 1 ->> 'capability' <> 'record_customer_payment'
     OR v_steps -> 1 ->> 'status' <> 'failed'
     OR v_steps -> 2 ->> 'status' <> 'not_executed' THEN
    RAISE EXCEPTION 'Historical step sequence/status mismatch: %', v_steps;
  END IF;
END;
$task_history_capture$;

RESET ROLE;

-- Seed another actor's historical metadata. The authenticated actor's history
-- query must never return this row, even though the gateway can read the journal.
INSERT INTO public.sarah_ai_task_history (
  auth_user_id, auth_session_id, request_id, status, steps,
  succeeded_count, failed_count, not_executed_count, pending_count,
  created_at, updated_at
) VALUES (
  '90000000-0000-4000-8000-000000000099',
  '90000000-0000-4000-8000-000000000098',
  '90000000-0000-4000-8000-000000000097',
  'FAILED', '[{"capability":"send_sms","status":"failed"}]'::jsonb,
  0, 1, 0, 0, now(), now()
);

-- The historical row must remain after the short-lived checkpoint is deleted.
DELETE FROM public.sarah_ai_tasks
WHERE auth_user_id = '10000000-0000-4000-8000-000000000001'
  AND auth_session_id = '20000000-0000-4000-8000-000000000001'
  AND request_id = '70000000-0000-4000-8000-000000000097';

SET ROLE service_role;
DO $task_history_survives$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.sarah_ai_task_history_list(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    20, true, NULL
  );
  IF jsonb_array_length(v_result -> 'tasks') <> 1 THEN
    RAISE EXCEPTION 'Historical task journal was deleted with its resumable checkpoint: %', v_result;
  END IF;
END;
$task_history_survives$;

RESET ROLE;

DO $task_history_acl$
BEGIN
  IF has_table_privilege('anon','public.sarah_ai_task_history','SELECT')
     OR has_table_privilege('authenticated','public.sarah_ai_task_history','SELECT')
     OR has_table_privilege('service_role','public.sarah_ai_task_history','SELECT') THEN
    RAISE EXCEPTION 'Sarah historical task table must not be directly readable';
  END IF;
  IF has_function_privilege('anon','public.sarah_ai_task_history_list(uuid,uuid,integer,boolean,uuid)','EXECUTE')
     OR has_function_privilege('authenticated','public.sarah_ai_task_history_list(uuid,uuid,integer,boolean,uuid)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.sarah_ai_task_history_list(uuid,uuid,integer,boolean,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Sarah historical task RPC must be service-role-only';
  END IF;
END;
$task_history_acl$;

ROLLBACK;
