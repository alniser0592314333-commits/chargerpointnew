\set ON_ERROR_STOP on
BEGIN;

DO $bin_reset_rpc_acl$
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.rpc_update_admin_bin(uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Administrative BIN reset RPC contract was removed';
  END IF;
  IF has_function_privilege('authenticated', 'public.rpc_update_admin_bin__session_guarded_impl(uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Internal administrative BIN reset implementation is directly executable';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.rpc_update_admin_password(uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Administrative password reset RPC contract was removed';
  END IF;
  IF has_function_privilege('authenticated', 'public.rpc_update_admin_password__session_guarded_impl(uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Internal administrative password reset implementation is directly executable';
  END IF;
END
$bin_reset_rpc_acl$;

SET LOCAL ROLE authenticated;
DO $bin_self_reset_rejected$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000001', true);
  PERFORM set_config(
    'request.jwt.claims',
    '{"sub":"11000000-0000-0000-0000-000000000001","role":"authenticated"}',
    true
  );

  BEGIN
    PERFORM public.rpc_update_admin_bin(
      '10000000-0000-0000-0000-000000000001',
      '5678',
      '1234'
    );
    RAISE EXCEPTION 'Administrative BIN reset unexpectedly allowed the caller to target their own account';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.rpc_update_admin_password(
      '10000000-0000-0000-0000-000000000001',
      'new-password',
      '1234'
    );
    RAISE EXCEPTION 'Administrative password reset unexpectedly allowed the caller to target their own account';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
END
$bin_self_reset_rejected$;

DO $bin_other_admin_reset_allowed$
DECLARE
  v_count integer;
BEGIN
  PERFORM public.rpc_update_admin_bin(
    '10000000-0000-0000-0000-000000000002',
    '5678',
    '1234'
  );
  SELECT count(*) INTO v_count
  FROM public.rpc_fetch_admin_audit_logs()
  WHERE action = 'ADMIN_BIN_RESET'
    AND target_admin_id = '10000000-0000-0000-0000-000000000002';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Authorized Super Admin could not reset a different admin account';
  END IF;

  PERFORM public.rpc_update_admin_password(
    '10000000-0000-0000-0000-000000000002',
    'new-password',
    '1234'
  );
  SELECT count(*) INTO v_count
  FROM public.rpc_fetch_admin_audit_logs()
  WHERE action = 'ADMIN_PASSWORD_RESET'
    AND target_admin_id = '10000000-0000-0000-0000-000000000002';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Authorized Super Admin could not reset a different admin password';
  END IF;
END
$bin_other_admin_reset_allowed$;

RESET ROLE;
ROLLBACK;
