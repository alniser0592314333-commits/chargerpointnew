-- Supabase-native scheduler for server-side automatic delivery.
-- Run every 30 minutes in UTC; the function enforces 17:00 Asia/Gaza locally,
-- avoiding fixed-UTC schedule drift when Palestine changes daylight-saving time.
-- Before applying this migration, add these two secrets in Supabase Vault:
--   chargerpoint_supabase_url
--   chargerpoint_auto_delivery_service_role_key
-- Never place secret values in migrations or source control.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $schedule$
DECLARE
  v_job_id bigint;
BEGIN
  -- pg_cron unschedule is keyed by job_id; do not pass the job name.
  SELECT jobid INTO v_job_id
  FROM cron.job
  WHERE jobname = 'chargerpoint-server-auto-delivery'
  ORDER BY jobid DESC
  LIMIT 1;

  IF v_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_job_id);
  END IF;

  PERFORM cron.schedule(
    'chargerpoint-server-auto-delivery',
    '*/30 * * * *',
    $job$
      WITH config AS (
        SELECT
          (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'chargerpoint_supabase_url' LIMIT 1) AS project_url,
          (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'chargerpoint_auto_delivery_service_role_key' LIMIT 1) AS service_key
      )
      SELECT net.http_post(
        url := rtrim(config.project_url, '/') || '/functions/v1/auto-deliver-pending',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || config.service_key,
          'apikey', config.service_key,
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 55000
      )
      FROM config
      WHERE config.project_url IS NOT NULL
        AND config.service_key IS NOT NULL
    $job$
  );
END
$schedule$;
