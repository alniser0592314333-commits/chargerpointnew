-- Reconcile expired active goals only when an authorized admin already loads
-- the goals read model. This avoids a background polling schedule and adds no
-- client request, HTTP call, Edge Function invocation, or periodic database work.
--
-- The existing order-item trigger remains the immediate path for progress and
-- completion. This read-time reconciliation is only the fallback for goals that
-- expired without a subsequent order-item update.

CREATE OR REPLACE FUNCTION public.get_admin_goals_page_data()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_is_super_admin boolean := false;
  v_can_view_goals boolean := false;
  v_can_view_requests boolean := false;
  v_customer_id uuid;
  v_result jsonb;
BEGIN
  v_admin_id := public._cp_assert_active_admin_permission(NULL);

  SELECT a.role
    INTO v_admin_role
  FROM public.admins a
  WHERE a.id = v_admin_id
    AND a.is_active IS TRUE;

  v_is_super_admin := upper(replace(trim(coalesce(v_admin_role, '')), ' ', '_')) = 'SUPER_ADMIN';

  IF v_is_super_admin THEN
    v_can_view_goals := true;
    v_can_view_requests := true;
  ELSE
    SELECT
      coalesce(bool_or(ep.permission IN ('goals:view', 'goals:manage')), false),
      coalesce(bool_or(ep.permission IN ('goals:requests:view', 'goals:approve')), false)
    INTO v_can_view_goals, v_can_view_requests
    FROM public.get_effective_permissions__session_guarded_impl(v_admin_id) ep;
  END IF;

  IF NOT v_can_view_goals AND NOT v_can_view_requests THEN
    RAISE EXCEPTION 'Missing required permission: goals:view or goals:requests:view'
      USING ERRCODE = '42501';
  END IF;

  -- Only reconcile when this request is already authorized to view goals.
  -- There is at most one ACTIVE goal per customer (partial unique index).
  IF v_can_view_goals THEN
    -- Read-time reconciliation must not fan out to an external push provider.
    -- Normal delivery-triggered completion keeps its existing push behavior.
    PERFORM set_config('app.suppress_goal_completion_push', '1', true);
    FOR v_customer_id IN
      SELECT g.customer_id
      FROM public.goals g
      WHERE g.status = 'ACTIVE'
        AND g.expires_at <= now()
      ORDER BY g.expires_at, g.customer_id
    LOOP
      PERFORM public.evaluate_customer_active_goal_internal(v_customer_id);
    END LOOP;
    PERFORM set_config('app.suppress_goal_completion_push', '0', true);
  END IF;

  SELECT jsonb_build_object(
    'schema_version', 1,
    'goals', CASE WHEN v_can_view_goals THEN
      coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'id', g.id,
          'customer_id', g.customer_id,
          'target_quantity', g.target_quantity,
          'current_progress', g.current_progress,
          'bonus_amount_minor', g.bonus_amount_minor,
          'duration_days', g.duration_days,
          'status', g.status,
          'started_at', g.started_at,
          'expires_at', g.expires_at,
          'completed_at', g.completed_at,
          'bonus_ledger_id', g.bonus_ledger_id,
          'created_at', g.created_at,
          'updated_at', g.updated_at,
          'version', g.version
        ) ORDER BY g.created_at DESC, g.id)
        FROM public.goals g
      ), '[]'::jsonb)
    ELSE '[]'::jsonb END,
    'goal_requests', CASE WHEN v_can_view_requests THEN
      coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'id', r.id,
          'customer_id', r.customer_id,
          'requested_target', r.requested_target,
          'status', r.status,
          'reviewed_by', r.reviewed_by,
          'reviewed_at', r.reviewed_at,
          'rejection_reason', r.rejection_reason,
          'resulting_goal_id', r.resulting_goal_id,
          'created_at', r.created_at,
          'updated_at', r.updated_at,
          'version', r.version
        ) ORDER BY r.created_at DESC, r.id)
        FROM public.goal_requests r
      ), '[]'::jsonb)
    ELSE '[]'::jsonb END,
    'customers', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'is_active', (c.is_active IS TRUE AND c.deleted_at IS NULL),
        'deleted_at', c.deleted_at,
        'created_at', c.created_at,
        'updated_at', c.updated_at,
        'version', c.version
      ) ORDER BY c.name, c.id)
      FROM public.customers c
      WHERE (v_can_view_goals AND c.is_active IS TRUE AND c.deleted_at IS NULL)
         OR c.id IN (SELECT g.customer_id FROM public.goals g WHERE v_can_view_goals
                     UNION
                     SELECT r.customer_id FROM public.goal_requests r WHERE v_can_view_requests)
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.get_admin_goals_page_data()
IS 'Returns the admin goals read model and reconciles expired ACTIVE goals on-demand, avoiding a background polling job.';

-- Goal, goal-request, and financial-ledger writes are already captured by trg_change_capture.
-- The canonical command dispatcher also calls record_canonical_change after
-- those DML statements, which previously produced two change_log rows for the
-- same entity/action/version in one transaction. Reuse the trigger's row instead
-- of appending a second sync event. The entity index keeps this lookup bounded.
CREATE OR REPLACE FUNCTION public.record_canonical_change(
  p_entity_type text,
  p_entity_id uuid,
  p_action text,
  p_payload jsonb,
  p_version integer
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_seq bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('chargerpointnew:change_log:commit_order', 0));

  IF p_entity_type IN ('goals', 'goal_requests', 'financial_ledger') THEN
    SELECT cl.sequence_id
      INTO v_seq
    FROM public.change_log cl
    WHERE cl.entity_type = p_entity_type
      AND cl.entity_id = p_entity_id
      AND cl.action = p_action
      AND cl.version IS NOT DISTINCT FROM COALESCE(p_version, 1)
      AND cl.xmin = pg_current_xact_id()::xid
    ORDER BY cl.sequence_id DESC
    LIMIT 1;

    IF v_seq IS NOT NULL THEN
      RETURN v_seq;
    END IF;
  END IF;

  INSERT INTO public.change_log(entity_type, entity_id, action, payload, version, changed_at)
  VALUES (p_entity_type, p_entity_id, p_action, COALESCE(p_payload, '{}'::jsonb), COALESCE(p_version, 1), NOW())
  RETURNING sequence_id INTO v_seq;

  RETURN v_seq;
END;
$function$;

COMMENT ON FUNCTION public.record_canonical_change(text, uuid, text, jsonb, integer)
IS 'Appends canonical sync changes; goal, goal-request, and financial-ledger manual calls reuse the row already captured by the same transaction trigger.';

-- A client-controlled UPDATE_GOAL_PROGRESS payload could previously insert a
-- BONUS ledger row before the same transaction proved that the goal was earned.
-- Check at transaction end so the legitimate evaluator can insert the ledger
-- row first and mark the goal COMPLETED second, while an ACTIVE goal cannot
-- retain an unearned bonus.
CREATE OR REPLACE FUNCTION public.enforce_goal_bonus_requires_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_goal public.goals%ROWTYPE;
BEGIN
  IF NEW.event_type <> 'BONUS' THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO v_goal
  FROM public.goals
  WHERE id = NEW.reference_id;

  IF NOT FOUND
     OR v_goal.status <> 'COMPLETED'
     OR v_goal.bonus_ledger_id IS DISTINCT FROM NEW.id
     OR v_goal.customer_id IS DISTINCT FROM NEW.customer_id
     OR v_goal.bonus_amount_minor IS DISTINCT FROM NEW.amount_minor THEN
    RAISE EXCEPTION 'Goal bonus ledger entry must match a completed goal'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_goal_bonus_requires_completion()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_goal_bonus_requires_completion ON public.financial_ledger;

CREATE CONSTRAINT TRIGGER trg_goal_bonus_requires_completion
AFTER INSERT ON public.financial_ledger
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.enforce_goal_bonus_requires_completion();

COMMENT ON FUNCTION public.enforce_goal_bonus_requires_completion()
IS 'Defers goal BONUS validation until commit and requires the matching goal to be COMPLETED.';

-- Keep the customer-facing portal's existing RPC response current as well.
-- A valid customer QR token resolves exactly one customer; only that customer's
-- expired ACTIVE goal is evaluated. No extra browser request or polling is added.
DO $migration$
DECLARE
  v_signature regprocedure;
  v_definition text;
  v_old text := E'IF v_customer_id IS NULL THEN\n    RETURN NULL;\n  END IF;';
  v_new text;
BEGIN
  v_new := v_old || E'\n\n  IF EXISTS (\n    SELECT 1\n    FROM public.goals g\n    WHERE g.customer_id = v_customer_id\n      AND g.status = ''ACTIVE''\n      AND g.expires_at <= statement_timestamp()\n  ) THEN\n    PERFORM set_config(''app.suppress_goal_completion_push'', ''1'', true);\n    PERFORM public.evaluate_customer_active_goal_internal(v_customer_id);\n    PERFORM set_config(''app.suppress_goal_completion_push'', ''0'', true);\n  END IF;';

  FOREACH v_signature IN ARRAY ARRAY[
    'public.public_resolve_customer_portal(text)'::regprocedure,
    'public.public_resolve_customer_portal(text,boolean)'::regprocedure
  ]
  LOOP
    v_definition := pg_get_functiondef(v_signature);

    IF strpos(v_definition, v_old) = 0 THEN
      RAISE EXCEPTION 'Customer portal resolver % no longer matches the expected safe insertion point', v_signature;
    END IF;

    v_definition := replace(v_definition, v_old, v_new);
    EXECUTE v_definition;
  END LOOP;
END;
$migration$;

-- Goal completion reached only through a read-time fallback is already visible
-- in the response, so do not invoke pg_net/HTTP for a push from that read.
-- Normal order-item-triggered completion remains unchanged and still notifies.
CREATE OR REPLACE FUNCTION public.trigger_native_push_for_goal_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF pg_catalog.current_setting('app.suppress_goal_completion_push', true) = '1' THEN
    RETURN NEW;
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status
     AND upper(COALESCE(NEW.status, '')) = 'COMPLETED'
     AND NEW.customer_id IS NOT NULL THEN
    PERFORM public.enqueue_native_push_event('goals', NEW.id, 'UPDATE', 'COMPLETED');
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.trigger_native_push_for_goal_completion()
IS 'Sends completion push for normal event-driven completions; suppresses external push dispatch during read-time expiry reconciliation.';

-- The client approval use case already sends the reviewed target, bonus and
-- duration. Do not silently fall back to requested_target/10, 500 agorot, or
-- 7 days when an old or incomplete outbox payload reaches the server.
DO $migration$
DECLARE
  v_signature regprocedure := 'public.execute_canonical_sync_command_unlocked(uuid,text,jsonb,text,text,uuid)'::regprocedure;
  v_definition text;
  v_old_target text := 'COALESCE((p_payload->>''targetQuantity'')::INTEGER, v_rec_goal_request.requested_target, 10)';
  v_old_bonus text := 'COALESCE((p_payload->>''bonusAmountMinor'')::BIGINT, 500)';
  v_old_duration text := 'COALESCE((p_payload->>''durationDays'')::INTEGER, 7)';
  v_anchor text := 'v_entity_uuid := COALESCE((p_payload->>''resultingGoalId'')::UUID, gen_random_uuid());';
  v_guard text := E'IF p_payload->>''targetQuantity'' IS NULL\n               OR p_payload->>''bonusAmountMinor'' IS NULL\n               OR p_payload->>''durationDays'' IS NULL\n               OR (p_payload->>''targetQuantity'')::INTEGER <= 0\n               OR (p_payload->>''bonusAmountMinor'')::BIGINT < 0\n               OR (p_payload->>''durationDays'')::INTEGER NOT BETWEEN 3 AND 15 THEN\n                RAISE EXCEPTION ''Goal approval requires valid reviewed target, bonus, and duration values'' USING ERRCODE = ''P2201'';\n            END IF;\n\n            ';
BEGIN
  v_definition := pg_get_functiondef(v_signature);

  IF (length(v_definition) - length(replace(v_definition, v_old_target, ''))) / length(v_old_target) <> 1
     OR (length(v_definition) - length(replace(v_definition, v_old_bonus, ''))) / length(v_old_bonus) <> 1
     OR (length(v_definition) - length(replace(v_definition, v_old_duration, ''))) / length(v_old_duration) <> 2
     OR (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'Canonical goal approval branch changed; refusing an unsafe fallback rewrite';
  END IF;

  v_definition := replace(v_definition, v_old_target, '(p_payload->>''targetQuantity'')::INTEGER');
  v_definition := replace(v_definition, v_old_bonus, '(p_payload->>''bonusAmountMinor'')::BIGINT');
  v_definition := replace(v_definition, v_old_duration, '(p_payload->>''durationDays'')::INTEGER');
  v_definition := replace(v_definition, v_anchor, v_guard || v_anchor);

  EXECUTE v_definition;
END;
$migration$;

-- Goal BONUS ledger entries are accounting facts. They may be reversed by a
-- separate compensating entry, but must never be edited or deleted in place.
CREATE OR REPLACE FUNCTION public.prevent_goal_bonus_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF OLD.event_type = 'BONUS' THEN
    RAISE EXCEPTION 'Goal BONUS ledger entries are immutable; post a reversal entry instead'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.prevent_goal_bonus_ledger_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_prevent_goal_bonus_ledger_mutation ON public.financial_ledger;

CREATE TRIGGER trg_prevent_goal_bonus_ledger_mutation
BEFORE UPDATE OR DELETE ON public.financial_ledger
FOR EACH ROW
EXECUTE FUNCTION public.prevent_goal_bonus_ledger_mutation();

COMMENT ON FUNCTION public.prevent_goal_bonus_ledger_mutation()
IS 'Prevents in-place mutation of goal BONUS ledger entries; corrections must use compensating ledger events.';
