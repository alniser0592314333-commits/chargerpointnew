-- Runtime regression tests for the actual smart-goal policy migration.
BEGIN;

-- The migration must repair a safe historical bonus but must not pay an item
-- that became recognized only after the bonus timestamp.
DO $historical_bonus_backfill$
BEGIN
  IF (SELECT payment_status FROM public.order_items
      WHERE id='c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3') <> 'PAID' THEN
    RAISE EXCEPTION 'Historical bonus backfill must pay the oldest eligible item';
  END IF;
  IF (SELECT payment_status FROM public.order_items
      WHERE id='d4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4') <> 'UNPAID' THEN
    RAISE EXCEPTION 'Historical bonus backfill must not pay items recognized after the bonus';
  END IF;
  IF (SELECT count(*) FROM public.payment_allocations
      WHERE payment_id='efefefef-efef-4fef-8fef-efefefefefef') <> 1
     OR (SELECT COALESCE(SUM(allocated_amount_minor),0) FROM public.payment_allocations
         WHERE payment_id='efefefef-efef-4fef-8fef-efefefefefef') <> 15 THEN
    RAISE EXCEPTION 'Historical bonus backfill must allocate only the 15-unit pre-existing debt';
  END IF;
  IF (SELECT count(*) FROM public.payments
      WHERE id='efefefef-efef-4fef-8fef-efefefefefef' AND payment_method='GOAL_BONUS') <> 1 THEN
    RAISE EXCEPTION 'Historical bonus backfill must create exactly one allocation funding record';
  END IF;
  IF EXISTS (SELECT 1 FROM public.financial_ledger
             WHERE event_type='PAYMENT' AND reference_id='efefefef-efef-4fef-8fef-efefefefefef') THEN
    RAISE EXCEPTION 'Historical bonus backfill must not duplicate the bonus in the ledger';
  END IF;
END;
$historical_bonus_backfill$;

INSERT INTO public.admins(id, auth_user_id, role, is_active)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '11111111-1111-4111-8111-111111111111', 'SUPER_ADMIN', TRUE);
SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', TRUE);
SELECT set_config('request.jwt.claim.role', 'authenticated', TRUE);

DO $goal_privileges$
BEGIN
  IF has_function_privilege('anon', 'public.evaluate_customer_active_goal(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Anonymous callers must not execute the goal evaluator';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.evaluate_customer_active_goal(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.evaluate_customer_active_goal(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Authorized goal-evaluator grants are missing';
  END IF;
  IF has_function_privilege('authenticated', 'public.evaluate_customer_active_goal_internal(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.evaluate_customer_active_goal_internal(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Internal goal evaluator must not be directly executable by client roles';
  END IF;
END $goal_privileges$;

INSERT INTO public.customers(id, status, is_active) VALUES
 ('22222222-2222-4222-8222-222222222222', 'ACTIVE', TRUE),
 ('33333333-3333-4333-8333-333333333333', 'ACTIVE', TRUE);
INSERT INTO public.orders(id, customer_id, day_id, display_number, internal_sequence) VALUES
 ('44444444-4444-4444-8444-444444444444', '22222222-2222-4222-8222-222222222222',
  '99999999-9999-4999-8999-999999999999', 1, 1),
 ('55555555-5555-4555-8555-555555555555', '22222222-2222-4222-8222-222222222222',
  '99999999-9999-4999-8999-999999999999', 2, 2);

INSERT INTO public.goals(
 id, customer_id, target_quantity, current_progress, bonus_amount_minor,
 duration_days, status, started_at, expires_at, version
) VALUES (
 '66666666-6666-4666-8666-666666666666',
 '22222222-2222-4222-8222-222222222222',
 2, 0, 40, 3, 'ACTIVE', now() - interval '1 day',
 (now() - interval '1 day') + interval '3 days', 1
), (
 '77777777-7777-4777-8777-777777777777',
 '33333333-3333-4333-8333-333333333333',
 2, 0, 20, 3, 'ACTIVE', now() - interval '5 days',
 (now() - interval '5 days') + interval '3 days', 1
);

INSERT INTO public.order_items(id, order_id, item_sequence, final_charge_snapshot_minor) VALUES
 ('88888888-8888-4888-8888-888888888888', '44444444-4444-4444-8444-444444444444', 1, 25),
 ('99999999-9999-4999-8999-999999999998', '55555555-5555-4555-8555-555555555555', 1, 30);

-- Progress is calculated from server-recognized delivery state, not client payload.
UPDATE public.order_items
SET status='delivered', operational_status='DELIVERED', financial_status='RECOGNIZED',
    delivered_at=now() - interval '30 minutes'
WHERE id='88888888-8888-4888-8888-888888888888';

DO $$
DECLARE g public.goals%ROWTYPE;
BEGIN
  SELECT * INTO g FROM public.goals WHERE id='66666666-6666-4666-8666-666666666666';
  IF g.status <> 'ACTIVE' OR g.current_progress <> 1 OR g.bonus_ledger_id IS NOT NULL THEN
    RAISE EXCEPTION 'Goal progress must be server-calculated after first recognized delivery';
  END IF;
END $$;

UPDATE public.order_items
SET status='delivered', operational_status='DELIVERED', financial_status='RECOGNIZED',
    delivered_at=now() - interval '20 minutes'
WHERE id='99999999-9999-4999-8999-999999999998';

DO $$
DECLARE g public.goals%ROWTYPE; bonus_count integer;
BEGIN
  SELECT * INTO g FROM public.goals WHERE id='66666666-6666-4666-8666-666666666666';
  SELECT count(*) INTO bonus_count FROM public.financial_ledger
   WHERE event_type='BONUS' AND reference_id=g.id AND customer_id=g.customer_id;
  IF g.status <> 'COMPLETED' OR g.current_progress <> 2 OR g.bonus_ledger_id IS NULL THEN
    RAISE EXCEPTION 'Goal must complete only after target is reached from recognized deliveries';
  END IF;
  IF bonus_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one immutable bonus ledger entry, found %', bonus_count;
  END IF;

  -- The 40-unit bonus must be allocated FIFO: 25 to the oldest item, then 15
  -- to the next item. No second PAYMENT ledger entry may double-count the reward.
  IF (SELECT payment_status FROM public.order_items
      WHERE id='88888888-8888-4888-8888-888888888888') <> 'PAID' THEN
    RAISE EXCEPTION 'Goal bonus must fully pay the oldest outstanding item';
  END IF;
  IF (SELECT payment_status FROM public.order_items
      WHERE id='99999999-9999-4999-8999-999999999998') <> 'PARTIALLY_PAID' THEN
    RAISE EXCEPTION 'Goal bonus remainder must partially pay the next item';
  END IF;
  IF (SELECT count(*) FROM public.payments
      WHERE id=g.bonus_ledger_id AND payment_method='GOAL_BONUS' AND amount_minor=40) <> 1 THEN
    RAISE EXCEPTION 'Goal bonus must have exactly one non-cash allocation funding record';
  END IF;
  IF (SELECT count(*) FROM public.payment_allocations WHERE payment_id=g.bonus_ledger_id) <> 2
     OR (SELECT COALESCE(SUM(allocated_amount_minor),0)
         FROM public.payment_allocations WHERE payment_id=g.bonus_ledger_id) <> 40 THEN
    RAISE EXCEPTION 'Goal bonus allocations must total the bonus exactly without duplication';
  END IF;
  IF EXISTS (SELECT 1 FROM public.financial_ledger
             WHERE event_type='PAYMENT' AND reference_id=g.bonus_ledger_id) THEN
    RAISE EXCEPTION 'Goal bonus must not create a second PAYMENT ledger entry';
  END IF;

  IF public.evaluate_customer_active_goal(g.customer_id)->>'hasActiveGoal' <> 'false' THEN
    RAISE EXCEPTION 'Completed goal must not be evaluated as active again';
  END IF;
  IF (SELECT count(*) FROM public.financial_ledger WHERE event_type='BONUS' AND reference_id=g.id) <> 1
     OR (SELECT count(*) FROM public.payment_allocations WHERE payment_id=g.bonus_ledger_id) <> 2 THEN
    RAISE EXCEPTION 'Re-evaluation must not duplicate the bonus or its allocations';
  END IF;
END $$;

-- An expired goal below target must fail and never receive a bonus.
SELECT public.evaluate_customer_active_goal('33333333-3333-4333-8333-333333333333');
DO $$
DECLARE g public.goals%ROWTYPE;
BEGIN
  SELECT * INTO g FROM public.goals WHERE id='77777777-7777-4777-8777-777777777777';
  IF g.status <> 'FAILED' OR g.current_progress >= g.target_quantity OR g.bonus_ledger_id IS NOT NULL THEN
    RAISE EXCEPTION 'Expired below-target goal must fail without a bonus';
  END IF;
END $$;

-- Reject client attempts to create an invalid reward cap or duration.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.goals(
      id, customer_id, target_quantity, current_progress, bonus_amount_minor,
      duration_days, status, started_at, expires_at
    ) VALUES (
      '12121212-1212-4212-8212-121212121212',
      '33333333-3333-4333-8333-333333333333',
      1, 0, 21, 3, 'ACTIVE', now(),
      now() + interval '3 days'
    );
    RAISE EXCEPTION 'Invalid bonus cap unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '22023' OR check_violation THEN
    NULL;
  END;
END $$;

ROLLBACK;
