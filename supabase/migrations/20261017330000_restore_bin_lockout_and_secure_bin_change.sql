-- Restore the server-authoritative BIN attempt counter and prevent direct BIN reset
-- through legacy RPCs. BIN change requires a password re-authentication plus the current
-- BIN, followed by a short-lived single-use proof bound to the authenticated admin.

CREATE OR REPLACE FUNCTION public.verify_admin_bin_with_attempt_tracking__session_guarded_impl(
  p_bin text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin_id uuid;
  v_bin_hash text;
  v_is_active boolean;
  v_failed_attempts integer := 0;
  v_status text := 'ACTIVE';
  v_is_correct boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object(
      'success', false, 'status', 'UNAUTHENTICATED', 'is_locked', false,
      'remaining_attempts', 0, 'failed_attempts', 0, 'error', 'Authentication required'
    );
  END IF;

  SELECT a.id, a.bin_hash, a.is_active,
         COALESCE(a.bin_failed_attempts, 0),
         COALESCE(a.bin_status, 'ACTIVE')
    INTO v_admin_id, v_bin_hash, v_is_active, v_failed_attempts, v_status
  FROM public.admins AS a
  WHERE a.auth_user_id = auth.uid()
  FOR UPDATE;

  IF NOT FOUND OR v_is_active IS NOT TRUE OR v_bin_hash IS NULL THEN
    RETURN jsonb_build_object(
      'success', false, 'status', 'INACTIVE', 'is_locked', false,
      'remaining_attempts', 0, 'failed_attempts', COALESCE(v_failed_attempts, 0),
      'error', 'Active admin record or BIN not found'
    );
  END IF;

  IF v_status = 'LOCKED' OR v_failed_attempts >= 3 THEN
    UPDATE public.admins
    SET bin_status = 'LOCKED',
        bin_locked_at = COALESCE(bin_locked_at, now()),
        bin_failed_attempts = GREATEST(COALESCE(bin_failed_attempts, 0), 3)
    WHERE id = v_admin_id;

    RETURN jsonb_build_object(
      'success', false, 'status', 'LOCKED', 'is_locked', true,
      'remaining_attempts', 0, 'failed_attempts', GREATEST(v_failed_attempts, 3),
      'error', 'BIN_LOCKED_FROZEN'
    );
  END IF;

  IF p_bin IS NOT NULL
     AND length(trim(p_bin)) >= 4
     AND trim(p_bin) ~ '^[0-9]{4,}$' THEN
    v_is_correct := crypt(trim(p_bin), v_bin_hash) = v_bin_hash;
  END IF;

  IF v_is_correct THEN
    UPDATE public.admins
    SET bin_failed_attempts = 0,
        bin_status = 'ACTIVE',
        bin_locked_at = NULL,
        updated_at = now()
    WHERE id = v_admin_id;

    RETURN jsonb_build_object(
      'success', true, 'status', 'ACTIVE', 'is_locked', false,
      'remaining_attempts', 3, 'failed_attempts', 0
    );
  END IF;

  v_failed_attempts := v_failed_attempts + 1;

  IF v_failed_attempts >= 3 THEN
    UPDATE public.admins
    SET bin_failed_attempts = v_failed_attempts,
        bin_status = 'LOCKED',
        bin_locked_at = COALESCE(bin_locked_at, now()),
        updated_at = now()
    WHERE id = v_admin_id;

    RETURN jsonb_build_object(
      'success', false, 'status', 'LOCKED', 'is_locked', true,
      'remaining_attempts', 0, 'failed_attempts', v_failed_attempts,
      'error', 'BIN_LOCKED_FROZEN'
    );
  END IF;

  UPDATE public.admins
  SET bin_failed_attempts = v_failed_attempts,
      bin_status = 'ACTIVE',
      updated_at = now()
  WHERE id = v_admin_id;

  RETURN jsonb_build_object(
    'success', false, 'status', 'ACTIVE', 'is_locked', false,
    'remaining_attempts', 3 - v_failed_attempts,
    'failed_attempts', v_failed_attempts,
    'error', 'WRONG_BIN'
  );
END;
$function$;

-- Both browser-facing verification contracts use the same atomic lockout implementation.
CREATE OR REPLACE FUNCTION public.verify_admin_bin_with_attempt_tracking(p_bin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.assert_my_account_session_active();
  RETURN public.verify_admin_bin_with_attempt_tracking__session_guarded_impl(p_bin);
END;
$function$;

CREATE OR REPLACE FUNCTION public.verify_admin_bin(p_bin text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public.assert_my_account_session_active();
  v_result := public.verify_admin_bin_with_attempt_tracking__session_guarded_impl(p_bin);
  RETURN COALESCE((v_result ->> 'success')::boolean, false);
END;
$function$;

REVOKE ALL ON FUNCTION public.verify_admin_bin_with_attempt_tracking__session_guarded_impl(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.verify_admin_bin__session_guarded_impl(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.verify_admin_bin_with_attempt_tracking(text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_admin_bin_with_attempt_tracking(text)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.verify_admin_bin(text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_admin_bin(text)
  TO authenticated, service_role;

-- Issue a BIN_CHANGE proof only after the current password was re-authenticated
-- and the current BIN was successfully verified. The proof is random, short-lived,
-- single-use, purpose-bound, and tied to this Auth user.
CREATE OR REPLACE FUNCTION public.issue_bin_change_proof(p_current_bin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin_id uuid;
  v_bin_result jsonb;
  v_token text;
  v_token_hash text;
  v_expires_at timestamptz;
  v_session_id uuid;
BEGIN
  PERFORM public.assert_my_account_session_active();

  v_session_id := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  IF v_session_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM auth.sessions AS s
    WHERE s.id = v_session_id
      AND s.user_id = auth.uid()
      AND s.created_at >= now() - interval '2 minutes'
      AND (s.not_after IS NULL OR s.not_after > now())
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'RECENT_REAUTH_REQUIRED: Sign in again before changing the BIN'
    );
  END IF;

  v_bin_result := public.verify_admin_bin_with_attempt_tracking__session_guarded_impl(p_current_bin);
  IF COALESCE((v_bin_result ->> 'success')::boolean, false) IS NOT TRUE THEN
    RETURN v_bin_result || jsonb_build_object('proof_token', NULL);
  END IF;

  SELECT id INTO v_admin_id
  FROM public.admins
  WHERE auth_user_id = auth.uid() AND is_active IS TRUE;

  IF v_admin_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Active admin record not found');
  END IF;

  UPDATE public.admin_bin_recovery_proofs
  SET is_used = true, used_at = now()
  WHERE auth_user_id = auth.uid()
    AND purpose = 'BIN_CHANGE'
    AND is_used IS false;

  v_token := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(digest(v_token, 'sha256'), 'hex');
  v_expires_at := now() + interval '2 minutes';

  INSERT INTO public.admin_bin_recovery_proofs (
    admin_id, auth_user_id, proof_token_hash, purpose, issued_at, expires_at, is_used
  ) VALUES (
    v_admin_id, auth.uid(), v_token_hash, 'BIN_CHANGE', now(), v_expires_at, false
  );

  RETURN jsonb_build_object(
    'success', true, 'proof_token', v_token,
    'expires_in_seconds', 120, 'purpose', 'BIN_CHANGE'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.change_admin_bin(
  p_new_bin text,
  p_change_proof text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin_id uuid;
  v_is_active boolean;
  v_bin_status text;
  v_failed_attempts integer;
  v_proof_id uuid;
  v_proof_hash text;
  v_new_hash text;
BEGIN
  PERFORM public.assert_my_account_session_active();

  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Authentication required');
  END IF;

  IF p_new_bin IS NULL OR length(trim(p_new_bin)) < 4
     OR trim(p_new_bin) !~ '^[0-9]{4,}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Valid numeric BIN of at least 4 digits is required');
  END IF;

  IF p_change_proof IS NULL OR length(trim(p_change_proof)) < 32 THEN
    RETURN jsonb_build_object('success', false, 'error', 'PROOF_REQUIRED: Verify the current password and BIN first');
  END IF;

  SELECT id, is_active, COALESCE(bin_status, 'ACTIVE'), COALESCE(bin_failed_attempts, 0)
    INTO v_admin_id, v_is_active, v_bin_status, v_failed_attempts
  FROM public.admins
  WHERE auth_user_id = auth.uid()
  FOR UPDATE;

  IF NOT FOUND OR v_is_active IS NOT TRUE THEN
    RETURN jsonb_build_object('success', false, 'error', 'Active admin record not found');
  END IF;

  IF v_bin_status = 'LOCKED' OR v_failed_attempts >= 3 THEN
    RETURN jsonb_build_object('success', false, 'error', 'RECOVERY_REQUIRED: Use the locked-account recovery flow');
  END IF;

  v_proof_hash := encode(digest(trim(p_change_proof), 'sha256'), 'hex');

  SELECT id INTO v_proof_id
  FROM public.admin_bin_recovery_proofs
  WHERE admin_id = v_admin_id
    AND auth_user_id = auth.uid()
    AND proof_token_hash = v_proof_hash
    AND purpose = 'BIN_CHANGE'
    AND is_used IS false
    AND expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_OR_EXPIRED_PROOF: BIN change proof is invalid or expired');
  END IF;

  UPDATE public.admin_bin_recovery_proofs
  SET is_used = true, used_at = now()
  WHERE id = v_proof_id;

  v_new_hash := crypt(trim(p_new_bin), gen_salt('bf', 10));

  UPDATE public.admins
  SET bin_hash = v_new_hash,
      bin_failed_attempts = 0,
      bin_status = 'ACTIVE',
      bin_locked_at = NULL,
      updated_at = now(),
      version = version + 1
  WHERE id = v_admin_id;

  INSERT INTO public.admin_audit_logs(actor_admin_id, action, target_admin_id, metadata)
  VALUES (
    v_admin_id,
    'ADMIN_BIN_SELF_CHANGE',
    v_admin_id,
    jsonb_build_object('timestamp', now(), 'proofPurpose', 'BIN_CHANGE')
  );

  RETURN jsonb_build_object('success', true, 'status', 'ACTIVE');
END;
$function$;

-- The old setters could replace a BIN with only an active Auth session. The
-- current client now uses change_admin_bin with a proof; retire the legacy RPCs.
REVOKE ALL ON FUNCTION public.set_admin_bin(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_admin_bin(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_admin_bin__session_guarded_impl(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_admin_bin__session_guarded_impl(text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.issue_bin_change_proof(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_bin_change_proof(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.change_admin_bin(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_admin_bin(text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
