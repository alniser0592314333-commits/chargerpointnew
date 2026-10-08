-- Canonical Admin Management permissions read path
-- Date: 2026-10-08
--
-- Root cause addressed:
-- Admin custom permissions are written through a SECURITY DEFINER RPC, but the
-- Admin Management page previously read the table directly through PostgREST.
-- That direct read is subject to table RLS and can legitimately return an empty
-- row set to the browser, making persisted permissions appear as zero.
--
-- This RPC is read-only, authenticated, and restricted to an active SUPER_ADMIN.
-- It does not change permission data or authorization semantics for mutations.

CREATE OR REPLACE FUNCTION public.rpc_fetch_custom_permissions()
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_is_active BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '28000';
  END IF;

  SELECT role, is_active
  INTO v_role, v_is_active
  FROM public.admins
  WHERE auth_user_id = auth.uid()
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Caller admin profile not found'
      USING ERRCODE = '42501';
  END IF;

  IF v_is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Caller admin profile is suspended'
      USING ERRCODE = '42501';
  END IF;

  IF upper(replace(trim(coalesce(v_role, '')), ' ', '_')) <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Unauthorized operation: SUPER_ADMIN role required'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT jsonb_build_object(
    'admin_id', p.admin_id,
    'permission', p.permission,
    'is_grant', p.is_grant
  )
  FROM public.admin_custom_permissions p
  ORDER BY p.admin_id, p.permission;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_fetch_custom_permissions() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_fetch_custom_permissions() FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_fetch_custom_permissions() TO authenticated;

NOTIFY pgrst, 'reload schema';
