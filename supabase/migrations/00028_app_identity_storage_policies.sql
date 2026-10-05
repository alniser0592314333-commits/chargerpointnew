-- ============================================================================
-- Migration: 00028_app_identity_storage_policies.sql
-- Purpose: Ensure `app-identity` storage bucket exists and configure explicit
--          Supabase Storage RLS policies on `storage.objects` for white/dark logos.
-- ============================================================================

-- 1. Ensure storage bucket `app-identity` exists and is public
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
        NULL;
END $$;

-- 2. Storage Policies for `app-identity` bucket
-- Read Policy: Public / Anyone can view app identity logo assets
DROP POLICY IF EXISTS "Public Read App Identity Logos" ON storage.objects;
CREATE POLICY "Public Read App Identity Logos"
    ON storage.objects
    FOR SELECT
    USING (bucket_id = 'app-identity');

-- Insert Policy: Only Super Admin can upload app identity logos
DROP POLICY IF EXISTS "Super Admin Upload App Identity Logos" ON storage.objects;
CREATE POLICY "Super Admin Upload App Identity Logos"
    ON storage.objects
    FOR INSERT
    TO authenticated
    WITH CHECK (
        bucket_id = 'app-identity' AND
        EXISTS (
            SELECT 1 FROM public.admins
            WHERE auth_user_id = auth.uid()
            AND role IN ('SUPER_ADMIN', 'Super Admin')
            AND (is_active IS NULL OR is_active = TRUE)
        )
    );

-- Update Policy: Only Super Admin can update app identity logos
DROP POLICY IF EXISTS "Super Admin Update App Identity Logos" ON storage.objects;
CREATE POLICY "Super Admin Update App Identity Logos"
    ON storage.objects
    FOR UPDATE
    TO authenticated
    USING (
        bucket_id = 'app-identity' AND
        EXISTS (
            SELECT 1 FROM public.admins
            WHERE auth_user_id = auth.uid()
            AND role IN ('SUPER_ADMIN', 'Super Admin')
            AND (is_active IS NULL OR is_active = TRUE)
        )
    )
    WITH CHECK (
        bucket_id = 'app-identity' AND
        EXISTS (
            SELECT 1 FROM public.admins
            WHERE auth_user_id = auth.uid()
            AND role IN ('SUPER_ADMIN', 'Super Admin')
            AND (is_active IS NULL OR is_active = TRUE)
        )
    );

-- Delete Policy: Only Super Admin can delete app identity logos
DROP POLICY IF EXISTS "Super Admin Delete App Identity Logos" ON storage.objects;
CREATE POLICY "Super Admin Delete App Identity Logos"
    ON storage.objects
    FOR DELETE
    TO authenticated
    USING (
        bucket_id = 'app-identity' AND
        EXISTS (
            SELECT 1 FROM public.admins
            WHERE auth_user_id = auth.uid()
            AND role IN ('SUPER_ADMIN', 'Super Admin')
            AND (is_active IS NULL OR is_active = TRUE)
        )
    );
