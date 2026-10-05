/**
 * Supabase Migration: 00017_drop_obsolete_rpc_overloads.sql
 * Explicitly drops obsolete UUID-based overloads of execute_sync_command and execute_command
 * to resolve PostgREST PGRST203 function resolution ambiguity.
 */

-- 1. Drop obsolete UUID overloads
DROP FUNCTION IF EXISTS public.execute_sync_command(uuid, character varying, character varying, uuid, jsonb, integer);
DROP FUNCTION IF EXISTS public.execute_sync_command(uuid, varchar, varchar, uuid, jsonb, integer);

DROP FUNCTION IF EXISTS public.execute_command(uuid, character varying, character varying, uuid, jsonb, integer);
DROP FUNCTION IF EXISTS public.execute_command(uuid, varchar, varchar, uuid, jsonb, integer);

-- 2. Re-assert single authoritative signature permissions
REVOKE EXECUTE ON FUNCTION public.execute_sync_command(TEXT, VARCHAR, VARCHAR, TEXT, JSONB, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.execute_sync_command(TEXT, VARCHAR, VARCHAR, TEXT, JSONB, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.execute_sync_command(TEXT, VARCHAR, VARCHAR, TEXT, JSONB, INTEGER) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.execute_command(TEXT, VARCHAR, VARCHAR, TEXT, JSONB, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.execute_command(TEXT, VARCHAR, VARCHAR, TEXT, JSONB, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.execute_command(TEXT, VARCHAR, VARCHAR, TEXT, JSONB, INTEGER) TO authenticated;
