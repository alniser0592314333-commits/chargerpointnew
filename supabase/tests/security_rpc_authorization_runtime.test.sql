-- Runtime authorization regressions for privileged public-schema RPCs.
\set ON_ERROR_STOP on

DO $migration_contract$
BEGIN
  IF has_function_privilege('anon', 'public.get_or_create_order_qr(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rotate_customer_qr(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.create_or_get_customer_qr_token(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.create_or_get_customer_qr_token(uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.calculate_customer_authoritative_balance(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rpc_fetch_admins()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A privileged application RPC remains callable by anon';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.get_or_create_order_qr(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.rotate_customer_qr(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.calculate_customer_authoritative_balance(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.rpc_fetch_admins()', 'EXECUTE') THEN
    RAISE EXCEPTION 'An intended authenticated RPC contract was removed instead of guarded';
  END IF;

  IF has_function_privilege('anon', 'public.get_current_admin_profile()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_current_admin_profile()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_current_admin_profile__session_guarded_impl()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_current_admin_profile__session_guarded_impl()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Admin profile RPC/helper grants do not match the intended boundary';
  END IF;

  IF has_function_privilege('anon', 'public.digest(text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.digest(text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.crypt(text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.crypt(text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.gen_random_bytes(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.gen_random_bytes(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'pgcrypto primitives remain directly callable by browser roles';
  END IF;

  IF has_function_privilege('anon', 'public.derive_customer_code(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.derive_customer_code(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.safe_cast_uuid(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.safe_cast_uuid(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Internal helper functions remain directly callable by browser roles';
  END IF;

  IF has_function_privilege('anon', 'public.get_email_by_username(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_email_by_username(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.test_fn(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.test_fn(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Legacy username resolver or test RPC remains browser-callable';
  END IF;

  IF NOT has_function_privilege('anon', 'public.get_global_app_identity()', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.check_system_bootstrapped()', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.is_system_bootstrapped()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Public branding/bootstrap read contract was unintentionally broken';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc p,
         LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid IN (
      'public.get_global_app_identity()'::regprocedure,
      'public.check_system_bootstrapped()'::regprocedure,
      'public.is_system_bootstrapped()'::regprocedure
    )
      AND a.grantee = 0
      AND a.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'A public branding/bootstrap function still has a blanket PUBLIC execute grant';
  END IF;

  IF NOT (
    (SELECT proconfig FROM pg_proc WHERE oid = 'public.get_global_app_identity()'::regprocedure)
      @> ARRAY['search_path=public, pg_temp']::text[]
  ) OR NOT (
    (SELECT proconfig FROM pg_proc WHERE oid = 'public.is_system_bootstrapped()'::regprocedure)
      @> ARRAY['search_path=public, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'A public SECURITY DEFINER getter is missing its pinned search_path';
  END IF;

  IF has_function_privilege('anon', 'public._cp_assert_active_admin_permission(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._cp_assert_active_admin_permission(text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._cp_assert_active_admin_permission(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Internal authorization helper is directly executable';
  END IF;

  IF has_function_privilege('anon', 'public.assert_my_account_session_active()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.assert_my_account_session_active()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.authorize_super_admin_admin_management(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.authorize_super_admin_admin_management(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._cp_guard_nonempty_replacement_payload(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._cp_guard_nonempty_replacement_payload(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A helper-only SECURITY DEFINER RPC remains directly executable';
  END IF;

  IF has_table_privilege('anon', 'public.admins', 'SELECT')
     OR has_table_privilege('authenticated', 'public.admins', 'SELECT')
     OR has_table_privilege('authenticated', 'public.admins', 'INSERT')
     OR has_table_privilege('authenticated', 'public.admins', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.admins', 'DELETE')
     OR has_table_privilege('anon', 'public.global_app_identity', 'SELECT')
     OR has_table_privilege('authenticated', 'public.global_app_identity', 'SELECT')
     OR has_table_privilege('authenticated', 'public.global_app_identity', 'INSERT')
     OR has_table_privilege('authenticated', 'public.global_app_identity', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.global_app_identity', 'DELETE') THEN
    RAISE EXCEPTION 'Browser roles retain direct privileges on RPC-only admin/identity tables';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND (
        has_table_privilege('anon', c.oid, 'INSERT')
        OR has_table_privilege('anon', c.oid, 'UPDATE')
        OR has_table_privilege('anon', c.oid, 'DELETE')
        OR has_table_privilege('authenticated', c.oid, 'INSERT')
        OR has_table_privilege('authenticated', c.oid, 'UPDATE')
        OR has_table_privilege('authenticated', c.oid, 'DELETE')
      )
  ) THEN
    RAISE EXCEPTION 'Browser role still has direct write privileges on a public table';
  END IF;

  IF has_sequence_privilege('anon', 'public.fixture_sequence', 'USAGE')
     OR has_sequence_privilege('anon', 'public.fixture_sequence', 'SELECT')
     OR has_sequence_privilege('anon', 'public.fixture_sequence', 'UPDATE')
     OR has_sequence_privilege('authenticated', 'public.fixture_sequence', 'USAGE')
     OR has_sequence_privilege('authenticated', 'public.fixture_sequence', 'SELECT')
     OR has_sequence_privilege('authenticated', 'public.fixture_sequence', 'UPDATE') THEN
    RAISE EXCEPTION 'Browser roles retain direct sequence privileges';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    LEFT JOIN pg_roles grantee ON grantee.oid = a.grantee
    WHERE d.defaclrole = 'postgres'::regrole
      AND n.nspname = 'public'
      AND d.defaclobjtype = 'r'
      AND grantee.rolname IN ('anon', 'authenticated')
      AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  ) OR EXISTS (
    SELECT 1
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    LEFT JOIN pg_roles grantee ON grantee.oid = a.grantee
    WHERE d.defaclrole = 'postgres'::regrole
      AND n.nspname = 'public'
      AND d.defaclobjtype = 'S'
      AND grantee.rolname IN ('anon', 'authenticated')
  ) THEN
    RAISE EXCEPTION 'Browser DML/sequence privileges remain in public-schema defaults';
  END IF;
END
$migration_contract$;

-- A valid Auth session without an application admin profile must not mint/rotate
-- QR capabilities, inspect another admin's permissions, read customer balances,
-- or enumerate the admin directory.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000003', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims', '{"role":"authenticated","email":"staff@example.test","session_id":"12000000-0000-0000-0000-000000000003"}', false);

DO $non_admin_denied$
DECLARE
  v_denied boolean;
  v_profile jsonb;
  v_rows_before integer;
  v_rows_after integer;
BEGIN
  -- A confirmed Auth identity sharing a linked admin's email must not take over
  -- that admin row; email matching is no longer an account-linking mechanism.
  v_profile := public.get_current_admin_profile();
  IF v_profile ->> 'is_admin' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'Unlinked Auth identity was automatically linked to an existing admin by email';
  END IF;
  -- Confirm the existing linked identity still resolves to the same admin row.
  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000002', false);
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated","email":"staff@example.test","session_id":"12000000-0000-0000-0000-000000000002"}', false);
  v_profile := public.get_current_admin_profile();
  IF v_profile ->> 'is_admin' IS DISTINCT FROM 'true'
     OR v_profile ->> 'admin_id' IS DISTINCT FROM '10000000-0000-0000-0000-000000000002' THEN
    RAISE EXCEPTION 'Existing linked admin no longer resolves to its original identity';
  END IF;

  -- A confirmed email matching an unlinked legacy row also must not auto-link.
  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000004', false);
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated","email":"unlinked@example.test","session_id":"12000000-0000-0000-0000-000000000004"}', false);
  v_profile := public.get_current_admin_profile();
  IF v_profile ->> 'is_admin' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'Auth identity was automatically linked to an unlinked admin row by email';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000003', false);
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated","email":"staff@example.test","session_id":"12000000-0000-0000-0000-000000000003"}', false);

  v_denied := false;
  BEGIN PERFORM public.get_or_create_order_qr('30000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Non-admin minted an order QR token'; END IF;

  SELECT count(*) INTO v_rows_before FROM public.qr_tokens;
  v_denied := false;
  BEGIN PERFORM public.rotate_customer_qr('20000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  SELECT count(*) INTO v_rows_after FROM public.qr_tokens;
  IF NOT v_denied OR v_rows_after <> v_rows_before THEN
    RAISE EXCEPTION 'Non-admin rotated customer QR or changed QR rows';
  END IF;

  v_denied := false;
  BEGIN
    PERFORM * FROM public.create_or_get_customer_qr_token(
      '20000000-0000-0000-0000-000000000001',
      repeat('a', 64)
    );
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Non-admin changed customer QR token state'; END IF;

  v_denied := false;
  BEGIN
    PERFORM public.calculate_customer_authoritative_balance('20000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Non-admin read a customer authoritative balance'; END IF;

  IF EXISTS (SELECT 1 FROM public.get_effective_permissions(NULL::uuid)) THEN
    RAISE EXCEPTION 'Null permission lookup must return an empty set';
  END IF;

  v_denied := false;
  BEGIN
    PERFORM * FROM public.get_effective_permissions('10000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Non-admin enumerated another admin permissions'; END IF;

  v_denied := false;
  BEGIN PERFORM * FROM public.rpc_fetch_admins();
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Non-admin enumerated the admin directory'; END IF;
END
$non_admin_denied$;
RESET ROLE;

-- An active staff admin retains permitted order/customer QR operations, but not
-- finance-only balance reads or cross-admin privilege inspection.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000002', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims', '{"role":"authenticated","session_id":"12000000-0000-0000-0000-000000000002"}', false);

DO $staff_contract$
DECLARE
  v_denied boolean;
  v_result text;
  v_balance bigint;
  v_rows integer;
BEGIN
  v_result := public.get_or_create_order_qr('30000000-0000-0000-0000-000000000001');
  IF v_result <> 'order-capability-token' THEN RAISE EXCEPTION 'Permitted order QR creation contract changed'; END IF;

  v_result := public.get_or_create_customer_qr('20000000-0000-0000-0000-000000000001');
  IF v_result <> 'customer-capability-token' THEN RAISE EXCEPTION 'Permitted customer QR creation contract changed'; END IF;

  v_result := public.rotate_customer_qr('20000000-0000-0000-0000-000000000001');
  IF v_result <> 'rotated-20000000-0000-0000-0000-000000000001' THEN
    RAISE EXCEPTION 'Permitted customer QR rotation contract changed';
  END IF;

  IF has_function_privilege('authenticated', 'public.create_or_get_customer_qr_token(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Retired legacy customer QR token RPC remains exposed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.get_effective_permissions('10000000-0000-0000-0000-000000000002')
    WHERE permission = 'orders:view'
  ) THEN RAISE EXCEPTION 'Admin must be able to inspect its own effective permissions'; END IF;

  v_denied := false;
  BEGIN
    PERFORM public.calculate_customer_authoritative_balance('20000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Staff without financial permission read a customer balance'; END IF;

  v_denied := false;
  BEGIN
    PERFORM * FROM public.get_effective_permissions('10000000-0000-0000-0000-000000000001');
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Staff without admin:manage enumerated another admin permissions'; END IF;

  v_denied := false;
  BEGIN PERFORM * FROM public.rpc_fetch_admins();
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true; END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Staff without admin:manage enumerated the admin directory'; END IF;
END
$staff_contract$;
RESET ROLE;

-- After the required permissions are granted, financial balance and admin-directory
-- reads continue to work; cross-admin permission lookup is now explicitly authorized.
UPDATE public.admins
SET permissions = ARRAY[
  'orders:view','customers:view','customers:edit',
  'customers:financial-view','finance:view','admin:manage'
]
WHERE id = '10000000-0000-0000-0000-000000000002';

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000002', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims', '{"role":"authenticated","session_id":"12000000-0000-0000-0000-000000000002"}', false);

DO $authorized_reads$
DECLARE
  v_balance bigint;
  v_admin_count integer;
BEGIN
  v_balance := public.calculate_customer_authoritative_balance('20000000-0000-0000-0000-000000000001');
  IF v_balance <> -100 THEN RAISE EXCEPTION 'Authorized customer balance result changed: %', v_balance; END IF;

  SELECT count(*) INTO v_admin_count FROM public.rpc_fetch_admins();
  IF v_admin_count <> 3 THEN RAISE EXCEPTION 'Authorized admin directory result changed'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.get_effective_permissions('10000000-0000-0000-0000-000000000001')
    WHERE permission = 'admin:manage'
  ) THEN
    RAISE EXCEPTION 'admin:manage caller could not inspect target effective permissions';
  END IF;
END
$authorized_reads$;
RESET ROLE;

-- Service-role grants remain trusted and the new authorization helper stays internal.
DO $service_role_contract$
BEGIN
  IF NOT has_function_privilege('service_role', 'public.get_or_create_order_qr(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.rotate_customer_qr(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.calculate_customer_authoritative_balance(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.rpc_fetch_admins()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Trusted service_role RPC contract was unexpectedly removed';
  END IF;
END
$service_role_contract$;
