-- Administrative Sarah workloads are not capped by per-hour or per-day request quotas.
-- Authorization remains enforced by sarah_ai_assert_use_permission(): active Super Admins
-- and active ordinary admins with ai:use only. Every action still rechecks its own
-- live domain permission in its canonical RPC.
CREATE OR REPLACE FUNCTION public.sarah_ai_consume_my_quota(p_period text DEFAULT 'hour'::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid;
BEGIN
  v_actor := public.sarah_ai_assert_use_permission();

  IF p_period NOT IN ('hour','day','tool_hour','tool_day') THEN
    RAISE EXCEPTION 'Invalid quota period' USING ERRCODE='22023';
  END IF;

  -- Sarah is an admin execution agent, not a metered one-action chatbot.
  -- Return an explicit unlimited result without incrementing artificial
  -- chat/tool counters. Provider/network safety limits remain independent.
  RETURN pg_catalog.jsonb_build_object(
    'allowed', true,
    'unlimited', true,
    'remaining', NULL,
    'actor_auth_user_id', v_actor
  );
END;
$function$;
