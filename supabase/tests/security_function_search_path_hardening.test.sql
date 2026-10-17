-- Run after applying 20261018090000_security_function_search_path_hardening.sql.
-- Read-only assertions; no business data is changed.

DO $security_function_search_path_assertions$
DECLARE
  v_signature text;
  v_config text[];
  v_expected text[] := ARRAY[
    'public.update_updated_at_column()',
    'public.prevent_ledger_modification()',
    'public.log_table_changes()',
    'public.derive_customer_code(uuid)',
    'public.prevent_ledger_tampering()',
    'public.protect_audit_logs()',
    'public.enforce_single_super_admin()',
    'public.test_fn(text)',
    'public.safe_cast_uuid(text)',
    'public.protect_super_admin_permissions()',
    'public.prevent_financial_ledger_tampering()',
    'public.freeze_recognized_order_item_snapshots()'
  ];
BEGIN
  IF has_function_privilege('anon', 'public.get_email_by_username(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_email_by_username(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Legacy username-to-email resolver remains executable by browser roles';
  END IF;

  IF has_function_privilege('anon', 'public.test_fn(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.test_fn(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Test-only RPC remains executable by browser roles';
  END IF;

  FOREACH v_signature IN ARRAY v_expected LOOP
    SELECT p.proconfig
      INTO v_config
      FROM pg_proc p
     WHERE p.oid = to_regprocedure(v_signature);

    IF v_config IS NULL OR NOT EXISTS (
      SELECT 1 FROM unnest(v_config) AS config(setting)
      WHERE setting LIKE 'search_path=%'
    ) THEN
      RAISE EXCEPTION 'Function % does not have a fixed search_path', v_signature;
    END IF;
  END LOOP;
END;
$security_function_search_path_assertions$;
