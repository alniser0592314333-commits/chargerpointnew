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

-- Local isolated CI databases do not install pg_cron. Production already has it;
-- schedule only when its catalog is present. Dynamic SQL keeps this migration
-- valid in both environments without introducing another extension dependency.
DO $schedule_sarah_task_cleanup$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $schedule$
      SELECT cron.schedule(
        'sarah-ai-task-checkpoint-cleanup',
        '17 3 * * *',
        'SELECT public.sarah_ai_purge_expired_tasks();'
      )
    $schedule$;
  END IF;
END;
$schedule_sarah_task_cleanup$;
