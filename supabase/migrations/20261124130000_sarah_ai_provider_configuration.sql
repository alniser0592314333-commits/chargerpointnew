-- Sarah AI provider configuration foundation.
-- Provider credentials are stored only in Supabase Vault and are accessible
-- through service-role-only SECURITY DEFINER functions.
-- No browser role can read provider configuration or secrets.

BEGIN;

INSERT INTO public.permissions (code, description)
VALUES
  ('ai:use', 'Use the Sarah AI assistant'),
  ('ai:manage', 'Configure Sarah AI providers, models, and integration settings')
ON CONFLICT (code) DO UPDATE
SET description = EXCLUDED.description;

-- Initially enable Sarah only for Super Admin. Other roles receive access only
-- through an explicit, audited custom permission grant in a later admin flow.
INSERT INTO public.role_permissions (role, permission)
VALUES
  ('SUPER_ADMIN', 'ai:use'),
  ('SUPER_ADMIN', 'ai:manage'),
  ('Super Admin', 'ai:use'),
  ('Super Admin', 'ai:manage')
ON CONFLICT (role, permission) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.sarah_ai_provider_config (
  id text PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
  provider_id text NOT NULL CHECK (provider_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  model_id text NOT NULL CHECK (length(model_id) BETWEEN 1 AND 128),
  endpoint_url text,
  generation_config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(generation_config) = 'object'),
  secret_id uuid,
  enabled boolean NOT NULL DEFAULT false,
  updated_by_auth_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sarah_ai_provider_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sarah_ai_provider_config FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sarah_ai_provider_config FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.sarah_ai_provider_config TO service_role;

-- Database-enforced AI management authorization. The browser cannot call this
-- helper directly; each public settings RPC invokes it under SECURITY DEFINER.
CREATE OR REPLACE FUNCTION public.sarah_ai_assert_manage_permission()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_profile jsonb;
  v_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authenticated admin session required' USING ERRCODE = '28000';
  END IF;

  v_profile := public.get_current_admin_profile();
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
    WHERE permission_item.permission = 'ai:manage'
  ) THEN
    RAISE EXCEPTION 'AI_MANAGE_PERMISSION_REQUIRED' USING ERRCODE = '42501';
  END IF;

  RETURN auth.uid();
END;
$function$;
REVOKE ALL ON FUNCTION public.sarah_ai_assert_manage_permission() FROM PUBLIC, anon, authenticated, service_role;

-- Safe provider metadata only; never return a Vault secret or secret identifier.
CREATE OR REPLACE FUNCTION public.sarah_ai_get_provider_config()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor_auth_user_id uuid;
  v_result jsonb;
BEGIN
  v_actor_auth_user_id := public.sarah_ai_assert_manage_permission();

  SELECT pg_catalog.jsonb_build_object(
    'provider_id', c.provider_id,
    'model_id', c.model_id,
    'generation_config', c.generation_config,
    'enabled', c.enabled,
    'has_api_key', c.secret_id IS NOT NULL,
    'updated_at', c.updated_at
  )
  INTO v_result
  FROM public.sarah_ai_provider_config c
  WHERE c.id = 'default';

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sarah_ai_save_provider_config(
  p_provider_id text,
  p_model_id text,
  p_endpoint_url text DEFAULT NULL,
  p_generation_config jsonb DEFAULT '{}'::jsonb,
  p_api_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_existing public.sarah_ai_provider_config%ROWTYPE;
  v_secret_id uuid;
  v_api_key text := NULLIF(pg_catalog.btrim(p_api_key), '');
  v_actor_auth_user_id uuid;
BEGIN
  v_actor_auth_user_id := public.sarah_ai_assert_manage_permission();

  IF p_provider_id IS NULL OR p_provider_id !~ '^[a-z][a-z0-9_-]{0,63}$' THEN
    RAISE EXCEPTION 'Invalid provider identifier' USING ERRCODE = '22023';
  END IF;
  IF p_model_id IS NULL OR p_model_id !~ '^[A-Za-z0-9._:-]{1,128}$' THEN
    RAISE EXCEPTION 'Invalid model identifier' USING ERRCODE = '22023';
  END IF;
  IF p_generation_config IS NULL OR pg_catalog.jsonb_typeof(p_generation_config) <> 'object' THEN
    RAISE EXCEPTION 'Generation configuration must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_object_keys(p_generation_config) AS setting_fields(field_name)
    WHERE field_name NOT IN ('temperature', 'maxOutputTokens', 'timeoutMs')
  ) THEN
    RAISE EXCEPTION 'Unsupported generation configuration field' USING ERRCODE = '22023';
  END IF;

  IF p_generation_config ? 'temperature' THEN
    IF pg_catalog.jsonb_typeof(p_generation_config->'temperature') <> 'number' THEN
      RAISE EXCEPTION 'Temperature must be numeric' USING ERRCODE = '22023';
    END IF;
    IF (p_generation_config->>'temperature')::numeric NOT BETWEEN 0 AND 2 THEN
      RAISE EXCEPTION 'Temperature must be between 0 and 2' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_generation_config ? 'maxOutputTokens' THEN
    IF pg_catalog.jsonb_typeof(p_generation_config->'maxOutputTokens') <> 'number' THEN
      RAISE EXCEPTION 'maxOutputTokens must be numeric' USING ERRCODE = '22023';
    END IF;
    IF (p_generation_config->>'maxOutputTokens') !~ '^[0-9]{1,5}$' THEN
      RAISE EXCEPTION 'maxOutputTokens must be an integer' USING ERRCODE = '22023';
    END IF;
    IF (p_generation_config->>'maxOutputTokens')::integer NOT BETWEEN 1 AND 4096 THEN
      RAISE EXCEPTION 'maxOutputTokens must be between 1 and 65536' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_generation_config ? 'timeoutMs' THEN
    IF pg_catalog.jsonb_typeof(p_generation_config->'timeoutMs') <> 'number' THEN
      RAISE EXCEPTION 'timeoutMs must be numeric' USING ERRCODE = '22023';
    END IF;
    IF (p_generation_config->>'timeoutMs') !~ '^[0-9]{4,6}$' THEN
      RAISE EXCEPTION 'timeoutMs must be an integer' USING ERRCODE = '22023';
    END IF;
    IF (p_generation_config->>'timeoutMs')::integer NOT BETWEEN 5000 AND 120000 THEN
      RAISE EXCEPTION 'timeoutMs must be between 5000 and 120000' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT * INTO v_existing
  FROM public.sarah_ai_provider_config
  WHERE id = 'default'
  FOR UPDATE;

  v_secret_id := v_existing.secret_id;
  IF v_api_key IS NOT NULL THEN
    IF pg_catalog.length(v_api_key) < 20 OR pg_catalog.length(v_api_key) > 512 THEN
      RAISE EXCEPTION 'Invalid provider API key length' USING ERRCODE = '22023';
    END IF;

    IF v_secret_id IS NULL THEN
      v_secret_id := vault.create_secret(
        v_api_key,
        'sarah-ai-provider-default',
        'Sarah AI provider API key. Server-side use only.'
      );
    ELSE
      PERFORM vault.update_secret(
        v_secret_id,
        v_api_key,
        'sarah-ai-provider-default',
        'Sarah AI provider API key. Server-side use only.'
      );
    END IF;
  END IF;

  IF v_secret_id IS NULL THEN
    RAISE EXCEPTION 'Provider API key is required before enabling Sarah AI' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.sarah_ai_provider_config (
    id, provider_id, model_id, endpoint_url, generation_config,
    secret_id, enabled, updated_by_auth_user_id, created_at, updated_at
  )
  VALUES (
    'default', p_provider_id, p_model_id, NULLIF(pg_catalog.btrim(p_endpoint_url), ''),
    p_generation_config, v_secret_id, true, v_actor_auth_user_id, now(), now()
  )
  ON CONFLICT (id) DO UPDATE SET
    provider_id = EXCLUDED.provider_id,
    model_id = EXCLUDED.model_id,
    endpoint_url = EXCLUDED.endpoint_url,
    generation_config = EXCLUDED.generation_config,
    secret_id = EXCLUDED.secret_id,
    enabled = true,
    updated_by_auth_user_id = EXCLUDED.updated_by_auth_user_id,
    updated_at = now();

  RETURN pg_catalog.jsonb_build_object(
    'configured', true,
    'providerId', p_provider_id,
    'modelId', p_model_id,
    'hasApiKey', true,
    'updatedAt', now()
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.sarah_ai_get_provider_secret()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_secret_id uuid;
  v_secret text;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;

  SELECT secret_id INTO v_secret_id
  FROM public.sarah_ai_provider_config
  WHERE id = 'default' AND enabled IS TRUE;

  IF v_secret_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE id = v_secret_id;

  RETURN v_secret;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sarah_ai_clear_provider_config()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor_auth_user_id uuid;
  v_secret_id uuid;
BEGIN
  v_actor_auth_user_id := public.sarah_ai_assert_manage_permission();

  SELECT secret_id INTO v_secret_id
  FROM public.sarah_ai_provider_config
  WHERE id = 'default'
  FOR UPDATE;

  IF v_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_secret_id;
  END IF;

  DELETE FROM public.sarah_ai_provider_config WHERE id = 'default';
  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_save_provider_config(text, text, text, jsonb, text) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.sarah_ai_get_provider_config() FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.sarah_ai_get_provider_secret() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sarah_ai_clear_provider_config() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_save_provider_config(text, text, text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sarah_ai_get_provider_config() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sarah_ai_get_provider_secret() TO service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_clear_provider_config() TO authenticated;

COMMIT;
