-- Runtime contract for canonical goal create/request command dispatch.
DO $privileges$
BEGIN
  IF has_function_privilege('authenticated','public.execute_canonical_sync_command_unlocked(uuid,text,jsonb,text,text,uuid)','EXECUTE')
     OR has_function_privilege('service_role','public.execute_canonical_sync_command_unlocked(uuid,text,jsonb,text,text,uuid)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.execute_canonical_sync_command(uuid,text,jsonb,text,text,uuid)','EXECUTE')
     OR NOT EXISTS(
       SELECT 1 FROM pg_indexes
       WHERE schemaname='public' AND indexname='goals_one_active_per_customer_idx'
     ) THEN
    RAISE EXCEPTION 'Canonical goal command wrapper ACL or active-goal index is incorrect';
  END IF;
END;
$privileges$;

-- Super Admin can create a goal without a separately assigned goals:manage permission.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
SELECT set_config('request.jwt.claim.session_id','40000000-0000-4000-8000-000000000001',false);
DO $super_admin_goal$
DECLARE v_result jsonb; v_started timestamptz:=now(); v_goal_id uuid:='50000000-0000-4000-8000-000000000001'; v_payload jsonb;
BEGIN
  v_payload:=jsonb_build_object(
    'id',v_goal_id,'customerId','30000000-0000-4000-8000-000000000001',
    'targetQuantity',10,'durationDays',5,'bonusAmountMinor',150,
    'startedAt',v_started,'expiresAt',v_started+interval '5 days','resetGeneration',1
  );
  v_result:=public.execute_canonical_sync_command(
    v_goal_id,'CREATE_GOAL',v_payload,'goal-hash-1','test-device',
    auth.uid()
  );
  IF v_result->>'success'<>'true'
     OR v_result#>>'{result,status}'<>'ACTIVE'
     OR v_result#>>'{result,currentProgress}'<>'0' THEN
    RAISE EXCEPTION 'Super Admin goal creation failed: %',v_result;
  END IF;
  v_result:=public.execute_canonical_sync_command(
    v_goal_id,'CREATE_GOAL',v_payload,'goal-hash-1','test-device',
    auth.uid()
  );
  IF v_result->>'idempotent'<>'true' THEN
    RAISE EXCEPTION 'Goal command retry was not idempotent: %',v_result;
  END IF;

  BEGIN
    v_payload:=jsonb_build_object(
      'id','50000000-0000-4000-8000-000000000002',
      'customerId','30000000-0000-4000-8000-000000000001',
      'targetQuantity',10,'durationDays',5,'bonusAmountMinor',150,
      'startedAt',v_started,'expiresAt',v_started+interval '5 days','resetGeneration',1
    );
    PERFORM public.execute_canonical_sync_command(
      '50000000-0000-4000-8000-000000000002','CREATE_GOAL',v_payload,'goal-hash-2','test-device',
      '20000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'Second active goal for one customer was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;

  BEGIN
    v_payload:=jsonb_build_object(
      'id','50000000-0000-4000-8000-000000000003',
      'customerId','30000000-0000-4000-8000-000000000002',
      'targetQuantity',10,'durationDays',5,'bonusAmountMinor',201,
      'startedAt',v_started,'expiresAt',v_started+interval '5 days','resetGeneration',1
    );
    PERFORM public.execute_canonical_sync_command(
      '50000000-0000-4000-8000-000000000003','CREATE_GOAL',v_payload,'goal-hash-3','test-device',
      '20000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'Goal above the 20-minor-unit-per-device cap was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  BEGIN
    v_payload:=jsonb_build_object(
      'id','50000000-0000-4000-8000-000000000004',
      'customerId','30000000-0000-4000-8000-000000000003',
      'targetQuantity',10,'durationDays',5,'bonusAmountMinor',150,
      'startedAt',v_started,'expiresAt',v_started+interval '5 days','resetGeneration',1
    );
    PERFORM public.execute_canonical_sync_command(
      '50000000-0000-4000-8000-000000000004','CREATE_GOAL',v_payload,'goal-hash-4','test-device',
      '20000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'Goal for an inactive customer was accepted';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;

  v_payload:=jsonb_build_object(
    'id','60000000-0000-4000-8000-000000000001',
    'customerId','30000000-0000-4000-8000-000000000002',
    'requestedTarget',12,'resetGeneration',1
  );
  v_result:=public.execute_canonical_sync_command(
    '60000000-0000-4000-8000-000000000001','RECORD_GOAL_REQUEST',v_payload,'request-hash-1','test-device',
    auth.uid()
  );
  IF v_result->>'success'<>'true' OR v_result#>>'{result,status}'<>'PENDING' THEN
    RAISE EXCEPTION 'Goal request recording failed: %',v_result;
  END IF;
END;
$super_admin_goal$;
RESET ROLE;

-- Ordinary admin is limited to its live goals:manage grant.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
SELECT set_config('request.jwt.claim.session_id','40000000-0000-4000-8000-000000000002',false);
DO $ordinary_admin_goal$
DECLARE v_result jsonb; v_started timestamptz:=now(); v_goal_id uuid:='50000000-0000-4000-8000-000000000005';
BEGIN
  v_result:=public.execute_canonical_sync_command(
    v_goal_id,'CREATE_GOAL',
    jsonb_build_object(
      'id',v_goal_id,'customerId','30000000-0000-4000-8000-000000000002',
      'targetQuantity',10,'durationDays',5,'bonusAmountMinor',150,
      'startedAt',v_started,'expiresAt',v_started+interval '5 days','resetGeneration',1
    ),
    'goal-hash-5','test-device','20000000-0000-4000-8000-000000000002'
  );
  IF v_result->>'success'<>'true' THEN RAISE EXCEPTION 'Authorized ordinary admin goal creation failed: %',v_result; END IF;
END;
$ordinary_admin_goal$;
RESET ROLE;

-- An ordinary admin without the permission is denied even though the command exists.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',false);
SELECT set_config('request.jwt.claim.session_id','40000000-0000-4000-8000-000000000003',false);
DO $denied_admin_goal$
DECLARE v_started timestamptz:=now(); v_goal_id uuid:='50000000-0000-4000-8000-000000000006';
BEGIN
  BEGIN
    PERFORM public.execute_canonical_sync_command(
      v_goal_id,'CREATE_GOAL',
      jsonb_build_object(
        'id',v_goal_id,'customerId','30000000-0000-4000-8000-000000000003',
        'targetQuantity',10,'durationDays',5,'bonusAmountMinor',150,
        'startedAt',v_started,'expiresAt',v_started+interval '5 days','resetGeneration',1
      ),
      'goal-hash-6','test-device','20000000-0000-4000-8000-000000000003'
    );
    RAISE EXCEPTION 'Admin without goals:manage was allowed to create a goal';
  EXCEPTION WHEN SQLSTATE 'P4003' THEN NULL;
  END;
END;
$denied_admin_goal$;
RESET ROLE;

-- All unrelated command types still reach the original hardened dispatcher.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',false);
SELECT set_config('request.jwt.claim.session_id','40000000-0000-4000-8000-000000000001',false);
DO $delegation$
DECLARE v_result jsonb;
BEGIN
  v_result:=public.execute_canonical_sync_command(
    '70000000-0000-4000-8000-000000000001','CREATE_ORDER','{}'::jsonb,'delegate-hash','test-device',
    auth.uid()
  );
  IF v_result->>'delegated'<>'true' THEN
    RAISE EXCEPTION 'Non-goal command did not delegate to the original dispatcher: %',v_result;
  END IF;
END;
$delegation$;
RESET ROLE;

DO $persisted$
BEGIN
  IF (SELECT count(*) FROM public.goals WHERE customer_id='30000000-0000-4000-8000-000000000001' AND status='ACTIVE')<>1
     OR (SELECT count(*) FROM public.goals WHERE customer_id='30000000-0000-4000-8000-000000000002' AND status='ACTIVE')<>1
     OR (SELECT count(*) FROM public.goal_requests WHERE id='60000000-0000-4000-8000-000000000001' AND status='PENDING')<>1
     OR (SELECT count(*) FROM public.processed_commands WHERE command_id='50000000-0000-4000-8000-000000000001')<>1 THEN
    RAISE EXCEPTION 'Canonical goal commands did not persist exactly once';
  END IF;
END;
$persisted$;
