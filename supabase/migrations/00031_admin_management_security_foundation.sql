-- 1. Create admin_audit_logs table
CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_admin_id UUID REFERENCES public.admins(id),
    action VARCHAR(100) NOT NULL,
    target_admin_id UUID REFERENCES public.admins(id),
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_custom_permissions ENABLE ROW LEVEL SECURITY;

-- 2. Drop existing policies to prevent conflicts
DROP POLICY IF EXISTS "Allow authenticated read of admins" ON public.admins;
DROP POLICY IF EXISTS "Allow Super Admin write of admins" ON public.admins;
DROP POLICY IF EXISTS "Allow authenticated read of custom permissions" ON public.admin_custom_permissions;
DROP POLICY IF EXISTS "Allow Super Admin write of custom permissions" ON public.admin_custom_permissions;
DROP POLICY IF EXISTS "Allow Super Admin read of audit logs" ON public.admin_audit_logs;

-- 3. Create RLS Policies
CREATE POLICY "Allow authenticated read of admins" ON public.admins 
    FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow Super Admin write of admins" ON public.admins 
    FOR ALL TO authenticated USING (
        EXISTS (
            SELECT 1 FROM public.admins 
            WHERE auth_user_id = auth.uid() 
              AND role = 'SUPER_ADMIN' 
              AND is_active = true
        )
    );

CREATE POLICY "Allow authenticated read of custom permissions" ON public.admin_custom_permissions 
    FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow Super Admin write of custom permissions" ON public.admin_custom_permissions 
    FOR ALL TO authenticated USING (
        EXISTS (
            SELECT 1 FROM public.admins 
            WHERE auth_user_id = auth.uid() 
              AND role = 'SUPER_ADMIN' 
              AND is_active = true
        )
    );

CREATE POLICY "Allow Super Admin read of audit logs" ON public.admin_audit_logs 
    FOR SELECT TO authenticated USING (
        EXISTS (
            SELECT 1 FROM public.admins 
            WHERE auth_user_id = auth.uid() 
              AND role = 'SUPER_ADMIN' 
              AND is_active = true
        )
    );

-- 4. Server-Side RPC: Suspend Admin Account
CREATE OR REPLACE FUNCTION public.rpc_suspend_admin(
    p_target_admin_id UUID,
    p_bin TEXT
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
    IF v_caller_bin_hash IS NULL OR extensions.crypt(trim(p_bin), v_caller_bin_hash) != v_caller_bin_hash THEN
        RAISE EXCEPTION 'Invalid authorization BIN credential';
    END IF;

    -- Verify Target exists
    IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_target_admin_id) THEN
        RAISE EXCEPTION 'Target admin not found';
    END IF;

    -- Prevent self-suspension
    IF v_caller_id = p_target_admin_id THEN
        RAISE EXCEPTION 'Cannot suspend own administrator account';
    END IF;

    -- Perform suspension mutation
    UPDATE public.admins
    SET is_active = false,
        disabled_at = NOW(),
        disabled_by = v_caller_id,
        updated_at = NOW(),
        version = version + 1
    WHERE id = p_target_admin_id;

    -- Log administrative audit record
    INSERT INTO public.admin_audit_logs (
        actor_admin_id,
        action,
        target_admin_id,
        metadata
    ) VALUES (
        v_caller_id,
        'ADMIN_SUSPENDED',
        p_target_admin_id,
        jsonb_build_object('timestamp', NOW())
    );
END;
$FUNC$;

-- 5. Server-Side RPC: Activate Admin Account
CREATE OR REPLACE FUNCTION public.rpc_activate_admin(
    p_target_admin_id UUID,
    p_bin TEXT
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
    IF v_caller_bin_hash IS NULL OR extensions.crypt(trim(p_bin), v_caller_bin_hash) != v_caller_bin_hash THEN
        RAISE EXCEPTION 'Invalid authorization BIN credential';
    END IF;

    -- Verify Target exists
    IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_target_admin_id) THEN
        RAISE EXCEPTION 'Target admin not found';
    END IF;

    -- Perform activation mutation
    UPDATE public.admins
    SET is_active = true,
        disabled_at = NULL,
        disabled_by = NULL,
        updated_at = NOW(),
        version = version + 1
    WHERE id = p_target_admin_id;

    -- Log administrative audit record
    INSERT INTO public.admin_audit_logs (
        actor_admin_id,
        action,
        target_admin_id,
        metadata
    ) VALUES (
        v_caller_id,
        'ADMIN_ACTIVATED',
        p_target_admin_id,
        jsonb_build_object('timestamp', NOW())
    );
END;
$FUNC$;

-- 6. Server-Side RPC: Grant Custom Permission
CREATE OR REPLACE FUNCTION public.rpc_grant_custom_permission(
    p_target_admin_id UUID,
    p_permission VARCHAR(100),
    p_is_grant BOOLEAN,
    p_bin TEXT
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
    IF v_caller_bin_hash IS NULL OR extensions.crypt(trim(p_bin), v_caller_bin_hash) != v_caller_bin_hash THEN
        RAISE EXCEPTION 'Invalid authorization BIN credential';
    END IF;

    -- Verify Target exists
    IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_target_admin_id) THEN
        RAISE EXCEPTION 'Target admin not found';
    END IF;

    -- Perform upsert custom permission
    INSERT INTO public.admin_custom_permissions (
        admin_id,
        permission,
        is_grant
    ) VALUES (
        p_target_admin_id,
        p_permission,
        p_is_grant
    )
    ON CONFLICT (admin_id, permission) DO UPDATE SET
        is_grant = EXCLUDED.is_grant;

    -- Log administrative audit record
    INSERT INTO public.admin_audit_logs (
        actor_admin_id,
        action,
        target_admin_id,
        metadata
    ) VALUES (
        v_caller_id,
        CASE WHEN p_is_grant = true THEN 'ADMIN_PERMISSION_GRANTED'::VARCHAR(100) ELSE 'ADMIN_PERMISSION_REVOKED'::VARCHAR(100) END,
        p_target_admin_id,
        jsonb_build_object('permission', p_permission, 'is_grant', p_is_grant)
    );
END;
$FUNC$;

-- 7. Server-Side RPC: Revoke Custom Permission
CREATE OR REPLACE FUNCTION public.rpc_revoke_custom_permission(
    p_target_admin_id UUID,
    p_permission VARCHAR(100),
    p_bin TEXT
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
    IF v_caller_bin_hash IS NULL OR extensions.crypt(trim(p_bin), v_caller_bin_hash) != v_caller_bin_hash THEN
        RAISE EXCEPTION 'Invalid authorization BIN credential';
    END IF;

    -- Verify Target exists
    IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_target_admin_id) THEN
        RAISE EXCEPTION 'Target admin not found';
    END IF;

    -- Perform deletion
    DELETE FROM public.admin_custom_permissions
    WHERE admin_id = p_target_admin_id AND permission = p_permission;

    -- Log administrative audit record
    INSERT INTO public.admin_audit_logs (
        actor_admin_id,
        action,
        target_admin_id,
        metadata
    ) VALUES (
        v_caller_id,
        'ADMIN_PERMISSION_REVOKED',
        p_target_admin_id,
        jsonb_build_object('permission', p_permission, 'is_revocation', true)
    );
END;
$FUNC$;

-- 8. Grant Executes to authenticated
REVOKE EXECUTE ON FUNCTION public.rpc_suspend_admin(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_suspend_admin(UUID, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.rpc_activate_admin(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_activate_admin(UUID, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.rpc_grant_custom_permission(UUID, VARCHAR, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_grant_custom_permission(UUID, VARCHAR, BOOLEAN, TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.rpc_revoke_custom_permission(UUID, VARCHAR, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_revoke_custom_permission(UUID, VARCHAR, TEXT) TO authenticated;
