-- Migration 00040: Atomic batch custom permissions update for subordinate administrators

CREATE OR REPLACE FUNCTION public.rpc_set_admin_custom_permissions(
    p_target_admin_id UUID,
    p_permissions TEXT[],
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
    v_perm TEXT;
BEGIN
    -- 1. Validate Caller Authentication
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    -- 2. Resolve Caller Admin Profile
    SELECT id, bin_hash, role, is_active 
    INTO v_caller_id, v_caller_bin_hash, v_caller_role, v_caller_is_active
    FROM public.admins
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    IF NOT FOUND OR v_caller_is_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Caller admin profile not found or suspended';
    END IF;

    -- 3. Verify Caller is SUPER_ADMIN
    IF v_caller_role NOT IN ('SUPER_ADMIN', 'Super Admin') THEN
        RAISE EXCEPTION 'Unauthorized operation: SUPER_ADMIN role required';
    END IF;

    -- 4. Verify Caller BIN
    IF v_caller_bin_hash IS NULL OR extensions.crypt(trim(p_bin), v_caller_bin_hash) != v_caller_bin_hash THEN
        RAISE EXCEPTION 'Invalid authorization BIN credential';
    END IF;

    -- 5. Verify Target Admin Exists
    IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_target_admin_id) THEN
        RAISE EXCEPTION 'Target admin not found';
    END IF;

    -- 6. Atomically replace custom permissions for target admin
    DELETE FROM public.admin_custom_permissions
    WHERE admin_id = p_target_admin_id;

    IF p_permissions IS NOT NULL AND array_length(p_permissions, 1) > 0 THEN
        FOREACH v_perm IN ARRAY p_permissions LOOP
            IF v_perm IS NOT NULL AND trim(v_perm) != '' THEN
                INSERT INTO public.admin_custom_permissions (
                    admin_id,
                    permission,
                    is_grant
                ) VALUES (
                    p_target_admin_id,
                    trim(v_perm),
                    TRUE
                )
                ON CONFLICT (admin_id, permission) DO UPDATE SET
                    is_grant = TRUE;
            END IF;
        END LOOP;
    END IF;

    -- 7. Record administrative audit log
    INSERT INTO public.admin_audit_logs (
        actor_admin_id,
        action,
        target_admin_id,
        metadata
    ) VALUES (
        v_caller_id,
        'ADMIN_CUSTOM_PERMISSIONS_UPDATED',
        p_target_admin_id,
        jsonb_build_object(
            'permissions_count', COALESCE(array_length(p_permissions, 1), 0),
            'timestamp', NOW()
        )
    );
END;
$FUNC$;

GRANT EXECUTE ON FUNCTION public.rpc_set_admin_custom_permissions(UUID, TEXT[], TEXT) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
