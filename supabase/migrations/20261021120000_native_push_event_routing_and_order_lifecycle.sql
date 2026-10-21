-- Complete native notification routing and order lifecycle events.
-- This migration only enqueues best-effort push events; it does not change accounting writes.

CREATE OR REPLACE FUNCTION public.native_push_customer_balance(p_customer_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT COALESCE(SUM(amount_minor), 0)::bigint
  FROM public.financial_ledger
  WHERE customer_id = p_customer_id;
$function$;

REVOKE ALL ON FUNCTION public.native_push_customer_balance(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.native_push_customer_balance(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.trigger_native_push_for_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.customer_id IS NOT NULL AND NEW.deleted_at IS NULL THEN
    PERFORM public.enqueue_native_push_event('orders', NEW.id, 'INSERT', 'CREATED');
  ELSIF TG_OP = 'UPDATE'
    AND OLD.status IS DISTINCT FROM NEW.status
    AND lower(COALESCE(NEW.status, '')) IN ('cancelled', 'canceled')
    AND NEW.customer_id IS NOT NULL
    AND NEW.deleted_at IS NULL THEN
    PERFORM public.enqueue_native_push_event('orders', NEW.id, 'UPDATE', 'CANCELLED');
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS native_push_order_status ON public.orders;
CREATE TRIGGER native_push_order_status
AFTER UPDATE OF status ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.trigger_native_push_for_order();

CREATE OR REPLACE FUNCTION public.trigger_native_push_for_order_item_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_order_created_at timestamptz;
  v_order_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT o.created_at, o.status
      INTO v_order_created_at, v_order_status
    FROM public.orders o
    WHERE o.id = NEW.order_id AND o.deleted_at IS NULL;

    -- Initial items are part of order creation. Notify only for a later add-on.
    IF v_order_created_at IS NOT NULL
       AND NEW.created_at > v_order_created_at + interval '1500 milliseconds'
       AND lower(COALESCE(v_order_status, '')) NOT IN ('cancelled', 'canceled') THEN
      PERFORM public.enqueue_native_push_event('order_items', NEW.id, 'INSERT', 'ADDED');
    END IF;
  ELSIF (
      (OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL)
      OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
    ) THEN
    PERFORM public.enqueue_native_push_event('order_items', NEW.id, 'UPDATE', 'CANCELLED');
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trigger_native_push_for_order_item_lifecycle() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS native_push_order_item_lifecycle ON public.order_items;
CREATE TRIGGER native_push_order_item_lifecycle
AFTER INSERT OR UPDATE OF cancelled_at, deleted_at ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.trigger_native_push_for_order_item_lifecycle();

CREATE OR REPLACE FUNCTION public.trigger_native_push_for_goal_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status
     AND upper(COALESCE(NEW.status, '')) = 'COMPLETED'
     AND NEW.customer_id IS NOT NULL THEN
    PERFORM public.enqueue_native_push_event('goals', NEW.id, 'UPDATE', 'COMPLETED');
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trigger_native_push_for_goal_completion() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS native_push_goal_completed ON public.goals;
CREATE TRIGGER native_push_goal_completed
AFTER UPDATE OF status ON public.goals
FOR EACH ROW EXECUTE FUNCTION public.trigger_native_push_for_goal_completion();
