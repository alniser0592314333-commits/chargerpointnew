\set ON_ERROR_STOP on
BEGIN;

DO $sync_rpc_contract$
BEGIN
  IF has_function_privilege('anon', 'public.capture_sync_bootstrap_snapshot()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pull_canonical_changes(bigint,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.capture_sync_bootstrap_snapshot__session_guarded_impl()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pull_canonical_changes__session_guarded_impl(bigint,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Sync RPC ACLs expose a privileged implementation to browser roles';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.capture_sync_bootstrap_snapshot()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pull_canonical_changes(bigint,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'The authenticated sync RPC contract was removed';
  END IF;
END
$sync_rpc_contract$;

DO $browser_table_read_closure$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (
        has_table_privilege('anon', c.oid, 'SELECT')
        OR has_table_privilege('authenticated', c.oid, 'SELECT')
      )
  ) THEN
    RAISE EXCEPTION 'Browser roles retain direct SELECT access to a public table or view';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND cmd IN ('SELECT', 'ALL')
  ) THEN
    RAISE EXCEPTION 'A direct public-schema SELECT policy remains after RPC-only read closure';
  END IF;

  -- Assert defaults for the migration role that owns the app's public objects.
  -- Platform-owned supabase_admin defaults are outside this migration's authority
  -- and are separately reported by the migration as a residual.
  IF EXISTS (
    SELECT 1
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    LEFT JOIN pg_roles grantee ON grantee.oid = a.grantee
    WHERE n.nspname = 'public'
      AND d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND d.defaclobjtype IN ('r', 'S')
      AND COALESCE(grantee.rolname, 'PUBLIC') IN ('PUBLIC', 'anon', 'authenticated')
  ) THEN
    RAISE EXCEPTION 'Application migration owner retains browser default privileges';
  END IF;
END
$browser_table_read_closure$;

-- Start with an active staff account that can view orders and goals, but lacks
-- goal-management, customer-view, and sync-management permissions. Synthetic rows only.
UPDATE public.admins
SET permissions = ARRAY['orders:view','goals:view']::text[]
WHERE id = '10000000-0000-0000-0000-000000000002';

SET LOCAL ROLE authenticated;
DO $test_denials$
DECLARE
  v_customer_id uuid := '20000000-0000-0000-0000-000000000001';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000002', true);
  PERFORM set_config(
    'request.jwt.claims',
    '{"sub":"11000000-0000-0000-0000-000000000002","role":"authenticated"}',
    true
  );

  BEGIN
    PERFORM public.evaluate_customer_active_goal(v_customer_id);
    RAISE EXCEPTION 'Goal evaluation unexpectedly succeeded with goals:view but without goals:manage';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.adopt_customer_qr_token(v_customer_id, 'legacy-customer-token-123456');
    RAISE EXCEPTION 'Customer QR adoption unexpectedly succeeded without customers:view';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.capture_sync_bootstrap_snapshot();
    RAISE EXCEPTION 'Sync bootstrap unexpectedly succeeded without sync:manage';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.pull_canonical_changes(0, 10);
    RAISE EXCEPTION 'Canonical change pull unexpectedly succeeded without sync:manage';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
END
$test_denials$;

RESET ROLE;
UPDATE public.admins
SET permissions = ARRAY['orders:view','goals:manage','sync:manage']::text[]
WHERE id = '10000000-0000-0000-0000-000000000002';

SET LOCAL ROLE authenticated;
DO $test_allowed_goal$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000002', true);
  PERFORM set_config(
    'request.jwt.claims',
    '{"sub":"11000000-0000-0000-0000-000000000002","role":"authenticated"}',
    true
  );
  v_result := public.evaluate_customer_active_goal('20000000-0000-0000-0000-000000000001');
  IF v_result->>'ok' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Authorized goal evaluation did not preserve the RPC response contract';
  END IF;

  v_result := public.capture_sync_bootstrap_snapshot();
  IF v_result->>'schema_version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Authorized sync bootstrap did not preserve the snapshot response contract';
  END IF;

  v_result := public.pull_canonical_changes(0, 10);
  IF jsonb_typeof(v_result->'changes') IS DISTINCT FROM 'array'
     OR v_result->>'serverResetGeneration' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Authorized change pull did not preserve the delta response contract';
  END IF;
END
$test_allowed_goal$;

DO $test_allowed_qr$
DECLARE
  v_token text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000001', true);
  PERFORM set_config(
    'request.jwt.claims',
    '{"sub":"11000000-0000-0000-0000-000000000001","role":"authenticated"}',
    true
  );
  v_token := public.adopt_customer_qr_token(
    '20000000-0000-0000-0000-000000000001',
    'legacy-customer-token-123456'
  );
  IF v_token IS NULL OR length(v_token) < 24 THEN
    RAISE EXCEPTION 'Authorized customer QR adoption did not return a capability token';
  END IF;
END
$test_allowed_qr$;

RESET ROLE;
ROLLBACK;
