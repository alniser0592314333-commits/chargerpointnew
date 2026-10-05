/**
 * Supabase Migration: 00010_auth_identity_resolution_and_bootstrap_security.sql
 * Phase 6.12.17: Secure First-Owner Bootstrap & Server-Authoritative Identity Profile Resolver.
 *
 * 1. Tightens bootstrap_first_super_admin RPC:
 *    - Enforces PostgreSQL-level owner eligibility check: lower(trim(email)) = 'al.niser.0592314333@gmail.com'
 *    - Enforces confirmed email check in auth.users
 *    - Preserves transaction-level advisory lock & single Super Admin constraint
 *
 * 2. Creates get_current_admin_profile RPC:
 *    - Derives identity solely from auth.uid()
 *    - Accepts zero parameters from client
 *    - Resolves authoritative role & effective permissions
 *    - Returns sanitized JSON profile without secrets
 */

-- Ensure pgcrypto extension is available
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==========================================
-- 1. SECURE FIRST-OWNER SUPER ADMIN BOOTSTRAP RPC
-- ==========================================
CREATE OR REPLACE FUNCTION bootstrap_first_super_admin(
    p_username TEXT,
    p_full_name TEXT DEFAULT NULL,
    p_bin TEXT DEFAULT NULL
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
DECLARE
    v_email VARCHAR(255);
    v_email_confirmed TIMESTAMPTZ;
    v_bin_hash VARCHAR(255);
    v_new_admin_id UUID;
    v_target_owner_email CONSTANT TEXT := 'al.niser.0592314333@gmail.com';
BEGIN
    -- 1. Caller MUST be authenticated via Supabase Auth
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required: caller must be signed in via Supabase Auth';
    END IF;

    -- 2. Acquire transaction-level advisory lock to serialize concurrent attempts
    PERFORM pg_advisory_xact_lock(hashtext('super_admin_bootstrap_lock'));

    -- 3. Confirm there is NO existing Super Admin in the system
    IF EXISTS (SELECT 1 FROM admins WHERE role IN ('SUPER_ADMIN', 'Super Admin')) THEN
        RAISE EXCEPTION 'System is already bootstrapped with a Super Admin';
    END IF;

    -- 4. Confirm this auth.users identity is not already bound to another admin
    IF EXISTS (SELECT 1 FROM admins WHERE auth_user_id = auth.uid()) THEN
        RAISE EXCEPTION 'This authenticated account is already registered as an admin';
    END IF;

    -- 5. Retrieve verified email and email_confirmed_at from auth.users
    SELECT email, email_confirmed_at 
    INTO v_email, v_email_confirmed 
    FROM auth.users 
    WHERE id = auth.uid();

    IF v_email IS NULL THEN
        RAISE EXCEPTION 'No email found for authenticated user in auth.users';
    END IF;

    -- 6. Enforce email confirmation requirement
    IF v_email_confirmed IS NULL THEN
        RAISE EXCEPTION 'Email confirmation required: user must confirm email before bootstrapping Super Admin';
    END IF;

    -- 7. Enforce FIRST-OWNER BOOTSTRAP ELIGIBILITY
    IF LOWER(TRIM(v_email)) != LOWER(TRIM(v_target_owner_email)) THEN
        RAISE EXCEPTION 'Unauthorized: This authenticated account is not authorized to bootstrap the first Super Admin';
    END IF;

    -- 8. Validate username
    IF p_username IS NULL OR length(trim(p_username)) < 3 THEN
        RAISE EXCEPTION 'Username must be at least 3 characters long';
    END IF;

    -- Check username uniqueness
    IF EXISTS (SELECT 1 FROM admins WHERE LOWER(username) = LOWER(trim(p_username))) THEN
        RAISE EXCEPTION 'Username is already taken';
    END IF;

    -- 9. Validate BIN format (minimum 4 numeric digits)
    IF p_bin IS NULL OR length(trim(p_bin)) < 4 OR NOT (trim(p_bin) ~ '^\d{4,}$') THEN
        RAISE EXCEPTION 'Valid numeric BIN of at least 4 digits is required';
    END IF;

    -- 10. Hash BIN with salted bcrypt in PostgreSQL memory
    v_bin_hash := crypt(trim(p_bin), gen_salt('bf', 10));

    -- 11. Insert the authoritative Super Admin row
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

    -- 12. Populate authoritative Super Admin role permissions if empty
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

    -- Mirror to legacy 'Super Admin' for full backwards compatibility
    INSERT INTO role_permissions (role, permission)
    SELECT 'Super Admin', permission FROM role_permissions WHERE role = 'SUPER_ADMIN'
    ON CONFLICT (role, permission) DO NOTHING;

    -- 13. Return sanitized bootstrap summary (NEVER expose bin_hash or plaintext)
    RETURN json_build_object(
        'success', TRUE,
        'admin_id', v_new_admin_id,
        'username', trim(p_username),
        'email', v_email,
        'role', 'SUPER_ADMIN'
    );
END;
$$;

-- Revoke permissions from public/anon, grant strictly to authenticated
REVOKE EXECUTE ON FUNCTION bootstrap_first_super_admin(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION bootstrap_first_super_admin(TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION bootstrap_first_super_admin(TEXT, TEXT, TEXT) TO authenticated;

-- ==========================================
-- 2. SERVER-AUTHORITATIVE ADMIN PROFILE RESOLVER RPC
-- ==========================================
CREATE OR REPLACE FUNCTION get_current_admin_profile()
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
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

    -- 2. Retrieve caller email confirmation state from auth.users
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
$$;

-- Revoke permissions from public/anon, grant strictly to authenticated
REVOKE EXECUTE ON FUNCTION get_current_admin_profile() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_current_admin_profile() FROM anon;
GRANT EXECUTE ON FUNCTION get_current_admin_profile() TO authenticated;
