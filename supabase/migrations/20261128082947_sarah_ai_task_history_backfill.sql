-- Backfill the still-retained task checkpoints into the sanitized history journal.
-- Updating the existing timestamp column fires only the journal capture trigger;
-- the task state itself and its sensitive payload are not changed.
UPDATE public.sarah_ai_tasks AS task
SET updated_at = task.updated_at
WHERE NOT EXISTS (
  SELECT 1
  FROM public.sarah_ai_task_history AS history
  WHERE history.auth_user_id = task.auth_user_id
    AND history.auth_session_id = task.auth_session_id
    AND history.request_id = task.request_id
);
