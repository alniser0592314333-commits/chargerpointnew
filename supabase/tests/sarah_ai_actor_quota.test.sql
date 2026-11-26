-- Isolated behavioral quota regression; run after provider and quota migrations.

-- The trusted server wrapper remains bounded and actor-scoped.
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false);
DO $quota_test$
DECLARE
  v_result jsonb;
  actor1 uuid := '00000000-0000-0000-0000-000000000101';
  actor2 uuid := '00000000-0000-0000-0000-000000000102';
BEGIN
  v_result := public.sarah_ai_consume_quota(actor1,2,3600);
  IF v_result->>'allowed'<>'true' OR v_result->>'remaining'<>'1' THEN
    RAISE EXCEPTION 'first request must be allowed with one remaining';
  END IF;
  v_result := public.sarah_ai_consume_quota(actor1,2,3600);
  IF v_result->>'allowed'<>'true' OR v_result->>'remaining'<>'0' THEN
    RAISE EXCEPTION 'second request must be allowed and exhaust quota';
  END IF;
  v_result := public.sarah_ai_consume_quota(actor1,2,3600);
  IF v_result->>'allowed'<>'false' OR v_result->>'remaining'<>'0' THEN
    RAISE EXCEPTION 'quota must reject excess request';
  END IF;
  v_result := public.sarah_ai_consume_quota(actor2,2,3600);
  IF v_result->>'allowed'<>'true' THEN
    RAISE EXCEPTION 'quota must be isolated per actor';
  END IF;
  BEGIN
    PERFORM public.sarah_ai_consume_quota(NULL,2,3600);
    RAISE EXCEPTION 'null actor must be rejected';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.sarah_ai_consume_quota(actor1,101,3600);
    RAISE EXCEPTION 'excessive max requests must be rejected';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.sarah_ai_consume_quota(actor1,2,59);
    RAISE EXCEPTION 'short window must be rejected';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.sarah_ai_consume_quota(actor1,2,86401);
    RAISE EXCEPTION 'long window must be rejected';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$quota_test$;
RESET ROLE;

-- Authenticated users cannot choose their actor ID or quota cap. The DB derives
-- the user from auth.uid() and fixes hour/day limits server-side.
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000001',false);
DO $authenticated_quota$
DECLARE
  v_result jsonb;
  i integer;
BEGIN
  FOR i IN 1..20 LOOP
    v_result := public.sarah_ai_consume_my_quota('hour');
    IF v_result->>'allowed' <> 'true' THEN
      RAISE EXCEPTION 'hourly quota rejected a request before the 20 request cap';
    END IF;
  END LOOP;
  v_result := public.sarah_ai_consume_my_quota('hour');
  IF v_result->>'allowed' <> 'false' THEN
    RAISE EXCEPTION 'hourly quota did not reject request 21';
  END IF;

  FOR i IN 1..100 LOOP
    v_result := public.sarah_ai_consume_my_quota('day');
    IF v_result->>'allowed' <> 'true' THEN
      RAISE EXCEPTION 'daily quota rejected a request before the 100 request cap';
    END IF;
  END LOOP;
  v_result := public.sarah_ai_consume_my_quota('day');
  IF v_result->>'allowed' <> 'false' THEN
    RAISE EXCEPTION 'daily quota did not reject request 101';
  END IF;

  BEGIN
    PERFORM public.sarah_ai_consume_my_quota('week');
    RAISE EXCEPTION 'unsupported quota period was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$authenticated_quota$;
RESET ROLE;

-- Hourly and daily buckets are distinct even when their UTC start timestamps
-- coincide (e.g. exactly at midnight).
DO $window_separation$
BEGIN
  IF (
    SELECT count(*) FROM public.sarah_ai_usage_windows
    WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000001'
      AND window_seconds IN (3600,86400)
  ) <> 2 THEN
    RAISE EXCEPTION 'Hourly and daily quota windows collided';
  END IF;
END;
$window_separation$;

-- A manager with ai:manage but without ai:use can test provider configuration
-- but cannot consume the chat quota.
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000002',false);
DO $permission_boundary$
DECLARE v_result jsonb;
BEGIN
  v_result := public.sarah_ai_consume_my_manage_quota('hour');
  IF v_result->>'allowed' <> 'true' THEN
    RAISE EXCEPTION 'ai:manage user should be able to test provider connection';
  END IF;
  BEGIN
    PERFORM public.sarah_ai_consume_my_quota('hour');
    RAISE EXCEPTION 'ai:manage without ai:use unexpectedly consumed chat quota';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$permission_boundary$;

-- An unregistered session cannot use the authenticated quota wrapper.
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000004',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000004',false);
DO $unregistered$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_consume_my_quota('hour');
    RAISE EXCEPTION 'Unregistered admin session unexpectedly consumed quota';
  EXCEPTION WHEN invalid_authorization_specification THEN NULL;
  END;
END;
$unregistered$;
RESET ROLE;

DO $priv$
BEGIN
  IF has_table_privilege('anon','public.sarah_ai_usage_windows','SELECT')
     OR has_table_privilege('authenticated','public.sarah_ai_usage_windows','SELECT') THEN
    RAISE EXCEPTION 'usage windows exposed to browser roles';
  END IF;
  IF has_function_privilege('anon','public.sarah_ai_consume_quota(uuid,integer,integer)','EXECUTE')
     OR has_function_privilege('authenticated','public.sarah_ai_consume_quota(uuid,integer,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'server-only quota RPC exposed to browser roles';
  END IF;
  IF has_function_privilege('anon','public.sarah_ai_consume_quota_internal(uuid,integer,integer)','EXECUTE')
     OR has_function_privilege('authenticated','public.sarah_ai_consume_quota_internal(uuid,integer,integer)','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_consume_quota_internal(uuid,integer,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'private quota counter is directly executable';
  END IF;
  IF NOT has_function_privilege('service_role','public.sarah_ai_consume_quota(uuid,integer,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'service role quota execution missing';
  END IF;
  IF NOT has_function_privilege('authenticated','public.sarah_ai_consume_my_quota(text)','EXECUTE')
     OR has_function_privilege('anon','public.sarah_ai_consume_my_quota(text)','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_consume_my_quota(text)','EXECUTE') THEN
    RAISE EXCEPTION 'authenticated chat quota grants are incorrect';
  END IF;
  IF NOT has_function_privilege('authenticated','public.sarah_ai_consume_my_manage_quota(text)','EXECUTE')
     OR has_function_privilege('anon','public.sarah_ai_consume_my_manage_quota(text)','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_consume_my_manage_quota(text)','EXECUTE') THEN
    RAISE EXCEPTION 'authenticated settings quota grants are incorrect';
  END IF;
END;
$priv$;
