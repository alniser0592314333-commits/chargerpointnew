-- Prevent concurrent QR rotations from leaving multiple active capability tokens
-- for the same customer/order. The advisory lock serializes all customer QR writers;
-- the partial unique index is the database-level invariant against any future writer.
DO $preflight_active_qr_uniqueness$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.qr_tokens
    WHERE is_active IS TRUE
    GROUP BY target_id, token_type
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'QR rotation migration blocked: duplicate active tokens exist; reconcile them explicitly before retrying';
  END IF;
END;
$preflight_active_qr_uniqueness$;

CREATE UNIQUE INDEX IF NOT EXISTS qr_tokens_one_active_token_per_target_type
  ON public.qr_tokens(target_id, token_type)
  WHERE is_active IS TRUE;

CREATE OR REPLACE FUNCTION public.rotate_customer_qr__session_guarded_impl(
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
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'Active customer not found for QR rotation'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('customer-qr:' || p_customer_id::text, 0)
  );

  -- Revalidate after acquiring the lock so a concurrent customer deactivation
  -- cannot race the initial permission wrapper's existence check.
  IF NOT EXISTS (
    SELECT 1
    FROM public.customers AS c
    WHERE c.id = p_customer_id
      AND c.is_active IS TRUE
      AND c.deleted_at IS NULL
      AND c.status <> 'DELETED'
  ) THEN
    RAISE EXCEPTION 'Active customer not found for QR rotation'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.qr_tokens
  SET is_active = FALSE
  WHERE target_id = p_customer_id
    AND token_type = 'CUSTOMER'
    AND is_active IS TRUE;

  LOOP
    v_token := replace(
      replace(
        replace(encode(public.gen_random_bytes(24), 'base64'), '+', '-'),
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

  INSERT INTO public.qr_tokens(
    id, token_hash, public_token, token_type, target_id, is_active, expires_at, created_at
  )
  VALUES (
    gen_random_uuid(),
    encode(public.digest(v_token, 'sha256'), 'hex'),
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

-- Order QR creation has the same invariant and must not return an expired token.
CREATE OR REPLACE FUNCTION public.get_or_create_order_qr__session_guarded_impl(
  p_order_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_token text;
BEGIN
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Active order not found for QR creation'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('order-qr:' || p_order_id::text, 0)
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.orders AS o
    JOIN public.customers AS c ON c.id = o.customer_id
    WHERE o.id = p_order_id
      AND o.deleted_at IS NULL
      AND o.cancelled_at IS NULL
      AND c.is_active IS TRUE
      AND c.deleted_at IS NULL
      AND c.status <> 'DELETED'
  ) THEN
    RAISE EXCEPTION 'Active order not found for QR creation'
      USING ERRCODE = '22023';
  END IF;

  SELECT qt.public_token INTO v_token
  FROM public.qr_tokens AS qt
  WHERE qt.target_id = p_order_id
    AND qt.token_type = 'ORDER'
    AND qt.is_active IS TRUE
    AND (qt.expires_at IS NULL OR qt.expires_at > now())
  ORDER BY qt.created_at DESC
  LIMIT 1;

  IF v_token IS NOT NULL THEN
    RETURN v_token;
  END IF;

  UPDATE public.qr_tokens
  SET is_active = FALSE
  WHERE target_id = p_order_id
    AND token_type = 'ORDER'
    AND is_active IS TRUE;

  LOOP
    v_token := replace(
      replace(
        replace(encode(public.gen_random_bytes(24), 'base64'), '+', '-'),
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

  INSERT INTO public.qr_tokens(
    id, token_hash, public_token, token_type, target_id, is_active, expires_at, created_at
  )
  VALUES (
    gen_random_uuid(),
    encode(public.digest(v_token, 'sha256'), 'hex'),
    v_token,
    'ORDER',
    p_order_id,
    TRUE,
    NULL,
    now()
  );

  RETURN v_token;
END;
$function$;

REVOKE ALL ON FUNCTION public.rotate_customer_qr__session_guarded_impl(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_or_create_order_qr__session_guarded_impl(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
