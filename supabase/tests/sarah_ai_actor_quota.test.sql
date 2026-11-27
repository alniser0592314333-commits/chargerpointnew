-- Isolated behavioral quota regression; run after provider and quota migrations.

-- Authenticated quota RPCs derive identity from auth.uid(), enforce active
-- account sessions and permissions, and expose only fixed hour/day caps.
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

  -- Direct lookup RPC calls consume independent tool buckets rather than
  -- sharing the chat quota or relying on the Edge Function to charge them.
  FOR i IN 1..20 LOOP
    v_result := public.sarah_ai_consume_my_quota('tool_hour');
    IF v_result->>'allowed' <> 'true' THEN
      RAISE EXCEPTION 'tool hourly quota rejected a request before the 20 request cap';
    END IF;
  END LOOP;
  v_result := public.sarah_ai_consume_my_quota('tool_hour');
  IF v_result->>'allowed' <> 'false' THEN
    RAISE EXCEPTION 'tool hourly quota did not reject request 21';
  END IF;

  FOR i IN 1..100 LOOP
    v_result := public.sarah_ai_consume_my_quota('tool_day');
    IF v_result->>'allowed' <> 'true' THEN
      RAISE EXCEPTION 'tool daily quota rejected a request before the 100 request cap';
    END IF;
  END LOOP;
  v_result := public.sarah_ai_consume_my_quota('tool_day');
  IF v_result->>'allowed' <> 'false' THEN
    RAISE EXCEPTION 'tool daily quota did not reject request 101';
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
      AND quota_type='chat'
      AND window_seconds IN (3600,86400)
  ) <> 2 OR (
    SELECT count(*) FROM public.sarah_ai_usage_windows
    WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000001'
      AND quota_type='tool'
      AND window_seconds IN (3600,86400)
  ) <> 2 THEN
    RAISE EXCEPTION 'Chat, tool, hourly and daily quota windows collided';
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
RESET ROLE;

-- ai:use without ai:manage permits chat quota use, but not provider management.
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000008',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000008',false);
DO $ai_use_only$
DECLARE v_result jsonb;
BEGIN
  v_result := public.sarah_ai_consume_my_quota('hour');
  IF v_result->>'allowed' <> 'true' THEN
    RAISE EXCEPTION 'ai:use-only user should be allowed to consume chat quota';
  END IF;
  BEGIN
    PERFORM public.sarah_ai_consume_my_manage_quota('hour');
    RAISE EXCEPTION 'ai:use-only user unexpectedly consumed provider-management quota';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$ai_use_only$;

-- customers:view without ai:use does not authorize even a direct quota RPC.
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000009',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000009',false);
DO $customer_view_only$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_consume_my_quota('hour');
    RAISE EXCEPTION 'customers:view-only user unexpectedly consumed AI quota';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$customer_view_only$;
RESET ROLE;

-- An unregistered session and an admin with disabled_at set are denied even
-- when the underlying Supabase Auth session is still live.
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

SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000006',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000006',false);
DO $disabled_admin$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_consume_my_quota('hour');
    RAISE EXCEPTION 'Disabled admin unexpectedly consumed chat quota';
  EXCEPTION WHEN invalid_authorization_specification THEN NULL;
  END;
END;
$disabled_admin$;
RESET ROLE;

DO $priv$
BEGIN
  IF has_table_privilege('anon','public.sarah_ai_usage_windows','SELECT')
     OR has_table_privilege('authenticated','public.sarah_ai_usage_windows','SELECT')
     OR has_table_privilege('service_role','public.sarah_ai_usage_windows','SELECT') THEN
    RAISE EXCEPTION 'usage windows exposed to browser or service roles';
  END IF;
  IF has_function_privilege('anon','public.sarah_ai_consume_quota_internal(uuid,text,integer,integer)','EXECUTE')
     OR has_function_privilege('authenticated','public.sarah_ai_consume_quota_internal(uuid,text,integer,integer)','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_consume_quota_internal(uuid,text,integer,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'private quota counter is directly executable';
  END IF;
  IF has_function_privilege('anon','public.sarah_ai_assert_use_permission()','EXECUTE')
     OR has_function_privilege('authenticated','public.sarah_ai_assert_use_permission()','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_assert_use_permission()','EXECUTE') THEN
    RAISE EXCEPTION 'private ai:use assertion is directly executable';
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
