-- Supabase-native scheduler for server-side automatic delivery.
-- Before applying this migration, add these two secrets in Supabase Vault:
--   chargerpoint_supabase_url
--   chargerpoint_auto_delivery_service_role_key
-- Never place secret values in migrations or source control.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $schedule$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'chargerpoint-server-auto-delivery') THEN
    PERFORM cron.unschedule('chargerpoint-server-auto-delivery');
  END IF;

  PERFORM cron.schedule(
    'chargerpoint-server-auto-delivery',
    '0,30 14-22 * * *',
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
