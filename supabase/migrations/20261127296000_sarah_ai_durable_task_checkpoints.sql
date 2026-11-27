-- Server-side checkpoints for resumable Sarah orchestration.
-- The task state never contains a BIN, password, API key, or provider secret.
CREATE TABLE IF NOT EXISTS public.sarah_ai_tasks (
  auth_user_id uuid NOT NULL,
  auth_session_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING','WAITING_CONFIRMATION','WAITING_CLARIFICATION','COMPLETED','FAILED','CANCELLED')),
  state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(state) = 'object'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  PRIMARY KEY (auth_user_id, auth_session_id, request_id)
);

CREATE INDEX IF NOT EXISTS sarah_ai_tasks_expiry_idx
  ON public.sarah_ai_tasks (expires_at);
CREATE INDEX IF NOT EXISTS sarah_ai_tasks_actor_updated_idx
  ON public.sarah_ai_tasks (auth_user_id, updated_at DESC);

ALTER TABLE public.sarah_ai_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sarah_ai_tasks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sarah_ai_tasks FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sarah_ai_task_state_has_forbidden_keys(p_state jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $function$
  WITH RECURSIVE nodes(value) AS (
    SELECT COALESCE(p_state, '{}'::jsonb)
    UNION ALL
    SELECT child.value
    FROM nodes n
    CROSS JOIN LATERAL (
      SELECT e.value
      FROM jsonb_each(CASE WHEN jsonb_typeof(n.value) = 'object' THEN n.value ELSE '{}'::jsonb END) e
      UNION ALL
      SELECT a.value
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.value) = 'array' THEN n.value ELSE '[]'::jsonb END) a
    ) child
  )
  SELECT EXISTS (
    SELECT 1
    FROM nodes n
    CROSS JOIN LATERAL jsonb_object_keys(
      CASE WHEN jsonb_typeof(n.value) = 'object' THEN n.value ELSE '{}'::jsonb END
    ) AS keys(key)
    WHERE lower(keys.key) IN ('bin','pin','password','api_key','apikey','secret','service_role_key','supabase_service_role_key')
  );
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_task_state_has_forbidden_keys(jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sarah_ai_task_load_or_create(
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
  v_actor uuid := auth.uid();
  v_session uuid := NULLIF(auth.jwt() ->> 'session_id', '')::uuid;
  v_task public.sarah_ai_tasks%ROWTYPE;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();
  IF v_actor IS NULL OR v_session IS NULL THEN
    RAISE EXCEPTION 'Active authenticated session required' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_request_hash IS NULL OR (length(p_request_hash) <> 64 OR p_request_hash ~ '[^0-9a-f]')
     OR p_initial_state IS NULL OR jsonb_typeof(p_initial_state) <> 'object'
     OR pg_column_size(p_initial_state) > 524288
     OR public.sarah_ai_task_state_has_forbidden_keys(p_initial_state) THEN
    RAISE EXCEPTION 'Invalid or sensitive Sarah task state' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.sarah_ai_tasks(auth_user_id, auth_session_id, request_id, request_hash, state)
  VALUES (v_actor, v_session, p_request_id, p_request_hash, p_initial_state)
  ON CONFLICT (auth_user_id, auth_session_id, request_id) DO NOTHING;

  SELECT * INTO v_task
  FROM public.sarah_ai_tasks
  WHERE auth_user_id = v_actor AND auth_session_id = v_session AND request_id = p_request_id
  FOR UPDATE;

  IF v_task.request_hash <> p_request_hash THEN
    RAISE EXCEPTION 'Sarah task request identity conflict' USING ERRCODE = '23505';
  END IF;
  IF v_task.expires_at <= now() THEN
    RAISE EXCEPTION 'Sarah task checkpoint expired' USING ERRCODE = '55000';
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

CREATE OR REPLACE FUNCTION public.sarah_ai_task_checkpoint(
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
  v_actor uuid := auth.uid();
  v_session uuid := NULLIF(auth.jwt() ->> 'session_id', '')::uuid;
  v_task public.sarah_ai_tasks%ROWTYPE;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();
  IF v_actor IS NULL OR v_session IS NULL THEN
    RAISE EXCEPTION 'Active authenticated session required' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 1
     OR p_status IS NULL OR p_status NOT IN ('RUNNING','WAITING_CONFIRMATION','WAITING_CLARIFICATION','COMPLETED','FAILED','CANCELLED')
     OR p_state IS NULL OR jsonb_typeof(p_state) <> 'object'
     OR pg_column_size(p_state) > 524288
     OR public.sarah_ai_task_state_has_forbidden_keys(p_state) THEN
    RAISE EXCEPTION 'Invalid or sensitive Sarah task checkpoint' USING ERRCODE = '22023';
  END IF;

  UPDATE public.sarah_ai_tasks
  SET status = p_status,
      state = p_state,
      version = version + 1,
      updated_at = now(),
      expires_at = now() + interval '7 days'
  WHERE auth_user_id = v_actor
    AND auth_session_id = v_session
    AND request_id = p_request_id
    AND version = p_expected_version
    AND expires_at > now()
  RETURNING * INTO v_task;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sarah task checkpoint version conflict or unavailable' USING ERRCODE = '40001';
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

REVOKE ALL ON FUNCTION public.sarah_ai_task_load_or_create(uuid,text,jsonb) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.sarah_ai_task_checkpoint(uuid,bigint,text,jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_task_load_or_create(uuid,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sarah_ai_task_checkpoint(uuid,bigint,text,jsonb) TO authenticated;


CREATE OR REPLACE FUNCTION public.sarah_ai_task_resume(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_session uuid := NULLIF(auth.jwt() ->> 'session_id', '')::uuid;
  v_task public.sarah_ai_tasks%ROWTYPE;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();
  IF v_actor IS NULL OR v_session IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'Active authenticated session and task ID required' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_task
  FROM public.sarah_ai_tasks
  WHERE auth_user_id = v_actor
    AND auth_session_id = v_session
    AND request_id = p_request_id
    AND expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Distinguish a genuinely never-created request from a task owned by a
    -- previous Auth session (or an expired task). The gateway may safely
    -- create only the former; it must never silently restart the latter.
    IF EXISTS (
      SELECT 1
      FROM public.sarah_ai_tasks
      WHERE auth_user_id = v_actor
        AND request_id = p_request_id
    ) THEN
      RAISE EXCEPTION 'Sarah task belongs to another or expired session' USING ERRCODE = '28000';
    END IF;
    RAISE EXCEPTION 'Sarah task checkpoint unavailable' USING ERRCODE = 'P0002';
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

REVOKE ALL ON FUNCTION public.sarah_ai_task_resume(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_task_resume(uuid) TO authenticated;
