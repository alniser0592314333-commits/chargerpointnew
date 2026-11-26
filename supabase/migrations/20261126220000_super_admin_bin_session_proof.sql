-- Bind Super Admin BIN verification to the exact fresh Auth session, and
-- require that proof before a new administrator app-session row is created.
-- This prevents direct RPC callers from skipping the UI's second factor.
BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_bin_session_proofs (
  auth_session_id uuid PRIMARY KEY REFERENCES auth.sessions(id) ON DELETE CASCADE,
  auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  verified_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > verified_at)
);
ALTER TABLE public.admin_bin_session_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_bin_session_proofs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_bin_session_proofs FROM PUBLIC, anon, authenticated, service_role;
CREATE INDEX IF NOT EXISTS admin_bin_session_proofs_expiry_idx
  ON public.admin_bin_session_proofs(expires_at);

-- The existing recovery proof table is also an internal capability store. No
-- browser or service-role client needs direct table access; SECURITY DEFINER
-- RPCs remain the only supported path.
DO $revoke_bin_proof_table$
BEGIN
  IF to_regclass('public.admin_bin_recovery_proofs') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.admin_bin_recovery_proofs ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE public.admin_bin_recovery_proofs FORCE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON TABLE public.admin_bin_recovery_proofs FROM PUBLIC, anon, authenticated, service_role';
  END IF;
END;
$revoke_bin_proof_table$;

CREATE OR REPLACE FUNCTION public.consume_my_super_admin_bin_session_proof()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_session_id uuid;
  v_role text;
  v_consumed boolean := false;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated administrator required' USING ERRCODE = '28000';
  END IF;
  BEGIN
    v_session_id := NULLIF(auth.jwt() ->> 'session_id', '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Authenticated session identity required' USING ERRCODE = '28000';
  END;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated session identity required' USING ERRCODE = '28000';
  END IF;

  SELECT a.role INTO v_role
  FROM public.admins a
  WHERE a.auth_user_id = v_user_id
    AND a.is_active IS TRUE
    AND a.disabled_at IS NULL;

  -- The verified first-owner bootstrap has no admin row yet. Its separate
  -- owner/email/BIN bootstrap boundary is checked before this helper is called.
  IF NOT FOUND OR v_role NOT IN ('SUPER_ADMIN', 'Super Admin') THEN
    RETURN;
  END IF;

  UPDATE public.admin_bin_session_proofs
  SET consumed_at = now()
  WHERE auth_session_id = v_session_id
    AND auth_user_id = v_user_id
    AND consumed_at IS NULL
    AND expires_at > now()
  RETURNING true INTO v_consumed;

  IF NOT COALESCE(v_consumed, false) THEN
    RAISE EXCEPTION 'Super Admin BIN verification is required before session registration'
      USING ERRCODE = '28000';
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.consume_my_super_admin_bin_session_proof()
  FROM PUBLIC, anon, authenticated, service_role;

-- Clone the already-guarded registration RPCs and consume a BIN proof only on
-- the new-session branch. Existing active sessions keep their normal heartbeat.
DO $patch_registration_bin_proof$
DECLARE
  v_definition text;
  v_impl text;
  v_anchor text;
BEGIN
  IF to_regprocedure('public.register_my_account_session_v2(text,text)') IS NOT NULL THEN
    v_definition := pg_get_functiondef('public.register_my_account_session_v2(text,text)'::regprocedure);
    IF position('register_my_account_session_v2__bin_proof_impl' IN v_definition) = 0 THEN
      v_impl := replace(
        v_definition,
        'FUNCTION public.register_my_account_session_v2(',
        'FUNCTION public.register_my_account_session_v2__bin_proof_impl('
      );
      v_anchor := $anchor$RAISE EXCEPTION 'SESSION_REGISTRATION_REQUIRES_FRESH_AUTH' USING ERRCODE = '28000';
    END IF;$anchor$;
      IF position(v_anchor IN v_impl) = 0 THEN
        RAISE EXCEPTION 'Could not locate fresh-auth registration boundary for BIN proof enforcement';
      END IF;
      v_impl := replace(
        v_impl,
        v_anchor,
        v_anchor || E'\n\n    PERFORM public.consume_my_super_admin_bin_session_proof();'
      );
      EXECUTE v_impl;
    END IF;
  END IF;

  IF to_regprocedure('public.reactivate_my_account_session(text)') IS NOT NULL THEN
    v_definition := pg_get_functiondef('public.reactivate_my_account_session(text)'::regprocedure);
    IF position('reactivate_my_account_session__bin_proof_impl' IN v_definition) = 0 THEN
      v_impl := replace(
        v_definition,
        'FUNCTION public.reactivate_my_account_session(',
        'FUNCTION public.reactivate_my_account_session__bin_proof_impl('
      );
      v_anchor := $anchor$RAISE EXCEPTION 'SESSION_REACTIVATION_REQUIRES_FRESH_AUTH' USING ERRCODE = '28000';
    END IF;$anchor$;
      IF position(v_anchor IN v_impl) = 0 THEN
        RAISE EXCEPTION 'Could not locate fresh-auth reactivation boundary for BIN proof enforcement';
      END IF;
      v_impl := replace(
        v_impl,
        v_anchor,
        v_anchor || E'\n\n    PERFORM public.consume_my_super_admin_bin_session_proof();'
      );
      EXECUTE v_impl;
    END IF;
  END IF;
END;
$patch_registration_bin_proof$;

CREATE OR REPLACE FUNCTION public.register_my_account_session_v2(
  p_user_agent text DEFAULT NULL,
  p_client_type text DEFAULT 'browser'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN public.register_my_account_session_v2__bin_proof_impl(p_user_agent, p_client_type);
END;
$function$;
REVOKE ALL ON FUNCTION public.register_my_account_session_v2(text,text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.register_my_account_session_v2(text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.register_my_account_session_v2__bin_proof_impl(text,text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reactivate_my_account_session(
  p_client_type text DEFAULT 'native'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN public.reactivate_my_account_session__bin_proof_impl(p_client_type);
END;
$function$;
REVOKE ALL ON FUNCTION public.reactivate_my_account_session(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.reactivate_my_account_session(text) TO authenticated;
REVOKE ALL ON FUNCTION public.reactivate_my_account_session__bin_proof_impl(text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Fresh password reauthentication is a narrowly scoped exception for BIN
-- change/recovery proof RPCs. It never grants an application session.
CREATE OR REPLACE FUNCTION public.assert_my_fresh_admin_reauth_session()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_session_id uuid;
  v_auth_role text;
  v_created_at timestamptz;
  v_not_after timestamptz;
  v_has_registry_row boolean := false;
  v_is_active_admin boolean := false;
BEGIN
  v_auth_role := COALESCE(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true));
  IF v_user_id IS NULL OR v_auth_role <> 'authenticated' THEN
    RAISE EXCEPTION 'Fresh authenticated administrator reauthentication required' USING ERRCODE = '28000';
  END IF;

  BEGIN
    v_session_id := NULLIF(auth.jwt() ->> 'session_id', '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Fresh authenticated administrator reauthentication required' USING ERRCODE = '28000';
  END;
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'Fresh authenticated administrator reauthentication required' USING ERRCODE = '28000';
  END IF;

  SELECT s.created_at, s.not_after INTO v_created_at, v_not_after
  FROM auth.sessions s
  WHERE s.id = v_session_id AND s.user_id = v_user_id;
  IF NOT FOUND OR v_created_at IS NULL OR v_created_at > now()
     OR v_created_at < now() - interval '2 minutes'
     OR (v_not_after IS NOT NULL AND v_not_after <= now()) THEN
    RAISE EXCEPTION 'Fresh authenticated administrator reauthentication required' USING ERRCODE = '28000';
  END IF;

  EXECUTE 'SELECT EXISTS (
    SELECT 1 FROM public.account_sessions s
    WHERE s.session_id = $1 AND s.user_id = $2
  )' INTO v_has_registry_row USING v_session_id, v_user_id;
  IF v_has_registry_row THEN
    RAISE EXCEPTION 'An expired or revoked app session cannot use the fresh-reauth exception'
      USING ERRCODE = '28000';
  END IF;

  EXECUTE 'SELECT EXISTS (
    SELECT 1 FROM public.admins a
    WHERE a.auth_user_id = $1
      AND a.is_active IS TRUE
      AND a.disabled_at IS NULL
  )' INTO v_is_active_admin USING v_user_id;
  IF NOT v_is_active_admin THEN
    RAISE EXCEPTION 'Active administrator account required' USING ERRCODE = '28000';
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.assert_my_fresh_admin_reauth_session()
  FROM PUBLIC, anon, authenticated, service_role;

-- The login BIN verifier creates a one-time proof only after the attempt-
-- tracked verifier succeeds. The proof is bound to this exact Auth session.
DO $guard_bin_login_proof$
BEGIN
  IF to_regprocedure('public.verify_admin_bin_with_attempt_tracking(text)') IS NOT NULL
     AND to_regprocedure('public.verify_admin_bin_with_attempt_tracking__session_guarded_impl(text)') IS NOT NULL THEN
    EXECUTE $wrapper$
      CREATE OR REPLACE FUNCTION public.verify_admin_bin_with_attempt_tracking(p_bin text)
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $function$
      DECLARE
        v_result jsonb;
        v_role text;
        v_session_id uuid;
      BEGIN
        IF public.is_my_account_session_active() IS TRUE THEN
          PERFORM public.assert_my_account_session_active();
        ELSE
          PERFORM public.assert_my_fresh_super_admin_login_session();
        END IF;

        v_result := public.verify_admin_bin_with_attempt_tracking__session_guarded_impl(p_bin);
        IF COALESCE((v_result ->> 'success')::boolean, false) IS TRUE THEN
          SELECT a.role INTO v_role
          FROM public.admins a
          WHERE a.auth_user_id = auth.uid()
            AND a.is_active IS TRUE
            AND a.disabled_at IS NULL;
          IF v_role IN ('SUPER_ADMIN', 'Super Admin') THEN
            v_session_id := NULLIF(auth.jwt() ->> 'session_id', '')::uuid;
            INSERT INTO public.admin_bin_session_proofs(
              auth_session_id, auth_user_id, verified_at, expires_at, consumed_at
            ) VALUES (v_session_id, auth.uid(), now(), now() + interval '5 minutes', NULL)
            ON CONFLICT (auth_session_id) DO UPDATE
              SET auth_user_id = EXCLUDED.auth_user_id,
                  verified_at = EXCLUDED.verified_at,
                  expires_at = EXCLUDED.expires_at,
                  consumed_at = NULL;
          END IF;
        END IF;
        RETURN v_result;
      END;
      $function$
    $wrapper$;
    EXECUTE 'REVOKE ALL ON FUNCTION public.verify_admin_bin_with_attempt_tracking(text) FROM PUBLIC, anon, service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.verify_admin_bin_with_attempt_tracking(text) TO authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.verify_admin_bin_with_attempt_tracking__session_guarded_impl(text) FROM PUBLIC, anon, authenticated, service_role';
  END IF;

  IF to_regprocedure('public.verify_admin_bin(text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.verify_admin_bin(text) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
END;
$guard_bin_login_proof$;

-- BIN change/recovery RPCs accept only an active app session or a fresh,
-- session-bound password reauthentication. The private implementations still
-- verify and consume their purpose-specific proof tokens.
DO $guard_bin_reauth_rpcs$
DECLARE
  v_definition text;
  v_impl text;
BEGIN
  IF to_regprocedure('public.issue_bin_change_proof(text)') IS NOT NULL THEN
    v_definition := pg_get_functiondef('public.issue_bin_change_proof(text)'::regprocedure);
    IF position('issue_bin_change_proof__reauth_impl' IN v_definition) = 0 THEN
      v_impl := replace(
        v_definition,
        'FUNCTION public.issue_bin_change_proof(',
        'FUNCTION public.issue_bin_change_proof__reauth_impl('
      );
      v_impl := replace(v_impl, 'PERFORM public.assert_my_account_session_active();', '');
      EXECUTE v_impl;
    END IF;
    EXECUTE $wrapper$
      CREATE OR REPLACE FUNCTION public.issue_bin_change_proof(p_current_bin text)
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $function$
      BEGIN
        IF public.is_my_account_session_active() IS TRUE THEN
          PERFORM public.assert_my_account_session_active();
        ELSE
          PERFORM public.assert_my_fresh_admin_reauth_session();
        END IF;
        RETURN public.issue_bin_change_proof__reauth_impl(p_current_bin);
      END;
      $function$
    $wrapper$;
    EXECUTE 'REVOKE ALL ON FUNCTION public.issue_bin_change_proof(text) FROM PUBLIC, anon, service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.issue_bin_change_proof(text) TO authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.issue_bin_change_proof__reauth_impl(text) FROM PUBLIC, anon, authenticated, service_role';
  END IF;

  IF to_regprocedure('public.change_admin_bin(text,text)') IS NOT NULL THEN
    v_definition := pg_get_functiondef('public.change_admin_bin(text,text)'::regprocedure);
    IF position('change_admin_bin__reauth_impl' IN v_definition) = 0 THEN
      v_impl := replace(
        v_definition,
        'FUNCTION public.change_admin_bin(',
        'FUNCTION public.change_admin_bin__reauth_impl('
      );
      v_impl := replace(v_impl, 'PERFORM public.assert_my_account_session_active();', '');
      EXECUTE v_impl;
    END IF;
    EXECUTE $wrapper$
      CREATE OR REPLACE FUNCTION public.change_admin_bin(p_new_bin text, p_change_proof text)
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $function$
      BEGIN
        IF public.is_my_account_session_active() IS TRUE THEN
          PERFORM public.assert_my_account_session_active();
        ELSE
          PERFORM public.assert_my_fresh_admin_reauth_session();
        END IF;
        RETURN public.change_admin_bin__reauth_impl(p_new_bin, p_change_proof);
      END;
      $function$
    $wrapper$;
    EXECUTE 'REVOKE ALL ON FUNCTION public.change_admin_bin(text,text) FROM PUBLIC, anon, service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.change_admin_bin(text,text) TO authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.change_admin_bin__reauth_impl(text,text) FROM PUBLIC, anon, authenticated, service_role';
  END IF;

  IF to_regprocedure('public.issue_bin_recovery_proof(text)') IS NOT NULL
     AND to_regprocedure('public.issue_bin_recovery_proof__session_guarded_impl(text)') IS NOT NULL THEN
    EXECUTE $wrapper$
      CREATE OR REPLACE FUNCTION public.issue_bin_recovery_proof(p_current_password text)
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $function$
      BEGIN
        IF public.is_my_account_session_active() IS TRUE THEN
          PERFORM public.assert_my_account_session_active();
        ELSE
          PERFORM public.assert_my_fresh_admin_reauth_session();
        END IF;
        RETURN public.issue_bin_recovery_proof__session_guarded_impl(p_current_password);
      END;
      $function$
    $wrapper$;
    EXECUTE 'REVOKE ALL ON FUNCTION public.issue_bin_recovery_proof(text) FROM PUBLIC, anon, service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.issue_bin_recovery_proof(text) TO authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.issue_bin_recovery_proof__session_guarded_impl(text) FROM PUBLIC, anon, authenticated, service_role';
  END IF;

  IF to_regprocedure('public.recover_and_reset_admin_bin(text,text)') IS NOT NULL
     AND to_regprocedure('public.recover_and_reset_admin_bin__session_guarded_impl(text,text)') IS NOT NULL THEN
    EXECUTE $wrapper$
      CREATE OR REPLACE FUNCTION public.recover_and_reset_admin_bin(p_new_bin text, p_recovery_proof text)
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $function$
      BEGIN
        IF public.is_my_account_session_active() IS TRUE THEN
          PERFORM public.assert_my_account_session_active();
        ELSE
          PERFORM public.assert_my_fresh_admin_reauth_session();
        END IF;
        RETURN public.recover_and_reset_admin_bin__session_guarded_impl(p_new_bin, p_recovery_proof);
      END;
      $function$
    $wrapper$;
    EXECUTE 'REVOKE ALL ON FUNCTION public.recover_and_reset_admin_bin(text,text) FROM PUBLIC, anon, service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.recover_and_reset_admin_bin(text,text) TO authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.recover_and_reset_admin_bin__session_guarded_impl(text,text) FROM PUBLIC, anon, authenticated, service_role';
  END IF;

  IF to_regprocedure('public.rpc_update_admin_bin(uuid,text,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.rpc_update_admin_bin(uuid,text,text) FROM PUBLIC, anon, service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.rpc_update_admin_bin(uuid,text,text) TO authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.rpc_update_admin_bin__session_guarded_impl(uuid,text,text) FROM PUBLIC, anon, authenticated, service_role';
  END IF;

  IF to_regprocedure('public.set_admin_bin(text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.set_admin_bin(text) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
  IF to_regprocedure('public.set_admin_bin(text,uuid)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.set_admin_bin(text,uuid) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
END;
$guard_bin_reauth_rpcs$;

-- The legacy boolean verifier had no attempt tracking. It is never a supported
-- browser or server entry point; only the attempt-tracked RPC remains callable.
DO $revoke_legacy_bin_paths$
BEGIN
  IF to_regprocedure('public.verify_admin_bin(text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.verify_admin_bin(text) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
  IF to_regprocedure('public.verify_admin_bin__session_guarded_impl(text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.verify_admin_bin__session_guarded_impl(text) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
END;
$revoke_legacy_bin_paths$;

DO $revoke_bin_service_role$
BEGIN
  IF to_regprocedure('public.change_admin_bin(text,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.change_admin_bin(text,text) FROM service_role';
  END IF;
  IF to_regprocedure('public.issue_bin_change_proof(text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.issue_bin_change_proof(text) FROM service_role';
  END IF;
  IF to_regprocedure('public.issue_bin_recovery_proof(text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.issue_bin_recovery_proof(text) FROM service_role';
  END IF;
  IF to_regprocedure('public.recover_and_reset_admin_bin(text,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.recover_and_reset_admin_bin(text,text) FROM service_role';
  END IF;
END;
$revoke_bin_service_role$;

NOTIFY pgrst, 'reload schema';
COMMIT;
