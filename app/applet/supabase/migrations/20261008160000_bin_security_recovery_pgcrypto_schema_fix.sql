-- Correct all remaining BIN security/recovery functions to use pgcrypto functions
-- from the actual public schema, preserving existing behavior and defaults.

CREATE OR REPLACE FUNCTION public.issue_bin_recovery_proof(p_current_password TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
    v_admin_id UUID;
    v_is_active BOOLEAN;
    v_bin_status VARCHAR(20);
    v_failed_attempts INT;
    v_encrypted_password TEXT;
    v_token TEXT;
    v_token_hash TEXT;
    v_expires_at TIMESTAMPTZ;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN json_build_object('success', FALSE, 'error', 'Authentication required');
    END IF;

    IF p_current_password IS NULL OR length(p_current_password) < 1 THEN
        RETURN json_build_object('success', FALSE, 'error', 'Current password is required');
    END IF;

    SELECT id, is_active, COALESCE(bin_status, 'ACTIVE'), COALESCE(bin_failed_attempts, 0)
    INTO v_admin_id, v_is_active, v_bin_status, v_failed_attempts
    FROM public.admins
    WHERE auth_user_id = auth.uid();

    IF NOT FOUND OR v_is_active IS NOT TRUE THEN
        RETURN json_build_object('success', FALSE, 'error', 'Active admin profile not found');
    END IF;

    IF v_bin_status != 'LOCKED' AND v_failed_attempts < 3 THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'RECOVERY_NOT_PERMITTED: BIN recovery is only permitted when account is locked after 3 failed attempts'
        );
    END IF;

    SELECT encrypted_password INTO v_encrypted_password
    FROM auth.users
    WHERE id = auth.uid();

    IF NOT FOUND OR v_encrypted_password IS NULL THEN
        RETURN json_build_object('success', FALSE, 'error', 'User credentials not found');
    END IF;

    IF crypt(p_current_password::text, v_encrypted_password::text) <> v_encrypted_password::text THEN
        RETURN json_build_object('success', FALSE, 'error', 'INVALID_PASSWORD');
    END IF;

    UPDATE public.admin_bin_recovery_proofs
    SET is_used = TRUE, used_at = NOW()
    WHERE auth_user_id = auth.uid() AND is_used IS FALSE;

    v_token := encode(gen_random_bytes(32), 'hex');
    v_token_hash := encode(digest(v_token::text, 'sha256'), 'hex');
    v_expires_at := NOW() + INTERVAL '2 minutes';

    INSERT INTO public.admin_bin_recovery_proofs (
        admin_id, auth_user_id, proof_token_hash, purpose, issued_at, expires_at, is_used
    ) VALUES (
        v_admin_id, auth.uid(), v_token_hash, 'BIN_RECOVERY', NOW(), v_expires_at, FALSE
    );

    RETURN json_build_object(
        'success', TRUE,
        'proof_token', v_token,
        'expires_in_seconds', 120,
        'purpose', 'BIN_RECOVERY'
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.recover_and_reset_admin_bin(
    p_new_bin TEXT,
    p_recovery_proof TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
    v_admin_id UUID;
    v_is_active BOOLEAN;
    v_bin_status VARCHAR(20);
    v_failed_attempts INT;
    v_proof_id UUID;
    v_proof_token_hash TEXT;
    v_new_bin_hash VARCHAR(255);
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN json_build_object('success', FALSE, 'error', 'Authentication required');
    END IF;

    IF p_recovery_proof IS NULL OR length(trim(p_recovery_proof)) < 16 THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'PROOF_REQUIRED: Valid recovery authorization proof is required to change BIN'
        );
    END IF;

    IF p_new_bin IS NULL OR length(trim(p_new_bin)) < 4 OR NOT (trim(p_new_bin) ~ '^[0-9]{4,}$') THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'Valid numeric BIN of at least 4 digits is required'
        );
    END IF;

    v_proof_token_hash := encode(digest(trim(p_recovery_proof)::text, 'sha256'), 'hex');

    SELECT id, admin_id
    INTO v_proof_id, v_admin_id
    FROM public.admin_bin_recovery_proofs
    WHERE auth_user_id = auth.uid()
      AND proof_token_hash = v_proof_token_hash
      AND purpose = 'BIN_RECOVERY'
      AND is_used IS FALSE
      AND expires_at > NOW()
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'INVALID_OR_EXPIRED_PROOF: Recovery proof is invalid, expired, or already used'
        );
    END IF;

    UPDATE public.admin_bin_recovery_proofs
    SET is_used = TRUE, used_at = NOW()
    WHERE id = v_proof_id;

    SELECT id, is_active, COALESCE(bin_status, 'ACTIVE'), COALESCE(bin_failed_attempts, 0)
    INTO v_admin_id, v_is_active, v_bin_status, v_failed_attempts
    FROM public.admins
    WHERE id = v_admin_id AND auth_user_id = auth.uid()
    FOR UPDATE;

    IF NOT FOUND OR v_is_active IS NOT TRUE THEN
        RETURN json_build_object('success', FALSE, 'error', 'Active admin profile not found');
    END IF;

    IF v_bin_status != 'LOCKED' AND v_failed_attempts < 3 THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'RECOVERY_NOT_PERMITTED: BIN recovery is only allowed when account is in LOCKED state'
        );
    END IF;

    v_new_bin_hash := crypt(trim(p_new_bin)::text, gen_salt('bf', 10));

    UPDATE public.admins
    SET bin_hash = v_new_bin_hash,
        bin_failed_attempts = 0,
        bin_status = 'ACTIVE',
        bin_locked_at = NULL,
        updated_at = NOW(),
        version = version + 1
    WHERE id = v_admin_id;

    RETURN json_build_object('success', TRUE, 'status', 'ACTIVE', 'message', 'BIN_RESET_SUCCESS');
END;
$$;

CREATE OR REPLACE FUNCTION public.set_admin_bin(
    p_bin TEXT,
    p_admin_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_admin_id UUID;
    v_caller_role VARCHAR(50);
    v_caller_active BOOLEAN;
    v_target_id UUID;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF p_bin IS NULL OR length(trim(p_bin)) < 4 OR NOT (trim(p_bin) ~ '^[0-9]{4,}$') THEN
        RAISE EXCEPTION 'BIN must be at least 4 numeric digits';
    END IF;

    SELECT id, role, is_active
    INTO v_caller_admin_id, v_caller_role, v_caller_active
    FROM public.admins
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    IF NOT FOUND OR v_caller_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Authenticated admin account is inactive or not found';
    END IF;

    IF p_admin_id IS NOT NULL AND p_admin_id != v_caller_admin_id THEN
        IF v_caller_role NOT IN ('SUPER_ADMIN', 'Super Admin') THEN
            RAISE EXCEPTION 'Unauthorized: Only Super Admin can update another admin BIN';
        END IF;

        SELECT id INTO v_target_id FROM public.admins WHERE id = p_admin_id;
        IF v_target_id IS NULL THEN
            RAISE EXCEPTION 'Target admin not found';
        END IF;
    ELSE
        v_target_id := v_caller_admin_id;
    END IF;

    UPDATE public.admins
    SET bin_hash = crypt(trim(p_bin)::text, gen_salt('bf', 10)),
        updated_at = NOW(),
        version = version + 1
    WHERE id = v_target_id;

    RETURN TRUE;
END;
$$;

NOTIFY pgrst, 'reload schema';
