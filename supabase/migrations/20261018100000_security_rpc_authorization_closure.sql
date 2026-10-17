-- Close remaining RPC authorization gaps found by auditing the live function bodies.
-- This migration changes function definitions/ACLs only; it does not touch business rows.
-- The public QR resolution RPCs remain available as capability-token endpoints.

CREATE OR REPLACE FUNCTION public._cp_assert_active_admin_permission(p_required_permission text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_request_role text := COALESCE(
    auth.jwt() ->> 'role',
    current_setting('request.jwt.claim.role', true)
  );
BEGIN
  -- Trusted server-to-server calls retain their existing ability to use these
  -- wrappers. Browser JWTs must map to an active, registered application admin.
  IF v_request_role = 'service_role' THEN
    RETURN NULL;
  END IF;

  PERFORM public.assert_my_account_session_active();

  IF public.is_active_admin_session() IS NOT TRUE THEN
    RAISE EXCEPTION 'Active administrator account required'
      USING ERRCODE = '42501';
  END IF;

  SELECT a.id, a.role
    INTO v_admin_id, v_admin_role
  FROM public.admins AS a
  WHERE a.auth_user_id = auth.uid()
    AND a.is_active IS TRUE
  LIMIT 1;

  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Active administrator profile not found'
      USING ERRCODE = '42501';
  END IF;

  IF upper(replace(trim(COALESCE(v_admin_role, '')), ' ', '_')) IN ('SUPER_ADMIN') THEN
    RETURN v_admin_id;
  END IF;

  IF p_required_permission IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.get_effective_permissions__session_guarded_impl(v_admin_id) AS ep
       WHERE ep.permission = ANY (
         CASE p_required_permission
           WHEN 'orders:view' THEN ARRAY['orders:view', 'orders:read', 'SUPER_ADMIN']::text[]
           WHEN 'customers:view' THEN ARRAY['customers:view', 'customers:read', 'SUPER_ADMIN']::text[]
           WHEN 'customers:edit' THEN ARRAY['customers:edit', 'customers:write', 'SUPER_ADMIN']::text[]
           WHEN 'finance:view' THEN ARRAY['finance:view', 'finances:read', 'SUPER_ADMIN']::text[]
           WHEN 'customers:financial-view' THEN ARRAY['customers:financial-view', 'finance:view', 'finances:read', 'SUPER_ADMIN']::text[]
           ELSE ARRAY[p_required_permission, 'SUPER_ADMIN']::text[]
         END
       )
     )
  THEN
    RAISE EXCEPTION 'Missing required permission: %', p_required_permission
      USING ERRCODE = '42501';
  END IF;

  RETURN v_admin_id;
END;
$function$;

REVOKE ALL ON FUNCTION public._cp_assert_active_admin_permission(text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Guard/assertion helpers are implementation details used by SECURITY DEFINER
-- wrappers and RLS expressions, not standalone API endpoints.
REVOKE ALL ON FUNCTION public.assert_my_account_session_active()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.authorize_super_admin_admin_management(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._cp_guard_nonempty_replacement_payload(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- These tables are accessed through guarded RPCs (and the trusted sign-in Edge
-- Function), not direct browser REST. Remove stale direct table grants as a second
-- boundary even though RLS currently has no policies on either table.
REVOKE ALL PRIVILEGES ON TABLE public.admins, public.global_app_identity
  FROM PUBLIC, anon, authenticated;

-- A valid Supabase Auth session is not sufficient authorization to mint or
-- rotate customer/order QR capabilities. Require an active app admin and the
-- permission appropriate to the target resource before entering the mutator.
CREATE OR REPLACE FUNCTION public.get_or_create_order_qr(p_order_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._cp_assert_active_admin_permission('orders:view');

  IF p_order_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.orders AS o
    JOIN public.customers AS c ON c.id = o.customer_id
    WHERE o.id = p_order_id
      AND o.deleted_at IS NULL
      AND o.cancelled_at IS NULL
      AND c.is_active IS TRUE
      AND c.deleted_at IS NULL
      AND c.status <> 'DELETED'
  ) THEN
    RAISE EXCEPTION 'Active order not found for QR creation'
      USING ERRCODE = '22023';
  END IF;

  RETURN public.get_or_create_order_qr__session_guarded_impl(p_order_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_or_create_order_qr(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_or_create_order_qr(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rotate_customer_qr(p_customer_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._cp_assert_active_admin_permission('customers:edit');

  IF p_customer_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.customers AS c
    WHERE c.id = p_customer_id
      AND c.is_active IS TRUE
      AND c.deleted_at IS NULL
      AND c.status <> 'DELETED'
  ) THEN
    RAISE EXCEPTION 'Active customer not found for QR rotation'
      USING ERRCODE = '22023';
  END IF;

  RETURN public.rotate_customer_qr__session_guarded_impl(p_customer_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.rotate_customer_qr(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rotate_customer_qr(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_or_get_customer_qr_token(
  p_customer_id uuid,
  p_token_hash text
)
RETURNS TABLE(id uuid, token_hash character varying, created_at timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._cp_assert_active_admin_permission('customers:edit');

  IF p_customer_id IS NULL OR p_token_hash IS NULL OR btrim(p_token_hash) = ''
     OR NOT EXISTS (
       SELECT 1
       FROM public.customers AS c
       WHERE c.id = p_customer_id
         AND c.is_active IS TRUE
         AND c.deleted_at IS NULL
         AND c.status <> 'DELETED'
     )
  THEN
    RAISE EXCEPTION 'Active customer and token hash are required'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT *
  FROM public.create_or_get_customer_qr_token__session_guarded_impl(
    p_customer_id,
    p_token_hash
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.create_or_get_customer_qr_token(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_or_get_customer_qr_token(uuid, text) TO authenticated, service_role;

-- The existing customer QR creator was already admin-gated, but did not check
-- the caller's customer-view permission. Preserve the RPC contract while enforcing it.
CREATE OR REPLACE FUNCTION public.get_or_create_customer_qr(p_customer_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._cp_assert_active_admin_permission('customers:view');
  RETURN public.get_or_create_customer_qr__session_guarded_impl(p_customer_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_or_create_customer_qr(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_or_create_customer_qr(uuid) TO authenticated, service_role;

-- Do not let an arbitrary authenticated account enumerate another admin's
-- effective permissions. A caller can inspect its own permissions; cross-admin
-- inspection requires admin:manage (or the Super Admin role).
CREATE OR REPLACE FUNCTION public.get_effective_permissions(p_admin_id uuid)
RETURNS TABLE(permission text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_request_role text := COALESCE(
    auth.jwt() ->> 'role',
    current_setting('request.jwt.claim.role', true)
  );
  v_current_admin_id uuid;
BEGIN
  IF v_request_role = 'service_role' THEN
    RETURN QUERY
    SELECT ep.permission
    FROM public.get_effective_permissions__session_guarded_impl(p_admin_id) AS ep;
    RETURN;
  END IF;

  v_current_admin_id := public._cp_assert_active_admin_permission(NULL);

  IF p_admin_id IS NULL THEN
    RAISE EXCEPTION 'Admin id is required'
      USING ERRCODE = '22023';
  END IF;

  IF p_admin_id IS DISTINCT FROM v_current_admin_id THEN
    PERFORM public._cp_assert_active_admin_permission('admin:manage');
  END IF;

  RETURN QUERY
  SELECT ep.permission
  FROM public.get_effective_permissions__session_guarded_impl(p_admin_id) AS ep;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_effective_permissions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_effective_permissions(uuid) TO authenticated, service_role;

-- Customer balance lookup is a privileged read, not a general authenticated RPC.
CREATE OR REPLACE FUNCTION public.calculate_customer_authoritative_balance(p_customer_id uuid)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin_id uuid;
  v_request_role text := COALESCE(
    auth.jwt() ->> 'role',
    current_setting('request.jwt.claim.role', true)
  );
BEGIN
  v_admin_id := public._cp_assert_active_admin_permission(NULL);

  IF v_request_role IS DISTINCT FROM 'service_role'
     AND NOT EXISTS (
       SELECT 1
       FROM public.get_effective_permissions__session_guarded_impl(v_admin_id) AS ep
       WHERE ep.permission IN ('customers:financial-view', 'finance:view', 'finances:read', 'SUPER_ADMIN')
     )
  THEN
    RAISE EXCEPTION 'Customer financial-view permission required'
      USING ERRCODE = '42501';
  END IF;

  IF p_customer_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.customers AS c
    WHERE c.id = p_customer_id
      AND c.is_active IS TRUE
      AND c.deleted_at IS NULL
      AND c.status <> 'DELETED'
  ) THEN
    RAISE EXCEPTION 'Active customer not found'
      USING ERRCODE = '22023';
  END IF;

  RETURN public.calculate_customer_authoritative_balance__session_guarded_impl(p_customer_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.calculate_customer_authoritative_balance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calculate_customer_authoritative_balance(uuid) TO authenticated, service_role;

-- Admin directory data includes usernames, names, and email addresses. The UI's
-- permission check is not an authorization boundary; enforce it inside the RPC.
CREATE OR REPLACE FUNCTION public.rpc_fetch_admins()
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._cp_assert_active_admin_permission('admin:manage');
  RETURN QUERY SELECT * FROM public.rpc_fetch_admins__session_guarded_impl();
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_fetch_admins() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_fetch_admins() TO authenticated, service_role;

-- Do not auto-link an Auth user to an existing admin row by email. The former
-- implementation could overwrite an already-linked auth_user_id after matching
-- the email, which turns email matching into an account-link takeover path.
-- All current production admin rows are already linked; new admins are linked by
-- the bootstrap/admin-creation RPCs, so this removes only the unsafe legacy fallback.
CREATE OR REPLACE FUNCTION public.get_current_admin_profile__session_guarded_impl()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  a public.admins;
  v_permissions text[] := '{}'::text[];
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('authenticated', false, 'is_admin', false);
  END IF;

  SELECT *
    INTO a
  FROM public.admins
  WHERE auth_user_id = auth.uid()
  LIMIT 1;

  -- No email-based fallback: an Auth identity must be explicitly linked by the
  -- trusted bootstrap/admin-creation flow. A matching email alone is not enough.
  IF a.id IS NULL THEN
    RETURN jsonb_build_object(
      'authenticated', true,
      'is_admin', false,
      'auth_user_id', auth.uid()
    );
  END IF;

  -- Preserve the suspended-account response without querying the active-admin
  -- permissions wrapper, which intentionally rejects inactive administrators.
  IF a.is_active IS TRUE THEN
    SELECT COALESCE(array_agg(ep.permission ORDER BY ep.permission), '{}'::text[])
      INTO v_permissions
    FROM public.get_effective_permissions(a.id) AS ep;
  END IF;

  RETURN jsonb_build_object(
    'authenticated', true,
    'is_admin', true,
    'is_active', COALESCE(a.is_active, false),
    'admin_id', a.id,
    'auth_user_id', a.auth_user_id,
    'username', a.username,
    'full_name', a.full_name,
    'email', a.email,
    'role', a.role,
    'permissions', COALESCE(v_permissions, '{}'::text[])
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_current_admin_profile__session_guarded_impl()
  FROM PUBLIC, anon, authenticated, service_role;

-- Pin the last two public SECURITY DEFINER getters to a deterministic path and
-- avoid inheriting broad PUBLIC grants. Anonymous access remains explicit where
-- required by first-run bootstrap and public branding.
ALTER FUNCTION public.get_global_app_identity() SET search_path TO public, pg_temp;
ALTER FUNCTION public.is_system_bootstrapped() SET search_path TO public, pg_temp;

REVOKE ALL ON FUNCTION public.get_global_app_identity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_global_app_identity() TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.check_system_bootstrapped() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_system_bootstrapped() TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_system_bootstrapped() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_system_bootstrapped() TO anon, authenticated, service_role;

-- These deterministic/internal helpers are called by server-side functions, not
-- by the browser as standalone RPCs. Keep the service role for any trusted tooling.
REVOKE ALL ON FUNCTION public.derive_customer_code(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.safe_cast_uuid(text) FROM PUBLIC, anon, authenticated;

-- pgcrypto was installed in the exposed public schema. Its cryptographic primitives
-- are used by privileged SQL functions; they do not need to be callable as browser RPCs.
DO $revoke_pgcrypto_browser_execute$
DECLARE
  v_function record;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    JOIN pg_depend AS d
      ON d.classid = 'pg_proc'::regclass
     AND d.objid = p.oid
     AND d.refclassid = 'pg_extension'::regclass
     AND d.deptype = 'e'
    JOIN pg_extension AS e ON e.oid = d.refobjid
    WHERE n.nspname = 'public'
      AND e.extname = 'pgcrypto'
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated',
      v_function.signature
    );
  END LOOP;
END;
$revoke_pgcrypto_browser_execute$;

-- Internal implementations should never resolve attacker-controlled temp objects.
ALTER FUNCTION public.get_or_create_order_qr__session_guarded_impl(uuid) SET search_path TO public, pg_temp;
ALTER FUNCTION public.rotate_customer_qr__session_guarded_impl(uuid) SET search_path TO public, pg_temp;
ALTER FUNCTION public.create_or_get_customer_qr_token__session_guarded_impl(uuid, text) SET search_path TO public, pg_temp;
ALTER FUNCTION public.rpc_fetch_admins__session_guarded_impl() SET search_path TO public, pg_temp;

NOTIFY pgrst, 'reload schema';
