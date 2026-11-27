-- Final Sarah admin quota policy: no artificial chat/tool/manage ceilings.
-- Run after the original quota migration and the two Sarah unlimited-admin migrations.

-- The preceding legacy quota tests deliberately create counters for these
-- fixture actors. Start this final-policy test with clean counters.
DELETE FROM public.sarah_ai_usage_windows
WHERE actor_auth_user_id IN (
  '10000000-0000-4000-8000-000000000001'::uuid,
  '10000000-0000-4000-8000-000000000007'::uuid,
  '10000000-0000-4000-8000-000000000008'::uuid
);

SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000001',false);

DO $super_admin_unlimited$
DECLARE
  v_result jsonb;
  v_period text;
  i integer;
BEGIN
  FOREACH v_period IN ARRAY ARRAY['hour','day','tool_hour','tool_day'] LOOP
    FOR i IN 1..150 LOOP
      v_result := public.sarah_ai_consume_my_quota(v_period);
      IF v_result->>'allowed' IS DISTINCT FROM 'true'
         OR v_result->>'unlimited' IS DISTINCT FROM 'true'
         OR v_result->'remaining' IS DISTINCT FROM 'null'::jsonb THEN
        RAISE EXCEPTION 'Super Admin quota unexpectedly restricted period % at request %: %',v_period,i,v_result;
      END IF;
    END LOOP;
  END LOOP;

  FOR i IN 1..150 LOOP
    v_result := public.sarah_ai_consume_my_manage_quota('hour');
    IF v_result->>'allowed' IS DISTINCT FROM 'true'
       OR v_result->>'unlimited' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'Super Admin provider-management quota unexpectedly restricted request %: %',i,v_result;
    END IF;
  END LOOP;
END;
$super_admin_unlimited$;
RESET ROLE;

-- Ordinary admin with ai:use gets the same unmetered workload, while still
-- being denied the stronger ai:manage operation.
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000008',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000008',false);
DO $ordinary_ai_use$
DECLARE
  v_result jsonb;
  v_period text;
  i integer;
BEGIN
  FOREACH v_period IN ARRAY ARRAY['hour','day','tool_hour','tool_day'] LOOP
    FOR i IN 1..150 LOOP
      v_result := public.sarah_ai_consume_my_quota(v_period);
      IF v_result->>'allowed' IS DISTINCT FROM 'true'
         OR v_result->>'unlimited' IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'Ordinary ai:use admin was quota-limited for % at request %: %',v_period,i,v_result;
      END IF;
    END LOOP;
  END LOOP;

  BEGIN
    PERFORM public.sarah_ai_consume_my_manage_quota('hour');
    RAISE EXCEPTION 'ai:use-only admin unexpectedly passed ai:manage gate';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$ordinary_ai_use$;
RESET ROLE;

-- An ordinary admin with ai:manage but no ai:use may test provider settings
-- without a quota, but still cannot use Sarah chat/tools.
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000007',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000007',false);
DO $ordinary_ai_manage$
DECLARE
  v_result jsonb;
  i integer;
BEGIN
  FOR i IN 1..150 LOOP
    v_result := public.sarah_ai_consume_my_manage_quota('day');
    IF v_result->>'allowed' IS DISTINCT FROM 'true'
       OR v_result->>'unlimited' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'Ordinary ai:manage admin was quota-limited at request %: %',i,v_result;
    END IF;
  END LOOP;

  -- Provider-management permission is still independently enforced by the
  -- manage quota wrapper; ai:use behavior is covered by the capability tests.
END;
$ordinary_ai_manage$;
RESET ROLE;

-- Invalid periods and inactive/disabled sessions still fail closed.
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000001',false);
DO $invalid_period$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_consume_my_quota('week');
    RAISE EXCEPTION 'Unsupported quota period was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$invalid_period$;

SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000006',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000006',false);
DO $disabled_admin$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_consume_my_quota('hour');
    RAISE EXCEPTION 'Disabled admin unexpectedly passed ai:use gate';
  EXCEPTION WHEN invalid_authorization_specification THEN NULL;
  END;
END;
$disabled_admin$;
RESET ROLE;

DO $no_usage_counters$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.sarah_ai_usage_windows
    WHERE actor_auth_user_id IN (
      '10000000-0000-4000-8000-000000000001'::uuid,
      '10000000-0000-4000-8000-000000000007'::uuid,
      '10000000-0000-4000-8000-000000000008'::uuid
    )
  ) THEN
    RAISE EXCEPTION 'Unlimited Sarah admin calls still increment usage windows';
  END IF;

  IF has_function_privilege('anon','public.sarah_ai_consume_my_quota(text)','EXECUTE')
     OR has_function_privilege('anon','public.sarah_ai_consume_my_manage_quota(text)','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_consume_my_quota(text)','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_consume_my_manage_quota(text)','EXECUTE') THEN
    RAISE EXCEPTION 'Quota RPC grants unexpectedly expose browser/service-role entry points';
  END IF;
END;
$no_usage_counters$;
