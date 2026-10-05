-- Migration 00036: Fix public.admins RLS Infinite Recursion & Provision rpc_fetch_admins

-- 1. Drop existing recursive policies on public.admins
DROP POLICY IF EXISTS "Allow authenticated read of admins" ON public.admins;
DROP POLICY IF EXISTS "Allow Super Admin write of admins" ON public.admins;
DROP POLICY IF EXISTS "Allow Super Admin insert of admins" ON public.admins;
DROP POLICY IF EXISTS "Allow Super Admin update of admins" ON public.admins;
DROP POLICY IF EXISTS "Allow Super Admin delete of admins" ON public.admins;

-- 2. Create non-recursive, split-command policies for public.admins
-- FOR SELECT: Authenticated users can only read their own admin record directly via REST SELECT
CREATE POLICY "Allow authenticated self read of admins" ON public.admins
    FOR SELECT TO authenticated USING (
        auth_user_id = auth.uid()
    );

-- Write policies (INSERT, UPDATE, DELETE) are kept separate from SELECT to prevent FOR ALL recursion
CREATE POLICY "Allow Super Admin insert of admins" ON public.admins
    FOR INSERT TO authenticated WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.admins 
            WHERE auth_user_id = auth.uid() 
              AND role = 'SUPER_ADMIN' 
              AND is_active = true
        )
    );

CREATE POLICY "Allow Super Admin update of admins" ON public.admins
    FOR UPDATE TO authenticated USING (
        EXISTS (
            SELECT 1 FROM public.admins 
            WHERE auth_user_id = auth.uid() 
              AND role = 'SUPER_ADMIN' 
              AND is_active = true
        )
    );

CREATE POLICY "Allow Super Admin delete of admins" ON public.admins
    FOR DELETE TO authenticated USING (
        EXISTS (
            SELECT 1 FROM public.admins 
            WHERE auth_user_id = auth.uid() 
              AND role = 'SUPER_ADMIN' 
              AND is_active = true
        )
    );

-- 3. Provision SECURITY DEFINER RPC: rpc_fetch_admins
-- Safe identity resolution without RLS self-recursion, filtering for authorized Admin Management callers
CREATE OR REPLACE FUNCTION public.rpc_fetch_admins()
RETURNS TABLE (
    id UUID,
    username VARCHAR(100),
    full_name VARCHAR(200),
    email VARCHAR(255),
    role VARCHAR(50),
    is_active BOOLEAN,
    version INTEGER,
    created_at TIMESTAMPTZ,
    disabled_at TIMESTAMPTZ,
    disabled_by UUID
)
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
LANGUAGE plpgsql
AS $FUNC$
DECLARE
    v_caller_id UUID;
    v_caller_role VARCHAR(50);
    v_caller_is_active BOOLEAN;
BEGIN
    -- 1. Validate caller authentication
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    -- 2. Resolve caller admin profile safely (SECURITY DEFINER bypasses RLS recursion)
    SELECT a.id, a.role, a.is_active 
    INTO v_caller_id, v_caller_role, v_caller_is_active
    FROM public.admins a
    WHERE a.auth_user_id = auth.uid()
    LIMIT 1;

    IF NOT FOUND OR v_caller_is_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Caller admin profile not found or suspended';
    END IF;

    -- 3. Verify caller authorization (SUPER_ADMIN or admin:manage permission)
    IF v_caller_role NOT IN ('SUPER_ADMIN', 'Super Admin') THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.get_effective_permissions(v_caller_id)
            WHERE permission IN ('admin:manage', 'SUPER_ADMIN')
        ) THEN
            RAISE EXCEPTION 'Forbidden: Admin lacks required permission "admin:manage"';
        END IF;
    END IF;

    -- 4. Return safe admin rows (NEVER return bin_hash, passwords, or credential secrets)
    RETURN QUERY
    SELECT 
        a.id,
        a.username,
        a.full_name,
        a.email,
        a.role,
        a.is_active,
        a.version,
        a.created_at,
        a.disabled_at,
        a.disabled_by
    FROM public.admins a
    ORDER BY a.username ASC;
END;
$FUNC$;

GRANT EXECUTE ON FUNCTION public.rpc_fetch_admins() TO anon, authenticated, service_role;

-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';

