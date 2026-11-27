-- Purge Sarah orchestration checkpoints after their seven-day resume window.
-- Task contents may include customer and financial tool results, so expired rows
-- must not remain indefinitely in the private checkpoint table.

CREATE OR REPLACE FUNCTION public.sarah_ai_purge_expired_tasks()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_deleted bigint;
BEGIN
  DELETE FROM public.sarah_ai_tasks
  WHERE expires_at <= statement_timestamp();

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_purge_expired_tasks() FROM PUBLIC, anon, authenticated, service_role;

-- pg_cron is already enabled in this project. Reusing the stable job name
-- updates the schedule safely if this migration is reapplied.
SELECT cron.schedule(
  'sarah-ai-task-checkpoint-cleanup',
  '17 3 * * *',
  'SELECT public.sarah_ai_purge_expired_tasks();'
);
