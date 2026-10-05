-- Migration 00012: Final One-Time Super Admin Setup (No Activation Code / No OTP / Auto-Confirmed Email)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Drop previous 4-parameter bootstrap RPC
DROP FUNCTION IF EXISTS public.bootstrap_first_super_admin(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.bootstrap_first_super_admin(TEXT, TEXT, TEXT);

-- 2. Create authoritative 3-parameter bootstrap RPC
CREATE OR REPLACE FUNCTION public.bootstrap_first_super_admin(
    p_username TEXT,
    p_full_name TEXT,
    p_bin TEXT
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
LANGUAGE plpgsql
AS $FUNC$
DECLARE
    v_email VARCHAR(255);
    v_bin_hash VARCHAR(255);
    v_new_admin_id UUID;
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
        RETURN json_build_object(
            'success', FALSE,
            'code', 'ALREADY_BOOTSTRAPPED',
            'message', 'System is already bootstrapped with a Super Admin'
        );
    END IF;

    -- 4. Confirm this auth account is not already an admin
    IF EXISTS (SELECT 1 FROM admins WHERE auth_user_id = auth.uid()) THEN
        RETURN json_build_object(
            'success', FALSE,
            'code', 'ALREADY_ADMIN',
            'message', 'This account is already registered as an admin'
        );
    END IF;

    -- 5. Retrieve email from auth.users
    SELECT email INTO v_email
    FROM auth.users
    WHERE id = auth.uid();

    IF v_email IS NULL THEN
        RETURN json_build_object(
            'success', FALSE,
            'code', 'NO_EMAIL',
            'message', 'No email found for authenticated user'
        );
    END IF;

    -- 6. Automatically confirm email in auth.users (no email sent / no OTP required)
    UPDATE auth.users
    SET email_confirmed_at = COALESCE(email_confirmed_at, NOW()),
        updated_at = NOW()
    WHERE id = auth.uid();

    -- 7. Validate Username
    IF p_username IS NULL OR length(trim(p_username)) < 3 THEN
        RETURN json_build_object(
            'success', FALSE,
            'code', 'INVALID_USERNAME',
            'message', 'Username must be at least 3 characters'
        );
    END IF;

    IF EXISTS (SELECT 1 FROM admins WHERE LOWER(username) = LOWER(trim(p_username))) THEN
        RETURN json_build_object(
            'success', FALSE,
            'code', 'USERNAME_TAKEN',
            'message', 'Username is already taken'
        );
    END IF;

    -- 8. Validate BIN format (minimum 4 numeric digits)
    IF p_bin IS NULL OR length(trim(p_bin)) < 4 OR NOT (trim(p_bin) ~ '^\d{4,}$') THEN
        RETURN json_build_object(
            'success', FALSE,
            'code', 'INVALID_BIN',
            'message', 'Valid numeric BIN of at least 4 digits is required'
        );
    END IF;

    -- 9. Hash BIN with bcrypt using schema-qualified extensions functions
    v_bin_hash := extensions.crypt(trim(p_bin), extensions.gen_salt('bf', 10));

    -- 10. Create Super Admin
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

    -- 11. Populate Super Admin permissions
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

    -- 12. Record audit log entry
    INSERT INTO audit_logs (
        actor_admin_id,
        action,
        entity_type,
        entity_id,
        after_state,
        created_at
    ) VALUES (
        v_new_admin_id,
        'SYSTEM_BOOTSTRAP',
        'admin',
        v_new_admin_id,
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

REVOKE EXECUTE ON FUNCTION public.bootstrap_first_super_admin(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bootstrap_first_super_admin(TEXT, TEXT, TEXT) TO authenticated;
