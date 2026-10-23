CREATE UNIQUE INDEX IF NOT EXISTS customer_debt_reminder_idempotency_idx
 ON public.customer_account_events(customer_id,(payload->>'reminder_key'))
 WHERE event_type='DEBT_PAYMENT_REMINDER' AND payload ? 'reminder_key';
CREATE OR REPLACE FUNCTION public.dispatch_customer_debt_reminders(p_reminder_key text DEFAULT NULL,p_force boolean DEFAULT false)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE v_local timestamp; v_key text; v_inserted integer:=0;
BEGIN
 v_local:=now() AT TIME ZONE 'Asia/Gaza';
 IF NOT COALESCE(p_force,false) AND NOT (extract(isodow FROM v_local)=3 AND extract(hour FROM v_local)=20 AND extract(minute FROM v_local)<15) THEN RETURN 0; END IF;
 v_key:=COALESCE(NULLIF(p_reminder_key,''),'weekly-'||to_char(v_local::date,'YYYY-MM-DD'));
 WITH balances AS (
  SELECT c.id customer_id,COALESCE(sum(fl.amount_minor),0)::bigint balance_minor
  FROM public.customers c
  JOIN public.customer_account_links l ON l.customer_id=c.id AND l.account_status='ACTIVE' AND NOT l.must_change_password
  JOIN public.financial_ledger fl ON fl.customer_id=c.id
  WHERE c.is_active IS TRUE AND c.deleted_at IS NULL AND c.status<>'DELETED'
  GROUP BY c.id HAVING COALESCE(sum(fl.amount_minor),0)<0
 ), inserted AS (
  INSERT INTO public.customer_account_events(customer_id,event_type,payload,is_read,created_at)
  SELECT b.customer_id,'DEBT_PAYMENT_REMINDER',
   jsonb_build_object('reminder_key',v_key,'balance_minor',abs(b.balance_minor),
    'message_ar','تذكير باستحقاق الدفع: المبلغ المستحق عليك '||to_char((abs(b.balance_minor)::numeric/100),'FM999999990D00')||' شيكل.',
    'message_en','Payment reminder: your outstanding amount is ILS '||to_char((abs(b.balance_minor)::numeric/100),'FM999999990D00')||'.','sent_at',now()),false,now()
  FROM balances b
  ON CONFLICT (customer_id,(payload->>'reminder_key')) WHERE event_type='DEBT_PAYMENT_REMINDER' AND payload ? 'reminder_key' DO NOTHING
  RETURNING id
 ) SELECT count(*)::integer INTO v_inserted FROM inserted;
 RETURN v_inserted;
END;$function$;
REVOKE ALL ON FUNCTION public.dispatch_customer_debt_reminders(text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_customer_debt_reminders(text,boolean) TO service_role;