-- Freeze the intent of BIN-gated payment actions at the first attempt.

-- The initial missing-BIN call persists the payload before returning P4004.

-- A later confirmation must replay that exact customer, amount, submission, and action.

CREATE OR REPLACE FUNCTION public.sarah_ai_record_and_approve_payment(
  p_request_id uuid,
  p_customer_code text,
  p_name_hint text,
  p_amount_minor bigint,
  p_note text,
  p_bin text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session_id uuid;
  v_admin_id uuid;
  v_code text;
  v_name_hint text;
  v_customer_id uuid;
  v_customer_name text;
  v_customer_count integer;
  v_customer_matches jsonb;
  v_request_payload jsonb;
  v_existing_action text;
  v_existing_payload jsonb;
  v_saved_result jsonb;
  v_pending_result jsonb;
  v_review_result jsonb;
  v_submission_id uuid;
  v_result jsonb;
  v_quota jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();

  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'A stable request id is required' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR COALESCE(auth.jwt()->>'session_id','') = '' THEN
    RAISE EXCEPTION 'Authenticated session required' USING ERRCODE = '28000';
  END IF;
  v_session_id := (auth.jwt()->>'session_id')::uuid;

  PERFORM public._cp_assert_active_admin_permission('customers:view');
  PERFORM public._cp_assert_active_admin_permission('finance:create-payment');
  PERFORM public._cp_assert_active_admin_permission('finance:approve-payment');

  IF p_customer_code IS NULL OR pg_catalog.btrim(p_customer_code) !~* '^[A-F0-9]{4}$' THEN
    RAISE EXCEPTION 'Customer code must be exactly four hexadecimal characters' USING ERRCODE = '22023';
  END IF;
  v_code := pg_catalog.upper(pg_catalog.btrim(p_customer_code));
  IF p_name_hint IS NOT NULL AND pg_catalog.btrim(p_name_hint) <> '' THEN
    IF pg_catalog.char_length(p_name_hint)>64 OR p_name_hint ~ '[[:cntrl:]]'
       OR pg_catalog.char_length(pg_catalog.btrim(p_name_hint))<2 THEN
      RAISE EXCEPTION 'Customer name hint must be 2 to 64 printable characters' USING ERRCODE = '22023';
    END IF;
    v_name_hint:=pg_catalog.regexp_replace(pg_catalog.btrim(p_name_hint),'\s+',' ','g');
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor<=0 OR p_amount_minor>99999999999 THEN
    RAISE EXCEPTION 'Payment amount must be positive ILS minor units within supported range' USING ERRCODE = '22023';
  END IF;
  IF p_note IS NOT NULL AND (pg_catalog.char_length(p_note)>500 OR p_note ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'Payment note is too long or contains control characters' USING ERRCODE = '22023';
  END IF;
  v_request_payload:=jsonb_build_object(
    'customer_code',v_code,
    'name_hint',v_name_hint,
    'amount_minor',p_amount_minor,
    'note',p_note
  );
  INSERT INTO public.sarah_ai_action_idempotency(auth_user_id,auth_session_id,request_id,action_name,request_payload)
  VALUES(auth.uid(),v_session_id,p_request_id,'record_and_approve_payment',v_request_payload)
  ON CONFLICT(auth_user_id,request_id) DO NOTHING;
  SELECT action_name,request_payload,result
  INTO v_existing_action,v_existing_payload,v_saved_result
  FROM public.sarah_ai_action_idempotency
  WHERE auth_user_id=auth.uid() AND request_id=p_request_id
  FOR UPDATE;
  IF v_existing_action IS DISTINCT FROM 'record_and_approve_payment' THEN
    RAISE EXCEPTION 'Request id was already used for a different action' USING ERRCODE = 'P0409';
  END IF;
  IF v_saved_result IS NOT NULL THEN
    IF v_existing_payload IS DISTINCT FROM v_request_payload THEN
      RAISE EXCEPTION 'Completed request id cannot be reused with different input' USING ERRCODE = 'P0409';
    END IF;
    RETURN v_saved_result || jsonb_build_object('idempotent_replay',true);
  END IF;
  IF v_existing_payload IS DISTINCT FROM v_request_payload THEN
    RAISE EXCEPTION 'Pending request id cannot be reused with different payment input' USING ERRCODE='P0409';
  END IF;

  UPDATE public.sarah_ai_action_idempotency
  SET request_payload=v_request_payload,auth_session_id=v_session_id
  WHERE auth_user_id=auth.uid() AND request_id=p_request_id AND result IS NULL;
  IF p_bin IS NULL OR pg_catalog.btrim(p_bin)='' THEN
    RAISE EXCEPTION 'BIN_REQUIRED' USING ERRCODE = 'P4004';
  END IF;

  v_quota:=public.sarah_ai_consume_my_quota('tool_hour');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_QUOTA_EXCEEDED' USING ERRCODE='P0001';
  END IF;
  v_quota:=public.sarah_ai_consume_my_quota('tool_day');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_DAILY_LIMIT_REACHED' USING ERRCODE='P0001';
  END IF;

  WITH matches AS (
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
      AND (v_name_hint IS NULL OR pg_catalog.strpos(pg_catalog.lower(c.name),pg_catalog.lower(v_name_hint))>0)
    ORDER BY c.name,c.id
    LIMIT 6
  )
  SELECT count(*)::integer,
         (array_agg(id ORDER BY name,id))[1],
         (array_agg(name ORDER BY name,id))[1],
         COALESCE(jsonb_agg(jsonb_build_object('customer_name',pg_catalog.left(name,80),'customer_code',v_code) ORDER BY name,id),'[]'::jsonb)
  INTO v_customer_count,v_customer_id,v_customer_name,v_customer_matches
  FROM matches;

  IF v_customer_count=0 THEN
    RETURN jsonb_build_object('ok',false,'error','CUSTOMER_LOOKUP_REQUIRED');
  ELSIF v_customer_count>1 THEN
    RETURN jsonb_build_object('ok',false,'error','CUSTOMER_NEEDS_DISAMBIGUATION','matches',v_customer_matches);
  END IF;

  v_pending_result:=public.create_admin_pending_customer_payment(v_customer_id,p_amount_minor,p_note);
  IF COALESCE((v_pending_result->>'success')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Could not create the pending payment submission' USING ERRCODE='P0001';
  END IF;
  v_submission_id:=(v_pending_result->>'id')::uuid;

  v_review_result:=public.review_qr_payment_submission(
    v_submission_id,'APPROVE',p_bin,p_note,p_amount_minor
  );
  IF COALESCE((v_review_result->>'success')::boolean,false) IS NOT TRUE
     OR v_review_result->>'status'<>'APPROVED' THEN
    RAISE EXCEPTION 'Canonical payment approval did not complete' USING ERRCODE='P0001';
  END IF;

  v_result:=jsonb_build_object(
    'ok',true,
    'customer_name',pg_catalog.left(v_customer_name,80),
    'customer_code',v_code,
    'submission_id',v_submission_id,
    'payment_id',v_review_result->>'payment_id',
    'amount_minor',p_amount_minor,
    'balance_before_minor',v_review_result->'balance_before_minor',
    'balance_after_minor',v_review_result->'balance_after_minor',
    'status','APPROVED',
    'currency','ILS'
  );
  UPDATE public.sarah_ai_action_idempotency SET result=v_result
  WHERE auth_user_id=auth.uid() AND request_id=p_request_id;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_record_and_approve_payment(uuid,text,text,bigint,text,text) FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.sarah_ai_record_and_approve_payment(uuid,text,text,bigint,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.sarah_ai_review_payment_submission(
  p_request_id uuid,
  p_submission_id uuid,
  p_action text,
  p_approved_amount_minor bigint DEFAULT NULL,
  p_rejection_reason text DEFAULT NULL,
  p_bin text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session_id uuid;
  v_request_payload jsonb;
  v_existing_action text;
  v_existing_payload jsonb;
  v_saved_result jsonb;
  v_review_result jsonb;
  v_result jsonb;
  v_quota jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();
  IF p_request_id IS NULL OR p_submission_id IS NULL THEN
    RAISE EXCEPTION 'Request and submission IDs are required' USING ERRCODE='22023';
  END IF;
  IF auth.uid() IS NULL OR COALESCE(auth.jwt()->>'session_id','')='' THEN
    RAISE EXCEPTION 'Authenticated session required' USING ERRCODE='28000';
  END IF;
  v_session_id:=(auth.jwt()->>'session_id')::uuid;
  PERFORM public._cp_assert_active_admin_permission('finance:approve-payment');

  IF pg_catalog.upper(pg_catalog.btrim(COALESCE(p_action,''))) NOT IN ('APPROVE','REJECT') THEN
    RAISE EXCEPTION 'Unsupported payment review action' USING ERRCODE='22023';
  END IF;
  IF pg_catalog.upper(pg_catalog.btrim(p_action))='APPROVE' THEN
    PERFORM public._cp_assert_active_admin_permission('finance:create-payment');
    IF p_approved_amount_minor IS NULL OR p_approved_amount_minor<=0 OR p_approved_amount_minor>99999999999 THEN
      RAISE EXCEPTION 'Approved payment amount is invalid' USING ERRCODE='22023';
    END IF;
  ELSE
    IF p_rejection_reason IS NULL OR pg_catalog.char_length(pg_catalog.btrim(p_rejection_reason))<2
       OR pg_catalog.char_length(p_rejection_reason)>500 OR p_rejection_reason ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'A rejection reason is required' USING ERRCODE='22023';
    END IF;
    IF p_approved_amount_minor IS NOT NULL THEN
      RAISE EXCEPTION 'Rejected payments cannot have an approved amount' USING ERRCODE='22023';
    END IF;
  END IF;

  v_request_payload:=jsonb_build_object(
    'submission_id',p_submission_id,
    'action',pg_catalog.upper(pg_catalog.btrim(p_action)),
    'approved_amount_minor',p_approved_amount_minor,
    'rejection_reason',p_rejection_reason
  );
  INSERT INTO public.sarah_ai_action_idempotency(auth_user_id,auth_session_id,request_id,action_name,request_payload)
  VALUES(auth.uid(),v_session_id,p_request_id,'review_payment_submission',v_request_payload)
  ON CONFLICT(auth_user_id,request_id) DO NOTHING;
  SELECT action_name,request_payload,result
  INTO v_existing_action,v_existing_payload,v_saved_result
  FROM public.sarah_ai_action_idempotency
  WHERE auth_user_id=auth.uid() AND request_id=p_request_id
  FOR UPDATE;
  IF v_existing_action IS DISTINCT FROM 'review_payment_submission' THEN
    RAISE EXCEPTION 'Request id was already used for a different action' USING ERRCODE='P0409';
  END IF;
  IF v_saved_result IS NOT NULL THEN
    IF v_existing_payload IS DISTINCT FROM v_request_payload THEN
      RAISE EXCEPTION 'Completed request id cannot be reused with different input' USING ERRCODE='P0409';
    END IF;
    RETURN v_saved_result || jsonb_build_object('idempotent_replay',true);
  END IF;
  IF v_existing_payload IS DISTINCT FROM v_request_payload THEN
    RAISE EXCEPTION 'Pending request id cannot be reused with different payment review input' USING ERRCODE='P0409';
  END IF;

  UPDATE public.sarah_ai_action_idempotency
  SET request_payload=v_request_payload,auth_session_id=v_session_id
  WHERE auth_user_id=auth.uid() AND request_id=p_request_id AND result IS NULL;
  IF pg_catalog.upper(pg_catalog.btrim(p_action))='APPROVE'
     AND (p_bin IS NULL OR pg_catalog.btrim(p_bin)='') THEN
    RAISE EXCEPTION 'BIN_REQUIRED' USING ERRCODE='P4004';
  END IF;

  v_quota:=public.sarah_ai_consume_my_quota('tool_hour');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_QUOTA_EXCEEDED' USING ERRCODE='P0001';
  END IF;
  v_quota:=public.sarah_ai_consume_my_quota('tool_day');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_DAILY_LIMIT_REACHED' USING ERRCODE='P0001';
  END IF;

  v_review_result:=public.review_qr_payment_submission(
    p_submission_id,
    pg_catalog.upper(pg_catalog.btrim(p_action)),
    p_bin,
    p_rejection_reason,
    p_approved_amount_minor
  );
  IF COALESCE((v_review_result->>'success')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Payment submission review did not complete' USING ERRCODE='P0001';
  END IF;
  v_result:=jsonb_build_object(
    'ok',true,
    'submission_id',p_submission_id,
    'status',v_review_result->>'status',
    'payment_id',v_review_result->>'payment_id',
    'approved_amount_minor',p_approved_amount_minor,
    'balance_before_minor',v_review_result->'balance_before_minor',
    'balance_after_minor',v_review_result->'balance_after_minor'
  );
  UPDATE public.sarah_ai_action_idempotency SET result=v_result
  WHERE auth_user_id=auth.uid() AND request_id=p_request_id;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_review_payment_submission(uuid,uuid,text,bigint,text,text) FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.sarah_ai_review_payment_submission(uuid,uuid,text,bigint,text,text) TO authenticated;