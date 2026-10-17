-- Customer QR portal read model.
-- The QR token is a high-entropy bearer capability. This RPC is deliberately
-- customer-token-only, returns a minimized projection, and grants no table access.
-- Apply only through an approved migration after testing against an isolated database.

CREATE OR REPLACE FUNCTION public.public_resolve_customer_portal(p_public_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_customer_id uuid;
  v_result jsonb;
  v_balance_minor bigint;
BEGIN
  -- Bound input and avoid distinguishable errors for invalid/inactive tokens.
  IF p_public_token IS NULL
     OR length(p_public_token) < 24
     OR length(p_public_token) > 64
     OR p_public_token !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN NULL;
  END IF;

  SELECT qt.target_id
    INTO v_customer_id
  FROM public.qr_tokens qt
  JOIN public.customers c ON c.id = qt.target_id
  WHERE qt.public_token = p_public_token
    AND qt.token_type = 'CUSTOMER'
    AND qt.is_active IS TRUE
    AND (qt.expires_at IS NULL OR qt.expires_at > statement_timestamp())
    AND c.is_active IS TRUE
    AND c.deleted_at IS NULL
    AND c.status <> 'DELETED'
  LIMIT 1;

  IF v_customer_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(fl.amount_minor), 0)::bigint
    INTO v_balance_minor
  FROM public.financial_ledger fl
  WHERE fl.customer_id = v_customer_id;

  SELECT jsonb_build_object(
    'customer_name', c.name,
    'customer_code', public.derive_customer_code(c.id)::text,
    'balance_minor', v_balance_minor,
    'orders', COALESCE((
      SELECT jsonb_agg(order_row ORDER BY order_created_at DESC, order_number DESC)
      FROM (
        SELECT
          o.created_at AS order_created_at,
          o.display_number AS order_number,
          jsonb_build_object(
            'order_number', o.display_number,
            'created_at', o.created_at,
            'status', o.status,
            'total_minor', COALESCE(items.total_minor, 0),
            'due_minor', COALESCE(items.due_minor, 0),
            'items', COALESCE(items.items, '[]'::jsonb)
          ) AS order_row
        FROM public.orders o
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(sum(oi.final_charge_snapshot_minor)
              FILTER (WHERE oi.cancelled_at IS NULL AND oi.deleted_at IS NULL), 0)::bigint AS total_minor,
            COALESCE(sum(
              GREATEST(oi.final_charge_snapshot_minor - COALESCE(pa.paid_minor, 0), 0)
            ) FILTER (
              WHERE oi.cancelled_at IS NULL
                AND oi.deleted_at IS NULL
                AND oi.financial_status = 'RECOGNIZED'
                AND oi.financially_recognized_at IS NOT NULL
            ), 0)::bigint AS due_minor,
            COALESCE(jsonb_agg(jsonb_build_object(
              'device_name_ar', COALESCE(dt.name_ar, dt.name, oi.device_name_snapshot),
              'device_name_en', COALESCE(dt.name_en, oi.device_name_snapshot),
              'has_charger', oi.has_charger,
              'status', oi.operational_status,
              'payment_status', CASE
                WHEN oi.financial_status = 'RECOGNIZED'
                 AND oi.financially_recognized_at IS NOT NULL
                THEN oi.payment_status ELSE 'NOT_DUE' END,
              'total_minor', oi.final_charge_snapshot_minor,
              'paid_minor', COALESCE(pa.paid_minor, 0),
              'due_minor', CASE
                WHEN oi.cancelled_at IS NULL
                 AND oi.deleted_at IS NULL
                 AND oi.financial_status = 'RECOGNIZED'
                 AND oi.financially_recognized_at IS NOT NULL
                THEN GREATEST(oi.final_charge_snapshot_minor - COALESCE(pa.paid_minor, 0), 0)
                ELSE 0 END
            ) ORDER BY oi.item_sequence)
            FILTER (WHERE oi.id IS NOT NULL AND oi.deleted_at IS NULL), '[]'::jsonb) AS items
          FROM public.order_items oi
          LEFT JOIN public.device_types dt ON dt.id = oi.device_type_id
          LEFT JOIN LATERAL (
            SELECT COALESCE(sum(pal.allocated_amount_minor), 0)::bigint AS paid_minor
            FROM public.payment_allocations pal
            WHERE pal.order_item_id = oi.id
          ) pa ON TRUE
          WHERE oi.order_id = o.id AND oi.deleted_at IS NULL
        ) items ON TRUE
        WHERE o.customer_id = v_customer_id
          AND o.deleted_at IS NULL
          AND o.cancelled_at IS NULL
        ORDER BY o.created_at DESC, o.display_number DESC
        LIMIT 30
      ) recent_orders
    ), '[]'::jsonb),
    'payment_submissions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'status', s.status,
        'payment_method', s.payment_method,
        'created_at', s.created_at,
        'reviewed_at', s.reviewed_at,
        'amount_minor', CASE WHEN s.status = 'APPROVED'
          THEN COALESCE(p.amount_minor, s.amount_minor) ELSE NULL END
      ) ORDER BY s.created_at DESC, s.id DESC)
      FROM (
        SELECT *
        FROM public.qr_payment_submissions
        WHERE customer_id = v_customer_id
        ORDER BY created_at DESC, id DESC
        LIMIT 10
      ) s
      LEFT JOIN public.payments p ON p.id = s.payment_id
    ), '[]'::jsonb),
    'goals', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'target_quantity', g.target_quantity,
        'current_progress', g.current_progress,
        'status', g.status,
        'expires_at', g.expires_at,
        'completed_at', g.completed_at,
        'bonus_minor', CASE
          WHEN g.bonus_ledger_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM public.financial_ledger bonus
                       WHERE bonus.id = g.bonus_ledger_id
                         AND bonus.customer_id = v_customer_id)
          THEN g.bonus_amount_minor ELSE NULL END,
        'bonus_recorded', (g.bonus_ledger_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.financial_ledger bonus
          WHERE bonus.id = g.bonus_ledger_id AND bonus.customer_id = v_customer_id
        ))
      ) ORDER BY g.created_at DESC)
      FROM public.goals g
      WHERE g.customer_id = v_customer_id
        AND (g.status IN ('ACTIVE', 'COMPLETED') OR g.completed_at IS NOT NULL)
    ), '[]'::jsonb)
  )
  INTO v_result
  FROM public.customers c
  WHERE c.id = v_customer_id
    AND c.is_active IS TRUE
    AND c.deleted_at IS NULL
    AND c.status <> 'DELETED';

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.public_resolve_customer_portal(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.public_resolve_customer_portal(text) TO anon, authenticated, service_role;
