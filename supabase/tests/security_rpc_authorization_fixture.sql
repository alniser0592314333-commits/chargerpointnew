-- Isolated contract fixture for the live RPC authorization closure.
-- This database contains synthetic rows only and never connects to production.
\set ON_ERROR_STOP on

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END
$roles$;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
CREATE SEQUENCE public.fixture_sequence;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, email_confirmed_at timestamptz);

CREATE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE
AS $function$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $function$;

CREATE FUNCTION auth.jwt()
RETURNS jsonb LANGUAGE sql STABLE
AS $function$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$function$;

CREATE TABLE public.admins (
  id uuid PRIMARY KEY,
  auth_user_id uuid UNIQUE,
  username text NOT NULL,
  full_name text NOT NULL,
  email text NOT NULL,
  role text NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}'::text[],
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_admin_id uuid,
  action varchar NOT NULL,
  target_admin_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.global_app_identity (
  id uuid PRIMARY KEY,
  singleton boolean NOT NULL DEFAULT true,
  app_name text,
  white_logo_url text,
  dark_logo_url text,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.global_app_identity ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.customers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  status text NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE public.orders (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  deleted_at timestamptz,
  cancelled_at timestamptz
);

CREATE TABLE public.qr_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  public_token text NOT NULL UNIQUE,
  token_type text NOT NULL,
  target_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.financial_ledger (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  amount_minor bigint NOT NULL
);

-- Model the broad legacy DML grants present in the live project. The migration
-- must remove write privileges while leaving non-sensitive read contracts alone.
GRANT ALL PRIVILEGES ON TABLE
  public.admins, public.global_app_identity, public.customers,
  public.orders, public.qr_tokens, public.financial_ledger, public.admin_audit_logs
TO authenticated;

CREATE FUNCTION public.assert_my_account_session_active()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) = 'service_role' THEN
    RETURN;
  END IF;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE FUNCTION public._cp_guard_nonempty_replacement_payload(p_payload jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_payload IS NULL OR p_payload = '{}'::jsonb THEN
    RAISE EXCEPTION 'Replacement payload is required' USING ERRCODE = '22023';
  END IF;
END;
$function$;

CREATE FUNCTION public.authorize_super_admin_admin_management(p_caller_bin text)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
  SELECT a.id FROM public.admins a
  WHERE a.auth_user_id = auth.uid()
    AND a.is_active
    AND upper(replace(trim(a.role), ' ', '_')) = 'SUPER_ADMIN'
  LIMIT 1
$function$;

CREATE FUNCTION public.rpc_update_admin_bin__session_guarded_impl(
  p_target_admin_id uuid, p_new_bin text, p_caller_bin text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE
  v_caller_id uuid;
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_caller_bin);
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Super Admin required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.admins SET version = version + 1 WHERE id = p_target_admin_id;
  INSERT INTO public.admin_audit_logs(actor_admin_id, action, target_admin_id, metadata)
  VALUES (v_caller_id, 'ADMIN_BIN_RESET', p_target_admin_id, '{"synthetic":true}'::jsonb);
END;
$function$;
REVOKE ALL ON FUNCTION public.rpc_update_admin_bin__session_guarded_impl(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.rpc_update_admin_bin(
  p_target_admin_id uuid, p_new_bin text, p_caller_bin text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.assert_my_account_session_active();
  PERFORM public.rpc_update_admin_bin__session_guarded_impl($1, $2, $3);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.rpc_update_admin_bin(uuid, text, text) TO authenticated, service_role;

CREATE FUNCTION public.rpc_update_admin_password__session_guarded_impl(
  p_target_admin_id uuid, p_new_password text, p_caller_bin text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE
  v_caller_id uuid;
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_caller_bin);
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Super Admin required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.admins SET version = version + 1 WHERE id = p_target_admin_id;
  INSERT INTO public.admin_audit_logs(actor_admin_id, action, target_admin_id, metadata)
  VALUES (v_caller_id, 'ADMIN_PASSWORD_RESET', p_target_admin_id, '{"synthetic":true}'::jsonb);
END;
$function$;
REVOKE ALL ON FUNCTION public.rpc_update_admin_password__session_guarded_impl(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.rpc_update_admin_password(
  p_target_admin_id uuid, p_new_password text, p_caller_bin text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.assert_my_account_session_active();
  PERFORM public.rpc_update_admin_password__session_guarded_impl($1, $2, $3);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.rpc_update_admin_password(uuid, text, text) TO authenticated, service_role;

CREATE FUNCTION public.is_active_admin_session()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.admins a WHERE a.auth_user_id = auth.uid() AND a.is_active)
$function$;

CREATE FUNCTION public.is_active_super_admin_session()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.admins a
       WHERE a.auth_user_id = auth.uid() AND a.is_active
         AND upper(replace(trim(a.role), ' ', '_')) = 'SUPER_ADMIN'
     )
$function$;

CREATE FUNCTION public.current_admin_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
  SELECT a.id FROM public.admins a WHERE a.auth_user_id = auth.uid() AND a.is_active LIMIT 1
$function$;

CREATE FUNCTION public.get_effective_permissions__session_guarded_impl(p_admin_id uuid)
RETURNS TABLE(permission text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
  SELECT unnest(a.permissions) FROM public.admins a WHERE a.id = p_admin_id AND a.is_active
$function$;
REVOKE ALL ON FUNCTION public.get_effective_permissions__session_guarded_impl(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_or_create_order_qr__session_guarded_impl(p_order_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
BEGIN
  RETURN 'order-capability-token';
END;
$function$;
REVOKE ALL ON FUNCTION public.get_or_create_order_qr__session_guarded_impl(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.rotate_customer_qr__session_guarded_impl(p_customer_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
BEGIN
  UPDATE public.qr_tokens SET is_active = false
  WHERE target_id = p_customer_id AND token_type = 'CUSTOMER' AND is_active;
  INSERT INTO public.qr_tokens(token_hash, public_token, token_type, target_id)
  VALUES (encode(digest('rotated-' || p_customer_id::text, 'sha256'), 'hex'),
          'rotated-' || p_customer_id::text, 'CUSTOMER', p_customer_id);
  RETURN 'rotated-' || p_customer_id::text;
END;
$function$;
REVOKE ALL ON FUNCTION public.rotate_customer_qr__session_guarded_impl(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_or_get_customer_qr_token__session_guarded_impl(
  p_customer_id uuid, p_token_hash text
)
RETURNS TABLE(id uuid, token_hash character varying, created_at timestamp with time zone)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
BEGIN
  INSERT INTO public.qr_tokens(token_hash, public_token, token_type, target_id)
  VALUES (p_token_hash, 'hashed-' || p_customer_id::text, 'CUSTOMER', p_customer_id)
  ON CONFLICT (token_hash) DO NOTHING;
  RETURN QUERY SELECT q.id, q.token_hash::varchar, q.created_at
    FROM public.qr_tokens q WHERE q.token_hash = p_token_hash;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_or_get_customer_qr_token__session_guarded_impl(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_or_create_customer_qr__session_guarded_impl(p_customer_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$ BEGIN RETURN 'customer-capability-token'; END; $function$;
REVOKE ALL ON FUNCTION public.get_or_create_customer_qr__session_guarded_impl(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.calculate_customer_authoritative_balance__session_guarded_impl(p_customer_id uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $function$ SELECT COALESCE(sum(amount_minor), 0)::bigint FROM public.financial_ledger WHERE customer_id = p_customer_id $function$;
REVOKE ALL ON FUNCTION public.calculate_customer_authoritative_balance__session_guarded_impl(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.rpc_fetch_admins__session_guarded_impl()
RETURNS SETOF jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $function$
  SELECT jsonb_build_object('id', a.id, 'username', a.username, 'email', a.email, 'role', a.role)
  FROM public.admins a ORDER BY a.created_at
$function$;
REVOKE ALL ON FUNCTION public.rpc_fetch_admins__session_guarded_impl()
  FROM PUBLIC, anon, authenticated, service_role;

-- Pre-hardening profile implementation reproduces the former email-based link
-- behavior so the runtime test can prove the migration removes that path.
CREATE FUNCTION public.get_current_admin_profile__session_guarded_impl()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE
  a public.admins;
  v_email text;
  v_permissions text[];
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('authenticated', false, 'is_admin', false);
  END IF;
  SELECT * INTO a FROM public.admins WHERE auth_user_id = auth.uid() LIMIT 1;
  IF a.id IS NULL THEN
    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
    IF v_email IS NULL THEN v_email := auth.jwt() ->> 'email'; END IF;
    IF v_email IS NOT NULL THEN
      SELECT * INTO a FROM public.admins
      WHERE email IS NOT NULL AND lower(email) = lower(v_email)
      LIMIT 1;
      IF a.id IS NOT NULL THEN
        UPDATE public.admins SET auth_user_id = auth.uid(), updated_at = now()
        WHERE id = a.id;
        a.auth_user_id := auth.uid();
      END IF;
    END IF;
  END IF;
  IF a.id IS NULL THEN
    RETURN jsonb_build_object('authenticated', true, 'is_admin', false, 'auth_user_id', auth.uid());
  END IF;
  SELECT COALESCE(array_agg(ep.permission ORDER BY ep.permission), '{}'::text[])
    INTO v_permissions FROM public.get_effective_permissions(a.id) ep;
  RETURN jsonb_build_object('authenticated', true, 'is_admin', true, 'admin_id', a.id,
    'auth_user_id', a.auth_user_id, 'email', a.email, 'is_active', a.is_active,
    'username', a.username, 'full_name', a.full_name, 'role', a.role,
    'permissions', COALESCE(v_permissions, '{}'::text[]));
END;
$function$;
REVOKE ALL ON FUNCTION public.get_current_admin_profile__session_guarded_impl()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_current_admin_profile()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.assert_my_account_session_active();
  RETURN public.get_current_admin_profile__session_guarded_impl();
END;
$function$;
GRANT EXECUTE ON FUNCTION public.get_current_admin_profile() TO authenticated, service_role;

-- Pre-hardening public wrappers intentionally mirror the weaker live contracts.
CREATE FUNCTION public.get_or_create_order_qr(p_order_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$ BEGIN PERFORM public.assert_my_account_session_active(); RETURN public.get_or_create_order_qr__session_guarded_impl(p_order_id); END; $function$;
GRANT EXECUTE ON FUNCTION public.get_or_create_order_qr(uuid) TO authenticated, service_role;

CREATE FUNCTION public.rotate_customer_qr(p_customer_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$ BEGIN PERFORM public.assert_my_account_session_active(); RETURN public.rotate_customer_qr__session_guarded_impl(p_customer_id); END; $function$;
GRANT EXECUTE ON FUNCTION public.rotate_customer_qr(uuid) TO authenticated, service_role;

CREATE FUNCTION public.create_or_get_customer_qr_token(p_customer_id uuid, p_token_hash text)
RETURNS TABLE(id uuid, token_hash character varying, created_at timestamp with time zone)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$ BEGIN PERFORM public.assert_my_account_session_active(); RETURN QUERY SELECT * FROM public.create_or_get_customer_qr_token__session_guarded_impl($1, $2); RETURN; END; $function$;
GRANT EXECUTE ON FUNCTION public.create_or_get_customer_qr_token(uuid, text) TO authenticated, service_role;

CREATE FUNCTION public.get_or_create_customer_qr(p_customer_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$ BEGIN PERFORM public.assert_my_account_session_active(); RETURN public.get_or_create_customer_qr__session_guarded_impl(p_customer_id); END; $function$;
GRANT EXECUTE ON FUNCTION public.get_or_create_customer_qr(uuid) TO authenticated, service_role;

CREATE FUNCTION public.calculate_customer_authoritative_balance(p_customer_id uuid)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $function$ BEGIN PERFORM public.assert_my_account_session_active(); RETURN public.calculate_customer_authoritative_balance__session_guarded_impl(p_customer_id); END; $function$;
GRANT EXECUTE ON FUNCTION public.calculate_customer_authoritative_balance(uuid) TO authenticated, service_role;

CREATE FUNCTION public.get_effective_permissions(p_admin_id uuid)
RETURNS TABLE(permission text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $function$ BEGIN PERFORM public.assert_my_account_session_active(); RETURN QUERY SELECT * FROM public.get_effective_permissions__session_guarded_impl($1); RETURN; END; $function$;
GRANT EXECUTE ON FUNCTION public.get_effective_permissions(uuid) TO authenticated, service_role;

CREATE FUNCTION public.rpc_fetch_admins()
RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$ BEGIN PERFORM public.assert_my_account_session_active(); RETURN QUERY SELECT * FROM public.rpc_fetch_admins__session_guarded_impl(); END; $function$;
GRANT EXECUTE ON FUNCTION public.rpc_fetch_admins() TO authenticated, service_role;

-- Objects touched by the version-reconciled search-path migration.
CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN RETURN NEW; END; $function$;
CREATE FUNCTION public.prevent_ledger_modification() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN RETURN NEW; END; $function$;
CREATE FUNCTION public.log_table_changes() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN RETURN NEW; END; $function$;
CREATE FUNCTION public.derive_customer_code(uuid) RETURNS varchar LANGUAGE sql IMMUTABLE AS 'SELECT $1::text';
CREATE FUNCTION public.prevent_ledger_tampering() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN RETURN NEW; END; $function$;
CREATE FUNCTION public.protect_audit_logs() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN RETURN NEW; END; $function$;
CREATE FUNCTION public.enforce_single_super_admin() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN RETURN NEW; END; $function$;
CREATE FUNCTION public.test_fn(text) RETURNS text LANGUAGE sql AS 'SELECT $1';
CREATE FUNCTION public.safe_cast_uuid(text) RETURNS uuid LANGUAGE sql IMMUTABLE AS 'SELECT $1::uuid';
CREATE FUNCTION public.protect_super_admin_permissions() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN RETURN NEW; END; $function$;
CREATE FUNCTION public.prevent_financial_ledger_tampering() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN RETURN NEW; END; $function$;
CREATE FUNCTION public.freeze_recognized_order_item_snapshots() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN RETURN NEW; END; $function$;
CREATE FUNCTION public.get_email_by_username(text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public AS 'SELECT NULL::text';
CREATE FUNCTION public.get_global_app_identity() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS 'SELECT ''{}''::jsonb';
CREATE FUNCTION public.is_system_bootstrapped() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS 'SELECT false';
CREATE FUNCTION public.check_system_bootstrapped() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS 'SELECT false';

GRANT EXECUTE ON FUNCTION public.get_global_app_identity() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_system_bootstrapped() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_system_bootstrapped() TO anon, authenticated, service_role;

INSERT INTO public.customers(id, name) VALUES
 ('20000000-0000-0000-0000-000000000001', 'Fixture Customer');
INSERT INTO public.orders(id, customer_id) VALUES
 ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001');
INSERT INTO public.financial_ledger(id, customer_id, amount_minor) VALUES
 ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', -125),
 ('40000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 25);

INSERT INTO auth.users(id, email, email_confirmed_at) VALUES
 ('11000000-0000-0000-0000-000000000003', 'staff@example.test', now()),
 ('11000000-0000-0000-0000-000000000004', 'unlinked@example.test', now());

INSERT INTO public.admins(id, auth_user_id, username, full_name, email, role, permissions, is_active) VALUES
 ('10000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001',
  'fixture_super', 'Fixture Super', 'super@example.test', 'SUPER_ADMIN',
  ARRAY['orders:view','customers:view','customers:edit','customers:financial-view','finance:view','admin:manage'], true),
 ('10000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000002',
  'fixture_staff', 'Fixture Staff', 'staff@example.test', 'STAFF',
  ARRAY['orders:view','customers:view','customers:edit'], true);
INSERT INTO public.admins(id, auth_user_id, username, full_name, email, role, permissions, is_active) VALUES
 ('10000000-0000-0000-0000-000000000004', NULL,
  'fixture_unlinked', 'Fixture Unlinked', 'unlinked@example.test', 'STAFF',
  ARRAY['orders:view'], true);
