CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL, not_after timestamptz);

CREATE TABLE public.admins (id uuid PRIMARY KEY, auth_user_id uuid NOT NULL, is_active boolean NOT NULL, disabled_at timestamptz);
CREATE TABLE public.account_sessions (session_id uuid NOT NULL, user_id uuid NOT NULL, revoked_at timestamptz, session_expires_at timestamptz NOT NULL);
CREATE TABLE public.customers (id uuid PRIMARY KEY, is_active boolean NOT NULL, deleted_at timestamptz, status text NOT NULL);
CREATE TABLE public.customer_account_links (customer_id uuid NOT NULL, auth_user_id uuid NOT NULL, account_status text NOT NULL);
CREATE TABLE public.customer_account_sessions (customer_id uuid NOT NULL, auth_user_id uuid NOT NULL, session_id uuid NOT NULL, revoked_at timestamptz, expires_at timestamptz NOT NULL);
CREATE TABLE public.native_push_devices (
  id uuid PRIMARY KEY, device_id uuid NOT NULL, token text NOT NULL, app_variant text NOT NULL,
  principal_id uuid NOT NULL, customer_id uuid, auth_session_id text NOT NULL, disabled_at timestamptz
);
