-- Keep Sarah's durable orchestration state behind the trusted Edge Function.
-- The authenticated browser must never call a task RPC that returns full saved
-- model/tool state. Only the service-role client inside sarah-ai-chat may use
-- these gateway RPCs; actor/session are revalidated from the live admin/session
-- tables before every load, resume, or checkpoint write.

CREATE OR REPLACE FUNCTION public.sarah_ai_task_assert_gateway_actor(
  p_actor_id uuid,
  p_session_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_admin_id uuid;
  v_role text;
BEGIN
  IF COALESCE(
    NULLIF(auth.jwt() ->> 'role', ''),
    NULLIF(current_setting('request.jwt.claim.role', true), '')
  ) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Sarah task gateway requires service role'
      USING ERRCODE = '42501';
  END IF;

  IF p_actor_id IS NULL OR p_session_id IS NULL THEN
    RAISE EXCEPTION 'Active Sarah admin session required'
      USING ERRCODE = '28000';
  END IF;

  SELECT a.id, a.role
    INTO v_admin_id, v_role
  FROM public.admins a
  JOIN public.account_sessions account_session
    ON account_session.user_id = a.auth_user_id
   AND account_session.session_id = p_session_id
   AND account_session.revoked_at IS NULL
   AND account_session.session_expires_at > now()
  JOIN auth.sessions auth_session
    ON auth_session.id = account_session.session_id
   AND auth_session.user_id = a.auth_user_id
   AND (auth_session.not_after IS NULL OR auth_session.not_after > now())
  WHERE a.auth_user_id = p_actor_id
    AND a.is_active IS TRUE
    AND a.disabled_at IS NULL
  LIMIT 1;

  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Sarah admin session is revoked, expired, or unavailable'
      USING ERRCODE = '28000';
  END IF;

  IF upper(replace(COALESCE(v_role, ''), ' ', '_')) <> 'SUPER_ADMIN'
     AND NOT EXISTS (
       SELECT 1
       FROM public.get_effective_permissions(v_admin_id) permission_row
       WHERE permission_row.permission = 'ai:use'
     ) THEN
    RAISE EXCEPTION 'AI_USE_PERMISSION_REQUIRED'
      USING ERRCODE = '42501';
  END IF;

  RETURN p_actor_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sarah_ai_task_gateway_load_or_create(
  p_actor_id uuid,
  p_session_id uuid,
  p_request_id uuid,
  p_request_hash text,
  p_initial_state jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_task public.sarah_ai_tasks%ROWTYPE;
BEGIN
  PERFORM public.sarah_ai_task_assert_gateway_actor(p_actor_id, p_session_id);

  IF p_request_id IS NULL
     OR p_request_hash IS NULL
     OR length(p_request_hash) <> 64
     OR p_request_hash ~ '[^0-9a-f]'
     OR p_initial_state IS NULL
     OR jsonb_typeof(p_initial_state) <> 'object'
     OR pg_column_size(p_initial_state) > 524288
     OR public.sarah_ai_task_state_has_forbidden_keys(p_initial_state) THEN
    RAISE EXCEPTION 'Invalid or sensitive Sarah task state'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.sarah_ai_tasks(auth_user_id, auth_session_id, request_id, request_hash, state)
  VALUES (p_actor_id, p_session_id, p_request_id, p_request_hash, p_initial_state)
  ON CONFLICT (auth_user_id, auth_session_id, request_id) DO NOTHING;

  SELECT * INTO v_task
  FROM public.sarah_ai_tasks
  WHERE auth_user_id = p_actor_id
    AND auth_session_id = p_session_id
    AND request_id = p_request_id
  FOR UPDATE;

  IF v_task.request_hash <> p_request_hash THEN
    RAISE EXCEPTION 'Sarah task request identity conflict'
      USING ERRCODE = '23505';
  END IF;
  IF v_task.expires_at <= now() THEN
    RAISE EXCEPTION 'Sarah task checkpoint expired'
      USING ERRCODE = '55000';
  END IF;

  RETURN jsonb_build_object(
    'request_id', v_task.request_id,
    'status', v_task.status,
    'state', v_task.state,
    'version', v_task.version,
    'created', v_task.created_at,
    'updated', v_task.updated_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.sarah_ai_task_gateway_resume(
  p_actor_id uuid,
  p_session_id uuid,
  p_request_id uuid,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_task public.sarah_ai_tasks%ROWTYPE;
BEGIN
  PERFORM public.sarah_ai_task_assert_gateway_actor(p_actor_id, p_session_id);

  IF p_request_id IS NULL
     OR p_request_hash IS NULL
     OR length(p_request_hash) <> 64
     OR p_request_hash ~ '[^0-9a-f]' THEN
    RAISE EXCEPTION 'Invalid Sarah task resume identity'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_task
  FROM public.sarah_ai_tasks
  WHERE auth_user_id = p_actor_id
    AND auth_session_id = p_session_id
    AND request_id = p_request_id
    AND expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1
      FROM public.sarah_ai_tasks
      WHERE auth_user_id = p_actor_id
        AND request_id = p_request_id
    ) THEN
      RAISE EXCEPTION 'Sarah task belongs to another or expired session'
        USING ERRCODE = '28000';
    END IF;
    RAISE EXCEPTION 'Sarah task checkpoint unavailable'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_task.request_hash <> p_request_hash THEN
    RAISE EXCEPTION 'Sarah task request identity conflict'
      USING ERRCODE = '23505';
  END IF;

  RETURN jsonb_build_object(
    'request_id', v_task.request_id,
    'status', v_task.status,
    'state', v_task.state,
    'version', v_task.version,
    'updated', v_task.updated_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.sarah_ai_task_gateway_checkpoint(
  p_actor_id uuid,
  p_session_id uuid,
  p_request_id uuid,
  p_expected_version bigint,
  p_status text,
  p_state jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_task public.sarah_ai_tasks%ROWTYPE;
BEGIN
  PERFORM public.sarah_ai_task_assert_gateway_actor(p_actor_id, p_session_id);

  IF p_request_id IS NULL
     OR p_expected_version IS NULL
     OR p_expected_version < 1
     OR p_status IS NULL
     OR p_status NOT IN ('RUNNING','WAITING_CONFIRMATION','WAITING_CLARIFICATION','COMPLETED','FAILED','CANCELLED')
     OR p_state IS NULL
     OR jsonb_typeof(p_state) <> 'object'
     OR pg_column_size(p_state) > 524288
     OR public.sarah_ai_task_state_has_forbidden_keys(p_state) THEN
    RAISE EXCEPTION 'Invalid or sensitive Sarah task checkpoint'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.sarah_ai_tasks
  SET status = p_status,
      state = p_state,
      version = version + 1,
      updated_at = now(),
      expires_at = now() + interval '7 days'
  WHERE auth_user_id = p_actor_id
    AND auth_session_id = p_session_id
    AND request_id = p_request_id
    AND version = p_expected_version
    AND expires_at > now()
  RETURNING * INTO v_task;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sarah task checkpoint version conflict or unavailable'
      USING ERRCODE = '40001';
  END IF;

  RETURN jsonb_build_object(
    'request_id', v_task.request_id,
    'status', v_task.status,
    'state', v_task.state,
    'version', v_task.version,
    'updated', v_task.updated_at
  );
END;
$function$;

-- Legacy authenticated RPCs are revoked in the follow-up cutover migration,
-- after the new Edge Function has been deployed to use this service-role gateway.

REVOKE ALL ON FUNCTION public.sarah_ai_task_assert_gateway_actor(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sarah_ai_task_gateway_load_or_create(uuid,uuid,uuid,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sarah_ai_task_gateway_resume(uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sarah_ai_task_gateway_checkpoint(uuid,uuid,uuid,bigint,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.sarah_ai_task_gateway_load_or_create(uuid,uuid,uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_task_gateway_resume(uuid,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_task_gateway_checkpoint(uuid,uuid,uuid,bigint,text,jsonb) TO service_role;
