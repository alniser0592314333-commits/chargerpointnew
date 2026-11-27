-- Verify Sarah task state is reachable only through the trusted service-role gateway.
-- Run after sarah_ai_durable_task_checkpoints.test.sql and its provider fixture.

DO $task_gateway_acl$
BEGIN
  IF has_function_privilege('anon','public.sarah_ai_task_load_or_create(uuid,text,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','public.sarah_ai_task_load_or_create(uuid,text,jsonb)','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_task_load_or_create(uuid,text,jsonb)','EXECUTE')
     OR has_function_privilege('anon','public.sarah_ai_task_resume(uuid)','EXECUTE')
     OR has_function_privilege('authenticated','public.sarah_ai_task_resume(uuid)','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_task_resume(uuid)','EXECUTE')
     OR has_function_privilege('anon','public.sarah_ai_task_checkpoint(uuid,bigint,text,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','public.sarah_ai_task_checkpoint(uuid,bigint,text,jsonb)','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_task_checkpoint(uuid,bigint,text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'Legacy browser-callable Sarah task RPCs must be fully revoked';
  END IF;

  IF has_function_privilege('anon','public.sarah_ai_task_gateway_load_or_create(uuid,uuid,uuid,text,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','public.sarah_ai_task_gateway_load_or_create(uuid,uuid,uuid,text,jsonb)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.sarah_ai_task_gateway_load_or_create(uuid,uuid,uuid,text,jsonb)','EXECUTE')
     OR has_function_privilege('anon','public.sarah_ai_task_gateway_resume(uuid,uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.sarah_ai_task_gateway_resume(uuid,uuid,uuid,text)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.sarah_ai_task_gateway_resume(uuid,uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('anon','public.sarah_ai_task_gateway_checkpoint(uuid,uuid,uuid,bigint,text,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','public.sarah_ai_task_gateway_checkpoint(uuid,uuid,uuid,bigint,text,jsonb)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.sarah_ai_task_gateway_checkpoint(uuid,uuid,uuid,bigint,text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'Sarah task gateway RPC grants are not service-role-only';
  END IF;

  IF has_function_privilege('authenticated','public.sarah_ai_task_assert_gateway_actor(uuid,uuid)','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_task_assert_gateway_actor(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Sarah task gateway actor validator must remain private';
  END IF;

  IF has_table_privilege('anon','public.sarah_ai_tasks','SELECT')
     OR has_table_privilege('authenticated','public.sarah_ai_tasks','SELECT')
     OR has_table_privilege('service_role','public.sarah_ai_tasks','SELECT') THEN
    RAISE EXCEPTION 'Sarah task table must remain inaccessible directly';
  END IF;
END;
$task_gateway_acl$;

-- Add an active manager fixture with no AI-use grant for the negative permission test.
INSERT INTO auth.users(id)
VALUES ('10000000-0000-4000-8000-000000000099')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.admins(id,auth_user_id,role,is_active,disabled_at,permissions)
VALUES (
  '00000000-0000-4000-8000-000000000099',
  '10000000-0000-4000-8000-000000000099',
  'MANAGER',true,NULL,'{}'::text[]
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.sessions(id,user_id,created_at,not_after,user_agent)
VALUES (
  '20000000-0000-4000-8000-000000000099',
  '10000000-0000-4000-8000-000000000099',
  now(),NULL,'manager without ai use'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.account_sessions(session_id,user_id,revoked_at,session_expires_at)
VALUES (
  '20000000-0000-4000-8000-000000000099',
  '10000000-0000-4000-8000-000000000099',
  NULL,now()+interval '7 days'
)
ON CONFLICT (session_id) DO NOTHING;

-- Exercise the trusted gateway with a real fixture actor/session and ensure
-- it independently enforces active account/session and ai:use permission.
SET ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',false);

DO $task_gateway_lifecycle$
DECLARE
  v jsonb;
  v_request uuid := '70000000-0000-4000-8000-000000000098';
  v_actor uuid := '10000000-0000-4000-8000-000000000001';
  v_session uuid := '20000000-0000-4000-8000-000000000001';
  v_hash text := repeat('d',64);
BEGIN
  v := public.sarah_ai_task_gateway_load_or_create(
    v_actor,v_session,v_request,v_hash,'{"phase":"gateway-test"}'::jsonb
  );
  IF v->>'status'<>'RUNNING' OR (v->>'version')::bigint<>1
     OR v->'state'->>'phase'<>'gateway-test' THEN
    RAISE EXCEPTION 'Service gateway failed to create a Sarah task: %',v;
  END IF;

  v := public.sarah_ai_task_gateway_checkpoint(
    v_actor,v_session,v_request,1,'WAITING_CONFIRMATION',
    '{"phase":"waiting_confirmation","safe":true}'::jsonb
  );
  IF v->>'status'<>'WAITING_CONFIRMATION' OR (v->>'version')::bigint<>2 THEN
    RAISE EXCEPTION 'Service gateway failed to checkpoint a Sarah task: %',v;
  END IF;

  v := public.sarah_ai_task_gateway_resume(v_actor,v_session,v_request,v_hash);
  IF v->>'status'<>'WAITING_CONFIRMATION' OR (v->>'version')::bigint<>2
     OR v->'state'->>'phase'<>'waiting_confirmation' THEN
    RAISE EXCEPTION 'Service gateway failed to resume the saved Sarah task: %',v;
  END IF;

  BEGIN
    PERFORM public.sarah_ai_task_gateway_resume(
      '10000000-0000-4000-8000-000000000099',
      '20000000-0000-4000-8000-000000000099',
      v_request,v_hash
    );
    RAISE EXCEPTION 'Gateway accepted a different admin without ai:use';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.sarah_ai_task_gateway_resume(
      '10000000-0000-4000-8000-000000000006',
      '20000000-0000-4000-8000-000000000006',
      v_request,v_hash
    );
    RAISE EXCEPTION 'Gateway accepted a disabled admin';
  EXCEPTION WHEN SQLSTATE '28000' THEN NULL;
  END;

  BEGIN
    PERFORM public.sarah_ai_task_gateway_resume(
      v_actor,v_session,v_request,repeat('e',64)
    );
    RAISE EXCEPTION 'Gateway accepted a changed request hash';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END;
$task_gateway_lifecycle$;

RESET ROLE;
