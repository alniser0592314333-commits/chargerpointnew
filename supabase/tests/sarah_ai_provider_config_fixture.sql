-- Minimal isolated Supabase-like fixture for the Sarah AI provider migration.
-- This fixture is disposable CI-only PostgreSQL and never connects to production.

DO $roles$
BEGIN
  CREATE ROLE anon;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$roles$;

DO $roles$
BEGIN
  CREATE ROLE authenticated;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$roles$;

DO $roles$
BEGIN
  CREATE ROLE service_role BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$roles$;

CREATE SCHEMA auth;
CREATE SCHEMA vault;

CREATE TABLE public.permissions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  code varchar UNIQUE NOT NULL,
  description text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.role_permissions (
  role varchar NOT NULL,
  permission varchar NOT NULL,
  PRIMARY KEY (role, permission)
);

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'role',
    pg_catalog.current_setting('request.jwt.claim.role', true)
  );
$function$;

CREATE TABLE vault.secrets (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  secret text NOT NULL,
  name text NOT NULL,
  description text
);

CREATE VIEW vault.decrypted_secrets AS
SELECT id, secret AS decrypted_secret
FROM vault.secrets;

CREATE OR REPLACE FUNCTION vault.create_secret(
  new_secret text,
  new_name text,
  new_description text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO vault.secrets (secret, name, description)
  VALUES (new_secret, new_name, new_description)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION vault.update_secret(
  secret_id uuid,
  new_secret text,
  new_name text DEFAULT NULL,
  new_description text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  UPDATE vault.secrets
  SET secret = new_secret,
      name = COALESCE(new_name, name),
      description = COALESCE(new_description, description)
  WHERE id = secret_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Secret not found';
  END IF;
END;
$function$;

GRANT USAGE ON SCHEMA public, auth, vault TO service_role;
GRANT EXECUTE ON FUNCTION auth.jwt() TO service_role;
GRANT EXECUTE ON FUNCTION vault.create_secret(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION vault.update_secret(uuid, text, text, text) TO service_role;
GRANT SELECT ON vault.decrypted_secrets TO service_role;
GRANT DELETE ON vault.secrets TO service_role;
