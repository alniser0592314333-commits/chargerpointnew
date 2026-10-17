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
