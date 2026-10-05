/**
 * Supabase Migration: 00004_auth_permissions_devices.sql
 * Establishes Phase 5 security foundation: admins, roles, effective permissions,
 * hashed BIN verification, app_devices registration, and single Super Admin enforcement.
 * Evolved cleanly from 00001 domain scaffold to direct string-based RBAC.
 */

-- ==========================================
-- 1. ADMINS TABLE EVOLUTION
-- ==========================================
CREATE TABLE IF NOT EXISTS admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(100) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Evolve admins schema with Phase 5 auth & RBAC columns
ALTER TABLE admins ADD COLUMN IF NOT EXISTS auth_user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS email VARCHAR(255) UNIQUE;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS role VARCHAR(50) NOT NULL DEFAULT 'Operator';
ALTER TABLE admins ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS disabled_by UUID REFERENCES admins(id);
ALTER TABLE admins ADD COLUMN IF NOT EXISTS bin_hash VARCHAR(255);
ALTER TABLE admins ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;

-- Relax legacy NOT NULL constraints from 00001 scaffold to support direct string-role inserts
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'admins' AND column_name = 'role_id' AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE admins ALTER COLUMN role_id DROP NOT NULL;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'admins' AND column_name = 'full_name' AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE admins ALTER COLUMN full_name DROP NOT NULL;
    END IF;
END $$;

-- Ensure only one Super Admin exists
CREATE OR REPLACE FUNCTION enforce_single_super_admin()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.role = 'Super Admin' THEN
        IF EXISTS (SELECT 1 FROM admins WHERE role = 'Super Admin' AND id != NEW.id) THEN
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

-- ==========================================
-- 2. ROLES & PERMISSIONS TABLES (DIRECT STRING RBAC)
-- ==========================================
DROP TABLE IF EXISTS role_permissions CASCADE;
CREATE TABLE role_permissions (
    role VARCHAR(50) NOT NULL,
    permission VARCHAR(100) NOT NULL,
    PRIMARY KEY (role, permission)
);

DROP TABLE IF EXISTS admin_custom_permissions CASCADE;
CREATE TABLE admin_custom_permissions (
    admin_id UUID REFERENCES admins(id) ON DELETE CASCADE,
    permission VARCHAR(100) NOT NULL,
    is_grant BOOLEAN NOT NULL, -- TRUE for explicit grant, FALSE for explicit denial
    PRIMARY KEY (admin_id, permission)
);

-- ==========================================
-- 3. APP DEVICES TABLE EVOLUTION
-- ==========================================
CREATE TABLE IF NOT EXISTS app_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID REFERENCES admins(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL,
    app_version VARCHAR(50) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE app_devices ADD COLUMN IF NOT EXISTS device_identifier VARCHAR(255) UNIQUE;
ALTER TABLE app_devices ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE app_devices ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;

-- ==========================================
-- 4. EFFECTIVE PERMISSIONS RESOLUTION RPC
-- ==========================================
CREATE OR REPLACE FUNCTION get_effective_permissions(p_admin_id UUID)
RETURNS TABLE (permission VARCHAR(100)) AS $$
DECLARE
    v_role VARCHAR(50);
    v_is_active BOOLEAN;
BEGIN
    SELECT role, is_active INTO v_role, v_is_active FROM admins WHERE id = p_admin_id;
    
    IF NOT FOUND OR NOT v_is_active THEN
        RETURN;
    END IF;

    -- Return role permissions plus grants minus denials
    RETURN QUERY
    SELECT rp.permission
    FROM role_permissions rp
    WHERE rp.role = v_role
      AND rp.permission NOT IN (
          SELECT acp.permission FROM admin_custom_permissions acp WHERE acp.admin_id = p_admin_id AND acp.is_grant = FALSE
      )
    UNION
    SELECT acp.permission
    FROM admin_custom_permissions acp
    WHERE acp.admin_id = p_admin_id AND acp.is_grant = TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
