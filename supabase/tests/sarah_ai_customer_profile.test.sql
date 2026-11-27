-- Limited customer profile read: no phone, balance, debt limit, notes, IDs or history.
-- Run after provider, actor-quota, scoped customer lookup and customer-profile migrations.

SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000001',false);
DO $customer_profile$
DECLARE
  v_result jsonb;
  v_matches jsonb;
  v_profile jsonb;
BEGIN
  v_result := public.sarah_ai_get_customer_profile('AAAA');
  v_matches := v_result->'matches';
  IF jsonb_array_length(v_matches) <> 5
     OR v_result->>'match_count' <> '5'
     OR v_result->>'has_more' <> 'true' THEN
    RAISE EXCEPTION 'Profile read must cap duplicate four-character codes at five and signal truncation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_matches) AS item(value)
    WHERE item.value->>'customer_code' <> 'AAAA'
       OR item.value ? 'customer_id'
       OR item.value ? 'id'
       OR item.value ? 'phone'
       OR item.value ? 'balance'
       OR item.value ? 'debt_limit'
       OR item.value ? 'notes'
       OR item.value ? 'orders'
       OR item.value ? 'financial_history'
  ) THEN
    RAISE EXCEPTION 'Customer profile exposed an identifier, contact, financial, or history field';
  END IF;

  v_result := public.sarah_ai_get_customer_profile('AAAA', 'أحمد علي');
  IF v_result->>'match_count' <> '1'
     OR v_result->>'has_more' <> 'false' THEN
    RAISE EXCEPTION 'Name hint did not disambiguate a colliding customer code';
  END IF;
  v_profile := v_result->'matches'->0;
  IF v_profile->>'customer_name' <> 'أحمد علي'
     OR v_profile->>'customer_code' <> 'AAAA'
     OR v_profile->>'status' <> 'ACTIVE'
     OR v_profile->>'is_active' <> 'true'
     OR v_profile->>'charger_fee_exempt' <> 'false'
     OR NULLIF(v_profile->>'created_at', '') IS NULL THEN
    RAISE EXCEPTION 'Limited customer profile DTO is incomplete or invalid';
  END IF;

  v_result := public.sarah_ai_get_customer_profile('BBBB');
  IF v_result->>'match_count' <> '1'
     OR v_result->'matches'->0->>'customer_code' <> 'BBBB' THEN
    RAISE EXCEPTION 'Exact customer code profile read failed';
  END IF;

  v_result := public.sarah_ai_get_customer_profile('9999');
  IF v_result->>'match_count' <> '0'
     OR jsonb_array_length(v_result->'matches') <> 0 THEN
    RAISE EXCEPTION 'No-match profile lookup returned data';
  END IF;

  BEGIN
    PERFORM public.sarah_ai_get_customer_profile('GGGG');
    RAISE EXCEPTION 'Non-hex customer code was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.sarah_ai_get_customer_profile('AAAA', 'A');
    RAISE EXCEPTION 'One-character name hint was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.sarah_ai_get_customer_profile('AAAA', E'xx\n');
    RAISE EXCEPTION 'Control characters in name hint were accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$customer_profile$;
RESET ROLE;

-- ai:manage alone does not authorize customer profile access.
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000007',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000007',false);
DO $manage_only_denied$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_get_customer_profile('AAAA');
    RAISE EXCEPTION 'ai:manage-only user unexpectedly read customer profile';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$manage_only_denied$;
RESET ROLE;

-- ai:use without customers:view is not enough.
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000008',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000008',false);
DO $ai_use_only_denied$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_get_customer_profile('AAAA');
    RAISE EXCEPTION 'ai:use-only user unexpectedly read customer profile';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$ai_use_only_denied$;

-- customers:view without ai:use is not enough.
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000009',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000009',false);
DO $customer_view_only_denied$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_get_customer_profile('AAAA');
    RAISE EXCEPTION 'customers:view-only user unexpectedly read customer profile';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$customer_view_only_denied$;
RESET ROLE;

-- An unregistered or disabled admin session is rejected by the database.
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000004',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000004',false);
DO $unregistered_denied$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_get_customer_profile('AAAA');
    RAISE EXCEPTION 'Unregistered session unexpectedly read customer profile';
  EXCEPTION WHEN invalid_authorization_specification THEN NULL;
  END;
END;
$unregistered_denied$;

SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000006',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000006',false);
DO $disabled_denied$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_get_customer_profile('AAAA');
    RAISE EXCEPTION 'Disabled admin unexpectedly read customer profile';
  EXCEPTION WHEN invalid_authorization_specification THEN NULL;
  END;
END;
$disabled_denied$;
RESET ROLE;

DO $profile_privileges$
BEGIN
  IF NOT has_function_privilege('authenticated','public.sarah_ai_get_customer_profile(text,text)','EXECUTE')
     OR has_function_privilege('anon','public.sarah_ai_get_customer_profile(text,text)','EXECUTE')
     OR has_function_privilege('service_role','public.sarah_ai_get_customer_profile(text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Customer profile RPC grants are incorrect';
  END IF;
END;
$profile_privileges$;
