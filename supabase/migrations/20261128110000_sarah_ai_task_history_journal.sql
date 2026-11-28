-- Keep a durable, account-scoped journal of Sarah task outcomes.
-- Unlike resumable checkpoints, this journal stores only capability names and
-- outcome categories; it never stores prompts, tool arguments, or tool results.

CREATE TABLE IF NOT EXISTS public.sarah_ai_task_history (
  auth_user_id uuid NOT NULL,
  request_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING','WAITING_CONFIRMATION','WAITING_CLARIFICATION','COMPLETED','FAILED','CANCELLED')),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array'),
  succeeded_count integer NOT NULL DEFAULT 0 CHECK (succeeded_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  not_executed_count integer NOT NULL DEFAULT 0 CHECK (not_executed_count >= 0),
  pending_count integer NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (auth_user_id, request_id)
);

CREATE INDEX IF NOT EXISTS sarah_ai_task_history_actor_created_idx
  ON public.sarah_ai_task_history (auth_user_id, created_at DESC);

ALTER TABLE public.sarah_ai_task_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sarah_ai_task_history FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sarah_ai_task_history FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sarah_ai_task_history_capture()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_calls jsonb := CASE
    WHEN jsonb_typeof(NEW.state -> 'requestedCalls') = 'array' THEN NEW.state -> 'requestedCalls'
    ELSE '[]'::jsonb
  END;
  v_results jsonb := CASE
    WHEN jsonb_typeof(NEW.state -> 'resultsByIndex') = 'object' THEN NEW.state -> 'resultsByIndex'
    ELSE '{}'::jsonb
  END;
  v_steps jsonb;
  v_succeeded integer := 0;
  v_failed integer := 0;
  v_not_executed integer := 0;
  v_pending integer := 0;
BEGIN
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('capability', capability, 'status', step_status)
      ORDER BY ordinal
    ),
    '[]'::jsonb
  )
  INTO v_steps
  FROM (
    SELECT
      calls.ordinality AS ordinal,
      calls.call ->> 'name' AS capability,
      CASE
        WHEN NOT (v_results ? (calls.ordinality - 1)::text) THEN 'pending'
        WHEN result.value ->> 'executed' = 'false'
          OR result.value ->> 'retry_after_prerequisites' = 'true' THEN 'not_executed'
        WHEN result.value ->> 'ok' = 'false'
          OR result.value ->> 'success' = 'false'
          OR result.value ? 'error' THEN 'failed'
        ELSE 'succeeded'
      END AS step_status
    FROM jsonb_array_elements(v_calls) WITH ORDINALITY AS calls(call, ordinality)
    CROSS JOIN LATERAL (
      SELECT v_results -> (calls.ordinality - 1)::text AS value
    ) AS result
    WHERE calls.ordinality <= 100
      AND COALESCE(calls.call ->> 'name', '') ~ '^[a-z][a-z0-9_]{0,79}$'
  ) AS sanitized;

  SELECT
    count(*) FILTER (WHERE value ->> 'status' = 'succeeded')::integer,
    count(*) FILTER (WHERE value ->> 'status' = 'failed')::integer,
    count(*) FILTER (WHERE value ->> 'status' = 'not_executed')::integer,
    count(*) FILTER (WHERE value ->> 'status' = 'pending')::integer
  INTO v_succeeded, v_failed, v_not_executed, v_pending
  FROM jsonb_array_elements(v_steps) AS step(value);

  INSERT INTO public.sarah_ai_task_history (
    auth_user_id, request_id, status, steps,
    succeeded_count, failed_count, not_executed_count, pending_count,
    created_at, updated_at, completed_at
  ) VALUES (
    NEW.auth_user_id, NEW.request_id, NEW.status, v_steps,
    v_succeeded, v_failed, v_not_executed, v_pending,
    NEW.created_at, NEW.updated_at,
    CASE WHEN NEW.status IN ('COMPLETED','FAILED','CANCELLED') THEN NEW.updated_at ELSE NULL END
  )
  ON CONFLICT (auth_user_id, request_id) DO UPDATE SET
    status = EXCLUDED.status,
    steps = EXCLUDED.steps,
    succeeded_count = EXCLUDED.succeeded_count,
    failed_count = EXCLUDED.failed_count,
    not_executed_count = EXCLUDED.not_executed_count,
    pending_count = EXCLUDED.pending_count,
    updated_at = EXCLUDED.updated_at,
    completed_at = EXCLUDED.completed_at;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_task_history_capture() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS sarah_ai_task_history_capture_trigger ON public.sarah_ai_tasks;
CREATE TRIGGER sarah_ai_task_history_capture_trigger
AFTER INSERT OR UPDATE OF state, status, updated_at
ON public.sarah_ai_tasks
FOR EACH ROW
EXECUTE FUNCTION public.sarah_ai_task_history_capture();

CREATE OR REPLACE FUNCTION public.sarah_ai_task_history_list(
  p_actor_id uuid,
  p_session_id uuid,
  p_limit integer DEFAULT 20,
  p_failed_only boolean DEFAULT false,
  p_exclude_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_tasks jsonb;
BEGIN
  PERFORM public.sarah_ai_task_assert_gateway_actor(p_actor_id, p_session_id);

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'request_id', task.request_id,
        'status', task.status,
        'steps', task.steps,
        'succeeded_count', task.succeeded_count,
        'failed_count', task.failed_count,
        'not_executed_count', task.not_executed_count,
        'pending_count', task.pending_count,
        'created_at', task.created_at,
        'updated_at', task.updated_at
      )
      ORDER BY task.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_tasks
  FROM (
    SELECT *
    FROM public.sarah_ai_task_history
    WHERE auth_user_id = p_actor_id
      AND (p_exclude_request_id IS NULL OR request_id <> p_exclude_request_id)
      AND (
        NOT COALESCE(p_failed_only, false)
        OR failed_count > 0
        OR not_executed_count > 0
        OR status = 'FAILED'
      )
    ORDER BY created_at DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 50))
  ) AS task;

  RETURN jsonb_build_object('tasks', v_tasks);
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_task_history_list(uuid,uuid,integer,boolean,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sarah_ai_task_history_list(uuid,uuid,integer,boolean,uuid) TO service_role;
