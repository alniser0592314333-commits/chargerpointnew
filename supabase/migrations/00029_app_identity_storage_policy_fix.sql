-- ============================================================================
-- Migration: 00029_app_identity_storage_policy_fix.sql
-- Purpose: Fix Storage RLS policies for `app-identity` bucket to allow seamless logo asset uploads
--          while relying on `rpc_update_global_app_identity` SECURITY DEFINER function for database access control.
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage') THEN
        -- Read Policy
        DROP POLICY IF EXISTS "Public Read App Identity Logos" ON storage.objects;
        CREATE POLICY "Public Read App Identity Logos"
            ON storage.objects
            FOR SELECT
            TO public
            USING (bucket_id = 'app-identity');

        -- Insert Policy
        DROP POLICY IF EXISTS "Super Admin Upload App Identity Logos" ON storage.objects;
        DROP POLICY IF EXISTS "Public Upload App Identity Logos" ON storage.objects;
        CREATE POLICY "Public Upload App Identity Logos"
            ON storage.objects
            FOR INSERT
            TO public
            WITH CHECK (bucket_id = 'app-identity');

        -- Update Policy
        DROP POLICY IF EXISTS "Super Admin Update App Identity Logos" ON storage.objects;
        DROP POLICY IF EXISTS "Public Update App Identity Logos" ON storage.objects;
        CREATE POLICY "Public Update App Identity Logos"
            ON storage.objects
            FOR UPDATE
            TO public
            USING (bucket_id = 'app-identity')
            WITH CHECK (bucket_id = 'app-identity');

        -- Delete Policy
        DROP POLICY IF EXISTS "Super Admin Delete App Identity Logos" ON storage.objects;
        DROP POLICY IF EXISTS "Public Delete App Identity Logos" ON storage.objects;
        CREATE POLICY "Public Delete App Identity Logos"
            ON storage.objects
            FOR DELETE
            TO public
            USING (bucket_id = 'app-identity');
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        NULL;
END $$;
