-- Contract checks for the scoped admin goals read model.
BEGIN;

DO $goals_read_model_acl$
DECLARE
  v_def text;
BEGIN
  IF has_function_privilege('anon', 'public.get_admin_goals_page_data()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Anonymous users must not execute the admin goals read model';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_admin_goals_page_data()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Authenticated users must be able to invoke the guarded goals read model';
  END IF;

  SELECT pg_get_functiondef('public.get_admin_goals_page_data()'::regprocedure) INTO v_def;
  IF position('_cp_assert_active_admin_permission' IN v_def) = 0
     OR position('get_effective_permissions__session_guarded_impl' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Goals read model is missing its active-admin or effective-permission guard';
  END IF;
  IF position('capture_sync_bootstrap_snapshot' IN v_def) > 0
     OR position('pull_canonical_changes' IN v_def) > 0 THEN
    RAISE EXCEPTION 'Goals read model must not invoke full bootstrap or change-log sync';
  END IF;
  IF position('SECURITY DEFINER' IN upper(v_def)) = 0 THEN
    RAISE EXCEPTION 'Goals read model must execute through its fixed-search-path security definer';
  END IF;
END
$goals_read_model_acl$;

ROLLBACK;
