-- Minimal schema reproducing the deployed customer-QR resolver contract drift.
CREATE TABLE public.customers (
  id uuid PRIMARY KEY,
  name varchar(200) NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz
);

CREATE TABLE public.qr_tokens (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL,
  public_token text NOT NULL UNIQUE,
  token_type text NOT NULL,
  target_id uuid NOT NULL REFERENCES public.customers(id),
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION public.derive_customer_code(p_customer_id uuid)
RETURNS varchar
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT upper(left(replace(p_customer_id::text, '-', ''), 4))::varchar;
$function$;

-- This is the composite-return shape currently found in production.
CREATE TYPE public.public_customer_qr_result AS (
  customer_name text,
  customer_code text
);

-- Reproduce the old broken resolver: varchar is returned for a text field.
CREATE FUNCTION public.public_resolve_customer_qr(p_public_token text)
RETURNS SETOF public.public_customer_qr_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v public.qr_tokens%rowtype;
BEGIN
  SELECT * INTO v
  FROM public.qr_tokens
  WHERE public_token = p_public_token
    AND token_type = 'CUSTOMER'
    AND is_active
    AND (expires_at IS NULL OR expires_at > now());

  IF v.id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT c.name, left(replace(c.id::text, '-', ''), 4)
  FROM public.customers AS c
  WHERE c.id = v.target_id;
END;
$function$;
