BEGIN;

CREATE OR REPLACE FUNCTION public.sarah_ai_lookup_customer_accounts(p_query text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session_id uuid;
  v_query text;
  v_result jsonb;
  v_quota jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();
  PERFORM public._cp_assert_active_admin_permission('customers:view');
  PERFORM public._cp_assert_active_admin_permission('customers:deactivate');

  IF auth.uid() IS NULL OR COALESCE(auth.jwt()->>'session_id','')='' THEN
    RAISE EXCEPTION 'Authenticated session required' USING ERRCODE='28000';
  END IF;
  v_session_id:=(auth.jwt()->>'session_id')::uuid;

  IF p_query IS NULL OR pg_catalog.char_length(p_query)>64 OR p_query ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Customer account lookup query must be 2 to 64 printable characters' USING ERRCODE='22023';
  END IF;
  v_query:=pg_catalog.regexp_replace(pg_catalog.btrim(p_query),'\s+',' ','g');
  IF pg_catalog.char_length(v_query)<2 THEN
    RAISE EXCEPTION 'Customer account lookup query must be 2 to 64 printable characters' USING ERRCODE='22023';
  END IF;

  v_quota:=public.sarah_ai_consume_my_quota('tool_hour');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_QUOTA_EXCEEDED' USING ERRCODE='P0001';
  END IF;
  v_quota:=public.sarah_ai_consume_my_quota('tool_day');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_DAILY_LIMIT_REACHED' USING ERRCODE='P0001';
  END IF;

  DELETE FROM public.sarah_ai_customer_lookup_proofs WHERE expires_at<=now();
  INSERT INTO public.sarah_ai_customer_lookup_proofs(
    auth_user_id,auth_session_id,customer_id,customer_code,expires_at
  )
  SELECT auth.uid(),v_session_id,c.id,
    pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text,'-',''),4)),
    now()+interval '5 minutes'
  FROM public.customers c
  WHERE c.deleted_at IS NULL AND COALESCE(c.status,'')<>'DELETED'
    AND (
      pg_catalog.strpos(pg_catalog.lower(c.name),pg_catalog.lower(v_query))>0
      OR pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text,'-',''),4))=pg_catalog.upper(v_query)
    )
  ORDER BY c.name,c.id
  LIMIT 5
  ON CONFLICT(auth_user_id,auth_session_id,customer_id)
  DO UPDATE SET customer_code=EXCLUDED.customer_code,created_at=now(),expires_at=now()+interval '5 minutes';

  WITH candidates AS (
    SELECT c.id,
      pg_catalog.left(pg_catalog.regexp_replace(pg_catalog.btrim(c.name),'[[:cntrl:]]',' ','g'),80) AS customer_name,
      pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text,'-',''),4)) AS customer_code,
      c.is_active
    FROM public.customers c
    WHERE c.deleted_at IS NULL AND COALESCE(c.status,'')<>'DELETED'
      AND (
        pg_catalog.strpos(pg_catalog.lower(c.name),pg_catalog.lower(v_query))>0
        OR pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text,'-',''),4))=pg_catalog.upper(v_query)
      )
    ORDER BY c.name,c.id
    LIMIT 6
  ),
  ranked AS (
    SELECT candidates.*,pg_catalog.row_number() OVER(ORDER BY customer_name,id) AS match_number
    FROM candidates
  )
  SELECT pg_catalog.jsonb_build_object(
    'matches',COALESCE(
      pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'customer_name',customer_name,
        'customer_code',customer_code,
        'is_active',is_active
      ) ORDER BY match_number) FILTER(WHERE match_number<=5),
      '[]'::jsonb
    ),
    'match_count',LEAST(pg_catalog.count(*)::integer,5),
    'has_more',pg_catalog.count(*)>5
  )
  INTO v_result FROM ranked;

  RETURN COALESCE(v_result,pg_catalog.jsonb_build_object('matches','[]'::jsonb,'match_count',0,'has_more',false));
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_lookup_customer_accounts(text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_lookup_customer_accounts(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.sarah_ai_set_customer_active_status(
  p_request_id uuid,
  p_customer_code text,
  p_name_hint text,
  p_is_active boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session_id uuid;
  v_customer_id uuid;
  v_customer_ids uuid[];
  v_current_version integer;
  v_current_name text;
  v_current_active boolean;
  v_code text;
  v_hint text;
  v_request_payload jsonb;
  v_existing_action text;
  v_existing_payload jsonb;
  v_saved_result jsonb;
  v_command_result jsonb;
  v_quota jsonb;
  v_result jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();
  PERFORM public._cp_assert_active_admin_permission('customers:view');
  PERFORM public._cp_assert_active_admin_permission('customers:edit');
  PERFORM public._cp_assert_active_admin_permission('customers:deactivate');

  IF p_request_id IS NULL OR p_is_active IS NULL OR auth.uid() IS NULL
     OR COALESCE(auth.jwt()->>'session_id','')='' THEN
    RAISE EXCEPTION 'Authenticated session, target state, and stable request id required' USING ERRCODE='22023';
  END IF;
  v_session_id:=(auth.jwt()->>'session_id')::uuid;

  IF p_customer_code IS NULL OR pg_catalog.btrim(p_customer_code) !~* '^[A-F0-9]{4}$' THEN
    RAISE EXCEPTION 'Customer code must be exactly four hexadecimal characters' USING ERRCODE='22023';
  END IF;
  v_code:=pg_catalog.upper(pg_catalog.btrim(p_customer_code));
  v_hint:=NULLIF(pg_catalog.regexp_replace(pg_catalog.btrim(COALESCE(p_name_hint,'')),'\s+',' ','g'),'');
  IF v_hint IS NULL OR pg_catalog.char_length(v_hint)<2 OR pg_catalog.char_length(v_hint)>64
     OR v_hint ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Customer name hint must be 2 to 64 printable characters' USING ERRCODE='22023';
  END IF;

  SELECT pg_catalog.array_agg(match.id ORDER BY match.name,match.id)
    INTO v_customer_ids
  FROM (
    SELECT c.id,c.name
    FROM public.customers c
    JOIN public.sarah_ai_customer_lookup_proofs proof
      ON proof.customer_id=c.id
     AND proof.auth_user_id=auth.uid()
     AND proof.auth_session_id=v_session_id
     AND proof.customer_code=v_code
     AND proof.expires_at>now()
    WHERE c.deleted_at IS NULL AND COALESCE(c.status,'')<>'DELETED'
      AND pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text,'-',''),4))=v_code
      AND pg_catalog.strpos(pg_catalog.lower(c.name),pg_catalog.lower(v_hint))>0
    FOR UPDATE OF c
  ) AS match;
  IF COALESCE(pg_catalog.cardinality(v_customer_ids),0)=0 THEN
    RAISE EXCEPTION 'Customer account lookup proof is missing, expired, or target was deleted' USING ERRCODE='42501';
  ELSIF pg_catalog.cardinality(v_customer_ids)>1 THEN
    RAISE EXCEPTION 'Customer account target is ambiguous; use a more distinctive name from lookup results' USING ERRCODE='P0409';
  END IF;
  v_customer_id:=v_customer_ids[1];
  SELECT c.version,c.name,c.is_active
    INTO v_current_version,v_current_name,v_current_active
  FROM public.customers c WHERE c.id=v_customer_id;

  v_request_payload:=jsonb_build_object('customer_id',v_customer_id,'is_active',p_is_active);
  INSERT INTO public.sarah_ai_action_idempotency(auth_user_id,auth_session_id,request_id,action_name,request_payload)
  VALUES(auth.uid(),v_session_id,p_request_id,'set_customer_active_status',v_request_payload)
  ON CONFLICT(auth_user_id,request_id) DO NOTHING;
  SELECT action_name,request_payload,result INTO v_existing_action,v_existing_payload,v_saved_result
  FROM public.sarah_ai_action_idempotency
  WHERE auth_user_id=auth.uid() AND request_id=p_request_id
  FOR UPDATE;
  IF v_existing_action IS DISTINCT FROM 'set_customer_active_status' THEN
    RAISE EXCEPTION 'Request id was already used for a different action' USING ERRCODE='P0409';
  END IF;
  IF v_saved_result IS NOT NULL THEN
    IF v_existing_payload IS DISTINCT FROM v_request_payload THEN
      RAISE EXCEPTION 'Completed request id cannot be reused with different input' USING ERRCODE='P0409';
    END IF;
    RETURN v_saved_result || jsonb_build_object('idempotent_replay',true);
  END IF;

  v_quota:=public.sarah_ai_consume_my_quota('tool_hour');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_QUOTA_EXCEEDED' USING ERRCODE='P0001';
  END IF;
  v_quota:=public.sarah_ai_consume_my_quota('tool_day');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_DAILY_LIMIT_REACHED' USING ERRCODE='P0001';
  END IF;

  IF v_current_active IS DISTINCT FROM p_is_active THEN
    v_command_result:=public.execute_sync_command(
      p_request_id,'UPDATE_CUSTOMER','customers',v_customer_id,
      jsonb_build_object('id',v_customer_id,'isActive',p_is_active,'expectedVersion',v_current_version),
      v_current_version
    );
    IF COALESCE((v_command_result->>'success')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Canonical customer account status command did not confirm success' USING ERRCODE='P0001';
    END IF;
  END IF;

  v_result:=jsonb_build_object(
    'ok',true,'customer_id',v_customer_id,'customer_code',v_code,
    'customer_name',v_current_name,'is_active',p_is_active,
    'status',CASE WHEN p_is_active THEN 'ACTIVE' ELSE 'INACTIVE' END,
    'changed',v_current_active IS DISTINCT FROM p_is_active
  );
  UPDATE public.sarah_ai_action_idempotency
  SET result=v_result
  WHERE auth_user_id=auth.uid() AND request_id=p_request_id;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_set_customer_active_status(uuid,text,text,boolean) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_set_customer_active_status(uuid,text,text,boolean) TO authenticated;

COMMIT;
