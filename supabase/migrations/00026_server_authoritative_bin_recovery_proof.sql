/**
 * Supabase Migration: 00026_server_authoritative_bin_recovery_proof.sql
 * Implements Server-Authoritative Ephemeral Cryptographic Recovery Proofs for Super Admin BIN Recovery.
 * Enforces Server-Side Lock Status (0, 1, 2 failures -> Blocked; 3 failures / LOCKED -> Permitted).
 * Closes Direct JWT RPC Bypass GAP.
 */

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Table for Ephemeral Single-Use Recovery Proofs
CREATE TABLE IF NOT EXISTS public.admin_bin_recovery_proofs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID NOT NULL REFERENCES public.admins(id) ON DELETE CASCADE,
    auth_user_id UUID NOT NULL,
    proof_token_hash VARCHAR(64) NOT NULL,
    purpose VARCHAR(50) NOT NULL DEFAULT 'BIN_RECOVERY',
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '2 minutes'),
    is_used BOOLEAN NOT NULL DEFAULT FALSE,
    used_at TIMESTAMPTZ DEFAULT NULL
);

-- Index for fast lookup & verification
CREATE INDEX IF NOT EXISTS idx_recovery_proofs_lookup 
ON public.admin_bin_recovery_proofs(auth_user_id, proof_token_hash, purpose, is_used, expires_at);

-- 2. RLS Security: No direct client access to proof storage
ALTER TABLE public.admin_bin_recovery_proofs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_bin_recovery_proofs FROM PUBLIC, anon, authenticated;

-- 3. Drop obsolete single-argument recovery overload
DROP FUNCTION IF EXISTS public.recover_and_reset_admin_bin(TEXT);

-- 4. RPC to Issue Server-Authoritative Recovery Proof after Password Verification
CREATE OR REPLACE FUNCTION public.issue_bin_recovery_proof(
    p_current_password TEXT
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, extensions, auth, pg_temp
LANGUAGE plpgsql
AS $FUNC$
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
    -- 1. Caller MUST be authenticated
    IF auth.uid() IS NULL THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'Authentication required'
        );
    END IF;

    -- 2. Input validation
    IF p_current_password IS NULL OR length(p_current_password) < 1 THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'Current password is required'
        );
    END IF;

    -- 3. Verify admin profile exists, is active, AND is in LOCKED state / >= 3 failed attempts
    SELECT id, is_active, COALESCE(bin_status, 'ACTIVE'), COALESCE(bin_failed_attempts, 0)
    INTO v_admin_id, v_is_active, v_bin_status, v_failed_attempts
    FROM public.admins
    WHERE auth_user_id = auth.uid();

    IF NOT FOUND OR v_is_active IS NOT TRUE THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'Active admin profile not found'
        );
    END IF;

    -- Server-Authoritative Gate: Recovery is ONLY permitted when account is LOCKED (3 failures reached)
    IF v_bin_status != 'LOCKED' AND v_failed_attempts < 3 THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'RECOVERY_NOT_PERMITTED: BIN recovery is only permitted when account is locked after 3 failed attempts'
        );
    END IF;

    -- 4. Verify password against auth.users
    SELECT encrypted_password
    INTO v_encrypted_password
    FROM auth.users
    WHERE id = auth.uid();

    IF NOT FOUND OR v_encrypted_password IS NULL THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'User credentials not found'
        );
    END IF;

    -- Cryptographic password verification (bcrypt)
    IF extensions.crypt(p_current_password, v_encrypted_password) != v_encrypted_password THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'INVALID_PASSWORD'
        );
    END IF;

    -- 5. Invalidate any prior unused recovery proofs for this user
    UPDATE public.admin_bin_recovery_proofs
    SET is_used = TRUE,
        used_at = NOW()
    WHERE auth_user_id = auth.uid() AND is_used IS FALSE;

    -- 6. Generate 256-bit cryptographically secure token and SHA-256 hash
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    v_token_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');
    v_expires_at := NOW() + INTERVAL '2 minutes';

    INSERT INTO public.admin_bin_recovery_proofs (
        admin_id,
        auth_user_id,
        proof_token_hash,
        purpose,
        issued_at,
        expires_at,
        is_used
    ) VALUES (
        v_admin_id,
        auth.uid(),
        v_token_hash,
        'BIN_RECOVERY',
        NOW(),
        v_expires_at,
        FALSE
    );

    RETURN json_build_object(
        'success', TRUE,
        'proof_token', v_token,
        'expires_in_seconds', 120,
        'purpose', 'BIN_RECOVERY'
    );
END;
$FUNC$;

REVOKE EXECUTE ON FUNCTION public.issue_bin_recovery_proof(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_bin_recovery_proof(TEXT) TO authenticated;


-- 5. Hardened recover_and_reset_admin_bin requiring Valid Proof Token & Locked State
CREATE OR REPLACE FUNCTION public.recover_and_reset_admin_bin(
    p_new_bin TEXT,
    p_recovery_proof TEXT
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, extensions, auth, pg_temp
LANGUAGE plpgsql
AS $FUNC$
DECLARE
    v_admin_id UUID;
    v_is_active BOOLEAN;
    v_bin_status VARCHAR(20);
    v_failed_attempts INT;
    v_proof_id UUID;
    v_proof_token_hash TEXT;
    v_new_bin_hash VARCHAR(255);
BEGIN
    -- 1. Caller MUST be authenticated via Supabase Auth
    IF auth.uid() IS NULL THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'Authentication required'
        );
    END IF;

    -- 2. Proof Token MUST be supplied (JWT alone is NOT sufficient)
    IF p_recovery_proof IS NULL OR length(trim(p_recovery_proof)) < 16 THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'PROOF_REQUIRED: Valid recovery authorization proof is required to change BIN'
        );
    END IF;

    -- 3. Format validation for new BIN (minimum 4 numeric digits)
    IF p_new_bin IS NULL OR length(trim(p_new_bin)) < 4 OR NOT (trim(p_new_bin) ~ '^\d{4,}$') THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'Valid numeric BIN of at least 4 digits is required'
        );
    END IF;

    -- 4. Verify and Lock Proof Record (Single-use, Purpose-bound, User-bound, Non-expired)
    v_proof_token_hash := encode(extensions.digest(trim(p_recovery_proof), 'sha256'), 'hex');

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

    -- 5. Mark proof as used immediately (Replay protection)
    UPDATE public.admin_bin_recovery_proofs
    SET is_used = TRUE,
        used_at = NOW()
    WHERE id = v_proof_id;

    -- 6. Verify active admin row for caller AND confirm LOCKED state
    SELECT id, is_active, COALESCE(bin_status, 'ACTIVE'), COALESCE(bin_failed_attempts, 0)
    INTO v_admin_id, v_is_active, v_bin_status, v_failed_attempts
    FROM public.admins
    WHERE id = v_admin_id AND auth_user_id = auth.uid()
    FOR UPDATE;

    IF NOT FOUND OR v_is_active IS NOT TRUE THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'Active admin profile not found'
        );
    END IF;

    IF v_bin_status != 'LOCKED' AND v_failed_attempts < 3 THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'RECOVERY_NOT_PERMITTED: BIN recovery is only allowed when account is in LOCKED state'
        );
    END IF;

    -- 7. Hash new BIN securely with bcrypt
    v_new_bin_hash := extensions.crypt(trim(p_new_bin), extensions.gen_salt('bf', 10));

    -- 8. Atomically update bin_hash, reset failed attempts, and unlock status
    UPDATE public.admins
    SET bin_hash = v_new_bin_hash,
        bin_failed_attempts = 0,
        bin_status = 'ACTIVE',
        bin_locked_at = NULL,
        updated_at = NOW(),
        version = version + 1
    WHERE id = v_admin_id;

    RETURN json_build_object(
        'success', TRUE,
        'status', 'ACTIVE',
        'message', 'BIN_RESET_SUCCESS'
    );
END;
$FUNC$;

REVOKE EXECUTE ON FUNCTION public.recover_and_reset_admin_bin(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recover_and_reset_admin_bin(TEXT, TEXT) TO authenticated;
