-- Upsert app-identity bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'app-identity', 
  'app-identity', 
  true, 
  5242880, 
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Ensure policies are created properly
DROP POLICY IF EXISTS "Public Read Access" ON storage.objects;
DROP POLICY IF EXISTS "Admin Insert Access" ON storage.objects;
DROP POLICY IF EXISTS "Admin Update Access" ON storage.objects;
DROP POLICY IF EXISTS "Admin Delete Access" ON storage.objects;

-- 1. Public Read
CREATE POLICY "Public Read Access" ON storage.objects
FOR SELECT
TO public
USING (bucket_id = 'app-identity');

-- 2. Admin Insert
CREATE POLICY "Admin Insert Access" ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'app-identity' AND 
  EXISTS (SELECT 1 FROM admins WHERE auth_user_id = auth.uid())
);

-- 3. Admin Update
CREATE POLICY "Admin Update Access" ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'app-identity' AND 
  EXISTS (SELECT 1 FROM admins WHERE auth_user_id = auth.uid())
);

-- 4. Admin Delete
CREATE POLICY "Admin Delete Access" ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'app-identity' AND 
  EXISTS (SELECT 1 FROM admins WHERE auth_user_id = auth.uid())
);
