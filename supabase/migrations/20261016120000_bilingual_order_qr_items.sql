-- Migration: 20261016120000_bilingual_order_qr_items.sql
-- Enables dynamic bilingual device names (Arabic and English) in public_resolve_order_qr

CREATE OR REPLACE FUNCTION public.public_resolve_order_qr(p_public_token text)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order_id uuid;
  v_order record;
  v_customer record;
  v_items jsonb;
  v_items_count integer;
  v_total_minor bigint;
  v_due_minor bigint;
BEGIN
  IF p_public_token IS NULL OR length(p_public_token) < 20 OR length(p_public_token) > 128 THEN
    RETURN;
  END IF;

  SELECT qt.target_id INTO v_order_id
  FROM public.qr_tokens qt
  WHERE qt.public_token = p_public_token
    AND qt.token_type = 'ORDER'
    AND qt.is_active = true
    AND (qt.expires_at IS NULL OR qt.expires_at > now())
  LIMIT 1;

  IF v_order_id IS NULL THEN RETURN; END IF;

  SELECT o.id, o.display_number, o.status, o.customer_id, o.created_at
  INTO v_order
  FROM public.orders o
  WHERE o.id = v_order_id AND o.deleted_at IS NULL AND o.cancelled_at IS NULL;

  IF v_order.id IS NULL THEN RETURN; END IF;

  SELECT c.id, c.name INTO v_customer
  FROM public.customers c
  WHERE c.id = v_order.customer_id AND c.status <> 'DELETED' AND c.is_active = true AND c.deleted_at IS NULL;

  IF v_customer.id IS NULL THEN RETURN; END IF;

  SELECT
    count(*)::integer,
    coalesce(sum(oi.final_charge_snapshot_minor) FILTER (WHERE oi.cancelled_at IS NULL), 0)::bigint,
    coalesce(sum(greatest(oi.final_charge_snapshot_minor - coalesce(pa.paid_minor, 0), 0)) FILTER (WHERE oi.cancelled_at IS NULL), 0)::bigint,
    coalesce(jsonb_agg(
      jsonb_build_object(
        'name', oi.device_name_snapshot,
        'name_ar', coalesce(dt.name_ar, dt.name, oi.device_name_snapshot),
        'name_en', dt.name_en,
        'device_type_id', oi.device_type_id,
        'status', oi.status,
        'operational_status', oi.operational_status,
        'payment_status', oi.payment_status,
        'has_charger', oi.has_charger,
        'quantity', 1,
        'unit_price_minor', oi.unit_price_minor,
        'total_price_minor', oi.final_charge_snapshot_minor,
        'paid_minor', coalesce(pa.paid_minor, 0),
        'due_minor', CASE WHEN oi.cancelled_at IS NULL
          THEN greatest(oi.final_charge_snapshot_minor - coalesce(pa.paid_minor, 0), 0)
          ELSE 0 END,
        'charger_fee_exempt', (oi.customer_charger_fee_exempt_snapshot AND oi.has_charger)
      ) ORDER BY oi.item_sequence
    ), '[]'::jsonb)
  INTO v_items_count, v_total_minor, v_due_minor, v_items
  FROM public.order_items oi
  LEFT JOIN public.device_types dt ON dt.id = oi.device_type_id
  LEFT JOIN LATERAL (
    SELECT coalesce(sum(pal.allocated_amount_minor), 0)::bigint AS paid_minor
    FROM public.payment_allocations pal
    WHERE pal.order_item_id = oi.id
  ) pa ON true
  WHERE oi.order_id = v_order.id
    AND oi.deleted_at IS NULL;

  RETURN NEXT jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.display_number,
    'customer_name', v_customer.name,
    'customer_code', left(replace(v_customer.id::text, '-', ''), 4),
    'status', v_order.status,
    'created_at', v_order.created_at,
    'items_count', v_items_count,
    'order_total_minor', v_total_minor,
    'order_due_minor', v_due_minor,
    'items', v_items
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.public_resolve_order_qr(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_resolve_order_qr(text) TO anon, authenticated, service_role;
