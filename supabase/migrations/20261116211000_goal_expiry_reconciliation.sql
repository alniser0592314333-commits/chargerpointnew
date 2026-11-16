-- Reconcile expired active goals even when no order-item update occurs.
-- The evaluator is server-authoritative: it locks each active goal, recalculates
-- delivered/recognized items, and either completes it (granting its ledger
-- bonus exactly once) or marks it failed after expiry.
DO $migration$
DECLARE
  v_job_id bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_extension
    WHERE extname = 'pg_cron'
  ) THEN
    RAISE EXCEPTION 'pg_cron is required to schedule expired-goal reconciliation';
  END IF;

  SELECT jobid INTO v_job_id
  FROM cron.job
  WHERE jobname = 'chargerpoint-expired-goals';

  IF v_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_job_id);
  END IF;

  PERFORM cron.schedule(
    'chargerpoint-expired-goals',
    '* * * * *',
    $command$
      SELECT public.evaluate_customer_active_goal_internal(g.customer_id)
      FROM public.goals AS g
      WHERE g.status = 'ACTIVE'
        AND g.expires_at <= now()
      GROUP BY g.customer_id;
    $command$
  );

  IF NOT EXISTS (
    SELECT 1
    FROM cron.job
    WHERE jobname = 'chargerpoint-expired-goals'
      AND active IS TRUE
      AND schedule = '* * * * *'
  ) THEN
    RAISE EXCEPTION 'Failed to register chargerpoint-expired-goals cron job';
  END IF;
END;
$migration$;

COMMENT ON FUNCTION public.evaluate_customer_active_goal_internal(uuid)
IS 'Server-authoritative goal reconciliation; invoked by item lifecycle triggers and the expired-goal cron job.';
