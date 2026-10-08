-- The runtime authority is execute_sync_command -> execute_canonical_sync_command.
-- The older implementation is retained only for internal/service-role compatibility.
REVOKE ALL ON FUNCTION public.execute_sync_command_impl(uuid,text,text,uuid,jsonb,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.execute_sync_command_impl(uuid,text,text,uuid,jsonb,integer) TO service_role;
