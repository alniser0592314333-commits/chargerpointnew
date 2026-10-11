-- Allocate completed-goal bonuses to recognized outstanding items using the canonical FIFO order.
-- This migration changes only the goal reward allocation path and lock ordering; it does not
-- change RPC signatures, authentication policy, ledger history, or customer balance semantics.

-- Preserve the currently installed canonical dispatcher, including newer debt-limit safeguards,
-- and inject only the customer-first lock acquisition needed for FIFO bonus allocation.
DO $migration$
DECLARE
  v_function_definition text;
  v_route_anchor text := $anchor$
    -- ==========================================
    -- 5. ROUTE BY CANONICAL COMMAND TYPE
    -- ==========================================
    CASE p_command_type$anchor$;
  v_lock_block text := $locks$
    -- Finance/goal operations must acquire the customer lock before item or goal locks.
    -- This matches CREATE_PAYMENT's lock order and prevents a delivery-triggered bonus
    -- allocation from deadlocking with a concurrent payment.
    v_customer_uuid := NULL;
    IF p_command_type IN ('DELIVER_ORDER_ITEM', 'CANCEL_ORDER_ITEM') THEN
        v_item_uuid := COALESCE((p_payload->>'itemId')::UUID, (p_payload->>'orderItemId')::UUID, (p_payload->>'id')::UUID);
        SELECT o.customer_id INTO v_customer_uuid
        FROM public.order_items oi
        JOIN public.orders o ON o.id = oi.order_id
        WHERE oi.id = v_item_uuid;
    ELSIF p_command_type = 'CANCEL_ORDER' THEN
        v_order_uuid := COALESCE((p_payload->>'orderId')::UUID, (p_payload->>'id')::UUID);
        SELECT customer_id INTO v_customer_uuid
        FROM public.orders
        WHERE id = v_order_uuid;
    ELSIF p_command_type IN ('UPDATE_GOAL_CONFIG', 'UPDATE_GOAL_PROGRESS') THEN
        v_entity_uuid := COALESCE((p_payload->>'goalId')::UUID, (p_payload->>'id')::UUID);
        SELECT customer_id INTO v_customer_uuid
        FROM public.goals
        WHERE id = v_entity_uuid;
    END IF;

    IF v_customer_uuid IS NOT NULL THEN
        PERFORM 1
        FROM public.customers
        WHERE id = v_customer_uuid
        FOR UPDATE;
    END IF;

$locks$;
  v_replaced_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.execute_canonical_sync_command(uuid,text,jsonb,text,text,uuid)'::regprocedure
  ) INTO v_function_definition;

  IF v_function_definition IS NULL THEN
    RAISE EXCEPTION 'Canonical sync dispatcher was not found; refusing to alter its lock order';
  END IF;
  IF position(v_route_anchor IN v_function_definition) = 0 THEN
    RAISE EXCEPTION 'Expected canonical dispatcher route anchor was not found; refusing an unsafe rewrite';
  END IF;

  v_replaced_definition := replace(v_function_definition, v_route_anchor, v_lock_block || v_route_anchor);
  IF v_replaced_definition = v_function_definition
     OR (length(v_function_definition) - length(replace(v_function_definition, v_route_anchor, ''))) <> length(v_route_anchor) THEN
    RAISE EXCEPTION 'Canonical dispatcher route anchor was not replaced exactly once';
  END IF;

  EXECUTE v_replaced_definition;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.evaluate_customer_active_goal(p_customer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    IF COALESCE(auth.role(), '') <> 'service_role' THEN
      RAISE EXCEPTION 'Authentication required to evaluate a customer goal' USING ERRCODE='P0001';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.admins
    WHERE auth_user_id = auth.uid() AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'Only an active registered admin may evaluate a customer goal' USING ERRCODE='P0001';
  END IF;

  -- Acquire the same customer-first lock order as canonical financial mutations.
  PERFORM 1 FROM public.customers WHERE id = p_customer_id FOR UPDATE;
  RETURN public.evaluate_customer_active_goal_internal(p_customer_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_goal_bonus_fifo(
  p_bonus_ledger_id uuid,
  p_customer_id uuid,
  p_amount_minor bigint,
  p_created_at timestamptz,
  p_goal_id uuid,
  p_recognized_before timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_goal_id uuid;
  v_remaining bigint;
  v_due bigint;
  v_allocate bigint;
  v_item record;
  v_existing_payment record;
BEGIN
  IF p_amount_minor <= 0 THEN
    RETURN;
  END IF;

  SELECT g.id INTO v_goal_id
  FROM public.goals g
  WHERE g.id = p_goal_id
    AND g.customer_id = p_customer_id
    AND g.bonus_amount_minor = p_amount_minor;

  IF v_goal_id IS NULL THEN
    RETURN;
  END IF;

  -- Idempotent if the funding record already exists; reject an unrelated UUID collision.
  SELECT p.id, p.customer_id, p.amount_minor, p.payment_method
  INTO v_existing_payment
  FROM public.payments p
  WHERE p.id = p_bonus_ledger_id;

  IF FOUND THEN
    IF v_existing_payment.customer_id = p_customer_id
       AND v_existing_payment.amount_minor = p_amount_minor
       AND v_existing_payment.payment_method = 'GOAL_BONUS' THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'Goal bonus allocation identity conflicts with an existing payment record';
  END IF;

  -- Reuse the bonus ledger UUID as the allocation funding identity. This creates
  -- no second PAYMENT ledger entry, so the bonus is counted in the customer balance once.
  INSERT INTO public.payments (
    id, customer_id, amount_minor, payment_method, reference,
    actor_admin_id, command_id, notes, created_at
  )
  SELECT
    p_bonus_ledger_id, p_customer_id, p_amount_minor, 'GOAL_BONUS',
    'Goal completion bonus', fl.actor_admin_id, p_bonus_ledger_id,
    'Goal ID: ' || v_goal_id::text, p_created_at
  FROM public.financial_ledger fl
  WHERE fl.id = p_bonus_ledger_id;

  v_remaining := p_amount_minor;

  -- Canonical dispatcher and public evaluator lock the customer first. Lock all
  -- eligible item rows in the same FIFO order used by real payments before reading
  -- their existing allocations, so concurrent financial mutations cannot over-allocate.
  -- The optional cutoff is used only for safe historical backfill; live bonuses are
  -- allocated against debt that exists at the moment the bonus is issued.
  PERFORM 1
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  WHERE o.customer_id = p_customer_id
    AND o.status <> 'cancelled'
    AND oi.status <> 'cancelled'
    AND oi.financial_status = 'RECOGNIZED'
    AND oi.payment_status <> 'PAID'
    AND (
      p_recognized_before IS NULL
      OR COALESCE(oi.financially_recognized_at, oi.delivered_at) <= p_recognized_before
    )
  ORDER BY o.internal_sequence ASC, oi.item_sequence ASC, oi.id ASC
  FOR UPDATE OF oi;

  FOR v_item IN
    SELECT oi.id, oi.order_id, oi.final_charge_snapshot_minor,
           COALESCE(SUM(pa.allocated_amount_minor), 0) AS paid_so_far
    FROM public.order_items oi
    JOIN public.orders o ON oi.order_id = o.id
    LEFT JOIN public.payment_allocations pa ON pa.order_item_id = oi.id
    WHERE o.customer_id = p_customer_id
      AND o.status <> 'cancelled'
      AND oi.status <> 'cancelled'
      AND oi.financial_status = 'RECOGNIZED'
      AND oi.payment_status <> 'PAID'
      AND (
        p_recognized_before IS NULL
        OR COALESCE(oi.financially_recognized_at, oi.delivered_at) <= p_recognized_before
      )
    GROUP BY oi.id, oi.order_id, oi.final_charge_snapshot_minor,
             o.internal_sequence, oi.item_sequence
    ORDER BY o.internal_sequence ASC, oi.item_sequence ASC, oi.id ASC
  LOOP
    EXIT WHEN v_remaining <= 0;

    v_due := v_item.final_charge_snapshot_minor - v_item.paid_so_far;
    IF v_due <= 0 THEN
      UPDATE public.order_items
      SET payment_status = 'PAID', updated_at = NOW(), version = version + 1
      WHERE id = v_item.id AND payment_status <> 'PAID';
      CONTINUE;
    END IF;

    v_allocate := LEAST(v_remaining, v_due);
    v_remaining := v_remaining - v_allocate;

    UPDATE public.order_items
    SET payment_status = CASE
          WHEN v_allocate >= v_due THEN 'PAID'
          ELSE 'PARTIALLY_PAID'
        END,
        updated_at = NOW(),
        version = version + 1
    WHERE id = v_item.id;

    INSERT INTO public.payment_allocations (
      id, payment_id, order_item_id, order_id, allocated_amount_minor, created_at
    ) VALUES (
      gen_random_uuid(), p_bonus_ledger_id, v_item.id, v_item.order_id, v_allocate, p_created_at
    );
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.allocate_goal_bonus_fifo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.event_type <> 'BONUS'
     OR COALESCE(NEW.metadata->>'reason', '') <> 'GOAL_COMPLETED'
     OR NEW.amount_minor <= 0 THEN
    RETURN NEW;
  END IF;

  PERFORM public.apply_goal_bonus_fifo(
    NEW.id, NEW.customer_id, NEW.amount_minor, NEW.created_at, NEW.reference_id, NULL
  );
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_allocate_goal_bonus_fifo ON public.financial_ledger;
CREATE TRIGGER trg_allocate_goal_bonus_fifo
AFTER INSERT ON public.financial_ledger
FOR EACH ROW
WHEN (NEW.event_type = 'BONUS')
EXECUTE FUNCTION public.allocate_goal_bonus_fifo();

-- Safe backfill for historical completed-goal bonuses that have not been allocated.
-- Do not replay a bonus if later positive credits or later allocations exist: doing so
-- could silently reshuffle payments already recorded after that bonus. Only debt already
-- recognized by the bonus timestamp is eligible for this historical repair.
DO $bonus_backfill$
DECLARE
  v_bonus record;
BEGIN
  FOR v_bonus IN
    SELECT fl.id, fl.customer_id, fl.amount_minor, fl.created_at, fl.reference_id
    FROM public.financial_ledger fl
    JOIN public.goals g
      ON g.id = fl.reference_id
     AND g.customer_id = fl.customer_id
     AND g.bonus_ledger_id = fl.id
     AND g.bonus_amount_minor = fl.amount_minor
     AND g.status = 'COMPLETED'
    WHERE fl.event_type = 'BONUS'
      AND COALESCE(fl.metadata->>'reason', '') = 'GOAL_COMPLETED'
      AND fl.amount_minor > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.payments p
        WHERE p.id = fl.id AND p.payment_method = 'GOAL_BONUS'
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.financial_ledger later
        WHERE later.customer_id = fl.customer_id
          AND later.event_type IN ('PAYMENT', 'CREDIT_ADJUSTMENT')
          AND later.amount_minor > 0
          AND later.created_at > fl.created_at
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.payment_allocations pa
        JOIN public.payments p ON p.id = pa.payment_id
        WHERE p.customer_id = fl.customer_id
          AND pa.created_at > fl.created_at
      )
    ORDER BY fl.created_at ASC, fl.id ASC
  LOOP
    PERFORM 1
    FROM public.customers
    WHERE id = v_bonus.customer_id
    FOR UPDATE;

    PERFORM public.apply_goal_bonus_fifo(
      v_bonus.id,
      v_bonus.customer_id,
      v_bonus.amount_minor,
      v_bonus.created_at,
      v_bonus.reference_id,
      v_bonus.created_at
    );
  END LOOP;
END;
$bonus_backfill$;

REVOKE ALL ON FUNCTION public.apply_goal_bonus_fifo(uuid, uuid, bigint, timestamptz, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.allocate_goal_bonus_fifo()
  FROM PUBLIC, anon, authenticated, service_role;
