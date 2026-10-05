-- Migration 00014: Fix extensions search_path for pgcrypto functions (crypt, gen_salt) across all security definer functions

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- 1. bootstrap_first_super_admin
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
    IF auth.uid() IS NULL THEN
        RETURN json_build_object(
            'success', FALSE,
            'code', 'UNAUTHENTICATED',
            'message', 'Authentication required'
        );
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('super_admin_bootstrap_lock'));

    IF EXISTS (SELECT 1 FROM admins WHERE role IN ('SUPER_ADMIN', 'Super Admin') AND is_active = TRUE) THEN
        RETURN json_build_object(
            'success', FALSE,
            'code', 'ALREADY_BOOTSTRAPPED',
            'message', 'System is already bootstrapped with a Super Admin'
        );
    END IF;

    IF EXISTS (SELECT 1 FROM admins WHERE auth_user_id = auth.uid()) THEN
        RETURN json_build_object(
            'success', FALSE,
            'code', 'ALREADY_ADMIN',
            'message', 'This account is already registered as an admin'
        );
    END IF;

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

    UPDATE auth.users
    SET email_confirmed_at = COALESCE(email_confirmed_at, NOW()),
        updated_at = NOW()
    WHERE id = auth.uid();

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

    IF p_bin IS NULL OR length(trim(p_bin)) < 4 OR NOT (trim(p_bin) ~ '^\d{4,}$') THEN
        RETURN json_build_object(
            'success', FALSE,
            'code', 'INVALID_BIN',
            'message', 'Valid numeric BIN of at least 4 digits is required'
        );
    END IF;

    v_bin_hash := extensions.crypt(trim(p_bin), extensions.gen_salt('bf', 10));

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

-- 2. verify_admin_bin
CREATE OR REPLACE FUNCTION public.verify_admin_bin(p_bin TEXT)
RETURNS BOOLEAN
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
LANGUAGE plpgsql
AS $FUNC$
DECLARE
    v_admin_id UUID;
    v_bin_hash VARCHAR(255);
    v_is_active BOOLEAN;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN FALSE;
    END IF;

    IF p_bin IS NULL OR length(trim(p_bin)) < 4 THEN
        RETURN FALSE;
    END IF;

    SELECT id, bin_hash, is_active 
    INTO v_admin_id, v_bin_hash, v_is_active
    FROM admins
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    IF NOT FOUND OR v_is_active IS NOT TRUE OR v_bin_hash IS NULL THEN
        RETURN FALSE;
    END IF;

    IF extensions.crypt(trim(p_bin), v_bin_hash) = v_bin_hash THEN
        RETURN TRUE;
    ELSE
        RETURN FALSE;
    END IF;
END;
$FUNC$;

REVOKE EXECUTE ON FUNCTION public.verify_admin_bin(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_admin_bin(TEXT) TO authenticated;

-- 3. set_admin_bin
CREATE OR REPLACE FUNCTION public.set_admin_bin(p_bin TEXT, p_admin_id UUID DEFAULT NULL)
RETURNS BOOLEAN
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
LANGUAGE plpgsql
AS $FUNC$
DECLARE
    v_caller_admin_id UUID;
    v_caller_role VARCHAR(50);
    v_caller_active BOOLEAN;
    v_target_id UUID;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF p_bin IS NULL OR length(trim(p_bin)) < 4 OR NOT (trim(p_bin) ~ '^\d{4,}$') THEN
        RAISE EXCEPTION 'BIN must be at least 4 numeric digits';
    END IF;

    SELECT id, role, is_active 
    INTO v_caller_admin_id, v_caller_role, v_caller_active
    FROM admins 
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    IF NOT FOUND OR v_caller_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Authenticated admin account is inactive or not found';
    END IF;

    IF p_admin_id IS NOT NULL AND p_admin_id != v_caller_admin_id THEN
        IF v_caller_role NOT IN ('SUPER_ADMIN', 'Super Admin') THEN
            RAISE EXCEPTION 'Unauthorized: Only Super Admin can update another admin BIN';
        END IF;
        
        SELECT id INTO v_target_id FROM admins WHERE id = p_admin_id;
        IF v_target_id IS NULL THEN
            RAISE EXCEPTION 'Target admin not found';
        END IF;
    ELSE
        v_target_id := v_caller_admin_id;
    END IF;

    UPDATE admins 
    SET bin_hash = extensions.crypt(trim(p_bin), extensions.gen_salt('bf', 10)),
        updated_at = NOW(),
        version = version + 1
    WHERE id = v_target_id;

    RETURN TRUE;
END;
$FUNC$;

REVOKE EXECUTE ON FUNCTION public.set_admin_bin(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_admin_bin(TEXT, UUID) TO authenticated;

-- 4. execute_customer_top_up_atomic
CREATE OR REPLACE FUNCTION public.execute_customer_top_up_atomic(
    p_command_id UUID,
    p_customer_id UUID,
    p_amount_minor BIGINT,
    p_bin TEXT,
    p_note TEXT DEFAULT NULL
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
    v_role VARCHAR(50);
    v_ledger_id UUID;
    v_new_balance BIGINT;
    v_existing_cmd RECORD;
    v_result JSONB;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
        RAISE EXCEPTION 'Top-up amount must be strictly positive';
    END IF;

    SELECT * INTO v_existing_cmd FROM processed_commands WHERE command_id = p_command_id;
    IF FOUND THEN
        RETURN v_existing_cmd.result_payload;
    END IF;

    SELECT id, bin_hash, is_active, role 
    INTO v_admin_id, v_bin_hash, v_is_active, v_role
    FROM admins 
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    IF NOT FOUND OR v_is_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Admin account not found or inactive';
    END IF;

    IF v_bin_hash IS NULL OR extensions.crypt(trim(p_bin), v_bin_hash) != v_bin_hash THEN
        RAISE EXCEPTION 'Invalid authorization BIN credential';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM customers WHERE id = p_customer_id) THEN
        RAISE EXCEPTION 'Customer not found';
    END IF;

    v_ledger_id := gen_random_uuid();
    INSERT INTO financial_ledger (
        id,
        customer_id,
        amount_minor,
        event_type,
        actor_admin_id,
        created_at
    ) VALUES (
        v_ledger_id,
        p_customer_id,
        p_amount_minor,
        'CREDIT_ADJUSTMENT',
        v_admin_id,
        NOW()
    );

    SELECT COALESCE(SUM(amount_minor), 0)
    INTO v_new_balance
    FROM financial_ledger
    WHERE customer_id = p_customer_id;

    UPDATE customers 
    SET updated_at = NOW(),
        version = version + 1
    WHERE id = p_customer_id;

    v_result := jsonb_build_object(
        'success', true,
        'transactionId', v_ledger_id,
        'newBalanceMinor', v_new_balance,
        'processedAt', NOW()
    );

    INSERT INTO processed_commands (
        command_id,
        actor_id,
        command_type,
        result_payload,
        processed_at
    ) VALUES (
        p_command_id,
        v_admin_id,
        'CREATE_CUSTOMER_CREDIT',
        v_result,
        NOW()
    );

    RETURN v_result;
END;
$FUNC$;

REVOKE EXECUTE ON FUNCTION public.execute_customer_top_up_atomic(UUID, UUID, BIGINT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.execute_customer_top_up_atomic(UUID, UUID, BIGINT, TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
