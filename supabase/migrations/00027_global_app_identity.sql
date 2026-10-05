-- ============================================================================
-- Migration: 00027_global_app_identity.sql
-- Purpose: Central Source of Truth for Global Application Identity & Brand Logos.
--
-- Architecture:
-- 1. Creates `public.global_app_identity` table (Singleton Identity metadata).
--    - white_logo_url: Canonical White Logo (used for Light Theme UI & ALL QR codes)
--    - dark_logo_url: Dark Logo (used exclusively for Dark Theme UI)
--    - version: Monotonically increasing version counter for client cache invalidation
--    - ZERO Base64 strings stored in Postgres (metadata/paths/URLs only)
-- 2. Sets up `app-identity` storage bucket with deterministic path conventions:
--    - app-identity/white/
--    - app-identity/dark/
-- 3. Implements Server-Authoritative RPCs:
--    - `public.get_global_app_identity()` (Public/authenticated read)
--    - `public.update_global_app_identity()` (Protected: Super Admin only)
-- ============================================================================

-- 1. Create global_app_identity table
CREATE TABLE IF NOT EXISTS public.global_app_identity (
    id TEXT PRIMARY KEY DEFAULT 'global',
    app_name TEXT NOT NULL DEFAULT 'نظام إدارة شحن الأجهزة',
    white_logo_url TEXT,
    dark_logo_url TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed singleton row if missing
INSERT INTO public.global_app_identity (id, app_name, version, updated_at)
VALUES ('global', 'نظام إدارة شحن الأجهزة', 1, NOW())
ON CONFLICT (id) DO NOTHING;

-- Enable RLS
ALTER TABLE public.global_app_identity ENABLE ROW LEVEL SECURITY;

-- Read policy: Anyone can read global app identity for branding
DROP POLICY IF EXISTS "Public Read Global App Identity" ON public.global_app_identity;
CREATE POLICY "Public Read Global App Identity"
    ON public.global_app_identity
    FOR SELECT
    USING (true);

-- Update/Insert policy: Only Super Admin
DROP POLICY IF EXISTS "Super Admin Modify Global App Identity" ON public.global_app_identity;
CREATE POLICY "Super Admin Modify Global App Identity"
    ON public.global_app_identity
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.admins
            WHERE auth_user_id = auth.uid()
            AND role IN ('SUPER_ADMIN', 'Super Admin')
            AND (is_active IS NULL OR is_active = TRUE)
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.admins
            WHERE auth_user_id = auth.uid()
            AND role IN ('SUPER_ADMIN', 'Super Admin')
            AND (is_active IS NULL OR is_active = TRUE)
        )
    );

-- 2. Create Storage Bucket (if storage schema exists)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage') THEN
        INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        VALUES (
            'app-identity',
            'app-identity',
            true,
            5242880,
            ARRAY['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']
        )
        ON CONFLICT (id) DO UPDATE SET
            public = true,
            file_size_limit = 5242880,
            allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        NULL; -- Gracefully handle if storage extension is configured differently
END $$;

-- 3. Public RPC to fetch global app identity
CREATE OR REPLACE FUNCTION public.get_global_app_identity()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_rec RECORD;
BEGIN
    SELECT id, app_name, white_logo_url, dark_logo_url, version, updated_at, updated_by
    INTO v_rec
    FROM public.global_app_identity
    WHERE id = 'global'
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'id', 'global',
            'app_name', 'نظام إدارة شحن الأجهزة',
            'white_logo_url', NULL,
            'dark_logo_url', NULL,
            'version', 1,
            'updated_at', NOW()
        );
    END IF;

    RETURN jsonb_build_object(
        'id', v_rec.id,
        'app_name', v_rec.app_name,
        'white_logo_url', v_rec.white_logo_url,
        'dark_logo_url', v_rec.dark_logo_url,
        'version', v_rec.version,
        'updated_at', v_rec.updated_at,
        'updated_by', v_rec.updated_by
    );
END;
$$;

-- 4. Server-Authoritative Protected RPC to update global app identity
CREATE OR REPLACE FUNCTION public.update_global_app_identity(
    p_app_name TEXT DEFAULT NULL,
    p_white_logo_url TEXT DEFAULT NULL,
    p_dark_logo_url TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_caller_id UUID;
    v_is_super_admin BOOLEAN := FALSE;
    v_updated_at TIMESTAMPTZ := NOW();
    v_rec RECORD;
BEGIN
    v_caller_id := auth.uid();
    
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'AUTH_REQUIRED: Authentication required to update global app identity';
    END IF;

    -- Verify caller is active Super Admin
    SELECT EXISTS (
        SELECT 1 FROM public.admins
        WHERE auth_user_id = v_caller_id
        AND role IN ('SUPER_ADMIN', 'Super Admin')
        AND (is_active IS NULL OR is_active = TRUE)
    ) INTO v_is_super_admin;

    IF NOT v_is_super_admin THEN
        RAISE EXCEPTION 'PERMISSION_DENIED: Only Super Admin can modify global app identity';
    END IF;

    -- Upsert singleton identity
    INSERT INTO public.global_app_identity (
        id, app_name, white_logo_url, dark_logo_url, version, updated_at, updated_by
    )
    VALUES (
        'global',
        COALESCE(NULLIF(TRIM(p_app_name), ''), 'نظام إدارة شحن الأجهزة'),
        p_white_logo_url,
        p_dark_logo_url,
        1,
        v_updated_at,
        v_caller_id
    )
    ON CONFLICT (id) DO UPDATE SET
        app_name = COALESCE(NULLIF(TRIM(p_app_name), ''), public.global_app_identity.app_name),
        white_logo_url = COALESCE(p_white_logo_url, public.global_app_identity.white_logo_url),
        dark_logo_url = COALESCE(p_dark_logo_url, public.global_app_identity.dark_logo_url),
        version = public.global_app_identity.version + 1,
        updated_at = v_updated_at,
        updated_by = v_caller_id
    RETURNING * INTO v_rec;

    RETURN jsonb_build_object(
        'success', true,
        'id', v_rec.id,
        'app_name', v_rec.app_name,
        'white_logo_url', v_rec.white_logo_url,
        'dark_logo_url', v_rec.dark_logo_url,
        'version', v_rec.version,
        'updated_at', v_rec.updated_at
    );
END;
$$;
