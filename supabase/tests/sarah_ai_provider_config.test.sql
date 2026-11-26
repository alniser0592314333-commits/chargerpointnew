-- Run after the Sarah AI provider migration in an isolated CI database.

DO $privileges$
BEGIN
  IF has_table_privilege('anon', 'public.sarah_ai_provider_config', 'SELECT') THEN
    RAISE EXCEPTION 'anon must not read provider configuration';
  END IF;
  IF has_table_privilege('authenticated', 'public.sarah_ai_provider_config', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated must not read provider configuration';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.sarah_ai_provider_config', 'SELECT') THEN
    RAISE EXCEPTION 'service_role must read provider configuration';
  END IF;
  IF has_function_privilege('anon', 'public.sarah_ai_save_provider_config(text,text,text,jsonb,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute provider save';
  END IF;
  IF has_function_privilege('authenticated', 'public.sarah_ai_get_provider_secret()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must not read provider secrets';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.sarah_ai_get_provider_secret()', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must read provider secrets';
  END IF;
END;
$privileges$;

SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

DO $behavior$
DECLARE
  v_result jsonb;
  v_secret text;
BEGIN
  v_result := public.sarah_ai_save_provider_config(
    'gemini',
    'gemini-3.8-flash',
    NULL,
    '{"temperature":0.2,"maxOutputTokens":2048,"timeoutMs":30000}'::jsonb,
    'first-test-api-key-01234567890123456789',
    '00000000-0000-0000-0000-000000000001'::uuid
  );
  IF v_result->>'configured' <> 'true' OR v_result->>'hasApiKey' <> 'true' THEN
    RAISE EXCEPTION 'Provider save did not return a configured state';
  END IF;

  v_secret := public.sarah_ai_get_provider_secret();
  IF v_secret <> 'first-test-api-key-01234567890123456789' THEN
    RAISE EXCEPTION 'Vault secret was not stored or retrieved correctly';
  END IF;

  PERFORM public.sarah_ai_save_provider_config(
    'gemini',
    'gemini-3.8-flash',
    NULL,
    '{"temperature":0.4,"maxOutputTokens":1024,"timeoutMs":15000}'::jsonb,
    'rotated-test-api-key-01234567890123456789',
    '00000000-0000-0000-0000-000000000001'::uuid
  );
  v_secret := public.sarah_ai_get_provider_secret();
  IF v_secret <> 'rotated-test-api-key-01234567890123456789' THEN
    RAISE EXCEPTION 'Vault secret rotation failed';
  END IF;

  BEGIN
    PERFORM public.sarah_ai_save_provider_config(
      'gemini',
      'gemini-3.8-flash',
      NULL,
      '{"temperature":"not-a-number"}'::jsonb,
      NULL,
      '00000000-0000-0000-0000-000000000001'::uuid
    );
    RAISE EXCEPTION 'Invalid generation configuration was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  PERFORM public.sarah_ai_clear_provider_config();
  IF EXISTS (SELECT 1 FROM public.sarah_ai_provider_config) THEN
    RAISE EXCEPTION 'Provider configuration was not cleared';
  END IF;
  IF EXISTS (SELECT 1 FROM vault.decrypted_secrets) THEN
    RAISE EXCEPTION 'Vault secret was not deleted with provider configuration';
  END IF;
END;
$behavior$;

RESET ROLE;

DO $permissions$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.permissions WHERE code = 'ai:use'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.permissions WHERE code = 'ai:manage'
  ) THEN
    RAISE EXCEPTION 'AI permission catalog entries are missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.role_permissions
    WHERE role = 'SUPER_ADMIN' AND permission = 'ai:manage'
  ) THEN
    RAISE EXCEPTION 'Super Admin default AI management permission is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.role_permissions
    WHERE role IN ('ADMIN', 'MANAGER') AND permission = 'ai:manage'
  ) THEN
    RAISE EXCEPTION 'AI management must not be granted to regular roles by default';
  END IF;
END;
$permissions$;
