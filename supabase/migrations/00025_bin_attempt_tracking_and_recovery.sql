/**
 * Supabase Migration: 00025_bin_attempt_tracking_and_recovery.sql
 * Implements Server-Authoritative 3-Attempt Tracking, Atomic Locking, and Password-Authenticated BIN Recovery.
 */

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Extend admins table with attempt tracking and lock status
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS bin_failed_attempts INT DEFAULT 0;
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS bin_locked_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS bin_status VARCHAR(20) DEFAULT 'ACTIVE';

-- 2. Server-Authoritative BIN Verification with Attempt Tracking & Atomic Locking
CREATE OR REPLACE FUNCTION public.verify_admin_bin_with_attempt_tracking(
    p_bin TEXT
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
LANGUAGE plpgsql
AS $FUNC$
DECLARE
    v_admin_id UUID;
    v_bin_hash VARCHAR(255);
    v_is_active BOOLEAN;
    v_failed_attempts INT;
    v_status VARCHAR(20);
    v_is_correct BOOLEAN := FALSE;
BEGIN
    -- 1. Caller MUST be authenticated via Supabase Auth
    IF auth.uid() IS NULL THEN
        RETURN json_build_object(
            'success', FALSE,
            'status', 'UNAUTHENTICATED',
            'is_locked', FALSE,
            'remaining_attempts', 0,
            'failed_attempts', 0,
            'error', 'Authentication required'
        );
    END IF;

    -- 2. Lock and retrieve admin record
    SELECT id, bin_hash, is_active, COALESCE(bin_failed_attempts, 0), COALESCE(bin_status, 'ACTIVE')
    INTO v_admin_id, v_bin_hash, v_is_active, v_failed_attempts, v_status
    FROM public.admins
    WHERE auth_user_id = auth.uid()
    FOR UPDATE;

    IF NOT FOUND OR v_is_active IS NOT TRUE OR v_bin_hash IS NULL THEN
        RETURN json_build_object(
            'success', FALSE,
            'status', 'INACTIVE',
            'is_locked', FALSE,
            'remaining_attempts', 0,
            'failed_attempts', v_failed_attempts,
            'error', 'Admin record not found or inactive'
        );
    END IF;

    -- 3. Check if account is already LOCKED
    IF v_status = 'LOCKED' OR v_failed_attempts >= 3 THEN
        UPDATE public.admins
        SET bin_status = 'LOCKED',
            bin_locked_at = COALESCE(bin_locked_at, NOW())
        WHERE id = v_admin_id;

        RETURN json_build_object(
            'success', FALSE,
            'status', 'LOCKED',
            'is_locked', TRUE,
            'remaining_attempts', 0,
            'failed_attempts', v_failed_attempts,
            'error', 'BIN_LOCKED_FROZEN'
        );
    END IF;

    -- 4. Check format and crypt match
    IF p_bin IS NOT NULL AND length(trim(p_bin)) >= 4 THEN
        IF extensions.crypt(trim(p_bin), v_bin_hash) = v_bin_hash THEN
            v_is_correct := TRUE;
        END IF;
    END IF;

    -- 5. Handle correct BIN
    IF v_is_correct IS TRUE THEN
        UPDATE public.admins
        SET bin_failed_attempts = 0,
            bin_status = 'ACTIVE',
            bin_locked_at = NULL,
            updated_at = NOW()
        WHERE id = v_admin_id;

        RETURN json_build_object(
            'success', TRUE,
            'status', 'ACTIVE',
            'is_locked', FALSE,
            'remaining_attempts', 3,
            'failed_attempts', 0
        );
    END IF;

    -- 6. Handle incorrect BIN -> Increment attempts atomically
    v_failed_attempts := v_failed_attempts + 1;
    IF v_failed_attempts >= 3 THEN
        v_status := 'LOCKED';
        UPDATE public.admins
        SET bin_failed_attempts = v_failed_attempts,
            bin_status = 'LOCKED',
            bin_locked_at = NOW(),
            updated_at = NOW()
        WHERE id = v_admin_id;

        RETURN json_build_object(
            'success', FALSE,
            'status', 'LOCKED',
            'is_locked', TRUE,
            'remaining_attempts', 0,
            'failed_attempts', v_failed_attempts,
            'error', 'BIN_LOCKED_FROZEN'
        );
    ELSE
        UPDATE public.admins
        SET bin_failed_attempts = v_failed_attempts,
            bin_status = 'ACTIVE',
            updated_at = NOW()
        WHERE id = v_admin_id;

        RETURN json_build_object(
            'success', FALSE,
            'status', 'ACTIVE',
            'is_locked', FALSE,
            'remaining_attempts', (3 - v_failed_attempts),
            'failed_attempts', v_failed_attempts,
            'error', 'WRONG_BIN'
        );
    END IF;
END;
$FUNC$;

REVOKE EXECUTE ON FUNCTION public.verify_admin_bin_with_attempt_tracking(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_admin_bin_with_attempt_tracking(TEXT) TO authenticated;


-- 3. Update public.verify_admin_bin to use attempt tracking & lock enforcement
CREATE OR REPLACE FUNCTION public.verify_admin_bin(p_bin TEXT)
RETURNS BOOLEAN
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
LANGUAGE plpgsql
AS $FUNC$
DECLARE
    v_res JSONB;
BEGIN
    v_res := public.verify_admin_bin_with_attempt_tracking(p_bin);
    IF (v_res->>'success')::BOOLEAN IS TRUE THEN
        RETURN TRUE;
    ELSE
        RETURN FALSE;
    END IF;
END;
$FUNC$;

REVOKE EXECUTE ON FUNCTION public.verify_admin_bin(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_admin_bin(TEXT) TO authenticated;


-- 4. Server-Authoritative Password-Authenticated Super Admin BIN Recovery RPC
CREATE OR REPLACE FUNCTION public.recover_and_reset_admin_bin(
    p_new_bin TEXT
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
LANGUAGE plpgsql
AS $FUNC$
DECLARE
    v_admin_id UUID;
    v_is_active BOOLEAN;
    v_new_bin_hash VARCHAR(255);
BEGIN
    -- 1. Caller MUST be authenticated via Supabase Auth
    IF auth.uid() IS NULL THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'Authentication required'
        );
    END IF;

    -- 2. Format validation (minimum 4 numeric digits)
    IF p_new_bin IS NULL OR length(trim(p_new_bin)) < 4 OR NOT (trim(p_new_bin) ~ '^\d{4,}$') THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'Valid numeric BIN of at least 4 digits is required'
        );
    END IF;

    -- 3. Verify active admin row for caller
    SELECT id, is_active
    INTO v_admin_id, v_is_active
    FROM public.admins
    WHERE auth_user_id = auth.uid();

    IF NOT FOUND OR v_is_active IS NOT TRUE THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'Active admin profile not found'
        );
    END IF;

    -- 4. Hash new BIN securely with bcrypt
    v_new_bin_hash := extensions.crypt(trim(p_new_bin), extensions.gen_salt('bf', 10));

    -- 5. Atomically update bin_hash, reset failed attempts, and unlock status
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

REVOKE EXECUTE ON FUNCTION public.recover_and_reset_admin_bin(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recover_and_reset_admin_bin(TEXT) TO authenticated;
