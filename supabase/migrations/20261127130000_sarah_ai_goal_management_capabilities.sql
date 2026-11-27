BEGIN;

-- Reproduce the app's generateCustomerGoalProposalForAdmin -> generateGoalProposal
-- calculation from the same 28-day delivered/recognized item profile. This runs
-- server-side so Sarah cannot invent a target, duration, or bonus.
CREATE OR REPLACE FUNCTION public.sarah_ai_goal_proposal_for_customer(p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_profile integer[] := array_fill(0, ARRAY[28]);
  v_age_days integer;
  v_started_at timestamptz := now();
  v_daily_rate numeric;
  v_recent_rate numeric;
  v_baseline_rate numeric;
  v_min_duration integer;
  v_max_duration integer;
  v_duration integer;
  v_expected numeric;
  v_target integer;
  v_difficulty numeric;
  v_derived_rate integer;
  v_rate integer;
  v_bonus bigint;
BEGIN
  IF p_customer_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.customers c
    WHERE c.id=p_customer_id AND c.is_active IS TRUE
      AND c.deleted_at IS NULL AND COALESCE(c.status,'')<>'DELETED'
  ) THEN
    RAISE EXCEPTION 'Active goal customer is required' USING ERRCODE='P0002';
  END IF;

  FOR v_age_days IN
    SELECT floor(extract(epoch FROM (now()-COALESCE(i.delivered_at,o.delivered_at)))/86400)::integer
    FROM public.order_items i
    JOIN public.orders o ON o.id=i.order_id
    WHERE o.customer_id=p_customer_id
      AND i.deleted_at IS NULL
      AND o.deleted_at IS NULL
      AND COALESCE(o.status,'')<>'cancelled'
      AND lower(COALESCE(i.status,''))='delivered'
      AND i.financial_status='RECOGNIZED'
      AND i.replacement_of_item_id IS NULL
      AND COALESCE(i.delivered_at,o.delivered_at) IS NOT NULL
  LOOP
    IF v_age_days BETWEEN 0 AND 27 THEN
      v_profile[28-v_age_days]:=v_profile[28-v_age_days]+1;
    END IF;
  END LOOP;

  SELECT COALESCE(sum(v_profile[idx]),0)::numeric/7
  INTO v_recent_rate FROM generate_series(22,28) AS s(idx);
  SELECT COALESCE(sum(value),0)::numeric/28
  INTO v_baseline_rate FROM unnest(v_profile) AS u(value);
  v_daily_rate:=v_recent_rate*0.65+v_baseline_rate*0.35;

  v_min_duration:=CASE WHEN v_daily_rate>=1.5 THEN 5 ELSE 7 END;
  v_max_duration:=CASE WHEN v_daily_rate>=4 THEN 9
                       WHEN v_daily_rate>=1.5 THEN 11 ELSE 15 END;
  v_duration:=v_min_duration+floor(random()*(v_max_duration-v_min_duration+1))::integer;
  v_expected:=v_daily_rate*v_duration;
  v_target:=greatest(10,ceil(v_expected*(1.25+random()*0.30))::integer);
  v_difficulty:=CASE WHEN v_expected>0 THEN v_target/v_expected ELSE 1.5 END;
  v_derived_rate:=15+least(5,greatest(0,round((v_difficulty-1)*10)::integer));
  v_rate:=least(20,greatest(15,v_derived_rate+floor(random()*3)::integer-1));
  v_bonus:=least(v_target::bigint*20,greatest(150::bigint,round(v_target*v_rate)::bigint));

  RETURN jsonb_build_object(
    'target_quantity',v_target,
    'duration_days',v_duration,
    'bonus_amount_minor',v_bonus,
    'started_at',v_started_at,
    'expires_at',v_started_at+pg_catalog.make_interval(days=>v_duration),
    'currency','ILS',
    'profile_days',28
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_goal_proposal_for_customer(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sarah_ai_get_goal_proposal(p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();
  PERFORM public._cp_assert_active_admin_permission('goals:manage');
  RETURN public.sarah_ai_goal_proposal_for_customer(p_customer_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_get_goal_proposal(uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_get_goal_proposal(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.sarah_ai_execute_goal_action(
  p_request_id uuid,
  p_action text,
  p_customer_id uuid DEFAULT NULL,
  p_target_id uuid DEFAULT NULL,
  p_target_quantity integer DEFAULT NULL,
  p_duration_days integer DEFAULT NULL,
  p_bonus_amount_minor bigint DEFAULT NULL,
  p_expected_version integer DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_approve boolean DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_action text:=pg_catalog.upper(pg_catalog.btrim(COALESCE(p_action,'')));
  v_session_id uuid;
  v_customer_id uuid;
  v_customer_name text;
  v_goal public.goals%ROWTYPE;
  v_request public.goal_requests%ROWTYPE;
  v_proposal jsonb;
  v_target integer;
  v_duration integer;
  v_bonus bigint;
  v_started_at timestamptz;
  v_expires_at timestamptz;
  v_command_type text;
  v_payload jsonb;
  v_command_result jsonb;
  v_result jsonb;
  v_request_payload jsonb;
  v_existing_action text;
  v_existing_payload jsonb;
  v_saved_result jsonb;
  v_quota jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();
  IF auth.uid() IS NULL OR COALESCE(auth.jwt()->>'session_id','')='' OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated session and request ID are required' USING ERRCODE='28000';
  END IF;
  v_session_id:=(auth.jwt()->>'session_id')::uuid;

  IF v_action NOT IN (
    'CREATE_GOAL','APPROVE_GOAL_REQUEST','REJECT_GOAL_REQUEST',
    'UPDATE_GOAL_CONFIG','CANCEL_GOAL','REVIEW_GOAL_CANCELLATION'
  ) THEN
    RAISE EXCEPTION 'Unsupported goal action' USING ERRCODE='22023';
  END IF;

  IF v_action IN ('CREATE_GOAL','UPDATE_GOAL_CONFIG','CANCEL_GOAL') THEN
    PERFORM public._cp_assert_active_admin_permission('goals:manage');
  ELSIF v_action IN ('APPROVE_GOAL_REQUEST','REJECT_GOAL_REQUEST') THEN
    PERFORM public._cp_assert_active_admin_permission('goals:approve');
  END IF;

  IF p_reason IS NOT NULL AND (pg_catalog.char_length(p_reason)>500 OR p_reason ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'Goal action reason is invalid' USING ERRCODE='22023';
  END IF;

  v_request_payload:=jsonb_build_object(
    'action',v_action,'customer_id',p_customer_id,'target_id',p_target_id,
    'target_quantity',p_target_quantity,'duration_days',p_duration_days,
    'bonus_amount_minor',p_bonus_amount_minor,'expected_version',p_expected_version,
    'reason',p_reason,'approve',p_approve
  );
  INSERT INTO public.sarah_ai_action_idempotency(
    auth_user_id,auth_session_id,request_id,action_name,request_payload
  )
  VALUES(auth.uid(),v_session_id,p_request_id,'goal:'||v_action,v_request_payload)
  ON CONFLICT(auth_user_id,request_id) DO NOTHING;
  SELECT action_name,request_payload,result
  INTO v_existing_action,v_existing_payload,v_saved_result
  FROM public.sarah_ai_action_idempotency
  WHERE auth_user_id=auth.uid() AND request_id=p_request_id
  FOR UPDATE;
  IF v_existing_action IS DISTINCT FROM 'goal:'||v_action THEN
    RAISE EXCEPTION 'Request ID was already used for a different action' USING ERRCODE='P0409';
  END IF;
  IF v_saved_result IS NOT NULL THEN
    IF v_existing_payload IS DISTINCT FROM v_request_payload THEN
      RAISE EXCEPTION 'Completed goal action request cannot be reused with different input' USING ERRCODE='P0409';
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

  IF v_action='CREATE_GOAL' THEN
    v_customer_id:=p_customer_id;
    IF v_customer_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM public.customers c
      WHERE c.id=v_customer_id AND c.is_active IS TRUE
        AND c.deleted_at IS NULL AND COALESCE(c.status,'')<>'DELETED'
    ) THEN
      RAISE EXCEPTION 'Active goal customer is required' USING ERRCODE='P0002';
    END IF;
    SELECT c.name INTO v_customer_name FROM public.customers c WHERE c.id=v_customer_id;
    IF p_target_quantity IS NULL AND p_duration_days IS NULL AND p_bonus_amount_minor IS NULL THEN
      v_proposal:=public.sarah_ai_goal_proposal_for_customer(v_customer_id);
      v_target:=(v_proposal->>'target_quantity')::integer;
      v_duration:=(v_proposal->>'duration_days')::integer;
      v_bonus:=(v_proposal->>'bonus_amount_minor')::bigint;
      v_started_at:=(v_proposal->>'started_at')::timestamptz;
      v_expires_at:=(v_proposal->>'expires_at')::timestamptz;
    ELSIF p_target_quantity IS NOT NULL AND p_duration_days IS NOT NULL AND p_bonus_amount_minor IS NOT NULL THEN
      v_target:=p_target_quantity;
      v_duration:=p_duration_days;
      v_bonus:=p_bonus_amount_minor;
      v_started_at:=now();
      v_expires_at:=v_started_at+pg_catalog.make_interval(days=>v_duration);
    ELSE
      RAISE EXCEPTION 'Provide all goal parameters or let the app goal generator choose them' USING ERRCODE='22023';
    END IF;
    v_payload:=jsonb_build_object(
      'id',p_request_id,'customerId',v_customer_id,
      'targetQuantity',v_target,'durationDays',v_duration,
      'bonusAmountMinor',v_bonus,'startedAt',v_started_at,'expiresAt',v_expires_at
    );
    v_command_result:=public.execute_sync_command(
      p_request_id,'CREATE_GOAL','goals',p_request_id,v_payload,NULL
    );
    v_result:=jsonb_build_object(
      'ok',COALESCE((v_command_result->>'success')::boolean,false),
      'action',v_action,'customer_name',pg_catalog.left(v_customer_name,80),
      'goal_id',p_request_id,'target_quantity',v_target,'duration_days',v_duration,
      'bonus_amount_minor',v_bonus,'started_at',v_started_at,'expires_at',v_expires_at,
      'canonical_result',v_command_result->'result'
    );

  ELSIF v_action IN ('APPROVE_GOAL_REQUEST','REJECT_GOAL_REQUEST') THEN
    IF p_target_id IS NULL THEN RAISE EXCEPTION 'Goal request ID is required' USING ERRCODE='22023'; END IF;
    SELECT * INTO v_request FROM public.goal_requests r WHERE r.id=p_target_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Goal request not found' USING ERRCODE='P0002'; END IF;
    v_customer_id:=v_request.customer_id;
    SELECT c.name INTO v_customer_name FROM public.customers c WHERE c.id=v_customer_id;
    IF v_action='REJECT_GOAL_REQUEST' THEN
      IF p_reason IS NULL OR pg_catalog.char_length(pg_catalog.btrim(p_reason))<2 THEN
        RAISE EXCEPTION 'A rejection reason is required' USING ERRCODE='22023';
      END IF;
      v_command_type:='REJECT_GOAL_REQUEST';
      v_payload:=jsonb_build_object('requestId',p_target_id,'rejectionReason',p_reason);
    ELSE
      IF p_target_quantity IS NULL AND p_duration_days IS NULL AND p_bonus_amount_minor IS NULL THEN
        v_proposal:=public.sarah_ai_goal_proposal_for_customer(v_customer_id);
        v_target:=COALESCE(v_request.requested_target,(v_proposal->>'target_quantity')::integer);
        v_duration:=(v_proposal->>'duration_days')::integer;
        v_bonus:=LEAST((v_proposal->>'bonus_amount_minor')::bigint,v_target::bigint*20);
      ELSIF p_target_quantity IS NOT NULL AND p_duration_days IS NOT NULL AND p_bonus_amount_minor IS NOT NULL THEN
        v_target:=p_target_quantity;
        v_duration:=p_duration_days;
        v_bonus:=p_bonus_amount_minor;
      ELSE
        RAISE EXCEPTION 'Provide a complete goal proposal or use the app goal generator' USING ERRCODE='22023';
      END IF;
      v_started_at:=now();
      v_expires_at:=v_started_at+pg_catalog.make_interval(days=>v_duration);
      v_command_type:='APPROVE_GOAL_REQUEST';
      v_payload:=jsonb_build_object(
        'requestId',p_target_id,'resultingGoalId',pg_catalog.gen_random_uuid(),
        'targetQuantity',v_target,'durationDays',v_duration,
        'bonusAmountMinor',v_bonus,'expiresAt',v_expires_at
      );
    END IF;
    v_command_result:=public.execute_sync_command(
      p_request_id,v_command_type,
      CASE WHEN v_action='APPROVE_GOAL_REQUEST' THEN 'goals' ELSE 'goal_requests' END,
      p_target_id,v_payload,NULL
    );
    v_result:=jsonb_build_object(
      'ok',COALESCE((v_command_result->>'success')::boolean,false),
      'action',v_action,'customer_name',pg_catalog.left(v_customer_name,80),
      'request_id',p_target_id,'canonical_result',v_command_result->'result',
      'goal_proposal',CASE WHEN v_action='APPROVE_GOAL_REQUEST'
        THEN jsonb_build_object('target_quantity',v_target,'duration_days',v_duration,'bonus_amount_minor',v_bonus)
        ELSE NULL END
    );

  ELSIF v_action='UPDATE_GOAL_CONFIG' THEN
    IF p_target_id IS NULL OR (
      p_target_quantity IS NULL AND p_duration_days IS NULL AND p_bonus_amount_minor IS NULL
    ) THEN
      RAISE EXCEPTION 'Goal ID and at least one configuration value are required' USING ERRCODE='22023';
    END IF;
    SELECT * INTO v_goal FROM public.goals g WHERE g.id=p_target_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Goal not found' USING ERRCODE='P0002'; END IF;
    v_customer_id:=v_goal.customer_id;
    v_customer_name:=(SELECT c.name FROM public.customers c WHERE c.id=v_customer_id);
    v_payload:=pg_catalog.jsonb_strip_nulls(jsonb_build_object(
      'id',p_target_id,
      'targetQuantity',p_target_quantity,
      'durationDays',p_duration_days,
      'bonusAmountMinor',p_bonus_amount_minor,
      'expiresAt',CASE WHEN p_duration_days IS NOT NULL
        THEN v_goal.started_at+pg_catalog.make_interval(days=>p_duration_days) ELSE NULL END,
      'expectedVersion',p_expected_version
    ));
    v_command_result:=public.execute_sync_command(
      p_request_id,'UPDATE_GOAL_CONFIG','goals',p_target_id,v_payload,p_expected_version
    );
    v_result:=jsonb_build_object(
      'ok',COALESCE((v_command_result->>'success')::boolean,false),
      'action',v_action,'goal_id',p_target_id,'customer_name',pg_catalog.left(v_customer_name,80),
      'canonical_result',v_command_result->'result'
    );

  ELSIF v_action='CANCEL_GOAL' THEN
    IF p_target_id IS NULL THEN RAISE EXCEPTION 'Goal ID is required' USING ERRCODE='22023'; END IF;
    v_result:=public.admin_cancel_goal(p_target_id,p_reason);
    v_result:=v_result||jsonb_build_object('action',v_action);

  ELSIF v_action='REVIEW_GOAL_CANCELLATION' THEN
    IF p_target_id IS NULL OR p_approve IS NULL THEN
      RAISE EXCEPTION 'Goal ID and review decision are required' USING ERRCODE='22023';
    END IF;
    v_result:=public.admin_review_goal_cancellation(p_target_id,p_approve,p_reason);
    v_result:=v_result||jsonb_build_object('action',v_action);
  END IF;

  UPDATE public.sarah_ai_action_idempotency SET result=v_result
  WHERE auth_user_id=auth.uid() AND request_id=p_request_id;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_execute_goal_action(uuid,text,uuid,uuid,integer,integer,bigint,integer,text,boolean)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_execute_goal_action(uuid,text,uuid,uuid,integer,integer,bigint,integer,text,boolean)
  TO authenticated;

COMMIT;
