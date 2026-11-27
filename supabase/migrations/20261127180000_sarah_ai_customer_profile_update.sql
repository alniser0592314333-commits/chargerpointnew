BEGIN;

CREATE OR REPLACE FUNCTION public.sarah_ai_update_customer_profile(
  p_request_id uuid,
  p_customer_code text,
  p_name_hint text,
  p_name text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_notes text DEFAULT NULL
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
  v_current_phone text;
  v_current_notes text;
  v_code text;
  v_hint text;
  v_name text;
  v_phone text;
  v_notes text;
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

  IF p_request_id IS NULL OR auth.uid() IS NULL
     OR COALESCE(auth.jwt()->>'session_id','') = '' THEN
    RAISE EXCEPTION 'Authenticated session and stable request id required' USING ERRCODE='28000';
  END IF;
  v_session_id := (auth.jwt()->>'session_id')::uuid;

  IF p_customer_code IS NULL OR pg_catalog.btrim(p_customer_code) !~* '^[A-F0-9]{4}$' THEN
    RAISE EXCEPTION 'Customer code must be exactly four hexadecimal characters' USING ERRCODE='22023';
  END IF;
  v_code := pg_catalog.upper(pg_catalog.btrim(p_customer_code));
  v_hint := NULLIF(pg_catalog.regexp_replace(pg_catalog.btrim(COALESCE(p_name_hint,'')), '\s+', ' ', 'g'),'');
  IF v_hint IS NULL OR pg_catalog.char_length(v_hint)<2 OR pg_catalog.char_length(v_hint)>64
     OR v_hint ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Customer name hint must be 2 to 64 printable characters' USING ERRCODE='22023';
  END IF;

  v_name := CASE WHEN p_name IS NULL THEN NULL
    ELSE pg_catalog.regexp_replace(pg_catalog.btrim(p_name), '\s+', ' ', 'g') END;
  v_phone := CASE WHEN p_phone IS NULL THEN NULL ELSE NULLIF(pg_catalog.btrim(p_phone),'') END;
  v_notes := CASE WHEN p_notes IS NULL THEN NULL ELSE pg_catalog.btrim(p_notes) END;
  IF p_name IS NOT NULL AND (v_name='' OR pg_catalog.char_length(v_name)>80 OR v_name ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'Customer name must be 1 to 80 printable characters' USING ERRCODE='22023';
  END IF;
  IF p_phone IS NOT NULL AND (pg_catalog.char_length(COALESCE(v_phone,''))>32 OR COALESCE(v_phone,'') ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'Customer phone must be at most 32 printable characters' USING ERRCODE='22023';
  END IF;
  IF p_notes IS NOT NULL AND (pg_catalog.char_length(COALESCE(v_notes,''))>500 OR COALESCE(v_notes,'') ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'Customer notes must be at most 500 printable characters' USING ERRCODE='22023';
  END IF;
  IF v_name IS NULL AND p_phone IS NULL AND p_notes IS NULL THEN
    RAISE EXCEPTION 'At least one editable customer field is required' USING ERRCODE='22023';
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
    WHERE c.is_active IS TRUE AND c.deleted_at IS NULL
      AND COALESCE(c.status,'')<>'DELETED'
      AND pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text,'-',''),4))=v_code
      AND pg_catalog.strpos(pg_catalog.lower(c.name),pg_catalog.lower(v_hint))>0
    FOR UPDATE OF c
  ) AS match;
  IF COALESCE(pg_catalog.cardinality(v_customer_ids),0)=0 THEN
    RAISE EXCEPTION 'Customer lookup proof is missing, expired, or target is no longer active' USING ERRCODE='42501';
  ELSIF pg_catalog.cardinality(v_customer_ids)>1 THEN
    RAISE EXCEPTION 'Customer target is ambiguous; use a more distinctive name from lookup results' USING ERRCODE='P0409';
  END IF;
  v_customer_id:=v_customer_ids[1];
  SELECT c.version,c.name,c.phone,c.notes
    INTO v_current_version,v_current_name,v_current_phone,v_current_notes
  FROM public.customers c WHERE c.id=v_customer_id;

  v_request_payload:=jsonb_build_object(
    'customer_id',v_customer_id,'name',v_name,'phone',v_phone,'notes',v_notes
  );
  INSERT INTO public.sarah_ai_action_idempotency(auth_user_id,auth_session_id,request_id,action_name,request_payload)
  VALUES(auth.uid(),v_session_id,p_request_id,'update_customer_profile',v_request_payload)
  ON CONFLICT(auth_user_id,request_id) DO NOTHING;
  SELECT action_name,request_payload,result
    INTO v_existing_action,v_existing_payload,v_saved_result
  FROM public.sarah_ai_action_idempotency
  WHERE auth_user_id=auth.uid() AND request_id=p_request_id
  FOR UPDATE;
  IF v_existing_action IS DISTINCT FROM 'update_customer_profile' THEN
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

  v_command_result:=public.execute_sync_command(
    p_request_id,'UPDATE_CUSTOMER','customers',v_customer_id,
    jsonb_strip_nulls(jsonb_build_object(
      'id',v_customer_id,
      'name',v_name,
      'phone',v_phone,
      'notes',v_notes
    )),
    v_current_version
  );
  IF COALESCE((v_command_result->>'success')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Canonical UPDATE_CUSTOMER command did not confirm success' USING ERRCODE='P0001';
  END IF;

  SELECT c.name,c.phone,c.notes INTO v_current_name,v_current_phone,v_current_notes
  FROM public.customers c WHERE c.id=v_customer_id;
  v_result:=jsonb_build_object(
    'ok',true,
    'customer_id',v_customer_id,
    'customer_code',v_code,
    'customer_name',v_current_name,
    'phone',v_current_phone,
    'notes',v_current_notes
  );
  UPDATE public.sarah_ai_action_idempotency
  SET result=v_result
  WHERE auth_user_id=auth.uid() AND request_id=p_request_id;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_update_customer_profile(uuid,text,text,text,text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_update_customer_profile(uuid,text,text,text,text,text) TO authenticated;

COMMIT;
