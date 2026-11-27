-- Record the parent order's completion time when its final active item is delivered.
DO $migration$
DECLARE
  v_definition text;
  v_old text := $old$UPDATE public.orders SET status = 'delivered', updated_at = NOW(), version = version + 1
                    WHERE id = v_rec_item.order_id;
                    PERFORM public.record_canonical_change('orders', v_rec_item.order_id, 'UPDATE', jsonb_build_object('status', 'delivered'),
                        (SELECT version FROM public.orders WHERE id = v_rec_item.order_id));$old$;
  v_new text := $new$UPDATE public.orders
                    SET status = 'delivered',
                        delivered_at = COALESCE(
                            delivered_at,
                            (SELECT max(oi.delivered_at)
                             FROM public.order_items oi
                             WHERE oi.order_id = v_rec_item.order_id
                               AND oi.operational_status = 'DELIVERED'),
                            NOW()
                        ),
                        updated_at = NOW(),
                        version = version + 1
                    WHERE id = v_rec_item.order_id;
                    PERFORM public.record_canonical_change(
                        'orders',
                        v_rec_item.order_id,
                        'UPDATE',
                        jsonb_build_object(
                            'status', 'delivered',
                            'deliveredAt', (SELECT delivered_at FROM public.orders WHERE id = v_rec_item.order_id)
                        ),
                        (SELECT version FROM public.orders WHERE id = v_rec_item.order_id)
                    );$new$;
  v_count integer;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(
    'public.execute_canonical_sync_command_unlocked_internal(uuid,text,jsonb,text,text,uuid)'::regprocedure
  );
  v_count := (pg_catalog.length(v_definition) - pg_catalog.length(pg_catalog.replace(v_definition, v_old, '')))
    / pg_catalog.length(v_old);
  IF v_count = 1 THEN
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
    EXECUTE v_definition;
  ELSIF v_count = 0
        AND pg_catalog.strpos(v_definition, 'deliveredAt') > 0
        AND pg_catalog.strpos(v_definition, 'delivered_at = COALESCE(') > 0 THEN
    NULL; -- Already fixed.
  ELSE
    RAISE EXCEPTION 'Expected one legacy order-delivery timestamp branch, found %; migration aborted', v_count;
  END IF;
END
$migration$;

-- Backfill historical completed orders from the latest delivered item timestamp.
-- The orders trigger records each versioned metadata correction in the canonical change log.
WITH candidates AS (
  SELECT o.id,
         max(i.delivered_at) FILTER (WHERE i.operational_status = 'DELIVERED') AS delivered_at
  FROM public.orders o
  JOIN public.order_items i ON i.order_id = o.id AND i.deleted_at IS NULL
  WHERE o.status = 'delivered'
    AND o.delivered_at IS NULL
  GROUP BY o.id
  HAVING bool_and(i.operational_status IN ('DELIVERED', 'CANCELLED'))
     AND bool_or(i.operational_status = 'DELIVERED')
     AND max(i.delivered_at) FILTER (WHERE i.operational_status = 'DELIVERED') IS NOT NULL
)
UPDATE public.orders o
SET delivered_at = c.delivered_at,
    updated_at = now(),
    version = o.version + 1
FROM candidates c
WHERE o.id = c.id
  AND o.status = 'delivered'
  AND o.delivered_at IS NULL;
