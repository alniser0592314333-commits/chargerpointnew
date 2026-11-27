-- Provider connection checks are admin work too; do not meter them with a separate
-- artificial hourly/daily cap. Keep the stronger ai:manage and active-session gate.
CREATE OR REPLACE FUNCTION public.sarah_ai_consume_my_manage_quota(p_period text DEFAULT 'hour'::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid;
BEGIN
  v_actor := public.sarah_ai_assert_manage_permission();

  IF p_period NOT IN ('hour','day') THEN
    RAISE EXCEPTION 'Invalid quota period' USING ERRCODE='22023';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'allowed', true,
    'unlimited', true,
    'remaining', NULL,
    'actor_auth_user_id', v_actor
  );
END;
$function$;
