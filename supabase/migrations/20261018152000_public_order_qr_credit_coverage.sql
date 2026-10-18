-- Confirm full-order credit coverage without exposing the customer's balance.
CREATE OR REPLACE FUNCTION public.public_order_qr_credit_covers_order(p_public_token text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order_id uuid;
  v_customer_id uuid;
  v_customer_balance_minor bigint;
  v_order_total_minor bigint;
BEGIN
  IF p_public_token IS NULL OR length(p_public_token) < 20 OR length(p_public_token) > 128 THEN
    RETURN false;
  END IF;

  SELECT qt.target_id INTO v_order_id
  FROM public.qr_tokens qt
  WHERE qt.public_token = p_public_token
    AND qt.token_type = 'ORDER'
    AND qt.is_active = true
    AND (qt.expires_at IS NULL OR qt.expires_at > now())
  LIMIT 1;

  IF v_order_id IS NULL THEN RETURN false; END IF;

  SELECT o.customer_id INTO v_customer_id
  FROM public.orders o
  JOIN public.customers c ON c.id = o.customer_id
  WHERE o.id = v_order_id
    AND o.deleted_at IS NULL
    AND o.cancelled_at IS NULL
    AND c.deleted_at IS NULL
    AND c.is_active = true
    AND c.status <> 'DELETED';

  IF v_customer_id IS NULL THEN RETURN false; END IF;

  SELECT coalesce(sum(fl.amount_minor), 0)::bigint
  INTO v_customer_balance_minor
  FROM public.financial_ledger fl
  WHERE fl.customer_id = v_customer_id;

  SELECT coalesce(sum(oi.final_charge_snapshot_minor), 0)::bigint
  INTO v_order_total_minor
  FROM public.order_items oi
  WHERE oi.order_id = v_order_id
    AND oi.cancelled_at IS NULL
    AND oi.deleted_at IS NULL;

  RETURN v_order_total_minor > 0
    AND v_customer_balance_minor > 0
    AND v_customer_balance_minor >= v_order_total_minor;
END;
$function$;

REVOKE ALL ON FUNCTION public.public_order_qr_credit_covers_order(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.public_order_qr_credit_covers_order(text)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- Resolve the account identifier from a valid order QR without exposing balance data.
-- The identifier is only a username; customer-account actions still require password or a verified session.
CREATE OR REPLACE FUNCTION public.public_resolve_order_customer_id(p_public_token text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_customer_id uuid;
BEGIN
  IF p_public_token IS NULL OR length(p_public_token) < 20 OR length(p_public_token) > 128 THEN
    RETURN NULL;
  END IF;

  SELECT o.customer_id INTO v_customer_id
  FROM public.qr_tokens qt
  JOIN public.orders o ON o.id = qt.target_id
  JOIN public.customers c ON c.id = o.customer_id
  WHERE qt.public_token = p_public_token
    AND qt.token_type = 'ORDER'
    AND qt.is_active = true
    AND (qt.expires_at IS NULL OR qt.expires_at > now())
    AND o.deleted_at IS NULL
    AND o.cancelled_at IS NULL
    AND c.deleted_at IS NULL
    AND c.is_active = true
    AND c.status <> 'DELETED'
  LIMIT 1;

  RETURN v_customer_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.public_resolve_order_customer_id(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.public_resolve_order_customer_id(text)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
