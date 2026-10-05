/**
 * Supabase Migration: 00009_super_admin_bootstrap.sql
 * Establishes the authoritative first Super Admin bootstrap boundary.
 *
 * Guarantees:
 * 1. Single execution: Guaranteed by transaction-scoped advisory locks and existence checks.
 * 2. Strict authentication: Caller must be authenticated via Supabase Auth (auth.uid() IS NOT NULL).
 * 3. Identity binding: auth_user_id is strictly derived from auth.uid().
 * 4. Email binding: Derived directly from auth.users, preventing impersonation.
 * 5. Role normalization: Harmonizes 'SUPER_ADMIN' and legacy 'Super Admin' across triggers and unique indexes.
 * 6. Slow salted bcrypt: Hashed via pgcrypto crypt(trim(p_bin), gen_salt('bf', 10)).
 * 7. Atomicity: Fails closed on any violation with zero partial records.
 */

-- Ensure pgcrypto extension is active
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==========================================
-- 1. SCHEMA REFINEMENT & ROLE NORMALIZATION
-- ==========================================

-- Add full_name column to admins if missing
ALTER TABLE admins ADD COLUMN IF NOT EXISTS full_name VARCHAR(200);

-- Normalize existing Super Admin role values to canonical 'SUPER_ADMIN'
UPDATE admins SET role = 'SUPER_ADMIN' WHERE role = 'Super Admin';

-- Harmonize the single Super Admin trigger to protect both 'SUPER_ADMIN' and 'Super Admin'
CREATE OR REPLACE FUNCTION enforce_single_super_admin()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.role IN ('SUPER_ADMIN', 'Super Admin') THEN
        IF EXISTS (
            SELECT 1 FROM admins 
            WHERE role IN ('SUPER_ADMIN', 'Super Admin') 
              AND id != NEW.id
        ) THEN
            RAISE EXCEPTION 'System can only have one Super Admin';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_single_super_admin ON admins;
CREATE TRIGGER trg_enforce_single_super_admin
    BEFORE INSERT OR UPDATE OF role ON admins
    FOR EACH ROW
    EXECUTE FUNCTION enforce_single_super_admin();

-- Replace partial index to cover canonical 'SUPER_ADMIN' and legacy 'Super Admin'
DROP INDEX IF EXISTS idx_single_super_admin;
CREATE UNIQUE INDEX idx_single_super_admin ON admins ((true)) 
WHERE role IN ('SUPER_ADMIN', 'Super Admin');

-- Harmonize set_admin_bin to accept canonical role
CREATE OR REPLACE FUNCTION set_admin_bin(
    p_bin TEXT,
    p_admin_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
DECLARE
    v_caller_admin_id UUID;
    v_caller_role VARCHAR(50);
    v_caller_active BOOLEAN;
    v_target_id UUID;
BEGIN
    -- 1. Strict authentication check: auth.uid() MUST be present
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    -- 2. Format validation: at least 4 numeric digits
    IF p_bin IS NULL OR length(trim(p_bin)) < 4 OR NOT (trim(p_bin) ~ '^\d{4,}$') THEN
        RAISE EXCEPTION 'BIN must be at least 4 numeric digits';
    END IF;

    -- 3. Resolve caller admin record from auth.uid()
    SELECT id, role, is_active 
    INTO v_caller_admin_id, v_caller_role, v_caller_active
    FROM admins 
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    IF NOT FOUND OR v_caller_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Authenticated admin account is inactive or not found';
    END IF;

    -- 4. Determine target admin
    IF p_admin_id IS NOT NULL AND p_admin_id != v_caller_admin_id THEN
        -- Only Super Admin can modify another admin's BIN
        IF v_caller_role NOT IN ('SUPER_ADMIN', 'Super Admin') THEN
            RAISE EXCEPTION 'Unauthorized: Only Super Admin can update another admin BIN';
        END IF;
        
        SELECT id INTO v_target_id FROM admins WHERE id = p_admin_id;
        IF v_target_id IS NULL THEN
            RAISE EXCEPTION 'Target admin not found';
        END IF;
    ELSE
        -- Self-modification
        v_target_id := v_caller_admin_id;
    END IF;

    -- 5. Update bin_hash with fresh salted bcrypt hash
    UPDATE admins 
    SET bin_hash = crypt(trim(p_bin), gen_salt('bf', 10)),
        updated_at = NOW(),
        version = version + 1
    WHERE id = v_target_id;

    RETURN TRUE;
END;
$$;


-- ==========================================
-- 2. IS SYSTEM BOOTSTRAPPED RPC
-- ==========================================
CREATE OR REPLACE FUNCTION is_system_bootstrapped()
RETURNS BOOLEAN
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM admins 
        WHERE role IN ('SUPER_ADMIN', 'Super Admin') 
          AND is_active = TRUE
    );
END;
$$;

-- Allow anon and authenticated to check bootstrap status
REVOKE EXECUTE ON FUNCTION is_system_bootstrapped() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_system_bootstrapped() TO anon, authenticated;


-- ==========================================
-- 3. ATOMIC FIRST SUPER ADMIN BOOTSTRAP RPC
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
    v_bin_hash VARCHAR(255);
    v_new_admin_id UUID;
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

    -- 5. Retrieve verified email from auth.users (never accept client-supplied email)
    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
    IF v_email IS NULL THEN
        RAISE EXCEPTION 'No verified email found for authenticated user in auth.users';
    END IF;

    -- 6. Validate username
    IF p_username IS NULL OR length(trim(p_username)) < 3 THEN
        RAISE EXCEPTION 'Username must be at least 3 characters long';
    END IF;

    -- Check username uniqueness
    IF EXISTS (SELECT 1 FROM admins WHERE LOWER(username) = LOWER(trim(p_username))) THEN
        RAISE EXCEPTION 'Username is already taken';
    END IF;

    -- 7. Validate BIN format (minimum 4 numeric digits)
    IF p_bin IS NULL OR length(trim(p_bin)) < 4 OR NOT (trim(p_bin) ~ '^\d{4,}$') THEN
        RAISE EXCEPTION 'Valid numeric BIN of at least 4 digits is required';
    END IF;

    -- 8. Hash BIN with salted bcrypt in PostgreSQL memory
    v_bin_hash := crypt(trim(p_bin), gen_salt('bf', 10));

    -- 9. Insert the authoritative Super Admin row
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

    -- 10. Populate authoritative Super Admin role permissions if empty
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

    -- 11. Return sanitized bootstrap summary (NEVER expose bin_hash or plaintext)
    RETURN json_build_object(
        'success', TRUE,
        'admin_id', v_new_admin_id,
        'username', trim(p_username),
        'email', v_email,
        'role', 'SUPER_ADMIN'
    );
END;
$$;

-- Revoke from public/anon, grant strictly to authenticated
REVOKE EXECUTE ON FUNCTION bootstrap_first_super_admin(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION bootstrap_first_super_admin(TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION bootstrap_first_super_admin(TEXT, TEXT, TEXT) TO authenticated;
