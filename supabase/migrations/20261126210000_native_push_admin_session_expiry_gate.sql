-- Native admin push delivery must honor the same account-session expiry
-- and disablement state as interactive RPCs. Customer push eligibility remains
-- governed by customer_account_sessions and customer account status.
DO $patch_native_push_admin_gate$
DECLARE
  v_definition text;
BEGIN
  IF to_regprocedure('public.native_push_device_is_current(uuid,boolean,boolean)') IS NULL THEN
    RETURN;
  END IF;

  v_definition := pg_get_functiondef(
    'public.native_push_device_is_current(uuid,boolean,boolean)'::regprocedure
  );

  IF pg_catalog.strpos(v_definition, 'a.disabled_at IS NULL') = 0 THEN
    v_definition := replace(
      v_definition,
      'AND a.is_active = true',
      'AND a.is_active = true' || E'\n     AND a.disabled_at IS NULL'
    );
  END IF;

  IF pg_catalog.strpos(v_definition, 'admin_session.session_expires_at > now()') = 0 THEN
    v_definition := replace(
      v_definition,
      'AND admin_session.revoked_at IS NULL',
      'AND admin_session.revoked_at IS NULL' || E'\n          AND admin_session.session_expires_at > now()'
    );
  END IF;

  IF pg_catalog.strpos(v_definition, 'a.disabled_at IS NULL') = 0
     OR pg_catalog.strpos(v_definition, 'admin_session.session_expires_at > now()') = 0 THEN
    RAISE EXCEPTION 'Could not harden native admin push session validation';
  END IF;

  EXECUTE v_definition;
END;
$patch_native_push_admin_gate$;

NOTIFY pgrst, 'reload schema';
