BEGIN;

-- Database-level invariant: each customer can have at most one active goal.
-- Production was checked before adding this index; no duplicate active goals exist.
CREATE UNIQUE INDEX IF NOT EXISTS goals_one_active_per_customer_idx
  ON public.goals(customer_id)
  WHERE status = 'ACTIVE';

-- Preserve the full hardened dispatcher and wrap only the two missing goal
-- commands. All existing order/finance/day/device/purchase commands continue
-- through the original implementation unchanged.
DO $rename_dispatcher$
BEGIN
  IF to_regprocedure('public.execute_canonical_sync_command_unlocked_internal(uuid,text,jsonb,text,text,uuid)') IS NULL THEN
    EXECUTE 'ALTER FUNCTION public.execute_canonical_sync_command_unlocked(uuid,text,jsonb,text,text,uuid) RENAME TO execute_canonical_sync_command_unlocked_internal';
  END IF;
END;
$rename_dispatcher$;

REVOKE ALL ON FUNCTION public.execute_canonical_sync_command_unlocked_internal(uuid,text,jsonb,text,text,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.execute_canonical_sync_command_unlocked(
  p_command_id uuid,
  p_command_type text,
  p_payload jsonb,
  p_payload_hash text DEFAULT 'no_hash'::text,
  p_device_id text DEFAULT 'default_device'::text,
  p_actor_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor_id uuid;
  v_admin_role text;
  v_is_active boolean;
  v_entity_uuid uuid;
  v_customer_uuid uuid;
  v_requested_target integer;
  v_goal_target integer;
  v_goal_duration integer;
  v_goal_bonus bigint;
  v_goal_started timestamptz;
  v_goal_expires timestamptz;
  v_server_gen bigint;
  v_cmd_gen bigint;
  v_payload_hash text;
  v_existing_cmd record;
  v_change_seq bigint;
  v_result jsonb;
  v_command_type text := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_command_type,'')));
  v_payload jsonb := COALESCE(p_payload,'{}'::jsonb);
BEGIN
  IF v_command_type NOT IN ('CREATE_GOAL','RECORD_GOAL_REQUEST') THEN
    RETURN public.execute_canonical_sync_command_unlocked_internal(
      p_command_id,p_command_type,p_payload,p_payload_hash,p_device_id,p_actor_id
    );
  END IF;

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000';
  END IF;
  PERFORM public.assert_my_account_session_active();

  SELECT a.id,a.role,a.is_active
  INTO v_actor_id,v_admin_role,v_is_active
  FROM public.admins a
  WHERE a.auth_user_id=auth.uid()
  LIMIT 1;
  IF v_actor_id IS NULL OR v_is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Active admin profile required' USING ERRCODE='42501';
  END IF;
  IF p_actor_id IS NOT NULL AND p_actor_id<>v_actor_id THEN
    RAISE EXCEPTION 'Actor identity mismatch' USING ERRCODE='42501';
  END IF;

  IF v_command_type='CREATE_GOAL' THEN
    PERFORM public._cp_assert_active_admin_permission('goals:manage');
  ELSE
    PERFORM public._cp_assert_active_admin_permission('goals:manage');
  END IF;

  IF p_command_id IS NULL THEN
    RAISE EXCEPTION 'Command ID is required' USING ERRCODE='22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_command_id::text,0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('chargerpointnew:change_log:commit_order',0));

  SELECT COALESCE(s.value_number,1)
  INTO v_server_gen
  FROM public.system_settings s
  WHERE s.key='server_reset_generation';
  v_server_gen:=COALESCE(v_server_gen,1);
  v_cmd_gen:=COALESCE(
    NULLIF(v_payload->>'resetGeneration','')::bigint,
    NULLIF(v_payload->>'reset_generation','')::bigint,
    1
  );
  IF v_cmd_gen<v_server_gen THEN
    RAISE EXCEPTION 'Reset Generation Mismatch: stale goal command rejected'
      USING ERRCODE='P0002';
  END IF;

  v_payload_hash:=COALESCE(NULLIF(p_payload_hash,''),'no_hash');
  SELECT pc.command_id,pc.command_type,pc.payload_hash,pc.result_payload
  INTO v_existing_cmd
  FROM public.processed_commands pc
  WHERE pc.command_id=p_command_id
  FOR UPDATE;
  IF v_existing_cmd.command_id IS NOT NULL THEN
    IF v_existing_cmd.command_type=v_command_type
       AND (v_existing_cmd.payload_hash=v_payload_hash OR v_payload_hash='no_hash') THEN
      RETURN jsonb_build_object(
        'success',true,
        'idempotent',true,
        'commandId',p_command_id,
        'result',v_existing_cmd.result_payload
      );
    END IF;
    RAISE EXCEPTION 'Idempotency conflict for goal command %',p_command_id
      USING ERRCODE='23505';
  END IF;

  IF v_command_type='CREATE_GOAL' THEN
    v_entity_uuid:=COALESCE(NULLIF(v_payload->>'id','')::uuid,p_command_id);
    v_customer_uuid:=NULLIF(v_payload->>'customerId','')::uuid;
    v_goal_target:=NULLIF(v_payload->>'targetQuantity','')::integer;
    v_goal_duration:=NULLIF(v_payload->>'durationDays','')::integer;
    v_goal_bonus:=NULLIF(v_payload->>'bonusAmountMinor','')::bigint;
    v_goal_started:=COALESCE(NULLIF(v_payload->>'startedAt','')::timestamptz,now());
    v_goal_expires:=COALESCE(
      NULLIF(v_payload->>'expiresAt','')::timestamptz,
      v_goal_started+pg_catalog.make_interval(days=>v_goal_duration)
    );

    IF v_entity_uuid IS NULL OR v_customer_uuid IS NULL
       OR v_goal_target IS NULL OR v_goal_duration IS NULL OR v_goal_bonus IS NULL
       OR v_goal_target<=0 OR v_goal_duration<3 OR v_goal_duration>15
       OR v_goal_bonus<0 OR v_goal_bonus>v_goal_target::bigint*20
       OR v_goal_expires<>v_goal_started+pg_catalog.make_interval(days=>v_goal_duration) THEN
      RAISE EXCEPTION 'Goal proposal parameters are invalid' USING ERRCODE='22023';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_customer_uuid::text,1));
    PERFORM 1
    FROM public.customers c
    WHERE c.id=v_customer_uuid
      AND c.is_active IS TRUE
      AND c.deleted_at IS NULL
      AND COALESCE(c.status,'')<>'DELETED'
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Goal customer is inactive or unavailable' USING ERRCODE='P0002';
    END IF;
    IF EXISTS(
      SELECT 1 FROM public.goals g
      WHERE g.customer_id=v_customer_uuid AND g.status='ACTIVE'
    ) THEN
      RAISE EXCEPTION 'Customer already has an active goal' USING ERRCODE='P0001';
    END IF;

    INSERT INTO public.goals(
      id,customer_id,target_quantity,current_progress,bonus_amount_minor,
      duration_days,status,started_at,expires_at,completed_at,bonus_ledger_id,
      created_at,updated_at,version
    )
    VALUES(
      v_entity_uuid,v_customer_uuid,v_goal_target,0,v_goal_bonus,
      v_goal_duration,'ACTIVE',v_goal_started,v_goal_expires,NULL,NULL,
      now(),now(),1
    );

    v_change_seq:=public.record_canonical_change(
      'goals',v_entity_uuid,'INSERT',
      jsonb_build_object(
        'id',v_entity_uuid,'customerId',v_customer_uuid,
        'targetQuantity',v_goal_target,'currentProgress',0,
        'bonusAmountMinor',v_goal_bonus,'durationDays',v_goal_duration,
        'status','ACTIVE','startedAt',v_goal_started,'expiresAt',v_goal_expires,
        'version',1
      ),
      1
    );
    v_result:=jsonb_build_object(
      'goalId',v_entity_uuid,'customerId',v_customer_uuid,
      'targetQuantity',v_goal_target,'currentProgress',0,
      'bonusAmountMinor',v_goal_bonus,'durationDays',v_goal_duration,
      'status','ACTIVE','startedAt',v_goal_started,'expiresAt',v_goal_expires,
      'version',1,'changeSequence',v_change_seq
    );
  ELSE
    v_entity_uuid:=COALESCE(NULLIF(v_payload->>'id','')::uuid,p_command_id);
    v_customer_uuid:=NULLIF(v_payload->>'customerId','')::uuid;
    v_requested_target:=NULLIF(v_payload->>'requestedTarget','')::integer;
    IF v_entity_uuid IS NULL OR v_customer_uuid IS NULL
       OR (v_requested_target IS NOT NULL AND v_requested_target<=0) THEN
      RAISE EXCEPTION 'Goal request parameters are invalid' USING ERRCODE='22023';
    END IF;
    PERFORM 1
    FROM public.customers c
    WHERE c.id=v_customer_uuid
      AND c.is_active IS TRUE
      AND c.deleted_at IS NULL
      AND COALESCE(c.status,'')<>'DELETED'
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Goal request customer is inactive or unavailable' USING ERRCODE='P0002';
    END IF;

    INSERT INTO public.goal_requests(
      id,customer_id,requested_target,status,created_at,updated_at,
      reviewed_by,reviewed_at,rejection_reason,resulting_goal_id,version
    )
    VALUES(
      v_entity_uuid,v_customer_uuid,v_requested_target,'PENDING',
      COALESCE(NULLIF(v_payload->>'createdAt','')::timestamptz,now()),
      now(),NULL,NULL,NULL,NULL,1
    );

    v_change_seq:=public.record_canonical_change(
      'goal_requests',v_entity_uuid,'INSERT',
      jsonb_build_object(
        'id',v_entity_uuid,'customerId',v_customer_uuid,
        'requestedTarget',v_requested_target,'status','PENDING','version',1
      ),
      1
    );
    v_result:=jsonb_build_object(
      'requestId',v_entity_uuid,'customerId',v_customer_uuid,
      'requestedTarget',v_requested_target,'status','PENDING',
      'version',1,'changeSequence',v_change_seq
    );
  END IF;

  INSERT INTO public.processed_commands(
    command_id,command_type,payload_hash,aggregate_type,aggregate_id,
    actor_admin_id,device_id,result_payload
  )
  VALUES(
    p_command_id,v_command_type,v_payload_hash,
    CASE WHEN v_command_type='CREATE_GOAL' THEN 'goals' ELSE 'goal_requests' END,
    v_entity_uuid,v_actor_id,
    CASE WHEN COALESCE(p_device_id,'') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN p_device_id::uuid ELSE NULL END,
    v_result
  );

  RETURN jsonb_build_object(
    'success',true,'commandId',p_command_id,
    'commandType',v_command_type,'result',v_result,
    'serverProcessedAt',now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.execute_canonical_sync_command_unlocked(uuid,text,jsonb,text,text,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
