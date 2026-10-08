-- Authoritative subordinate-admin permission projection
-- Fixes the split permission model where Admin Management writes
-- admin_custom_permissions but login/profile/authorization still read admins.permissions.
--
-- Contract:
-- - SUPER_ADMIN remains unrestricted at application level.
-- - If an admin has any custom-permission rows, those rows are authoritative.
-- - If an admin has no custom-permission rows, retain legacy admins.permissions
--   as a backward-compatible fallback for pre-existing admins.
-- - An explicit Save & Apply with zero permissions therefore produces zero
--   effective permissions when no legacy permissions exist.
--
-- No permission data is mutated by this migration.

CREATE OR REPLACE FUNCTION public.get_effective_permissions(p_admin_id uuid)
RETURNS TABLE(permission text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  WITH custom AS (
    SELECT DISTINCT trim(p.permission) AS permission
    FROM public.admin_custom_permissions p
    JOIN public.admins a ON a.id = p.admin_id
    WHERE p.admin_id = p_admin_id
      AND a.is_active = true
      AND p.is_grant = true
      AND trim(p.permission) <> ''
  ),
  custom_state AS (
    SELECT EXISTS (
      SELECT 1
      FROM public.admin_custom_permissions p
      WHERE p.admin_id = p_admin_id
    ) AS has_custom_state
  )
  SELECT c.permission
  FROM custom c
  WHERE (SELECT has_custom_state FROM custom_state)

  UNION

  SELECT DISTINCT unnest(coalesce(a.permissions, '{}'::text[]))
  FROM public.admins a
  WHERE a.id = p_admin_id
    AND a.is_active = true
    AND NOT (SELECT has_custom_state FROM custom_state);
$function$;

CREATE OR REPLACE FUNCTION public.get_current_admin_profile()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  a public.admins;
  v_email text;
  v_permissions text[];
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('authenticated', false, 'is_admin', false);
  END IF;

  SELECT *
  INTO a
  FROM public.admins
  WHERE auth_user_id = auth.uid()
  LIMIT 1;

  IF a.id IS NULL THEN
    SELECT email INTO v_email
    FROM auth.users
    WHERE id = auth.uid();

    IF v_email IS NULL THEN
      v_email := auth.jwt()->>'email';
    END IF;

    IF v_email IS NOT NULL THEN
      SELECT *
      INTO a
      FROM public.admins
      WHERE email IS NOT NULL
        AND lower(email) = lower(v_email)
      LIMIT 1;

      IF a.id IS NOT NULL THEN
        UPDATE public.admins
        SET auth_user_id = auth.uid(),
            updated_at = now()
        WHERE id = a.id;

        a.auth_user_id := auth.uid();
      END IF;
    END IF;
  END IF;

  IF a.id IS NULL THEN
    RETURN jsonb_build_object(
      'authenticated', true,
      'is_admin', false,
      'auth_user_id', auth.uid()
    );
  END IF;

  SELECT coalesce(array_agg(ep.permission ORDER BY ep.permission), '{}'::text[])
  INTO v_permissions
  FROM public.get_effective_permissions(a.id) ep;

  RETURN jsonb_build_object(
    'authenticated', true,
    'is_admin', true,
    'is_active', coalesce(a.is_active, true),
    'admin_id', a.id,
    'auth_user_id', a.auth_user_id,
    'username', a.username,
    'full_name', a.full_name,
    'email', a.email,
    'role', a.role,
    'permissions', coalesce(v_permissions, '{}'::text[])
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_effective_permissions(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_current_admin_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_effective_permissions(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_current_admin_profile() TO authenticated;

NOTIFY pgrst, 'reload schema';
