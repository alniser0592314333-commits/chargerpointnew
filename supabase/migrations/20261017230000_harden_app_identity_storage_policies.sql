-- Restore the intended Super Admin-only write boundary for app identity logos.
-- Migration 00029 introduced PUBLIC write policies for the app-identity bucket,
-- allowing anonymous uploads, overwrites, and deletion. Migration 00030 added
-- authenticated policies but did not remove those PUBLIC policies.

CREATE OR REPLACE FUNCTION public.is_active_super_admin_session()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT auth.uid() IS NOT NULL
     AND public.is_my_account_session_active() IS TRUE
     AND EXISTS (
       SELECT 1
       FROM public.admins a
       WHERE a.auth_user_id = auth.uid()
         AND a.is_active IS TRUE
         AND a.role IN ('SUPER_ADMIN', 'Super Admin')
     );
$function$;

REVOKE ALL ON FUNCTION public.is_active_super_admin_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_super_admin_session() TO authenticated;

DO $storage_policies$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RETURN;
  END IF;

  DROP POLICY IF EXISTS "Public Upload App Identity Logos" ON storage.objects;
  DROP POLICY IF EXISTS "Public Update App Identity Logos" ON storage.objects;
  DROP POLICY IF EXISTS "Public Delete App Identity Logos" ON storage.objects;
  DROP POLICY IF EXISTS "Public Read Access" ON storage.objects;

  DROP POLICY IF EXISTS "Super Admin Upload App Identity Logos" ON storage.objects;
  DROP POLICY IF EXISTS "Super Admin Update App Identity Logos" ON storage.objects;
  DROP POLICY IF EXISTS "Super Admin Delete App Identity Logos" ON storage.objects;
  DROP POLICY IF EXISTS "Admin Insert Access" ON storage.objects;
  DROP POLICY IF EXISTS "Admin Update Access" ON storage.objects;
  DROP POLICY IF EXISTS "Admin Delete Access" ON storage.objects;
  DROP POLICY IF EXISTS "Public Read App Identity Logos" ON storage.objects;

  CREATE POLICY "Public Read App Identity Logos"
    ON storage.objects
    FOR SELECT
    TO public
    USING (bucket_id = 'app-identity');

  CREATE POLICY "Super Admin Upload App Identity Logos"
    ON storage.objects
    FOR INSERT
    TO authenticated
    WITH CHECK (
      bucket_id = 'app-identity'
      AND public.is_active_super_admin_session()
    );

  CREATE POLICY "Super Admin Update App Identity Logos"
    ON storage.objects
    FOR UPDATE
    TO authenticated
    USING (
      bucket_id = 'app-identity'
      AND public.is_active_super_admin_session()
    )
    WITH CHECK (
      bucket_id = 'app-identity'
      AND public.is_active_super_admin_session()
    );

  CREATE POLICY "Super Admin Delete App Identity Logos"
    ON storage.objects
    FOR DELETE
    TO authenticated
    USING (
      bucket_id = 'app-identity'
      AND public.is_active_super_admin_session()
    );
END
$storage_policies$;

NOTIFY pgrst, 'reload schema';
