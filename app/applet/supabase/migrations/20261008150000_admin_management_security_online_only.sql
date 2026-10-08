-- Canonical Admin Management Security + Online-only execution contract
-- Date: 2026-10-08
--
-- Goals:
-- 1. One server-side Super Admin authorization gate for subordinate-admin mutations.
-- 2. Preserve existing mutation semantics and audit actions.
-- 3. Never introduce an offline/outbox path for security-sensitive admin mutations.
-- 4. Return explicit authorization errors so the client cannot look like it silently reset.

CREATE OR REPLACE FUNCTION public.authorize_super_admin_admin_management(
  p_caller_bin TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
  v_caller_bin_hash VARCHAR(255);
  v_caller_role VARCHAR(50);
  v_caller_is_active BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '28000';
  END IF;

  SELECT id, bin_hash, role, is_active
  INTO v_caller_id, v_caller_bin_hash, v_caller_role, v_caller_is_active
  FROM public.admins
  WHERE auth_user_id = auth.uid()
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Caller admin profile not found'
      USING ERRCODE = '42501';
  END IF;

  IF v_caller_is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Caller admin profile is suspended'
      USING ERRCODE = '42501';
  END IF;

  IF upper(replace(trim(coalesce(v_caller_role, '')), ' ', '_')) <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Unauthorized operation: SUPER_ADMIN role required'
      USING ERRCODE = '42501';
  END IF;

  IF p_caller_bin IS NULL OR trim(p_caller_bin) = '' THEN
    RAISE EXCEPTION 'Authorization BIN is required'
      USING ERRCODE = '22023';
  END IF;

  IF v_caller_bin_hash IS NULL
     OR crypt(trim(p_caller_bin), v_caller_bin_hash) <> v_caller_bin_hash THEN
    RAISE EXCEPTION 'Invalid authorization BIN credential'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_caller_id;
END;
$$;

REVOKE ALL ON FUNCTION public.authorize_super_admin_admin_management(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.authorize_super_admin_admin_management(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.rpc_update_admin_password(
  p_target_admin_id UUID,
  p_new_password TEXT,
  p_caller_bin TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
  v_target_auth_user_id UUID;
  v_encrypted_password TEXT;
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_caller_bin);

  SELECT auth_user_id INTO v_target_auth_user_id
  FROM public.admins
  WHERE id = p_target_admin_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target admin account not found'
      USING ERRCODE = '23503';
  END IF;

  IF p_new_password IS NULL OR p_new_password = '' OR length(p_new_password) < 6 THEN
    RAISE EXCEPTION 'Password must be at least 6 characters'
      USING ERRCODE = '22023';
  END IF;

  v_encrypted_password := crypt(p_new_password, gen_salt('bf', 10));

  UPDATE auth.users
  SET encrypted_password = v_encrypted_password,
      updated_at = NOW()
  WHERE id = v_target_auth_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target authentication account not found'
      USING ERRCODE = '23503';
  END IF;

  UPDATE public.admins
  SET version = version + 1,
      updated_at = NOW()
  WHERE id = p_target_admin_id;

  INSERT INTO public.admin_audit_logs (
    actor_admin_id,
    action,
    target_admin_id,
    metadata
  ) VALUES (
    v_caller_id,
    'ADMIN_PASSWORD_RESET',
    p_target_admin_id,
    jsonb_build_object('timestamp', NOW())
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_update_admin_bin(
  p_target_admin_id UUID,
  p_new_bin TEXT,
  p_caller_bin TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
  v_new_bin_hash VARCHAR(255);
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_caller_bin);

  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_target_admin_id) THEN
    RAISE EXCEPTION 'Target admin account not found'
      USING ERRCODE = '23503';
  END IF;

  IF p_new_bin IS NULL OR p_new_bin = '' OR NOT (p_new_bin ~ '^[0-9]{4,}$') THEN
    RAISE EXCEPTION 'BIN must be at least 4 numeric digits'
      USING ERRCODE = '22023';
  END IF;

  v_new_bin_hash := crypt(trim(p_new_bin), gen_salt('bf', 10));

  UPDATE public.admins
  SET bin_hash = v_new_bin_hash,
      version = version + 1,
      updated_at = NOW()
  WHERE id = p_target_admin_id;

  INSERT INTO public.admin_audit_logs (
    actor_admin_id,
    action,
    target_admin_id,
    metadata
  ) VALUES (
    v_caller_id,
    'ADMIN_BIN_RESET',
    p_target_admin_id,
    jsonb_build_object('timestamp', NOW())
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_set_admin_custom_permissions(
  p_target_admin_id UUID,
  p_permissions TEXT[],
  p_bin TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
  v_perm TEXT;
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_bin);

  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_target_admin_id) THEN
    RAISE EXCEPTION 'Target admin not found'
      USING ERRCODE = '23503';
  END IF;

  DELETE FROM public.admin_custom_permissions
  WHERE admin_id = p_target_admin_id;

  IF p_permissions IS NOT NULL AND array_length(p_permissions, 1) > 0 THEN
    FOREACH v_perm IN ARRAY p_permissions LOOP
      IF v_perm IS NOT NULL AND trim(v_perm) <> '' THEN
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
$$;

CREATE OR REPLACE FUNCTION public.rpc_grant_custom_permission(
  p_target_admin_id UUID,
  p_permission VARCHAR,
  p_is_grant BOOLEAN,
  p_bin TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_bin);

  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_target_admin_id) THEN
    RAISE EXCEPTION 'Target admin not found'
      USING ERRCODE = '23503';
  END IF;

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

  INSERT INTO public.admin_audit_logs (
    actor_admin_id,
    action,
    target_admin_id,
    metadata
  ) VALUES (
    v_caller_id,
    CASE
      WHEN p_is_grant = TRUE THEN 'ADMIN_PERMISSION_GRANTED'::VARCHAR(100)
      ELSE 'ADMIN_PERMISSION_REVOKED'::VARCHAR(100)
    END,
    p_target_admin_id,
    jsonb_build_object('permission', p_permission, 'is_grant', p_is_grant)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_revoke_custom_permission(
  p_target_admin_id UUID,
  p_permission VARCHAR,
  p_bin TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_bin);

  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_target_admin_id) THEN
    RAISE EXCEPTION 'Target admin not found'
      USING ERRCODE = '23503';
  END IF;

  DELETE FROM public.admin_custom_permissions
  WHERE admin_id = p_target_admin_id
    AND permission = p_permission;

  INSERT INTO public.admin_audit_logs (
    actor_admin_id,
    action,
    target_admin_id,
    metadata
  ) VALUES (
    v_caller_id,
    'ADMIN_PERMISSION_REVOKED',
    p_target_admin_id,
    jsonb_build_object('permission', p_permission, 'is_revocation', TRUE)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_suspend_admin(
  p_target_admin_id UUID,
  p_bin TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_bin);

  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_target_admin_id) THEN
    RAISE EXCEPTION 'Target admin not found'
      USING ERRCODE = '23503';
  END IF;

  IF v_caller_id = p_target_admin_id THEN
    RAISE EXCEPTION 'Cannot suspend own administrator account'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.admins
  SET is_active = FALSE,
      disabled_at = NOW(),
      disabled_by = v_caller_id,
      updated_at = NOW(),
      version = version + 1
  WHERE id = p_target_admin_id;

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
$$;

CREATE OR REPLACE FUNCTION public.rpc_activate_admin(
  p_target_admin_id UUID,
  p_bin TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_bin);

  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_target_admin_id) THEN
    RAISE EXCEPTION 'Target admin not found'
      USING ERRCODE = '23503';
  END IF;

  UPDATE public.admins
  SET is_active = TRUE,
      disabled_at = NULL,
      disabled_by = NULL,
      updated_at = NOW(),
      version = version + 1
  WHERE id = p_target_admin_id;

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
$$;

-- Creation is also an online-only sensitive mutation. It remains a direct RPC;
-- it is never placed in the application's offline Outbox.
CREATE OR REPLACE FUNCTION public.rpc_create_admin(
  p_username TEXT,
  p_email TEXT,
  p_password TEXT,
  p_full_name TEXT,
  p_role TEXT,
  p_bin TEXT,
  p_caller_bin TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
  v_new_user_id UUID;
  v_new_admin_id UUID;
  v_clean_email VARCHAR(255);
  v_clean_username VARCHAR(100);
  v_clean_full_name VARCHAR(200);
  v_clean_role VARCHAR(50);
  v_encrypted_password TEXT;
  v_bin_hash VARCHAR(255);
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_caller_bin);

  v_clean_email := trim(lower(p_email));
  v_clean_username := trim(p_username);
  v_clean_full_name := trim(p_full_name);
  v_clean_role := trim(p_role);

  IF v_clean_role IN ('SUPER_ADMIN', 'Super Admin') THEN
    RAISE EXCEPTION 'Cannot create subordinate accounts with SUPER_ADMIN role'
      USING ERRCODE = '42501';
  END IF;

  IF v_clean_username = '' THEN
    RAISE EXCEPTION 'Username cannot be empty'
      USING ERRCODE = '22023';
  END IF;

  IF v_clean_email = '' THEN
    RAISE EXCEPTION 'Email cannot be empty'
      USING ERRCODE = '22023';
  END IF;

  IF p_password IS NULL OR p_password = '' OR length(p_password) < 6 THEN
    RAISE EXCEPTION 'Password must be at least 6 characters'
      USING ERRCODE = '22023';
  END IF;

  IF p_bin IS NULL OR p_bin = '' OR NOT (p_bin ~ '^[0-9]{4,}$') THEN
    RAISE EXCEPTION 'BIN must be at least 4 numeric digits'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM auth.users WHERE email = v_clean_email) THEN
    RAISE EXCEPTION 'An account with this email already exists'
      USING ERRCODE = '23505';
  END IF;

  IF EXISTS (SELECT 1 FROM public.admins WHERE username = v_clean_username) THEN
    RAISE EXCEPTION 'An admin account with this username already exists'
      USING ERRCODE = '23505';
  END IF;

  v_encrypted_password := crypt(p_password, gen_salt('bf', 10));
  v_bin_hash := crypt(trim(p_bin), gen_salt('bf', 10));

  INSERT INTO auth.users (
    id,
    instance_id,
    email,
    encrypted_password,
    email_confirmed_at,
    aud,
    role,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
  ) VALUES (
    gen_random_uuid(),
    '00000000-0000-0000-0000-000000000000'::UUID,
    v_clean_email,
    v_encrypted_password,
    NOW(),
    'authenticated',
    'authenticated',
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object(
      'sub', v_clean_email,
      'username', v_clean_username,
      'full_name', v_clean_full_name,
      'email', v_clean_email,
      'email_verified', TRUE,
      'phone_verified', FALSE
    ),
    NOW(),
    NOW()
  )
  RETURNING id INTO v_new_user_id;

  INSERT INTO auth.identities (
    id,
    user_id,
    identity_data,
    provider,
    provider_id,
    last_sign_in_at,
    created_at,
    updated_at,
    email
  ) VALUES (
    gen_random_uuid(),
    v_new_user_id,
    jsonb_build_object(
      'sub', v_new_user_id::text,
      'email', v_clean_email,
      'email_verified', TRUE,
      'phone_verified', FALSE
    ),
    'email',
    v_new_user_id::text,
    NOW(),
    NOW(),
    NOW(),
    v_clean_email
  );

  INSERT INTO public.admins (
    id,
    auth_user_id,
    username,
    full_name,
    email,
    role,
    is_active,
    bin_hash,
    version,
    created_at,
    updated_at
  ) VALUES (
    gen_random_uuid(),
    v_new_user_id,
    v_clean_username,
    v_clean_full_name,
    v_clean_email,
    v_clean_role,
    TRUE,
    v_bin_hash,
    1,
    NOW(),
    NOW()
  )
  RETURNING id INTO v_new_admin_id;

  INSERT INTO public.admin_audit_logs (
    actor_admin_id,
    action,
    target_admin_id,
    metadata
  ) VALUES (
    v_caller_id,
    'ADMIN_CREATED',
    v_new_admin_id,
    jsonb_build_object(
      'username', v_clean_username,
      'role', v_clean_role,
      'timestamp', NOW()
    )
  );

  RETURN v_new_admin_id;
END;
$$;

-- The public Data API must not expose the authorization helper to anonymous callers.
REVOKE ALL ON FUNCTION public.authorize_super_admin_admin_management(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.authorize_super_admin_admin_management(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.authorize_super_admin_admin_management(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
