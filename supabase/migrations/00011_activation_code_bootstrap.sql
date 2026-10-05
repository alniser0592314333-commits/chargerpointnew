-- Migration 00011: Activation Code Architecture & Bootstrap Security Hardening

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Create public.activation_codes table
CREATE TABLE IF NOT EXISTS public.activation_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code_hash VARCHAR(255) NOT NULL,
    is_used BOOLEAN NOT NULL DEFAULT FALSE,
    used_at TIMESTAMPTZ NULL,
    used_by_auth_user_id UUID NULL REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS and revoke public access
ALTER TABLE public.activation_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.activation_codes FROM PUBLIC, anon, authenticated;

-- Partial unique index ensuring ONLY ONE unconsumed activation code exists at any time
CREATE UNIQUE INDEX IF NOT EXISTS idx_activation_codes_unconsumed 
ON public.activation_codes (is_used) WHERE is_used = FALSE;


-- 2. Create public.activation_code_attempts table for rate limiting
CREATE TABLE IF NOT EXISTS public.activation_code_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id UUID NULL,
    ip_address TEXT NULL,
    success BOOLEAN NOT NULL,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS and revoke public access
ALTER TABLE public.activation_code_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.activation_code_attempts FROM PUBLIC, anon, authenticated;

-- Index for fast rate limit queries
CREATE INDEX IF NOT EXISTS idx_activation_code_attempts_rate_limit 
ON public.activation_code_attempts (auth_user_id, attempted_at) 
WHERE success = FALSE;


-- 3. Update get_current_admin_profile() to not strictly require email confirmation
CREATE OR REPLACE FUNCTION public.get_current_admin_profile()
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $FUNC$
DECLARE
    v_admin RECORD;
    v_perms JSONB;
    v_email VARCHAR(255);
    v_email_confirmed TIMESTAMPTZ;
BEGIN
    -- 1. Unauthenticated caller check
    IF auth.uid() IS NULL THEN
        RETURN json_build_object(
            'authenticated', FALSE,
            'is_admin', FALSE
        );
    END IF;

    -- 2. Retrieve caller email and confirmed timestamp from auth.users
    SELECT email, email_confirmed_at 
    INTO v_email, v_email_confirmed 
    FROM auth.users 
    WHERE id = auth.uid();

    -- 3. Resolve admin identity row linked to auth.uid()
    SELECT id, auth_user_id, username, full_name, email, role, is_active
    INTO v_admin
    FROM admins
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    -- 4. Not an application admin
    IF NOT FOUND THEN
        RETURN json_build_object(
            'authenticated', TRUE,
            'is_admin', FALSE,
            'auth_user_id', auth.uid(),
            'email', v_email,
            'is_email_confirmed', (v_email_confirmed IS NOT NULL)
        );
    END IF;

    -- 5. Inactive admin account
    IF v_admin.is_active IS NOT TRUE THEN
        RETURN json_build_object(
            'authenticated', TRUE,
            'is_admin', TRUE,
            'is_active', FALSE,
            'admin_id', v_admin.id,
            'username', v_admin.username,
            'role', v_admin.role,
            'email', v_admin.email
        );
    END IF;

    -- 6. Active admin account: resolve effective permissions
    SELECT json_agg(permission) INTO v_perms
    FROM (
        SELECT permission FROM get_effective_permissions(v_admin.id)
    ) p;

    RETURN json_build_object(
        'authenticated', TRUE,
        'is_admin', TRUE,
        'is_active', TRUE,
        'is_email_confirmed', (v_email_confirmed IS NOT NULL),
        'admin_id', v_admin.id,
        'auth_user_id', v_admin.auth_user_id,
        'username', v_admin.username,
        'full_name', COALESCE(v_admin.full_name, v_admin.username),
        'email', COALESCE(v_admin.email, v_email),
        'role', v_admin.role,
        'permissions', COALESCE(v_perms, '[]'::jsonb)
    );
END;
$FUNC$;

REVOKE EXECUTE ON FUNCTION public.get_current_admin_profile() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_current_admin_profile() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_current_admin_profile() TO authenticated;


-- 4. Drop legacy 3-parameter bootstrap RPC
DROP FUNCTION IF EXISTS public.bootstrap_first_super_admin(TEXT, TEXT, TEXT);

-- 5. Create authoritative 4-parameter bootstrap RPC with Activation Code & Rate Limiting
CREATE OR REPLACE FUNCTION public.bootstrap_first_super_admin(
    p_username TEXT,
    p_full_name TEXT,
    p_bin TEXT,
    p_activation_code TEXT
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $FUNC$
DECLARE
    v_email VARCHAR(255);
    v_bin_hash VARCHAR(255);
    v_new_admin_id UUID;
    v_target_owner_email CONSTANT TEXT := 'al.niser.0592314333@gmail.com';
    v_failed_attempts INTEGER;
    v_active_code RECORD;
BEGIN
    -- 1. Caller MUST be authenticated via Supabase Auth
    IF auth.uid() IS NULL THEN
        RETURN json_build_object(
            'success', FALSE,
            'code', 'UNAUTHENTICATED',
            'message', 'Authentication required'
        );
    END IF;

    -- 2. Acquire transaction-level advisory lock
    PERFORM pg_advisory_xact_lock(hashtext('super_admin_bootstrap_lock'));

    -- 3. Confirm there is NO existing Super Admin in the system
    IF EXISTS (SELECT 1 FROM admins WHERE role IN ('SUPER_ADMIN', 'Super Admin') AND is_active = TRUE) THEN
        INSERT INTO activation_code_attempts (auth_user_id, success) VALUES (auth.uid(), FALSE);
        RETURN json_build_object(
            'success', FALSE,
            'code', 'ALREADY_BOOTSTRAPPED',
            'message', 'System is already bootstrapped with a Super Admin'
        );
    END IF;

    -- 4. Confirm this auth account is not already an admin
    IF EXISTS (SELECT 1 FROM admins WHERE auth_user_id = auth.uid()) THEN
        INSERT INTO activation_code_attempts (auth_user_id, success) VALUES (auth.uid(), FALSE);
        RETURN json_build_object(
            'success', FALSE,
            'code', 'ALREADY_ADMIN',
            'message', 'This account is already registered as an admin'
        );
    END IF;

    -- 5. Check Rate Limit (max 5 failed attempts in last 15 minutes)
    SELECT count(*) INTO v_failed_attempts
    FROM activation_code_attempts
    WHERE auth_user_id = auth.uid()
      AND success = FALSE
      AND attempted_at > (NOW() - INTERVAL '15 minutes');

    IF v_failed_attempts >= 5 THEN
        RETURN json_build_object(
            'success', FALSE,
            'code', 'RATE_LIMIT_EXCEEDED',
            'message', 'Too many failed activation attempts. Locked out for 15 minutes.'
        );
    END IF;

    -- 6. Retrieve verified email from auth.users
    SELECT email INTO v_email
    FROM auth.users
    WHERE id = auth.uid();

    IF v_email IS NULL THEN
        INSERT INTO activation_code_attempts (auth_user_id, success) VALUES (auth.uid(), FALSE);
        RETURN json_build_object(
            'success', FALSE,
            'code', 'NO_EMAIL',
            'message', 'No email found for authenticated user'
        );
    END IF;

    -- 7. Enforce Authorized Owner check (server-authoritative)
    IF LOWER(TRIM(v_email)) != LOWER(TRIM(v_target_owner_email)) THEN
        INSERT INTO activation_code_attempts (auth_user_id, success) VALUES (auth.uid(), FALSE);
        RETURN json_build_object(
            'success', FALSE,
            'code', 'UNAUTHORIZED_OWNER',
            'message', 'This account is not authorized to bootstrap the system'
        );
    END IF;

    -- 8. Validate Activation Code
    IF p_activation_code IS NULL OR length(trim(p_activation_code)) = 0 THEN
        INSERT INTO activation_code_attempts (auth_user_id, success) VALUES (auth.uid(), FALSE);
        RETURN json_build_object(
            'success', FALSE,
            'code', 'INVALID_ACTIVATION_CODE',
            'message', 'Activation Code is required'
        );
    END IF;

    SELECT id, code_hash INTO v_active_code
    FROM activation_codes
    WHERE is_used = FALSE
    LIMIT 1;

    IF v_active_code.id IS NULL OR crypt(trim(p_activation_code), v_active_code.code_hash) != v_active_code.code_hash THEN
        INSERT INTO activation_code_attempts (auth_user_id, success) VALUES (auth.uid(), FALSE);
        RETURN json_build_object(
            'success', FALSE,
            'code', 'INVALID_ACTIVATION_CODE',
            'message', 'Invalid activation code'
        );
    END IF;

    -- 9. Validate Username
    IF p_username IS NULL OR length(trim(p_username)) < 3 THEN
        INSERT INTO activation_code_attempts (auth_user_id, success) VALUES (auth.uid(), FALSE);
        RETURN json_build_object(
            'success', FALSE,
            'code', 'INVALID_USERNAME',
            'message', 'Username must be at least 3 characters'
        );
    END IF;

    IF EXISTS (SELECT 1 FROM admins WHERE LOWER(username) = LOWER(trim(p_username))) THEN
        INSERT INTO activation_code_attempts (auth_user_id, success) VALUES (auth.uid(), FALSE);
        RETURN json_build_object(
            'success', FALSE,
            'code', 'USERNAME_TAKEN',
            'message', 'Username is already taken'
        );
    END IF;

    -- 10. Validate BIN format (minimum 4 numeric digits)
    IF p_bin IS NULL OR length(trim(p_bin)) < 4 OR NOT (trim(p_bin) ~ '^\d{4,}$') THEN
        INSERT INTO activation_code_attempts (auth_user_id, success) VALUES (auth.uid(), FALSE);
        RETURN json_build_object(
            'success', FALSE,
            'code', 'INVALID_BIN',
            'message', 'Valid numeric BIN of at least 4 digits is required'
        );
    END IF;

    -- 11. Hash BIN with bcrypt
    v_bin_hash := crypt(trim(p_bin), gen_salt('bf', 10));

    -- 12. Create Super Admin
    INSERT INTO admins (
        auth_user_id,
        username,
        email,
        full_name,
        bin_hash,
        is_active,
        role,
        created_at,
        updated_at,
        version
    ) VALUES (
        auth.uid(),
        trim(p_username),
        v_email,
        COALESCE(NULLIF(trim(p_full_name), ''), trim(p_username)),
        v_bin_hash,
        TRUE,
        'SUPER_ADMIN',
        NOW(),
        NOW(),
        1
    ) RETURNING id INTO v_new_admin_id;

    -- 13. Populate permissions
    INSERT INTO role_permissions (role, permission)
    VALUES
        ('SUPER_ADMIN', 'customers:read'),
        ('SUPER_ADMIN', 'customers:write'),
        ('SUPER_ADMIN', 'orders:read'),
        ('SUPER_ADMIN', 'orders:write'),
        ('SUPER_ADMIN', 'finances:read'),
        ('SUPER_ADMIN', 'finances:write'),
        ('SUPER_ADMIN', 'settings:manage'),
        ('SUPER_ADMIN', 'admin:manage'),
        ('SUPER_ADMIN', 'orders:view'),
        ('SUPER_ADMIN', 'orders:create'),
        ('SUPER_ADMIN', 'orders:edit'),
        ('SUPER_ADMIN', 'orders:deliver'),
        ('SUPER_ADMIN', 'orders:cancel'),
        ('SUPER_ADMIN', 'orders:correct'),
        ('SUPER_ADMIN', 'customers:view'),
        ('SUPER_ADMIN', 'customers:create'),
        ('SUPER_ADMIN', 'customers:edit'),
        ('SUPER_ADMIN', 'customers:deactivate'),
        ('SUPER_ADMIN', 'customers:debt-limit'),
        ('SUPER_ADMIN', 'customers:charger-exemption'),
        ('SUPER_ADMIN', 'customers:financial-view'),
        ('SUPER_ADMIN', 'finance:view'),
        ('SUPER_ADMIN', 'finance:create-payment'),
        ('SUPER_ADMIN', 'finance:approve-payment'),
        ('SUPER_ADMIN', 'finance:refund'),
        ('SUPER_ADMIN', 'finance:correction'),
        ('SUPER_ADMIN', 'finance:credit-adjustment'),
        ('SUPER_ADMIN', 'devices:view'),
        ('SUPER_ADMIN', 'devices:manage'),
        ('SUPER_ADMIN', 'devices:pricing'),
        ('SUPER_ADMIN', 'devices:charger-policy')
    ON CONFLICT (role, permission) DO NOTHING;

    INSERT INTO role_permissions (role, permission)
    SELECT 'Super Admin', permission FROM role_permissions WHERE role = 'SUPER_ADMIN'
    ON CONFLICT (role, permission) DO NOTHING;

    -- 14. Atomically consume the Activation Code
    UPDATE activation_codes
    SET is_used = TRUE,
        used_at = NOW(),
        used_by_auth_user_id = auth.uid()
    WHERE id = v_active_code.id;

    -- 15. Record successful attempt & audit log entry
    INSERT INTO activation_code_attempts (auth_user_id, success) VALUES (auth.uid(), TRUE);

    INSERT INTO audit_logs (
        action,
        entity_type,
        entity_id,
        actor_id,
        details,
        created_at
    ) VALUES (
        'SYSTEM_BOOTSTRAP',
        'admin',
        v_new_admin_id::text,
        auth.uid()::text,
        jsonb_build_object('username', trim(p_username), 'email', v_email, 'role', 'SUPER_ADMIN'),
        NOW()
    );

    RETURN json_build_object(
        'success', TRUE,
        'code', 'SUCCESS',
        'admin_id', v_new_admin_id,
        'username', trim(p_username),
        'email', v_email,
        'role', 'SUPER_ADMIN'
    );
END;
$FUNC$;

REVOKE EXECUTE ON FUNCTION public.bootstrap_first_super_admin(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.bootstrap_first_super_admin(TEXT, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.bootstrap_first_super_admin(TEXT, TEXT, TEXT, TEXT) TO authenticated;
