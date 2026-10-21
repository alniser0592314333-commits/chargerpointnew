-- Fix the deployed native-push enqueue call for the pg_net signature in this project.
-- The installed net.http_post requires the params argument; omitting it raises 42883
-- before any outbound request is queued. Keep push best-effort and business writes safe.

CREATE OR REPLACE FUNCTION public.enqueue_native_push_event(
  p_source text,
  p_record_id uuid,
  p_operation text,
  p_new_status text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, vault, net
AS $function$
DECLARE
  v_url text;
  v_secret text;
  v_pg_net_schema text;
  v_request_id bigint;
BEGIN
  SELECT decrypted_secret INTO v_url
  FROM vault.decrypted_secrets
  WHERE name = 'native_push_function_url'
  LIMIT 1;

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'native_push_dispatch_secret'
  LIMIT 1;

  -- Push is best-effort: it must never roll back an authoritative business write.
  IF COALESCE(v_url, '') = '' OR COALESCE(v_secret, '') = '' THEN
    RETURN;
  END IF;

  SELECT n.nspname INTO v_pg_net_schema
  FROM pg_catalog.pg_extension e
  JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_net';

  IF COALESCE(v_pg_net_schema, '') = '' THEN
    RETURN;
  END IF;

  -- pg_net's current signature is http_post(url, params, headers, body,
  -- timeout_milliseconds). Supplying params explicitly avoids SQLSTATE 42883.
  EXECUTE format(
    'SELECT %I.http_post($1, $4, $2, $3, $5)',
    v_pg_net_schema
  )
  INTO v_request_id
  USING
    v_url,
    '{}'::jsonb,
    jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-dispatch-secret', v_secret
    ),
    jsonb_build_object(
      'action', 'dispatch',
      'source', p_source,
      'recordId', p_record_id::text,
      'operation', p_operation,
      'newStatus', p_new_status
    ),
    1500;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Native push enqueue failed for %.%: %', p_source, p_record_id, SQLSTATE;
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_native_push_event(text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;

-- Notify the customer when a charging order is created for their account.
CREATE OR REPLACE FUNCTION public.trigger_native_push_for_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.customer_id IS NOT NULL AND NEW.deleted_at IS NULL THEN
    PERFORM public.enqueue_native_push_event('orders', NEW.id, 'INSERT', 'CREATED');
  END IF;
  RETURN NEW;
END;
$function$;

-- Send one delivery notification only after every active item in the order
-- has reached DELIVERED; item-level updates must not produce duplicate alerts.
CREATE OR REPLACE FUNCTION public.trigger_native_push_for_order_item_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF OLD.operational_status IS DISTINCT FROM 'DELIVERED'
     AND NEW.operational_status = 'DELIVERED'
     AND NEW.deleted_at IS NULL
     AND NEW.cancelled_at IS NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.order_items i
       WHERE i.order_id = NEW.order_id
         AND i.deleted_at IS NULL
         AND i.cancelled_at IS NULL
         AND i.operational_status IS DISTINCT FROM 'DELIVERED'
     ) THEN
    PERFORM public.enqueue_native_push_event('orders', NEW.order_id, 'UPDATE', 'DELIVERED');
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trigger_native_push_for_order() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trigger_native_push_for_order_item_delivery() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS native_push_order_created ON public.orders;
CREATE TRIGGER native_push_order_created
AFTER INSERT ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.trigger_native_push_for_order();

DROP TRIGGER IF EXISTS native_push_order_fully_delivered ON public.order_items;
CREATE TRIGGER native_push_order_fully_delivered
AFTER UPDATE OF operational_status, delivered_at ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.trigger_native_push_for_order_item_delivery();
