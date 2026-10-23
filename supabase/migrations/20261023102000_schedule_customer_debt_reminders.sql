DO $schedule$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname='customer-debt-reminders-wed-8pm';
  PERFORM cron.schedule('customer-debt-reminders-wed-8pm','*/15 * * * *','SELECT public.dispatch_customer_debt_reminders(NULL, false);');
 END IF;
END;
$schedule$;