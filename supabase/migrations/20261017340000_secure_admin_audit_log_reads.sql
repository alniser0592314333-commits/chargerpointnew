-- Keep administrator audit history available after browser table access is revoked.
-- The RPC is read-only, bounded, and requires explicit admin-management permission.
CREATE OR REPLACE FUNCTION public.rpc_fetch_admin_audit_logs()
RETURNS SETOF public.admin_audit_logs
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._cp_assert_active_admin_permission('admin:manage');

  RETURN QUERY
  SELECT l.*
  FROM public.admin_audit_logs AS l
  ORDER BY l.created_at DESC, l.id DESC
  LIMIT 1000;
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_fetch_admin_audit_logs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_fetch_admin_audit_logs() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
