-- Close authorization gaps in authenticated-only policies and SECURITY DEFINER QR wrappers.
-- The earlier session-management migration adds a session check, but an authenticated
-- session is not itself proof that the identity belongs to an active application admin.
-- Do not touch policies that also grant anon/PUBLIC access (public QR capability routes).

DO $policies$
DECLARE
  p record;
  v_using text;
  v_check text;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND roles = ARRAY['authenticated']::name[]
  LOOP
    IF p.cmd IN ('SELECT', 'UPDATE', 'DELETE', 'ALL')
       AND position('is_active_admin_session' IN COALESCE(p.qual, '')) = 0 THEN
      v_using := COALESCE(p.qual, 'true');
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I USING ((%s) AND public.is_active_admin_session())',
        p.policyname, p.schemaname, p.tablename, v_using
      );
    END IF;

    IF p.cmd IN ('INSERT', 'UPDATE', 'ALL')
       AND position('is_active_admin_session' IN COALESCE(p.with_check, p.qual, '')) = 0 THEN
      v_check := COALESCE(p.with_check, p.qual, 'true');
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I WITH CHECK ((%s) AND public.is_active_admin_session())',
        p.policyname, p.schemaname, p.tablename, v_check
      );
    END IF;
  END LOOP;
END
$policies$;

-- These SECURITY DEFINER functions bypass table RLS. Session validity alone is
-- insufficient: only an active application admin may create/adopt QR identities.
CREATE OR REPLACE FUNCTION public.get_or_create_customer_qr(p_customer_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.assert_my_account_session_active();
  IF COALESCE(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) IS DISTINCT FROM 'service_role'
     AND public.is_active_admin_session() IS NOT TRUE THEN
    RAISE EXCEPTION 'Active administrator account required'
      USING ERRCODE = '42501';
  END IF;
  RETURN public.get_or_create_customer_qr__session_guarded_impl(p_customer_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_or_create_customer_qr(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_or_create_customer_qr(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.adopt_customer_qr_token(
  p_customer_id uuid,
  p_public_token text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_existing_token text;
  v_token text;
BEGIN
  PERFORM public.assert_my_account_session_active();
  IF COALESCE(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) IS DISTINCT FROM 'service_role'
     AND public.is_active_admin_session() IS NOT TRUE THEN
    RAISE EXCEPTION 'Active administrator account required'
      USING ERRCODE = '42501';
  END IF;

  IF p_customer_id IS NULL
     OR p_public_token IS NULL
     OR p_public_token !~ '^[A-Za-z0-9_-]{24,64}$' THEN
    RAISE EXCEPTION 'Invalid legacy customer QR identity';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.customers AS c
    WHERE c.id = p_customer_id
      AND c.is_active = TRUE
      AND c.deleted_at IS NULL
      AND c.status <> 'DELETED'
  ) THEN
    RAISE EXCEPTION 'Active customer not found for legacy QR adoption';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('customer-qr:' || p_customer_id::text, 0));

  SELECT qt.public_token INTO v_existing_token
  FROM public.qr_tokens AS qt
  WHERE qt.target_id = p_customer_id
    AND qt.token_type = 'CUSTOMER'
    AND qt.is_active = TRUE
    AND (qt.expires_at IS NULL OR qt.expires_at > now())
  LIMIT 1;

  IF v_existing_token IS NOT NULL THEN
    RETURN v_existing_token;
  END IF;

  UPDATE public.qr_tokens
  SET is_active = FALSE
  WHERE target_id = p_customer_id
    AND token_type = 'CUSTOMER'
    AND is_active = TRUE;

  v_token := p_public_token;
  IF EXISTS (SELECT 1 FROM public.qr_tokens AS qt WHERE qt.public_token = v_token) THEN
    LOOP
      v_token := replace(replace(replace(encode(gen_random_bytes(24), 'base64'), '+', '-'), '/', '_'), '=', '');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.qr_tokens AS qt WHERE qt.public_token = v_token);
    END LOOP;
  END IF;

  INSERT INTO public.qr_tokens (
    id, token_hash, public_token, token_type, target_id, is_active, expires_at, created_at
  ) VALUES (
    gen_random_uuid(),
    encode(digest(v_token, 'sha256'), 'hex'),
    v_token,
    'CUSTOMER',
    p_customer_id,
    TRUE,
    NULL,
    now()
  );

  RETURN v_token;
END;
$function$;

REVOKE ALL ON FUNCTION public.adopt_customer_qr_token(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adopt_customer_qr_token(uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
