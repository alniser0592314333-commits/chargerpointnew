-- Isolated behavioral quota regression; run after quota migration.
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false);
DO $quota_test$
DECLARE r jsonb; actor1 uuid:='00000000-0000-0000-0000-000000000101'; actor2 uuid:='00000000-0000-0000-0000-000000000102';
BEGIN
 r:=public.sarah_ai_consume_quota(actor1,2,3600); IF r->>'allowed'<>'true' THEN RAISE EXCEPTION 'first request must be allowed'; END IF;
 r:=public.sarah_ai_consume_quota(actor1,2,3600); IF r->>'allowed'<>'true' THEN RAISE EXCEPTION 'second request must be allowed'; END IF;
 r:=public.sarah_ai_consume_quota(actor1,2,3600); IF r->>'allowed'<>'false' THEN RAISE EXCEPTION 'quota must reject excess request'; END IF;
 r:=public.sarah_ai_consume_quota(actor2,2,3600); IF r->>'allowed'<>'true' THEN RAISE EXCEPTION 'quota must be isolated per actor'; END IF;
 BEGIN
  PERFORM public.sarah_ai_consume_quota(NULL,2,3600);
  RAISE EXCEPTION 'null actor must be rejected';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END;$quota_test$;
RESET ROLE;
DO $priv$
BEGIN
 IF has_table_privilege('anon','public.sarah_ai_usage_windows','SELECT') OR has_table_privilege('authenticated','public.sarah_ai_usage_windows','SELECT') THEN RAISE EXCEPTION 'usage windows exposed to browser roles'; END IF;
 IF has_function_privilege('anon','public.sarah_ai_consume_quota(uuid,integer,integer)','EXECUTE') OR has_function_privilege('authenticated','public.sarah_ai_consume_quota(uuid,integer,integer)','EXECUTE') THEN RAISE EXCEPTION 'quota RPC exposed to browser roles'; END IF;
END;$priv$;