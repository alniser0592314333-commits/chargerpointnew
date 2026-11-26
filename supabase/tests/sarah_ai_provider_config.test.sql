-- Behavioral provider configuration security tests in an isolated PostgreSQL fixture.

DO $privileges$
BEGIN
  IF has_table_privilege('anon', 'public.sarah_ai_provider_config', 'SELECT') THEN
    RAISE EXCEPTION 'anon must not read provider configuration';
  END IF;
  IF has_table_privilege('authenticated', 'public.sarah_ai_provider_config', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated must not read provider configuration directly';
  END IF;
  IF has_table_privilege('service_role', 'public.sarah_ai_provider_config', 'SELECT') THEN
    RAISE EXCEPTION 'service_role must use the narrow runtime config RPC, not direct table access';
  END IF;
  IF has_function_privilege('anon', 'public.sarah_ai_save_provider_config(text,text,text,jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute provider save';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.sarah_ai_save_provider_config(text,text,text,jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must call the DB-authorized provider save RPC';
  END IF;
  IF has_function_privilege('service_role', 'public.sarah_ai_save_provider_config(text,text,text,jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must not bypass actor authorization for provider save';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.sarah_ai_get_provider_config()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must call the DB-authorized safe config read RPC';
  END IF;
  IF has_function_privilege('service_role', 'public.sarah_ai_get_provider_config()', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must not bypass actor authorization for config read';
  END IF;
  IF has_function_privilege('authenticated', 'public.sarah_ai_get_provider_secret()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must not read provider secrets';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.sarah_ai_get_provider_secret()', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must read provider secrets';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.sarah_ai_get_runtime_config()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sarah_ai_get_runtime_config()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.sarah_ai_get_runtime_config()', 'EXECUTE') THEN
    RAISE EXCEPTION 'runtime provider projection grants are incorrect';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.sarah_ai_clear_provider_config()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must call the DB-authorized provider clear RPC';
  END IF;
  IF has_function_privilege('service_role', 'public.sarah_ai_clear_provider_config()', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must not bypass actor authorization for provider clear';
  END IF;
  IF has_function_privilege('authenticated', 'public.sarah_ai_assert_manage_permission()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.sarah_ai_assert_manage_permission()', 'EXECUTE') THEN
    RAISE EXCEPTION 'private ai:manage assertion must not be directly executable';
  END IF;
END;
$privileges$;

-- Super Admin with a live registered session can configure the provider.
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id', '20000000-0000-4000-8000-000000000001', false);

DO $behavior$
DECLARE
  v_result jsonb;
BEGIN
  BEGIN
    PERFORM public.sarah_ai_save_provider_config(
      'openai',
      'gpt-test',
      NULL,
      '{}'::jsonb,
      NULL
    );
    RAISE EXCEPTION 'Non-Gemini provider was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  BEGIN
    PERFORM public.sarah_ai_save_provider_config(
      'gemini',
      'gemini-3.8-flash',
      'https://untrusted.example',
      '{}'::jsonb,
      NULL
    );
    RAISE EXCEPTION 'Custom provider endpoint was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  BEGIN
    PERFORM public.sarah_ai_save_provider_config(
      'gemini',
      '../unexpected/path',
      NULL,
      '{}'::jsonb,
      NULL
    );
    RAISE EXCEPTION 'Unsafe model identifier was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  v_result := public.sarah_ai_save_provider_config(
    'gemini',
    'gemini-3.8-flash',
    NULL,
    '{"temperature":0.2,"maxOutputTokens":2048,"timeoutMs":30000}'::jsonb,
    'first-test-api-key-01234567890123456789'
  );
  IF v_result->>'configured' <> 'true' OR v_result->>'hasApiKey' <> 'true' THEN
    RAISE EXCEPTION 'Provider save did not return a configured state';
  END IF;

  v_result := public.sarah_ai_get_provider_config();
  IF v_result->>'provider_id' <> 'gemini'
     OR v_result->>'model_id' <> 'gemini-3.8-flash'
     OR v_result->>'has_api_key' <> 'true'
     OR v_result ? 'secret_id' THEN
    RAISE EXCEPTION 'Safe provider metadata read returned incorrect or sensitive fields';
  END IF;
END;
$behavior$;

-- The secret can be read only by a service-role server process, never the user JWT.
RESET ROLE;
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $secret_read$
DECLARE
  v_secret text;
  v_config jsonb;
BEGIN
  v_secret := public.sarah_ai_get_provider_secret();
  IF v_secret <> 'first-test-api-key-01234567890123456789' THEN
    RAISE EXCEPTION 'Vault secret was not stored or retrieved correctly';
  END IF;

  v_config := public.sarah_ai_get_runtime_config();
  IF v_config->>'provider_id' <> 'gemini'
     OR v_config->>'model_id' <> 'gemini-3.8-flash'
     OR v_config ? 'secret_id'
     OR v_config ? 'api_key' THEN
    RAISE EXCEPTION 'Runtime config projection returned an invalid or sensitive field';
  END IF;
END;
$secret_read$;
RESET ROLE;

-- Rotate the secret through the authenticated, DB-authorized settings RPC.
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id', '20000000-0000-4000-8000-000000000001', false);
DO $rotation$
BEGIN
  PERFORM public.sarah_ai_save_provider_config(
    'gemini',
    'gemini-3.8-flash',
    NULL,
    '{"temperature":0.4,"maxOutputTokens":1024,"timeoutMs":15000}'::jsonb,
    'rotated-test-api-key-01234567890123456789'
  );

  BEGIN
    PERFORM public.sarah_ai_save_provider_config(
      'gemini',
      'gemini-3.8-flash',
      NULL,
      '{"temperature":"not-a-number"}'::jsonb,
      NULL
    );
    RAISE EXCEPTION 'Invalid generation configuration was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  BEGIN
    PERFORM public.sarah_ai_save_provider_config(
      'gemini',
      'gemini-3.8-flash',
      NULL,
      '{"maxOutputTokens":4097}'::jsonb,
      NULL
    );
    RAISE EXCEPTION 'Output token budget above the server cap was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
END;
$rotation$;

RESET ROLE;
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $rotated_secret$
DECLARE v_secret text;
BEGIN
  v_secret := public.sarah_ai_get_provider_secret();
  IF v_secret <> 'rotated-test-api-key-01234567890123456789' THEN
    RAISE EXCEPTION 'Vault secret rotation failed';
  END IF;
END;
$rotated_secret$;
RESET ROLE;

-- A regular manager without ai:manage cannot configure or read the provider.
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id', '20000000-0000-4000-8000-000000000002', false);
DO $denied_manager$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_get_provider_config();
    RAISE EXCEPTION 'Manager without ai:manage unexpectedly read provider configuration';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    PERFORM public.sarah_ai_save_provider_config(
      'gemini','gemini-3.8-flash',NULL,'{}'::jsonb,NULL
    );
    RAISE EXCEPTION 'Manager without ai:manage unexpectedly changed provider configuration';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$denied_manager$;
RESET ROLE;

-- An explicit permission grant enables the manager; the DB resolves it from the
-- authenticated admin profile, not a caller-supplied actor ID.
INSERT INTO public.role_permissions(role, permission) VALUES ('MANAGER','ai:manage');
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id', '20000000-0000-4000-8000-000000000002', false);
DO $granted_manager$
DECLARE v_result jsonb;
BEGIN
  v_result := public.sarah_ai_get_provider_config();
  IF v_result->>'provider_id' <> 'gemini' THEN
    RAISE EXCEPTION 'Manager with explicit ai:manage could not read provider configuration';
  END IF;
END;
$granted_manager$;
RESET ROLE;

-- Inactive admins and users without an account_sessions registry row are denied.
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id', '20000000-0000-4000-8000-000000000003', false);
DO $inactive_admin$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_get_provider_config();
    RAISE EXCEPTION 'Inactive admin unexpectedly read provider configuration';
  EXCEPTION WHEN invalid_authorization_specification THEN
    NULL;
  END;
END;
$inactive_admin$;

SELECT pg_catalog.set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id', '20000000-0000-4000-8000-000000000004', false);
DO $unregistered_admin$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_get_provider_config();
    RAISE EXCEPTION 'Unregistered session unexpectedly read provider configuration';
  EXCEPTION WHEN invalid_authorization_specification THEN
    NULL;
  END;
END;
$unregistered_admin$;
SELECT pg_catalog.set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000006', false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id', '20000000-0000-4000-8000-000000000006', false);
DO $disabled_admin$
BEGIN
  BEGIN
    PERFORM public.sarah_ai_get_provider_config();
    RAISE EXCEPTION 'Admin with disabled_at set unexpectedly read provider configuration';
  EXCEPTION WHEN invalid_authorization_specification THEN
    NULL;
  END;
END;
$disabled_admin$;
RESET ROLE;

-- A Super Admin can clear provider configuration; the secret is removed as well.
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id', '20000000-0000-4000-8000-000000000001', false);
DO $clear$
BEGIN
  IF public.sarah_ai_clear_provider_config() IS NOT TRUE THEN
    RAISE EXCEPTION 'Provider configuration clear did not succeed';
  END IF;
END;
$clear$;
RESET ROLE;

DO $cleared$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sarah_ai_provider_config) THEN
    RAISE EXCEPTION 'Provider configuration was not cleared';
  END IF;
  IF EXISTS (SELECT 1 FROM vault.decrypted_secrets) THEN
    RAISE EXCEPTION 'Vault secret was not deleted with provider configuration';
  END IF;
END;
$cleared$;

DO $permissions$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_custom_permissions
    WHERE admin_id = '00000000-0000-4000-8000-000000000002'
      AND permission = 'ai:manage'
      AND is_grant IS TRUE
  ) THEN
    RAISE EXCEPTION 'Manager fixture must carry an explicit ai:manage custom grant';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.admin_custom_permissions
    WHERE admin_id = '00000000-0000-4000-8000-000000000002'
      AND permission = 'ai:use'
      AND is_grant IS TRUE
  ) THEN
    RAISE EXCEPTION 'ai:manage must not imply ai:use';
  END IF;
END;
$permissions$;
