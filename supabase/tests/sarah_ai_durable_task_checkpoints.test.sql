-- Durable Sarah task checkpoint authorization, replay, and secret-exclusion tests.
-- Run after the provider/quota migrations and sarah_ai_provider_config_fixture.sql.

SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000001',false);

DO $task_checkpoint_lifecycle$
DECLARE
  v jsonb;
  v_replay jsonb;
  v_hash text := repeat('a',64);
  v_request uuid := '70000000-0000-4000-8000-000000000099';
BEGIN
  v := public.sarah_ai_task_load_or_create(
    v_request, v_hash,
    '{"phase":"awaiting_model","currentContents":[],"verifiedPrerequisites":[]}'::jsonb
  );
  IF v->>'status' <> 'RUNNING' OR (v->>'version')::bigint <> 1
     OR v->'state'->>'phase' <> 'awaiting_model' THEN
    RAISE EXCEPTION 'Initial Sarah task checkpoint was not created: %', v;
  END IF;

  -- Reopening the same request ID/hash must return the saved state, not overwrite it.
  v_replay := public.sarah_ai_task_load_or_create(
    v_request, v_hash, '{"phase":"must_not_replace"}'::jsonb
  );
  IF (v_replay->>'version')::bigint <> 1
     OR v_replay->'state'->>'phase' <> 'awaiting_model' THEN
    RAISE EXCEPTION 'Sarah task replay overwrote the durable checkpoint: %', v_replay;
  END IF;

  v := public.sarah_ai_task_checkpoint(
    v_request, 1, 'WAITING_CONFIRMATION',
    '{"phase":"waiting_confirmation","completedCalls":[{"name":"read"}],"pendingAction":{"name":"deliver_order_item","args":{"item_id":"x"}}}'::jsonb
  );
  IF v->>'status' <> 'WAITING_CONFIRMATION' OR (v->>'version')::bigint <> 2 THEN
    RAISE EXCEPTION 'Sarah task did not advance with an optimistic version: %', v;
  END IF;

  v_replay := public.sarah_ai_task_load_or_create(v_request, v_hash, '{}'::jsonb);
  IF v_replay->>'status' <> 'WAITING_CONFIRMATION'
     OR (v_replay->>'version')::bigint <> 2
     OR v_replay->'state'->>'phase' <> 'waiting_confirmation' THEN
    RAISE EXCEPTION 'Sarah task could not resume from the saved confirmation checkpoint: %', v_replay;
  END IF;
  v_replay := public.sarah_ai_task_resume(v_request);
  IF v_replay->>'status' <> 'WAITING_CONFIRMATION'
     OR (v_replay->>'version')::bigint <> 2
     OR v_replay->'state'->>'phase' <> 'waiting_confirmation' THEN
    RAISE EXCEPTION 'Session-bound Sarah task resume RPC did not return the saved checkpoint: %', v_replay;
  END IF;

  BEGIN
    PERFORM public.sarah_ai_task_checkpoint(v_request, 1, 'RUNNING', '{"phase":"stale"}'::jsonb);
    RAISE EXCEPTION 'Stale Sarah task checkpoint version unexpectedly succeeded';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;

  BEGIN
    PERFORM public.sarah_ai_task_load_or_create(v_request, repeat('b',64), '{}'::jsonb);
    RAISE EXCEPTION 'Sarah task request ID was reused with a different input hash';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.sarah_ai_task_checkpoint(v_request, 2, 'RUNNING', '{"nested":{"BIN":"1234"}}'::jsonb);
    RAISE EXCEPTION 'Sarah task checkpoint accepted a nested BIN field';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$task_checkpoint_lifecycle$;

RESET ROLE;

DO $task_checkpoint_acl$
DECLARE
  v_table oid := 'public.sarah_ai_tasks'::regclass;
BEGIN
  IF has_table_privilege('anon', v_table, 'SELECT')
     OR has_table_privilege('authenticated', v_table, 'SELECT')
     OR has_table_privilege('service_role', v_table, 'SELECT') THEN
    RAISE EXCEPTION 'Sarah task table must not be directly readable by browser or service roles';
  END IF;
  IF has_function_privilege('anon','public.sarah_ai_task_load_or_create(uuid,text,jsonb)','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_task_load_or_create(uuid,text,jsonb)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.sarah_ai_task_load_or_create(uuid,text,jsonb)','EXECUTE')
     OR has_function_privilege('anon','public.sarah_ai_task_checkpoint(uuid,bigint,text,jsonb)','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_task_checkpoint(uuid,bigint,text,jsonb)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.sarah_ai_task_checkpoint(uuid,bigint,text,jsonb)','EXECUTE')
     OR has_function_privilege('anon','public.sarah_ai_task_resume(uuid)','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_task_resume(uuid)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.sarah_ai_task_resume(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Sarah task RPC grants are not session-bound to authenticated users';
  END IF;
  IF has_function_privilege('authenticated','public.sarah_ai_task_state_has_forbidden_keys(jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'Sarah task sensitive-key validator must remain private';
  END IF;
END;
$task_checkpoint_acl$;

DO $task_checkpoint_privacy$
BEGIN
  IF public.sarah_ai_task_state_has_forbidden_keys(
    '{"outer":[{"nested":{"bin":"1234"}}]}'::jsonb
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Nested secret-key detection failed';
  END IF;
  IF public.sarah_ai_task_state_has_forbidden_keys(
    '{"args":{"item_id":"safe","amount_minor":1000}}'::jsonb
  ) IS TRUE THEN
    RAISE EXCEPTION 'Ordinary tool arguments were incorrectly rejected';
  END IF;
END;
$task_checkpoint_privacy$;
