BEGIN;

CREATE TABLE IF NOT EXISTS public.sarah_ai_usage_windows (
  actor_auth_user_id uuid NOT NULL,
  window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 60 AND 86400),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY(actor_auth_user_id, window_seconds, window_started_at)
);
ALTER TABLE public.sarah_ai_usage_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sarah_ai_usage_windows FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sarah_ai_usage_windows FROM PUBLIC, anon, authenticated, service_role;
CREATE INDEX IF NOT EXISTS sarah_ai_usage_windows_started_idx
  ON public.sarah_ai_usage_windows(window_started_at);

-- Private atomic counter. Distinct window_seconds prevents hourly and daily
-- buckets from colliding when both start at the same UTC boundary.
CREATE OR REPLACE FUNCTION public.sarah_ai_consume_quota_internal(
  p_actor_auth_user_id uuid,
  p_max_requests integer,
  p_window_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_window timestamptz;
  v_count integer;
BEGIN
  IF p_actor_auth_user_id IS NULL
     OR p_max_requests NOT BETWEEN 1 AND 100
     OR p_window_seconds NOT BETWEEN 60 AND 86400 THEN
    RAISE EXCEPTION 'Invalid quota parameters' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.sarah_ai_usage_windows
  WHERE window_started_at < now() - interval '48 hours';

  v_window := pg_catalog.to_timestamp(
    pg_catalog.floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds
  );

  INSERT INTO public.sarah_ai_usage_windows(
    actor_auth_user_id, window_seconds, window_started_at, request_count
  )
  VALUES (p_actor_auth_user_id, p_window_seconds, v_window, 1)
  ON CONFLICT(actor_auth_user_id, window_seconds, window_started_at)
  DO UPDATE SET request_count = public.sarah_ai_usage_windows.request_count + 1
  RETURNING request_count INTO v_count;

  IF v_count > p_max_requests THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false, 'remaining', 0, 'windowStartedAt', v_window
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'allowed', true, 'remaining', p_max_requests - v_count, 'windowStartedAt', v_window
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.sarah_ai_consume_quota_internal(uuid, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;

-- User-facing quota wrappers derive the actor from auth.uid() and enforce the
-- appropriate permission in the database; the client cannot choose its own cap.
CREATE OR REPLACE FUNCTION public.sarah_ai_assert_use_permission()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_profile jsonb;
  v_role text;
  v_disabled boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authenticated admin session required' USING ERRCODE = '28000';
  END IF;

  PERFORM public.assert_my_account_session_active();
  IF public.is_active_admin_session() IS NOT TRUE THEN
    RAISE EXCEPTION 'Active admin session required' USING ERRCODE = '28000';
  END IF;

  v_profile := public.get_current_admin_profile();
  IF pg_catalog.to_regclass('public.admins') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.admins WHERE auth_user_id = $1 AND disabled_at IS NOT NULL)'
      INTO v_disabled
      USING auth.uid();
  END IF;
  IF v_disabled IS TRUE THEN
    RAISE EXCEPTION 'Admin account is disabled' USING ERRCODE = '28000';
  END IF;

  IF COALESCE(v_profile->>'authenticated', 'false') <> 'true'
     OR COALESCE(v_profile->>'is_admin', 'false') <> 'true'
     OR COALESCE(v_profile->>'is_active', 'false') <> 'true'
     OR (v_profile->>'auth_user_id')::uuid IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Active admin session required' USING ERRCODE = '28000';
  END IF;

  v_role := pg_catalog.upper(pg_catalog.replace(COALESCE(v_profile->>'role', ''), ' ', '_'));
  IF v_role <> 'SUPER_ADMIN' AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements_text(
      COALESCE(v_profile->'permissions', '[]'::jsonb)
    ) AS permission_item(permission)
    WHERE permission_item.permission = 'ai:use'
  ) THEN
    RAISE EXCEPTION 'AI_USE_PERMISSION_REQUIRED' USING ERRCODE = '42501';
  END IF;

  RETURN auth.uid();
END;
$function$;
REVOKE ALL ON FUNCTION public.sarah_ai_assert_use_permission()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sarah_ai_consume_my_quota(p_period text DEFAULT 'hour')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid;
BEGIN
  v_actor := public.sarah_ai_assert_use_permission();
  IF p_period = 'hour' THEN
    RETURN public.sarah_ai_consume_quota_internal(v_actor, 20, 3600);
  ELSIF p_period = 'day' THEN
    RETURN public.sarah_ai_consume_quota_internal(v_actor, 100, 86400);
  END IF;
  RAISE EXCEPTION 'Invalid quota period' USING ERRCODE = '22023';
END;
$function$;
REVOKE ALL ON FUNCTION public.sarah_ai_consume_my_quota(text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_consume_my_quota(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.sarah_ai_consume_my_manage_quota(p_period text DEFAULT 'hour')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid;
BEGIN
  v_actor := public.sarah_ai_assert_manage_permission();
  IF p_period = 'hour' THEN
    RETURN public.sarah_ai_consume_quota_internal(v_actor, 20, 3600);
  ELSIF p_period = 'day' THEN
    RETURN public.sarah_ai_consume_quota_internal(v_actor, 100, 86400);
  END IF;
  RAISE EXCEPTION 'Invalid quota period' USING ERRCODE = '22023';
END;
$function$;
REVOKE ALL ON FUNCTION public.sarah_ai_consume_my_manage_quota(text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_consume_my_manage_quota(text) TO authenticated;

COMMIT;
