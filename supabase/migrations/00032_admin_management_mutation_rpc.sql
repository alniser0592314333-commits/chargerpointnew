-- Migration 00032: Server-Side RPC Mutations for Super Admin Management
-- Includes: Create Admin Account, Update Admin Password, and Update Admin BIN

-- 1. Create secure Admin creation function
CREATE OR REPLACE FUNCTION public.rpc_create_admin(
    p_username TEXT,
    p_email TEXT,
    p_password TEXT,
    p_full_name TEXT,
    p_role TEXT,
    p_bin TEXT,
    p_caller_bin TEXT
)
RETURNS UUID
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
LANGUAGE plpgsql
AS $FUNC$
DECLARE
    v_caller_id UUID;
    v_caller_bin_hash VARCHAR(255);
    v_caller_role VARCHAR(50);
    v_caller_is_active BOOLEAN;
    v_new_user_id UUID;
    v_new_admin_id UUID;
    v_clean_email VARCHAR(255);
    v_clean_username VARCHAR(100);
    v_clean_full_name VARCHAR(200);
    v_clean_role VARCHAR(50);
    v_encrypted_password TEXT;
    v_bin_hash VARCHAR(255);
BEGIN
    -- Validate Caller Auth
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    -- Resolve Caller Admin Profile
    SELECT id, bin_hash, role, is_active 
    INTO v_caller_id, v_caller_bin_hash, v_caller_role, v_caller_is_active
    FROM public.admins
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    IF NOT FOUND OR v_caller_is_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Caller admin profile not found or suspended';
    END IF;

    -- Verify Caller is SUPER_ADMIN
    IF v_caller_role != 'SUPER_ADMIN' THEN
        RAISE EXCEPTION 'Unauthorized operation: SUPER_ADMIN role required';
    END IF;

    -- Verify Caller BIN
    IF v_caller_bin_hash IS NULL OR extensions.crypt(trim(p_caller_bin), v_caller_bin_hash) != v_caller_bin_hash THEN
        RAISE EXCEPTION 'Invalid authorization BIN credential';
    END IF;

    -- Normalize & Clean Inputs
    v_clean_email := trim(lower(p_email));
    v_clean_username := trim(p_username);
    v_clean_full_name := trim(p_full_name);
    v_clean_role := trim(p_role);

    -- Ensure we do not create another Super Admin
    IF v_clean_role IN ('SUPER_ADMIN', 'Super Admin') THEN
        RAISE EXCEPTION 'Cannot create subordinate accounts with SUPER_ADMIN role';
    END IF;

    -- Validation checks
    IF v_clean_username = '' THEN
        RAISE EXCEPTION 'Username cannot be empty';
    END IF;

    IF v_clean_email = '' THEN
        RAISE EXCEPTION 'Email cannot be empty';
    END IF;

    IF p_password = '' OR length(p_password) < 6 THEN
        RAISE EXCEPTION 'Password must be at least 6 characters';
    END IF;

    IF p_bin = '' OR NOT (p_bin ~ '^\d{4,}$') THEN
        RAISE EXCEPTION 'BIN must be at least 4 numeric digits';
    END IF;

    -- Duplicate Checks
    IF EXISTS (SELECT 1 FROM auth.users WHERE email = v_clean_email) THEN
        RAISE EXCEPTION 'An account with this email already exists';
    END IF;

    IF EXISTS (SELECT 1 FROM public.admins WHERE username = v_clean_username) THEN
        RAISE EXCEPTION 'An admin account with this username already exists';
    END IF;

    -- Hash password using bcrypt bf
    v_encrypted_password := extensions.crypt(p_password, extensions.gen_salt('bf', 10));
    v_bin_hash := extensions.crypt(trim(p_bin), extensions.gen_salt('bf', 10));

    -- Create user in auth.users
    INSERT INTO auth.users (
        id,
        instance_id,
        email,
        encrypted_password,
        email_confirmed_at,
        confirmed_at,
        aud,
        role,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at
    ) VALUES (
        gen_random_uuid(),
        '00000000-0000-0000-0000-000000000000'::UUID,
        v_clean_email,
        v_encrypted_password,
        NOW(),
        NOW(),
        'authenticated',
        'authenticated',
        '{"provider": "email", "providers": ["email"]}'::jsonb,
        jsonb_build_object('username', v_clean_username, 'full_name', v_clean_full_name),
        NOW(),
        NOW()
    )
    RETURNING id INTO v_new_user_id;

    -- Create profile in public.admins
    INSERT INTO public.admins (
        id,
        auth_user_id,
        username,
        full_name,
        email,
        role,
        is_active,
        bin_hash,
        version,
        created_at,
        updated_at
    ) VALUES (
        gen_random_uuid(),
        v_new_user_id,
        v_clean_username,
        v_clean_full_name,
        v_clean_email,
        v_clean_role,
        true,
        v_bin_hash,
        1,
        NOW(),
        NOW()
    )
    RETURNING id INTO v_new_admin_id;

    -- Log administrative audit record
    INSERT INTO public.admin_audit_logs (
        actor_admin_id,
        action,
        target_admin_id,
        metadata
    ) VALUES (
        v_caller_id,
        'ADMIN_CREATED',
        v_new_admin_id,
        jsonb_build_object('username', v_clean_username, 'role', v_clean_role, 'timestamp', NOW())
    );

    RETURN v_new_admin_id;
END;
$FUNC$;


-- 2. Create secure Admin Password Reset function
CREATE OR REPLACE FUNCTION public.rpc_update_admin_password(
    p_target_admin_id UUID,
    p_new_password TEXT,
    p_caller_bin TEXT
)
RETURNS VOID
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
LANGUAGE plpgsql
AS $FUNC$
DECLARE
    v_caller_id UUID;
    v_caller_bin_hash VARCHAR(255);
    v_caller_role VARCHAR(50);
    v_caller_is_active BOOLEAN;
    v_target_auth_user_id UUID;
    v_encrypted_password TEXT;
BEGIN
    -- Validate Caller Auth
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    -- Resolve Caller Admin Profile
    SELECT id, bin_hash, role, is_active 
    INTO v_caller_id, v_caller_bin_hash, v_caller_role, v_caller_is_active
    FROM public.admins
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    IF NOT FOUND OR v_caller_is_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Caller admin profile not found or suspended';
    END IF;

    -- Verify Caller is SUPER_ADMIN
    IF v_caller_role != 'SUPER_ADMIN' THEN
        RAISE EXCEPTION 'Unauthorized operation: SUPER_ADMIN role required';
    END IF;

    -- Verify Caller BIN
    IF v_caller_bin_hash IS NULL OR extensions.crypt(trim(p_caller_bin), v_caller_bin_hash) != v_caller_bin_hash THEN
        RAISE EXCEPTION 'Invalid authorization BIN credential';
    END IF;

    -- Retrieve Target's Auth User ID
    SELECT auth_user_id INTO v_target_auth_user_id
    FROM public.admins
    WHERE id = p_target_admin_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target admin account not found';
    END IF;

    -- Validate Password
    IF p_new_password = '' OR length(p_new_password) < 6 THEN
        RAISE EXCEPTION 'Password must be at least 6 characters';
    END IF;

    -- Hash password
    v_encrypted_password := extensions.crypt(p_new_password, extensions.gen_salt('bf', 10));

    -- Update auth.users password
    UPDATE auth.users
    SET encrypted_password = v_encrypted_password,
        updated_at = NOW()
    WHERE id = v_target_auth_user_id;

    -- Increment admin profile version
    UPDATE public.admins
    SET version = version + 1,
        updated_at = NOW()
    WHERE id = p_target_admin_id;

    -- Log administrative audit record
    INSERT INTO public.admin_audit_logs (
        actor_admin_id,
        action,
        target_admin_id,
        metadata
    ) VALUES (
        v_caller_id,
        'ADMIN_PASSWORD_RESET',
        p_target_admin_id,
        jsonb_build_object('timestamp', NOW())
    );
END;
$FUNC$;


-- 3. Create secure Admin BIN Reset function
CREATE OR REPLACE FUNCTION public.rpc_update_admin_bin(
    p_target_admin_id UUID,
    p_new_bin TEXT,
    p_caller_bin TEXT
)
RETURNS VOID
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
LANGUAGE plpgsql
AS $FUNC$
DECLARE
    v_caller_id UUID;
    v_caller_bin_hash VARCHAR(255);
    v_caller_role VARCHAR(50);
    v_caller_is_active BOOLEAN;
    v_new_bin_hash VARCHAR(255);
BEGIN
    -- Validate Caller Auth
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    -- Resolve Caller Admin Profile
    SELECT id, bin_hash, role, is_active 
    INTO v_caller_id, v_caller_bin_hash, v_caller_role, v_caller_is_active
    FROM public.admins
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    IF NOT FOUND OR v_caller_is_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Caller admin profile not found or suspended';
    END IF;

    -- Verify Caller is SUPER_ADMIN
    IF v_caller_role != 'SUPER_ADMIN' THEN
        RAISE EXCEPTION 'Unauthorized operation: SUPER_ADMIN role required';
    END IF;

    -- Verify Caller BIN
    IF v_caller_bin_hash IS NULL OR extensions.crypt(trim(p_caller_bin), v_caller_bin_hash) != v_caller_bin_hash THEN
        RAISE EXCEPTION 'Invalid authorization BIN credential';
    END IF;

    -- Validate target existence
    IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_target_admin_id) THEN
        RAISE EXCEPTION 'Target admin account not found';
    END IF;

    -- Validate BIN
    IF p_new_bin = '' OR NOT (p_new_bin ~ '^\d{4,}$') THEN
        RAISE EXCEPTION 'BIN must be at least 4 numeric digits';
    END IF;

    -- Hash BIN
    v_new_bin_hash := extensions.crypt(trim(p_new_bin), extensions.gen_salt('bf', 10));

    -- Update target admin profile
    UPDATE public.admins
    SET bin_hash = v_new_bin_hash,
        version = version + 1,
        updated_at = NOW()
    WHERE id = p_target_admin_id;

    -- Log administrative audit record
    INSERT INTO public.admin_audit_logs (
        actor_admin_id,
        action,
        target_admin_id,
        metadata
    ) VALUES (
        v_caller_id,
        'ADMIN_BIN_RESET',
        p_target_admin_id,
        jsonb_build_object('timestamp', NOW())
    );
END;
$FUNC$;


-- 4. Grant Executes to authenticated
REVOKE EXECUTE ON FUNCTION public.rpc_create_admin(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_create_admin(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.rpc_update_admin_password(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_admin_password(UUID, TEXT, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.rpc_update_admin_bin(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_admin_bin(UUID, TEXT, TEXT) TO authenticated;
