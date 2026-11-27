-- Cut over from browser-callable task RPCs after sarah-ai-chat uses
-- the new service-role-only gateway functions.
REVOKE ALL ON FUNCTION public.sarah_ai_task_load_or_create(uuid,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sarah_ai_task_checkpoint(uuid,bigint,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sarah_ai_task_resume(uuid) FROM PUBLIC, anon, authenticated, service_role;
