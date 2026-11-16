-- Runtime checks for the isolated goal expiry/reconciliation migration.

INSERT INTO public.admins(id, role, is_active)
VALUES ('10000000-0000-4000-8000-000000000001', 'SUPER_ADMIN', true);

INSERT INTO public.customers(id, name, is_active, status)
VALUES
  ('20000000-0000-4000-8000-000000000001', 'Admin Read Customer', true, 'ACTIVE'),
  ('20000000-0000-4000-8000-000000000002', 'Portal Failure Customer', true, 'ACTIVE'),
  ('20000000-0000-4000-8000-000000000003', 'Portal Completion Customer', true, 'ACTIVE'),
  ('20000000-0000-4000-8000-000000000004', 'Normal Push Customer', true, 'ACTIVE');

INSERT INTO public.goals(
  id, customer_id, target_quantity, current_progress, bonus_amount_minor,
  duration_days, status, started_at, expires_at, created_at, updated_at, version
)
VALUES
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 10, 3, 200, 7, 'ACTIVE', now()-interval '8 days', now()-interval '1 day', now()-interval '8 days', now(), 1),
  ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 10, 2, 200, 7, 'ACTIVE', now()-interval '8 days', now()-interval '1 day', now()-interval '8 days', now(), 1),
  ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003', 2, 2, 200, 7, 'ACTIVE', now()-interval '8 days', now()-interval '1 day', now()-interval '8 days', now(), 1);

SELECT set_config('test.admin_id', '10000000-0000-4000-8000-000000000001', false);
SELECT public.get_admin_goals_page_data();

DO $$
BEGIN
  IF (SELECT status FROM public.goals WHERE id = '30000000-0000-4000-8000-000000000001') <> 'FAILED' THEN
    RAISE EXCEPTION 'Admin read did not reconcile expired goal';
  END IF;
  IF (SELECT count(*) FROM public.push_events) <> 0 THEN
    RAISE EXCEPTION 'Read-time reconciliation unexpectedly dispatched a push';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.get_admin_goals_page_data()'::regprocedure) <> 'v' THEN
    RAISE EXCEPTION 'Admin goals read RPC must be VOLATILE after on-demand reconciliation';
  END IF;
END;
$$;

-- Both existing customer portal RPC overloads reconcile only the token customer.
SELECT public.public_resolve_customer_portal('20000000-0000-4000-8000-000000000002');
SELECT public.public_resolve_customer_portal('20000000-0000-4000-8000-000000000003', false);

DO $$
BEGIN
  IF (SELECT status FROM public.goals WHERE id = '30000000-0000-4000-8000-000000000002') <> 'FAILED' THEN
    RAISE EXCEPTION 'Single-argument customer portal resolver did not reconcile expiry';
  END IF;
  IF (SELECT status FROM public.goals WHERE id = '30000000-0000-4000-8000-000000000003') <> 'COMPLETED' THEN
    RAISE EXCEPTION 'Two-argument customer portal resolver did not reconcile completion';
  END IF;
  IF (SELECT count(*) FROM public.financial_ledger WHERE event_type = 'BONUS') <> 1 THEN
    RAISE EXCEPTION 'Authoritative completion did not create exactly one bonus';
  END IF;
  IF (SELECT count(*) FROM public.push_events) <> 0 THEN
    RAISE EXCEPTION 'Customer portal read caused external push dispatch';
  END IF;
END;
$$;

-- Normal event-driven completion still keeps its existing push behavior.
INSERT INTO public.goals(
  id, customer_id, target_quantity, current_progress, bonus_amount_minor,
  duration_days, status, started_at, expires_at, created_at, updated_at, version
)
VALUES (
  '30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000004',
  1, 0, 200, 7, 'ACTIVE', now(), now()+interval '7 days', now(), now(), 1
);
UPDATE public.goals
SET status = 'COMPLETED', completed_at = now(), version = version + 1
WHERE id = '30000000-0000-4000-8000-000000000004';

DO $$
BEGIN
  IF (SELECT count(*) FROM public.push_events) <> 1 THEN
    RAISE EXCEPTION 'Normal delivery-triggered completion push behavior was not preserved';
  END IF;
END;
$$;

-- A BONUS ledger row cannot be committed while its goal remains ACTIVE.
DO $$
DECLARE
  v_goal_id uuid := '30000000-0000-4000-8000-000000000005';
  v_bonus_id uuid := '40000000-0000-4000-8000-000000000005';
  v_rejected boolean := false;
BEGIN
  INSERT INTO public.goals(
    id, customer_id, target_quantity, current_progress, bonus_amount_minor,
    duration_days, status, started_at, expires_at, created_at, updated_at, version
  )
  VALUES (
    v_goal_id, '20000000-0000-4000-8000-000000000004',
    10, 0, 200, 7, 'ACTIVE', now(), now()+interval '7 days', now(), now(), 1
  );

  BEGIN
    INSERT INTO public.financial_ledger(id, event_type, amount_minor, customer_id, reference_id)
    VALUES (v_bonus_id, 'BONUS', 200, '20000000-0000-4000-8000-000000000004', v_goal_id);
    SET CONSTRAINTS trg_goal_bonus_requires_completion IMMEDIATE;
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'Unearned BONUS ledger row was not rejected';
  END IF;
END;
$$;

-- Trigger + manual canonical logging in one transaction must produce one delta row.
DO $$
DECLARE
  v_id uuid := '50000000-0000-4000-8000-000000000001';
  v_count integer;
BEGIN
  INSERT INTO public.goals(
    id, customer_id, target_quantity, current_progress, bonus_amount_minor,
    duration_days, status, started_at, expires_at, created_at, updated_at, version
  )
  VALUES (
    v_id, '20000000-0000-4000-8000-000000000001',
    10, 0, 200, 7, 'ACTIVE', now(), now()+interval '7 days', now(), now(), 1
  );
  PERFORM public.record_canonical_change('goals', v_id, 'INSERT', jsonb_build_object('id', v_id), 1);
  SELECT count(*) INTO v_count FROM public.change_log
  WHERE entity_type = 'goals' AND entity_id = v_id AND action = 'INSERT' AND version = 1;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Goal trigger/manual change-log duplicate was not removed';
  END IF;
END;
$$;

DO $$
DECLARE
  v_id uuid := '60000000-0000-4000-8000-000000000001';
  v_count integer;
BEGIN
  INSERT INTO public.goal_requests(id, customer_id, requested_target, status, version)
  VALUES (v_id, '20000000-0000-4000-8000-000000000001', 10, 'PENDING', 1);
  UPDATE public.goal_requests SET status = 'APPROVED', version = 2 WHERE id = v_id;
  PERFORM public.record_canonical_change('goal_requests', v_id, 'UPDATE', jsonb_build_object('id', v_id), 2);
  SELECT count(*) INTO v_count FROM public.change_log
  WHERE entity_type = 'goal_requests' AND entity_id = v_id AND action = 'UPDATE' AND version = 2;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Goal-request trigger/manual change-log duplicate was not removed';
  END IF;
END;
$$;

DO $$
DECLARE
  v_id uuid := '70000000-0000-4000-8000-000000000001';
  v_count integer;
BEGIN
  INSERT INTO public.financial_ledger(id, event_type, amount_minor, customer_id)
  VALUES (v_id, 'PAYMENT', 100, '20000000-0000-4000-8000-000000000001');
  PERFORM public.record_canonical_change('financial_ledger', v_id, 'INSERT', jsonb_build_object('id', v_id), 1);
  SELECT count(*) INTO v_count FROM public.change_log
  WHERE entity_type = 'financial_ledger' AND entity_id = v_id AND action = 'INSERT' AND version = 1;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Financial-ledger trigger/manual change-log duplicate was not removed';
  END IF;
END;
$$;


-- Approval must reject incomplete legacy payloads instead of inventing defaults.
INSERT INTO public.customers(id, name, is_active, status)
VALUES ('20000000-0000-4000-8000-000000000005', 'Approval Validation Customer', true, 'ACTIVE');

INSERT INTO public.goal_requests(id, customer_id, requested_target, status, version)
VALUES ('60000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000005', 10, 'PENDING', 1);

DO $
DECLARE
  v_rejected boolean := false;
BEGIN
  BEGIN
    PERFORM public.execute_canonical_sync_command_unlocked(
      gen_random_uuid(),
      'APPROVE_GOAL_REQUEST',
      jsonb_build_object('requestId', '60000000-0000-4000-8000-000000000002'),
      'fixture-hash',
      'fixture-device',
      '10000000-0000-4000-8000-000000000001'
    );
  EXCEPTION WHEN SQLSTATE 'P2201' THEN
    v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'Incomplete goal approval payload was not rejected';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.goals
    WHERE customer_id = '20000000-0000-4000-8000-000000000005'
  ) THEN
    RAISE EXCEPTION 'Incomplete goal approval created a goal using fallback values';
  END IF;
END;
$;

SELECT public.execute_canonical_sync_command_unlocked(
  gen_random_uuid(),
  'APPROVE_GOAL_REQUEST',
  jsonb_build_object(
    'requestId', '60000000-0000-4000-8000-000000000002',
    'resultingGoalId', '30000000-0000-4000-8000-000000000005',
    'targetQuantity', 12,
    'bonusAmountMinor', 180,
    'durationDays', 6
  ),
  'fixture-hash',
  'fixture-device',
  '10000000-0000-4000-8000-000000000001'
);

DO $
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.goals
    WHERE id = '30000000-0000-4000-8000-000000000005'
      AND target_quantity = 12
      AND bonus_amount_minor = 180
      AND duration_days = 6
  ) THEN
    RAISE EXCEPTION 'Approval did not preserve the explicitly reviewed proposal values';
  END IF;
END;
$;

SELECT 'goal_expiry_reconciliation_runtime_tests_passed' AS result;
