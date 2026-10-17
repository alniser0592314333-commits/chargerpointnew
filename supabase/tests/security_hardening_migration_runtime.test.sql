-- Runtime regression for admin-bound SELECT policies and TRUNCATE revocation.
\set ON_ERROR_STOP on

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', false);
SELECT set_config('request.jwt.claims', '{"session_id":"11000000-0000-0000-0000-000000000001"}', false);
DO $admin_read$
BEGIN
  IF (SELECT count(*) FROM public.customers) <> 1 THEN
    RAISE EXCEPTION 'Active admin must retain customer read access';
  END IF;
  IF (SELECT count(*) FROM public.financial_ledger) <> 1 THEN
    RAISE EXCEPTION 'Active admin must retain financial ledger read access';
  END IF;
END
$admin_read$;

SELECT set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', false);
SELECT set_config('request.jwt.claims', '{"session_id":"11000000-0000-0000-0000-000000000002"}', false);
DO $nonadmin_read$
BEGIN
  IF (SELECT count(*) FROM public.customers) <> 0 THEN
    RAISE EXCEPTION 'Authenticated non-admin must not read customers';
  END IF;
  IF (SELECT count(*) FROM public.financial_ledger) <> 0 THEN
    RAISE EXCEPTION 'Authenticated non-admin must not read financial ledger';
  END IF;
  IF (SELECT count(*) FROM public.customer_requests) <> 0 THEN
    RAISE EXCEPTION 'Authenticated non-admin must not read customer requests, including nonstandard policy names';
  END IF;
END
$nonadmin_read$;
RESET ROLE;

DO $public_qr_contract$
DECLARE
  v_definition text := pg_get_functiondef('public.public_resolve_qr_payment_submission(text)'::regprocedure);
BEGIN
  IF position('balance_before_minor' IN v_definition) > 0
     OR position('balance_after_minor' IN v_definition) > 0 THEN
    RAISE EXCEPTION 'Public QR payment resolver exposes account balance before/after';
  END IF;
  IF NOT has_function_privilege('anon', 'public.public_resolve_qr_payment_submission(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.public_resolve_qr_payment_submission(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Public QR payment resolver execute contract was not preserved';
  END IF;
END
$public_qr_contract$;

DO $truncate_check$
BEGIN
  IF has_table_privilege('anon', 'public.customers', 'TRUNCATE') THEN
    RAISE EXCEPTION 'anon retains TRUNCATE on customers';
  END IF;
  IF has_table_privilege('authenticated', 'public.financial_ledger', 'TRUNCATE') THEN
    RAISE EXCEPTION 'authenticated retains TRUNCATE on financial_ledger';
  END IF;
  IF has_table_privilege('anon', 'public.customer_requests', 'TRUNCATE') THEN
    RAISE EXCEPTION 'anon retains TRUNCATE on customer_requests';
  END IF;
END
$truncate_check$;


DO $qr_wrapper_privileges$
BEGIN
  IF has_function_privilege('anon', 'public.get_or_create_customer_qr(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.adopt_customer_qr_token(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Anonymous role must not execute customer QR management RPCs';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_or_create_customer_qr(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.adopt_customer_qr_token(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Authenticated app role lost customer QR management RPC execution';
  END IF;
  IF position('is_active_admin_session' IN pg_get_functiondef('public.get_or_create_customer_qr(uuid)'::regprocedure)) = 0
     OR position('is_active_admin_session' IN pg_get_functiondef('public.adopt_customer_qr_token(uuid,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Customer QR management RPCs are missing active-admin authorization';
  END IF;
END
$qr_wrapper_privileges$;


-- First-owner bootstrap must reject any authenticated identity except the
-- pre-authorized, email-confirmed owner identity, and must not be callable by anon.
DO $bootstrap_privileges$
BEGIN
  IF has_function_privilege('anon', 'public.bootstrap_first_super_admin(text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Anonymous role must not execute first-owner bootstrap';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.bootstrap_first_super_admin(text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Authenticated role lost intended bootstrap RPC access';
  END IF;
  IF position('v_owner_email' IN pg_get_functiondef('public.bootstrap_first_super_admin(text,text,text)'::regprocedure)) = 0
     OR position('pg_advisory_xact_lock' IN pg_get_functiondef('public.bootstrap_first_super_admin(text,text,text)'::regprocedure)) = 0
     OR position('email_confirmed_at' IN pg_get_functiondef('public.bootstrap_first_super_admin(text,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'First-owner bootstrap is missing owner verification, email confirmation, or concurrency serialization';
  END IF;
END
$bootstrap_privileges$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', false);
SELECT set_config('request.jwt.claims', '{"session_id":"11000000-0000-0000-0000-000000000002"}', false);
DO $bootstrap_reject_nonowner$
DECLARE
  v_rejected boolean := false;
BEGIN
  BEGIN
    PERFORM public.bootstrap_first_super_admin('attacker_admin', 'Attacker', '1234');
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'Authenticated non-owner was able to bootstrap Super Admin';
  END IF;
END
$bootstrap_reject_nonowner$;
RESET ROLE;
DO $bootstrap_nonowner_no_side_effect$
BEGIN
  IF EXISTS (SELECT 1 FROM public.admins WHERE role IN ('SUPER_ADMIN', 'Super Admin')) THEN
    RAISE EXCEPTION 'Rejected bootstrap left a Super Admin row behind';
  END IF;
END
$bootstrap_nonowner_no_side_effect$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000003', false);
SELECT set_config('request.jwt.claims', '{"session_id":"11000000-0000-0000-0000-000000000003"}', false);
DO $bootstrap_accept_owner$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.bootstrap_first_super_admin('fixture_owner', 'Fixture Owner', '1234');
  IF v_result ->> 'success' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Verified owner could not complete first bootstrap: %', v_result;
  END IF;
END
$bootstrap_accept_owner$;
RESET ROLE;
DO $bootstrap_owner_created$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.admins
    WHERE auth_user_id = '10000000-0000-0000-0000-000000000003'
      AND role = 'SUPER_ADMIN'
      AND is_active = true
      AND bin_hash IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Successful owner bootstrap did not create the expected active Super Admin';
  END IF;
END
$bootstrap_owner_created$;


-- Anonymous callers may read public logos, but must not upload, overwrite, or delete them.
DO $storage_policy_shape$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
      AND ('public' = ANY(roles) OR 'anon' = ANY(roles))
  ) THEN
    RAISE EXCEPTION 'Public/anonymous app identity logo write policy remains';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND cmd = 'SELECT' AND 'public' = ANY(roles)
  ) THEN
    RAISE EXCEPTION 'Public logo read policy was not preserved';
  END IF;
END
$storage_policy_shape$;

SET ROLE anon;
DO $anon_logo_write$
DECLARE
  v_denied boolean := false;
  v_rows integer;
BEGIN
  BEGIN
    INSERT INTO storage.objects(bucket_id, name) VALUES ('app-identity', 'white/anon-upload.png');
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Anonymous caller was able to upload an app identity logo';
  END IF;

  UPDATE storage.objects SET name = 'white/anon-overwrite.png'
  WHERE bucket_id = 'app-identity' AND name = 'existing.png';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'Anonymous caller was able to overwrite an app identity logo';
  END IF;

  DELETE FROM storage.objects
  WHERE bucket_id = 'app-identity' AND name = 'existing.png';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'Anonymous caller was able to delete an app identity logo';
  END IF;
END
$anon_logo_write$;
RESET ROLE;

-- An active non-Super-Admin cannot write logos; the verified Super Admin can.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', false);
SELECT set_config('request.jwt.claims', '{"session_id":"11000000-0000-0000-0000-000000000001"}', false);
DO $operator_logo_write$
DECLARE
  v_denied boolean := false;
BEGIN
  BEGIN
    INSERT INTO storage.objects(bucket_id, name) VALUES ('app-identity', 'white/operator-upload.png');
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'Non-Super-Admin was able to upload an app identity logo';
  END IF;
END
$operator_logo_write$;

SELECT set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000003', false);
SELECT set_config('request.jwt.claims', '{"session_id":"11000000-0000-0000-0000-000000000003"}', false);
DO $super_admin_logo_write$
DECLARE
  v_rows integer;
BEGIN
  INSERT INTO storage.objects(bucket_id, name)
  VALUES ('app-identity', 'white/super-admin-upload.png');

  UPDATE storage.objects
  SET name = 'white/super-admin-updated.png'
  WHERE bucket_id = 'app-identity' AND name = 'white/super-admin-upload.png';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Active Super Admin could not update an app identity logo';
  END IF;

  DELETE FROM storage.objects
  WHERE bucket_id = 'app-identity' AND name = 'white/super-admin-updated.png';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Active Super Admin could not delete an app identity logo';
  END IF;
END
$super_admin_logo_write$;
RESET ROLE;


-- Trigger-returning SECURITY DEFINER routines are internal implementation
-- details, not RPCs. Their attached triggers still fire after execute is revoked.
DO $trigger_function_privileges$
DECLARE
  v_function record;
BEGIN
  IF has_function_privilege('anon', 'public.protect_super_admin_account()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.protect_super_admin_account()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.protect_super_admin_account()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Super Admin protection trigger function remains directly executable by an API role';
  END IF;

  IF has_function_privilege('anon', 'public.trg_change_capture()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trg_change_capture()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.trg_change_capture()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Canonical change-capture trigger function remains directly executable by an API role';
  END IF;

  FOR v_function IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prorettype = 'pg_catalog.trigger'::regtype
  LOOP
    IF has_function_privilege('anon', v_function.signature, 'EXECUTE')
       OR has_function_privilege('authenticated', v_function.signature, 'EXECUTE')
       OR has_function_privilege('service_role', v_function.signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'Trigger-only function % remains directly executable by an API role', v_function.signature;
    END IF;
  END LOOP;
END
$trigger_function_privileges$;
