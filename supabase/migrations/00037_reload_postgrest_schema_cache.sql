-- Migration 00037: PostgREST Schema Cache Reload & rpc_fetch_admins Introspection Grant Fix

-- Ensure grants for public.rpc_fetch_admins() allow PostgREST schema introspection
GRANT EXECUTE ON FUNCTION public.rpc_fetch_admins() TO anon, authenticated, service_role;

-- Explicitly trigger PostgREST schema cache reload on current database instance
NOTIFY pgrst, 'reload schema';

