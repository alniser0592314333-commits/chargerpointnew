-- Create one failed checkpoint before the history trigger exists.
-- This simulates a task already retained by production when the journal ships.
BEGIN;
SET ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);

DO $task_history_backfill_fixture$
DECLARE
  v jsonb;
  v_actor uuid := '10000000-0000-4000-8000-000000000001';
  v_session uuid := '20000000-0000-4000-8000-000000000001';
  v_request uuid := '70000000-0000-4000-8000-000000000096';
  v_hash text := repeat('b',64);
  v_state jsonb := '{
    "phase":"pre_journal_failure",
    "requestedCalls":[
      {"name":"lookup_customers","args":{"customer_name":"PRIVATE CUSTOMER NAME","phone":"0599999999"}}
    ],
    "resultsByIndex":{
      "0":{"ok":false,"error":"TARGET_NOT_FOUND","result":{"customer_name":"PRIVATE CUSTOMER NAME","phone":"0599999999"}}
    }
  }'::jsonb;
BEGIN
  v := public.sarah_ai_task_gateway_load_or_create(
    v_actor,v_session,v_request,v_hash,
    '{"phase":"pre_journal_fixture"}'::jsonb
  );
  IF v->>'status'<>'RUNNING' OR (v->>'version')::bigint<>1 THEN
    RAISE EXCEPTION 'Could not seed pre-journal Sarah task fixture: %',v;
  END IF;

  v := public.sarah_ai_task_gateway_checkpoint(
    v_actor,v_session,v_request,1,'FAILED',v_state
  );
  IF v->>'status'<>'FAILED' OR (v->>'version')::bigint<>2 THEN
    RAISE EXCEPTION 'Could not checkpoint pre-journal Sarah failure fixture: %',v;
  END IF;
END;
$task_history_backfill_fixture$;

RESET ROLE;
COMMIT;
