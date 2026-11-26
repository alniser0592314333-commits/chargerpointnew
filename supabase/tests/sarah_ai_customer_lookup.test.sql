-- Bounded read-only customer lookup. Run after provider, quota and lookup migrations.

SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000001',false);
DO $customer_lookup$
DECLARE
  v_result jsonb;
  v_matches jsonb;
BEGIN
  v_result := public.sarah_ai_lookup_customers('أحمد');
  v_matches := v_result->'matches';
  IF jsonb_array_length(v_matches) <> 5
     OR v_result->>'match_count' <> '5'
     OR v_result->>'has_more' <> 'true' THEN
    RAISE EXCEPTION 'Customer lookup must return at most five and signal truncation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_matches) AS item(value)
    WHERE item.value ? 'customer_id'
       OR item.value ? 'phone'
       OR item.value ? 'balance'
       OR item.value ? 'notes'
       OR item.value ? 'orders'
  ) THEN
    RAISE EXCEPTION 'Customer lookup exposed an identifier or sensitive customer field';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_matches) AS item(value)
    WHERE item.value->>'customer_code' <> 'AAAA'
       OR pg_catalog.char_length(item.value->>'customer_name') > 80
  ) THEN
    RAISE EXCEPTION 'Customer lookup returned an invalid code or oversized name';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_matches) AS item(value)
    WHERE item.value->>'customer_name' IN ('أحمد غير نشط','أحمد محذوف')
  ) THEN
    RAISE EXCEPTION 'Inactive or deleted customer was returned';
  END IF;

  v_result := public.sarah_ai_lookup_customers('BBBB');
  IF v_result->>'match_count' <> '1'
     OR v_result->>'has_more' <> 'false'
     OR v_result->'matches'->0->>'customer_code' <> 'BBBB' THEN
    RAISE EXCEPTION 'Exact four-character customer code lookup failed';
  END IF;

  v_result := public.sarah_ai_lookup_customers('ZZZZ');
  IF v_result->>'match_count' <> '0'
     OR jsonb_array_length(v_result->'matches') <> 0 THEN
    RAISE EXCEPTION 'No-match customer lookup returned data';
  END IF;

  BEGIN
    PERFORM public.sarah_ai_lookup_customers('A');
    RAISE EXCEPTION 'One-character query was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.sarah_ai_lookup_customers(pg_catalog.repeat('x',65));
    RAISE EXCEPTION 'Oversized query was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.sarah_ai_lookup_customers(E'xx\n');
    RAISE EXCEPTION 'Control characters were accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$customer_lookup$;
RESET ROLE;

-- ai:manage alone does not imply ai:use or customers:view.
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000002',false);
DO $manager_denied$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_lookup_customers('أحمد');
    RAISE EXCEPTION 'Manager without ai:use unexpectedly used Sarah lookup';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$manager_denied$;

SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000004',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000004',false);
DO $unregistered_denied$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_lookup_customers('أحمد');
    RAISE EXCEPTION 'Unregistered admin session unexpectedly used Sarah lookup';
  EXCEPTION WHEN invalid_authorization_specification THEN NULL;
  END;
END;
$unregistered_denied$;

SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000006',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000006',false);
DO $disabled_denied$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_lookup_customers('أحمد');
    RAISE EXCEPTION 'Disabled admin unexpectedly used Sarah lookup';
  EXCEPTION WHEN invalid_authorization_specification THEN NULL;
  END;
END;
$disabled_denied$;
RESET ROLE;

DO $lookup_privileges$
BEGIN
  IF NOT has_function_privilege('authenticated','public.sarah_ai_lookup_customers(text)','EXECUTE')
     OR has_function_privilege('anon','public.sarah_ai_lookup_customers(text)','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_lookup_customers(text)','EXECUTE') THEN
    RAISE EXCEPTION 'Customer lookup RPC grants are incorrect';
  END IF;
END;
$lookup_privileges$;
