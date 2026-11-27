-- Extend native push to canonical manual balance top-ups without duplicating QR-payment approval notifications.
CREATE OR REPLACE FUNCTION public.trigger_native_push_for_financial_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NEW.event_type = 'PAYMENT' AND NEW.customer_id IS NOT NULL THEN
    PERFORM public.enqueue_native_push_event(
      'financial_ledger', NEW.id, 'INSERT', NEW.event_type
    );
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS native_push_manual_balance_topup ON public.financial_ledger;
CREATE TRIGGER native_push_manual_balance_topup
AFTER INSERT ON public.financial_ledger
FOR EACH ROW
EXECUTE FUNCTION public.trigger_native_push_for_financial_ledger();

COMMENT ON FUNCTION public.trigger_native_push_for_financial_ledger() IS
  'Queues native push for canonical PAYMENT ledger entries; QR-approved payments are deduplicated by the Edge Function.';
