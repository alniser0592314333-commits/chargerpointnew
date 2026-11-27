BEGIN;

-- Customer credit/refund operations are bound to a same-session customer lookup
-- proof and delegate all financial writes to the app's canonical sync commands.

CREATE OR REPLACE FUNCTION public.sarah_ai_adjust_customer_finances(
  p_request_id uuid,
  p_action text,
  p_customer_code text,
  p_name_hint text,
  p_amount_minor bigint,
  p_reference_event_id uuid DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_bin text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_action text;
  v_session_id uuid;
  v_customer_id uuid;
  v_match_count integer;
  v_command_type text;
  v_aggregate_type text;
  v_aggregate_id uuid;
  v_payload jsonb;
  v_original_amount bigint;
  v_refunded_amount bigint;
  v_result jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();
  PERFORM public._cp_assert_active_admin_permission('customers:view');
  PERFORM public._cp_assert_active_admin_permission('customers:financial-view');

  v_action:=pg_catalog.upper(pg_catalog.btrim(COALESCE(p_action,'')));
  IF p_request_id IS NULL OR v_action NOT IN ('ADD_CREDIT','USE_CREDIT','REFUND')
     OR p_customer_code IS NULL OR pg_catalog.btrim(p_customer_code) !~* '^[A-F0-9]{4}$'
     OR p_name_hint IS NULL OR pg_catalog.char_length(pg_catalog.btrim(p_name_hint))<2
     OR pg_catalog.char_length(p_name_hint)>64 OR p_name_hint ~ '[[:cntrl:]]'
     OR p_amount_minor IS NULL OR p_amount_minor<=0
     OR (p_note IS NOT NULL AND pg_catalog.char_length(p_note)>500) THEN
    RAISE EXCEPTION 'Invalid customer financial adjustment' USING ERRCODE='22023';
  END IF;

  IF v_action IN ('ADD_CREDIT','USE_CREDIT') THEN
    PERFORM public._cp_assert_active_admin_permission('finance:credit-adjustment');
    v_command_type:=CASE WHEN v_action='ADD_CREDIT' THEN 'CREATE_CUSTOMER_CREDIT' ELSE 'CONSUME_CUSTOMER_CREDIT' END;
    v_aggregate_type:=CASE WHEN v_action='ADD_CREDIT' THEN 'payments' ELSE 'financial_ledger' END;
  ELSE
    PERFORM public._cp_assert_active_admin_permission('finance:refund');
    IF p_reference_event_id IS NULL THEN
      RAISE EXCEPTION 'A source payment ledger event is required for a refund' USING ERRCODE='22023';
    END IF;
    v_command_type:='CREATE_REFUND';
    v_aggregate_type:='financial_ledger';
  END IF;

  IF COALESCE(auth.jwt()->>'session_id','')='' THEN
    RAISE EXCEPTION 'Authenticated admin session required' USING ERRCODE='28000';
  END IF;
  v_session_id:=(auth.jwt()->>'session_id')::uuid;

  SELECT count(*)::integer,(array_agg(c.id ORDER BY c.name,c.id))[1]
  INTO v_match_count,v_customer_id
  FROM public.customers c
  JOIN public.sarah_ai_customer_lookup_proofs proof
    ON proof.customer_id=c.id AND proof.auth_user_id=auth.uid()
   AND proof.auth_session_id=v_session_id
   AND proof.customer_code=pg_catalog.upper(pg_catalog.btrim(p_customer_code))
   AND proof.expires_at>now()
  WHERE c.is_active IS TRUE AND c.deleted_at IS NULL
    AND COALESCE(c.status,'')<>'DELETED'
    AND pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text,'-',''),4))=pg_catalog.upper(pg_catalog.btrim(p_customer_code))
    AND pg_catalog.strpos(pg_catalog.lower(c.name),pg_catalog.lower(pg_catalog.btrim(p_name_hint)))>0;

  IF v_match_count=0 THEN
    RAISE EXCEPTION 'Customer lookup proof expired or customer not found' USING ERRCODE='P0002';
  ELSIF v_match_count>1 THEN
    RAISE EXCEPTION 'Customer code is ambiguous; provide a more specific name hint' USING ERRCODE='22023';
  END IF;

  IF v_action='REFUND' THEN
    SELECT fl.amount_minor INTO v_original_amount
    FROM public.financial_ledger fl
    WHERE fl.id=p_reference_event_id
      AND fl.customer_id=v_customer_id
      AND upper(fl.event_type)='PAYMENT'
      AND fl.amount_minor>0
    FOR UPDATE;
    IF v_original_amount IS NULL THEN
      RAISE EXCEPTION 'Refund source must be a positive payment event belonging to this customer' USING ERRCODE='P0002';
    END IF;
    SELECT COALESCE(sum(-fl.amount_minor),0)::bigint INTO v_refunded_amount
    FROM public.financial_ledger fl
    WHERE fl.event_type='refund' AND fl.reference_id=p_reference_event_id;
    IF p_amount_minor>v_original_amount-v_refunded_amount THEN
      RAISE EXCEPTION 'Refund amount exceeds the remaining refundable payment amount' USING ERRCODE='22023';
    END IF;
  END IF;

  v_aggregate_id:=p_request_id;
  v_payload:=pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'id',p_request_id,
    'customerId',v_customer_id,
    'amountMinor',p_amount_minor,
    'reference',p_note,
    'referenceEventId',p_reference_event_id,
    'bin',CASE WHEN v_action IN ('ADD_CREDIT','REFUND') THEN p_bin ELSE NULL END
  ));
  v_result:=public.execute_sync_command(
    p_request_id,v_command_type,v_aggregate_type,v_aggregate_id,v_payload,NULL
  );
  IF COALESCE((v_result->>'success')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Canonical financial command did not confirm success' USING ERRCODE='P0001';
  END IF;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_adjust_customer_finances(uuid,text,text,text,bigint,uuid,text,text)
  FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_adjust_customer_finances(uuid,text,text,text,bigint,uuid,text,text)
  TO authenticated;

COMMIT;
