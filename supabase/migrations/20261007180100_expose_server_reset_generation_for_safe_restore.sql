-- Read-only authoritative reset-generation accessor used by local restore flows.
-- This prevents a freshly restored local read model from being mistaken for stale data.

CREATE OR REPLACE FUNCTION public.get_server_reset_generation()
RETURNS BIGINT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(value_number, 1)::BIGINT
  FROM public.system_settings
  WHERE key = 'server_reset_generation'
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.get_server_reset_generation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_server_reset_generation() TO authenticated;
