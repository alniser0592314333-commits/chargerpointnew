-- Restore a stable public customer-QR RPC contract.
--
-- The deployed function drifted from the repository migration contract:
-- it returned SETOF public_customer_qr_result and selected customers.name
-- (varchar) into a text result column, which raises SQLSTATE 42804 for every
-- otherwise-valid customer token. Recreate the RPC with an explicit text/text
-- return contract consumed by the public QR page.
--
-- This is the existing public customer-profile path, not a new parallel path.

DROP FUNCTION IF EXISTS public.public_resolve_customer_qr(text);

CREATE FUNCTION public.public_resolve_customer_qr(p_public_token text)
RETURNS TABLE (
  customer_name text,
  customer_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_target_id uuid;
BEGIN
  IF p_public_token IS NULL OR btrim(p_public_token) = '' THEN
    RETURN;
  END IF;

  SELECT qt.target_id
    INTO v_target_id
  FROM public.qr_tokens AS qt
  JOIN public.customers AS c
    ON c.id = qt.target_id
  WHERE qt.public_token = p_public_token
    AND qt.token_type = 'CUSTOMER'
    AND qt.is_active = TRUE
    AND (qt.expires_at IS NULL OR qt.expires_at > now())
    AND c.is_active = TRUE
    AND c.deleted_at IS NULL
    AND c.status <> 'DELETED'
  LIMIT 1;

  IF v_target_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    c.name::text,
    public.derive_customer_code(c.id)::text
  FROM public.customers AS c
  WHERE c.id = v_target_id
    AND c.is_active = TRUE
    AND c.deleted_at IS NULL
    AND c.status <> 'DELETED';
END;
$function$;

-- The resolver intentionally exposes only a customer's public name and code.
REVOKE ALL ON FUNCTION public.public_resolve_customer_qr(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_resolve_customer_qr(text) TO anon, authenticated;

-- Keep the existing get-or-create RPC path, but make its internal implementation
-- authoritative for active customers, token expiry, hashing, and concurrency.
CREATE OR REPLACE FUNCTION public.get_or_create_customer_qr__session_guarded_impl(
  p_customer_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_token text;
BEGIN
  IF p_customer_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.customers AS c
    WHERE c.id = p_customer_id
      AND c.is_active = TRUE
      AND c.deleted_at IS NULL
      AND c.status <> 'DELETED'
  ) THEN
    RAISE EXCEPTION 'Active customer not found for QR creation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('customer-qr:' || p_customer_id::text, 0));

  SELECT qt.public_token
    INTO v_token
  FROM public.qr_tokens AS qt
  WHERE qt.target_id = p_customer_id
    AND qt.token_type = 'CUSTOMER'
    AND qt.is_active = TRUE
    AND (qt.expires_at IS NULL OR qt.expires_at > now())
  ORDER BY qt.created_at DESC
  LIMIT 1;

  IF v_token IS NOT NULL THEN
    RETURN v_token;
  END IF;

  UPDATE public.qr_tokens
  SET is_active = FALSE
  WHERE target_id = p_customer_id
    AND token_type = 'CUSTOMER'
    AND is_active = TRUE;

  LOOP
    v_token := replace(
      replace(
        replace(encode(gen_random_bytes(24), 'base64'), '+', '-'),
        '/',
        '_'
      ),
      '=',
      ''
    );
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.qr_tokens AS qt WHERE qt.public_token = v_token
    );
  END LOOP;

  INSERT INTO public.qr_tokens (
    id, token_hash, public_token, token_type, target_id, is_active, expires_at, created_at
  )
  VALUES (
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

REVOKE ALL ON FUNCTION public.get_or_create_customer_qr__session_guarded_impl(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the existing RPC entry point used by the app. The guard remains
-- on the exposed wrapper; the internal implementation cannot be called directly.
CREATE OR REPLACE FUNCTION public.get_or_create_customer_qr(p_customer_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.assert_my_account_session_active();
  RETURN public.get_or_create_customer_qr__session_guarded_impl(p_customer_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_or_create_customer_qr(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_or_create_customer_qr(uuid) TO authenticated, service_role;

-- Safely adopt an older local-only QR token when the central database has
-- no current token for this customer. This is used by the existing customer QR
-- creation flow to preserve old links where the original token is still local.
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

  IF p_customer_id IS NULL
     OR p_public_token IS NULL
     OR p_public_token !~ '^[A-Za-z0-9_-]{24,64}
DECLARE
  v_result_type text;
BEGIN
  SELECT pg_get_function_result('public.public_resolve_customer_qr(text)'::regprocedure)
    INTO v_result_type;

  IF v_result_type <> 'TABLE(customer_name text, customer_code text)' THEN
    RAISE EXCEPTION 'Unexpected public customer QR resolver contract: %', v_result_type;
  END IF;
END;
$verification$;
 THEN
    RAISE EXCEPTION 'Invalid legacy customer QR identity';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.customers AS c
    WHERE c.id = p_customer_id
      AND c.is_active = TRUE
      AND c.deleted_at IS NULL
      AND c.status <> 'DELETED'
  ) THEN
    RAISE EXCEPTION 'Active customer not found for legacy QR adoption';
  END IF;

  -- Serialize adoption/creation for this customer. Never replace a live
  -- central token: it may already be printed and shared.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_customer_id::text, 0));

  SELECT qt.public_token
    INTO v_existing_token
  FROM public.qr_tokens AS qt
  WHERE qt.target_id = p_customer_id
    AND qt.token_type = 'CUSTOMER'
    AND qt.is_active = TRUE
    AND (qt.expires_at IS NULL OR qt.expires_at > now())
  LIMIT 1;

  IF v_existing_token IS NOT NULL THEN
    RETURN v_existing_token;
  END IF;

  -- Expired active identities must not remain active alongside the new one.
  UPDATE public.qr_tokens
  SET is_active = FALSE
  WHERE target_id = p_customer_id
    AND token_type = 'CUSTOMER'
    AND is_active = TRUE;

  -- Preserve the old URL only if this capability value has never been
  -- registered. A previously revoked token must not be reactivated.
  v_token := p_public_token;
  IF EXISTS (
    SELECT 1 FROM public.qr_tokens AS qt WHERE qt.public_token = v_token
  ) THEN
    LOOP
      v_token := replace(
        replace(
          replace(encode(gen_random_bytes(24), 'base64'), '+', '-'),
          '/',
          '_'
        ),
        '=',
        ''
      );
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM public.qr_tokens AS qt WHERE qt.public_token = v_token
      );
    END LOOP;
  END IF;

  INSERT INTO public.qr_tokens (
    id, token_hash, public_token, token_type, target_id, is_active, expires_at, created_at
  )
  VALUES (
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
GRANT EXECUTE ON FUNCTION public.adopt_customer_qr_token(uuid, text) TO authenticated;

-- Fail migration immediately if the RPC's PostgREST-visible return contract drifts.
DO $verification$
DECLARE
  v_result_type text;
BEGIN
  SELECT pg_get_function_result('public.public_resolve_customer_qr(text)'::regprocedure)
    INTO v_result_type;

  IF v_result_type <> 'TABLE(customer_name text, customer_code text)' THEN
    RAISE EXCEPTION 'Unexpected public customer QR resolver contract: %', v_result_type;
  END IF;
END;
$verification$;
