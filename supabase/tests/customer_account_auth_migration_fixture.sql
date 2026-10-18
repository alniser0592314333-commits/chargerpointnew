CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE public.customers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'ACTIVE',
  deleted_at timestamptz
);
CREATE TABLE public.admins (id uuid PRIMARY KEY);
CREATE FUNCTION public.public_resolve_customer_portal(text)
RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
