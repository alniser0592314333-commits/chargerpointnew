DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END;
$roles$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$function$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;

CREATE TABLE public.admins (
  id uuid PRIMARY KEY,
  auth_user_id uuid UNIQUE,
  role text NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}'::text[],
  is_active boolean NOT NULL DEFAULT true,
  disabled_at timestamptz
);

CREATE TABLE public.admin_custom_permissions (
  admin_id uuid NOT NULL REFERENCES public.admins(id) ON DELETE CASCADE,
  permission text NOT NULL,
  is_grant boolean NOT NULL DEFAULT true,
  PRIMARY KEY (admin_id, permission)
);

CREATE OR REPLACE FUNCTION public.assert_my_account_session_active()
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_effective_permissions__session_guarded_impl(p_admin_id uuid)
RETURNS TABLE(permission text)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $function$
  WITH custom_state AS (
    SELECT EXISTS (
      SELECT 1 FROM public.admin_custom_permissions p WHERE p.admin_id = p_admin_id
    ) AS has_custom_state
  )
  SELECT trim(p.permission)
  FROM public.admin_custom_permissions p
  WHERE p.admin_id = p_admin_id AND p.is_grant IS TRUE
    AND (SELECT has_custom_state FROM custom_state)
  UNION
  SELECT unnest(a.permissions)
  FROM public.admins a
  WHERE a.id = p_admin_id AND NOT (SELECT has_custom_state FROM custom_state);
$function$;
