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
