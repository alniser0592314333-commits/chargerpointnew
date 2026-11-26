BEGIN;
CREATE TABLE IF NOT EXISTS public.sarah_ai_usage_windows (
 actor_auth_user_id uuid NOT NULL,
 window_started_at timestamptz NOT NULL,
 request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
 PRIMARY KEY(actor_auth_user_id, window_started_at)
);
ALTER TABLE public.sarah_ai_usage_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sarah_ai_usage_windows FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sarah_ai_usage_windows FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.sarah_ai_usage_windows TO service_role;
CREATE OR REPLACE FUNCTION public.sarah_ai_consume_quota(p_actor_auth_user_id uuid, p_max_requests integer DEFAULT 20, p_window_seconds integer DEFAULT 3600)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_window timestamptz; v_count integer;
BEGIN
 IF COALESCE(auth.jwt()->>'role',current_setting('request.jwt.claim.role',true)) <> 'service_role' THEN RAISE EXCEPTION 'Service role required' USING ERRCODE='42501'; END IF;
 IF p_actor_auth_user_id IS NULL OR p_max_requests NOT BETWEEN 1 AND 100 OR p_window_seconds NOT BETWEEN 60 AND 86400 THEN RAISE EXCEPTION 'Invalid quota parameters' USING ERRCODE='22023'; END IF;
 DELETE FROM public.sarah_ai_usage_windows WHERE window_started_at < now() - interval '48 hours';
 v_window := pg_catalog.to_timestamp(floor(extract(epoch FROM now())/p_window_seconds)*p_window_seconds);
 INSERT INTO public.sarah_ai_usage_windows(actor_auth_user_id,window_started_at,request_count) VALUES(p_actor_auth_user_id,v_window,1)
 ON CONFLICT(actor_auth_user_id,window_started_at) DO UPDATE SET request_count=public.sarah_ai_usage_windows.request_count+1
 RETURNING request_count INTO v_count;
 IF v_count>p_max_requests THEN RETURN jsonb_build_object('allowed',false,'remaining',0,'windowStartedAt',v_window); END IF;
 RETURN jsonb_build_object('allowed',true,'remaining',p_max_requests-v_count,'windowStartedAt',v_window);
END; $$;
REVOKE ALL ON FUNCTION public.sarah_ai_consume_quota(uuid,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sarah_ai_consume_quota(uuid,integer,integer) TO service_role;
COMMIT;