-- Restore the first-owner bootstrap boundary on the live schema.
-- Historical migration 00010 established that only the verified owner identity may
-- create the first Super Admin. The currently deployed function had drifted from
-- that contract and lacked serialization, allowing any signed-in Auth user to race
-- to become Super Admin if no active Super Admin row remained.

CREATE OR REPLACE FUNCTION public.bootstrap_first_super_admin(
  p_username text,
  p_full_name text DEFAULT NULL,
  p_bin text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_email text;
  v_email_confirmed_at timestamptz;
  v_admin_id uuid;
  v_owner_email constant text := 'al.niser.0592314333@gmail.com';
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '28000';
  END IF;

  -- Require a live Supabase Auth session, including during initial bootstrap.
  IF public.is_my_account_session_active() IS NOT TRUE THEN
    RAISE EXCEPTION 'Authentication session is revoked, expired, or unavailable'
      USING ERRCODE = '28000';
  END IF;

  -- Serialize first-owner attempts and re-check eligibility inside the lock.
  PERFORM pg_advisory_xact_lock(hashtext('super_admin_bootstrap_lock'));

  IF EXISTS (
    SELECT 1
    FROM public.admins a
    WHERE a.role IN ('SUPER_ADMIN', 'Super Admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'ALREADY_BOOTSTRAPPED');
  END IF;

  SELECT u.email, u.email_confirmed_at
    INTO v_email, v_email_confirmed_at
  FROM auth.users u
  WHERE u.id = auth.uid();

  IF v_email IS NULL OR v_email_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'Confirmed email required for first-owner bootstrap'
      USING ERRCODE = '42501';
  END IF;

  IF lower(btrim(v_email)) <> lower(btrim(v_owner_email)) THEN
    RAISE EXCEPTION 'This identity is not eligible for first-owner bootstrap'
      USING ERRCODE = '42501';
  END IF;

  -- Do not promote or overwrite a pre-existing admin identity through bootstrap.
  IF EXISTS (
    SELECT 1 FROM public.admins a WHERE a.auth_user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'This authenticated identity is already registered as an admin'
      USING ERRCODE = '42501';
  END IF;

  IF p_username IS NULL
     OR length(btrim(p_username)) < 3
     OR length(btrim(p_username)) > 64
     OR btrim(p_username) !~ '^[A-Za-z0-9_.-]+$' THEN
    RAISE EXCEPTION 'Username must be 3-64 characters using letters, digits, dot, underscore, or hyphen';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.admins a
    WHERE lower(a.username) = lower(btrim(p_username))
  ) THEN
    RAISE EXCEPTION 'Username is already taken'
      USING ERRCODE = '23505';
  END IF;

  IF p_bin IS NULL OR btrim(p_bin) !~ '^\d{4,}$' THEN
    RAISE EXCEPTION 'BIN must contain at least four numeric digits';
  END IF;

  INSERT INTO public.admins (
    auth_user_id, username, full_name, email, role, permissions,
    bin_hash, is_active, created_at, updated_at, version
  ) VALUES (
    auth.uid(),
    btrim(p_username),
    COALESCE(NULLIF(btrim(p_full_name), ''), btrim(p_username)),
    v_email,
    'SUPER_ADMIN',
    ARRAY[
      'orders:view','orders:create','orders:edit','orders:deliver','orders:cancel','orders:correct',
      'customers:view','customers:create','customers:edit','customers:deactivate','customers:debt-limit',
      'customers:charger-exemption','customers:financial-view','finance:view','finance:create-payment',
      'finance:approve-payment','finance:refund','finance:correction','finance:credit-adjustment',
      'devices:view','devices:manage','devices:pricing','devices:charger-policy','settings:manage',
      'admin:manage','sync:manage','sync:view','goals:view','goals:manage','goals:request','goals:approve'
    ]::text[],
    public.crypt(btrim(p_bin), public.gen_salt('bf')),
    true,
    now(),
    now(),
    1
  )
  RETURNING id INTO v_admin_id;

  RETURN jsonb_build_object(
    'success', true,
    'admin_id', v_admin_id,
    'username', btrim(p_username),
    'role', 'SUPER_ADMIN'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.bootstrap_first_super_admin(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bootstrap_first_super_admin(text, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
