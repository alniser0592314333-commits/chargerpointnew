-- Expired Sarah task checkpoints are purged, and the purge entry point is private.

DO $task_retention$
DECLARE
  v_actor uuid := gen_random_uuid();
  v_session uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_deleted bigint;
BEGIN
  INSERT INTO public.sarah_ai_tasks (
    auth_user_id, auth_session_id, request_id, request_hash,
    status, state, expires_at
  ) VALUES (
    v_actor, v_session, v_request, repeat('c', 64),
    'FAILED', '{"phase":"expired-test"}'::jsonb,
    statement_timestamp() - interval '1 minute'
  );

  v_deleted := public.sarah_ai_purge_expired_tasks();
  IF v_deleted < 1 THEN
    RAISE EXCEPTION 'Expired Sarah task checkpoint was not purged';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sarah_ai_tasks
    WHERE auth_user_id = v_actor
      AND auth_session_id = v_session
      AND request_id = v_request
  ) THEN
    RAISE EXCEPTION 'Expired Sarah task checkpoint remains after purge';
  END IF;
END;
$task_retention$;

DO $task_retention_acl$
BEGIN
  IF has_function_privilege('anon','public.sarah_ai_purge_expired_tasks()','EXECUTE')
     OR has_function_privilege('authenticated','public.sarah_ai_purge_expired_tasks()','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_purge_expired_tasks()','EXECUTE') THEN
    RAISE EXCEPTION 'Sarah task purge function must remain inaccessible to API roles';
  END IF;
END;
$task_retention_acl$;
