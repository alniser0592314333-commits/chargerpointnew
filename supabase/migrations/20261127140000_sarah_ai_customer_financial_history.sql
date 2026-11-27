BEGIN;

CREATE OR REPLACE FUNCTION public.sarah_ai_get_customer_financial_history(
  p_customer_code text,
  p_name_hint text DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session_id uuid;
  v_code text;
  v_name_hint text;
  v_customer_id uuid;
  v_customer_name text;
  v_match_count integer;
  v_entries jsonb;
  v_quota jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();
  PERFORM public._cp_assert_active_admin_permission('customers:financial-view');

  IF auth.uid() IS NULL OR COALESCE(auth.jwt()->>'session_id','')='' THEN
    RAISE EXCEPTION 'Authenticated session required' USING ERRCODE='28000';
  END IF;
  v_session_id:=(auth.jwt()->>'session_id')::uuid;
  IF p_customer_code IS NULL OR pg_catalog.btrim(p_customer_code) !~* '^[A-F0-9]{4}$'
     OR p_limit IS NULL OR p_limit<1 OR p_limit>20 THEN
    RAISE EXCEPTION 'Customer code or history limit is invalid' USING ERRCODE='22023';
  END IF;
  v_code:=pg_catalog.upper(pg_catalog.btrim(p_customer_code));
  IF p_name_hint IS NOT NULL AND p_name_hint<>'' THEN
    IF pg_catalog.char_length(p_name_hint)>64 OR pg_catalog.char_length(pg_catalog.btrim(p_name_hint))<2
       OR p_name_hint ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'Customer name hint must be 2 to 64 printable characters' USING ERRCODE='22023';
    END IF;
    v_name_hint:=pg_catalog.btrim(p_name_hint);
  END IF;

  v_quota:=public.sarah_ai_consume_my_quota('tool_hour');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_QUOTA_EXCEEDED' USING ERRCODE='P0001';
  END IF;
  v_quota:=public.sarah_ai_consume_my_quota('tool_day');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_DAILY_LIMIT_REACHED' USING ERRCODE='P0001';
  END IF;

  SELECT count(*)::integer,(array_agg(c.id ORDER BY c.name,c.id))[1],(array_agg(c.name ORDER BY c.name,c.id))[1]
  INTO v_match_count,v_customer_id,v_customer_name
  FROM public.customers c
  JOIN public.sarah_ai_customer_lookup_proofs proof
    ON proof.customer_id=c.id AND proof.auth_user_id=auth.uid()
   AND proof.auth_session_id=v_session_id AND proof.customer_code=v_code
   AND proof.expires_at>now()
  WHERE c.is_active IS TRUE AND c.deleted_at IS NULL
    AND COALESCE(c.status,'')<>'DELETED'
    AND pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text,'-',''),4))=v_code
    AND (v_name_hint IS NULL OR pg_catalog.strpos(pg_catalog.lower(c.name),pg_catalog.lower(v_name_hint))>0);

  IF v_match_count=0 THEN
    RETURN jsonb_build_object('match_count',0,'entries','[]'::jsonb);
  ELSIF v_match_count>1 THEN
    RAISE EXCEPTION 'Customer code is ambiguous; provide a more specific name hint' USING ERRCODE='22023';
  END IF;

  SELECT COALESCE(jsonb_agg(row_data ORDER BY created_at DESC,entry_id),'[]'::jsonb)
  INTO v_entries
  FROM (
    SELECT jsonb_build_object(
      'entry_id',fl.id,
      'event_type',fl.event_type,
      'amount_minor',fl.amount_minor,
      'reference_id',fl.reference_id,
      'order_id',fl.order_id,
      'order_item_id',fl.order_item_id,
      'created_at',fl.created_at
    ) AS row_data,fl.created_at,fl.id AS entry_id
    FROM public.financial_ledger fl
    WHERE fl.customer_id=v_customer_id
    ORDER BY fl.created_at DESC,fl.id
    LIMIT p_limit
  ) bounded;

  RETURN jsonb_build_object(
    'match_count',1,
    'customer_name',pg_catalog.left(v_customer_name,80),
    'customer_code',v_code,
    'entries',COALESCE(v_entries,'[]'::jsonb),
    'entry_count',COALESCE(jsonb_array_length(v_entries),0),
    'currency','ILS'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_get_customer_financial_history(text,text,integer)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_get_customer_financial_history(text,text,integer)
  TO authenticated;

COMMIT;
