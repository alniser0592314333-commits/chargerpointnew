\set ON_ERROR_STOP on
BEGIN;

-- The direct table endpoint must stay closed after the audit-history RPC is added.
DO $audit_acl_contract$
BEGIN
  IF has_table_privilege('authenticated', 'public.admin_audit_logs', 'SELECT') THEN
    RAISE EXCEPTION 'Authenticated role can still read audit logs directly';
  END IF;
  IF has_function_privilege('anon', 'public.rpc_fetch_admin_audit_logs()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Anonymous role can execute the audit-log RPC';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.rpc_fetch_admin_audit_logs()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Authenticated audit-log RPC contract is missing';
  END IF;
END
$audit_acl_contract$;

INSERT INTO public.admin_audit_logs(id, actor_admin_id, action, target_admin_id, metadata)
VALUES (
  '33000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  'AUDIT_RPC_CONTRACT_TEST',
  '10000000-0000-0000-0000-000000000002',
  '{"synthetic":true}'::jsonb
);

UPDATE public.admins
SET permissions = ARRAY['orders:view']::text[]
WHERE id = '10000000-0000-0000-0000-000000000002';

SET LOCAL ROLE authenticated;
DO $audit_denied_without_permission$
DECLARE
  v_count integer;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000002', true);
  PERFORM set_config(
    'request.jwt.claims',
    '{"sub":"11000000-0000-0000-0000-000000000002","role":"authenticated"}',
    true
  );
  BEGIN
    SELECT count(*) INTO v_count FROM public.rpc_fetch_admin_audit_logs();
    RAISE EXCEPTION 'Audit log read unexpectedly succeeded without admin:manage';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
END
$audit_denied_without_permission$;
RESET ROLE;

UPDATE public.admins
SET permissions = ARRAY['admin:manage']::text[]
WHERE id = '10000000-0000-0000-0000-000000000002';

SET LOCAL ROLE authenticated;
DO $audit_allowed_with_permission$
DECLARE
  v_row public.admin_audit_logs;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000002', true);
  PERFORM set_config(
    'request.jwt.claims',
    '{"sub":"11000000-0000-0000-0000-000000000002","role":"authenticated"}',
    true
  );
  SELECT * INTO v_row
  FROM public.rpc_fetch_admin_audit_logs()
  WHERE action = 'AUDIT_RPC_CONTRACT_TEST';
  IF v_row.id IS NULL OR v_row.metadata->>'synthetic' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Authorized audit-log RPC did not return the expected synthetic row';
  END IF;
END
$audit_allowed_with_permission$;
RESET ROLE;

ROLLBACK;
