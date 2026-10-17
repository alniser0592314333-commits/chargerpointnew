-- Bind BIN-recovery proofs to the exact freshly re-authenticated Auth session.
-- Lock the admin row before proof rows in both functions to serialize issuance/redeem
-- and avoid lock-order inversion with the proof-gated self-service BIN-change path.
CREATE OR REPLACE FUNCTION public.issue_bin_recovery_proof__session_guarded_impl(
  p_current_password text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $function$
DECLARE
  v_admin_id uuid;
  v_is_active boolean;
  v_bin_status varchar(20);
  v_failed_attempts integer;
  v_encrypted_password text;
  v_token text;
  v_token_hash text;
  v_expires_at timestamptz;
  v_session_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Authentication required');
  END IF;

  IF p_current_password IS NULL OR length(p_current_password) < 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Current password is required');
  END IF;

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
      'error', 'RECENT_REAUTH_REQUIRED: Sign in again before recovering the BIN'
    );
  END IF;

  SELECT a.id, a.is_active, COALESCE(a.bin_status, 'ACTIVE'),
         COALESCE(a.bin_failed_attempts, 0)
    INTO v_admin_id, v_is_active, v_bin_status, v_failed_attempts
  FROM public.admins AS a
  WHERE a.auth_user_id = auth.uid()
  FOR UPDATE;

  IF NOT FOUND OR v_is_active IS NOT TRUE THEN
    RETURN jsonb_build_object('success', false, 'error', 'Active admin profile not found');
  END IF;

  IF v_bin_status <> 'LOCKED' AND v_failed_attempts < 3 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'RECOVERY_NOT_PERMITTED: BIN recovery is only permitted when account is locked after 3 failed attempts'
    );
  END IF;

  SELECT u.encrypted_password INTO v_encrypted_password
  FROM auth.users AS u
  WHERE u.id = auth.uid();

  IF NOT FOUND OR v_encrypted_password IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'User credentials not found');
  END IF;

  IF public.crypt(p_current_password, v_encrypted_password) IS DISTINCT FROM v_encrypted_password THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_PASSWORD');
  END IF;

  UPDATE public.admin_bin_recovery_proofs
  SET is_used = true, used_at = now()
  WHERE auth_user_id = auth.uid()
    AND purpose = 'BIN_RECOVERY'
    AND is_used IS false;

  v_token := encode(public.gen_random_bytes(32), 'hex');
  v_token_hash := encode(public.digest(v_token, 'sha256'), 'hex');
  v_expires_at := now() + interval '2 minutes';

  INSERT INTO public.admin_bin_recovery_proofs (
    admin_id, auth_user_id, auth_session_id, proof_token_hash,
    purpose, issued_at, expires_at, is_used
  ) VALUES (
    v_admin_id, auth.uid(), v_session_id, v_token_hash,
    'BIN_RECOVERY', now(), v_expires_at, false
  );

  RETURN jsonb_build_object(
    'success', true,
    'proof_token', v_token,
    'expires_in_seconds', 120,
    'purpose', 'BIN_RECOVERY'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.recover_and_reset_admin_bin__session_guarded_impl(
  p_new_bin text,
  p_recovery_proof text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $function$
DECLARE
  v_admin_id uuid;
  v_is_active boolean;
  v_bin_status varchar(20);
  v_failed_attempts integer;
  v_proof_id uuid;
  v_proof_token_hash text;
  v_new_bin_hash varchar(255);
  v_session_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Authentication required');
  END IF;

  IF p_recovery_proof IS NULL OR length(trim(p_recovery_proof)) < 16 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'PROOF_REQUIRED: Valid recovery authorization proof is required to change BIN'
    );
  END IF;

  IF p_new_bin IS NULL OR length(trim(p_new_bin)) < 4
     OR trim(p_new_bin) !~ '^[0-9]{4,}$' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Valid numeric BIN of at least 4 digits is required'
    );
  END IF;

  v_session_id := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  IF v_session_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM auth.sessions AS s
    WHERE s.id = v_session_id
      AND s.user_id = auth.uid()
      AND (s.not_after IS NULL OR s.not_after > now())
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'RECENT_REAUTH_REQUIRED: Recovery proof must be redeemed in its active issuing session'
    );
  END IF;

  -- Lock admin first, matching proof issuance and normal BIN change lock order.
  SELECT a.id, a.is_active, COALESCE(a.bin_status, 'ACTIVE'),
         COALESCE(a.bin_failed_attempts, 0)
    INTO v_admin_id, v_is_active, v_bin_status, v_failed_attempts
  FROM public.admins AS a
  WHERE a.auth_user_id = auth.uid()
  FOR UPDATE;

  IF NOT FOUND OR v_is_active IS NOT TRUE THEN
    RETURN jsonb_build_object('success', false, 'error', 'Active admin profile not found');
  END IF;

  v_proof_token_hash := encode(public.digest(trim(p_recovery_proof), 'sha256'), 'hex');

  SELECT p.id
    INTO v_proof_id
  FROM public.admin_bin_recovery_proofs AS p
  WHERE p.admin_id = v_admin_id
    AND p.auth_user_id = auth.uid()
    AND p.auth_session_id = v_session_id
    AND p.proof_token_hash = v_proof_token_hash
    AND p.purpose = 'BIN_RECOVERY'
    AND p.is_used IS false
    AND p.expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'INVALID_OR_EXPIRED_PROOF: Recovery proof is invalid, expired, or already used'
    );
  END IF;

  IF v_bin_status <> 'LOCKED' AND v_failed_attempts < 3 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'RECOVERY_NOT_PERMITTED: BIN recovery is only allowed when account is in LOCKED state'
    );
  END IF;

  v_new_bin_hash := public.crypt(trim(p_new_bin), public.gen_salt('bf', 10));

  UPDATE public.admin_bin_recovery_proofs
  SET is_used = true, used_at = now()
  WHERE id = v_proof_id;

  UPDATE public.admins
  SET bin_hash = v_new_bin_hash,
      bin_failed_attempts = 0,
      bin_status = 'ACTIVE',
      bin_locked_at = NULL,
      updated_at = now(),
      version = version + 1
  WHERE id = v_admin_id;

  INSERT INTO public.admin_audit_logs(actor_admin_id, action, target_admin_id, metadata)
  VALUES (
    v_admin_id,
    'ADMIN_BIN_RECOVERY',
    v_admin_id,
    jsonb_build_object('timestamp', now(), 'proofPurpose', 'BIN_RECOVERY')
  );

  RETURN jsonb_build_object('success', true, 'status', 'ACTIVE', 'message', 'BIN_RESET_SUCCESS');
END;
$function$;

NOTIFY pgrst, 'reload schema';
