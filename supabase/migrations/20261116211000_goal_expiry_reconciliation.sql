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
    FOR v_customer_id IN
      SELECT g.customer_id
      FROM public.goals g
      WHERE g.status = 'ACTIVE'
        AND g.expires_at <= now()
      ORDER BY g.expires_at, g.customer_id
    LOOP
      PERFORM public.evaluate_customer_active_goal_internal(v_customer_id);
    END LOOP;
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

-- Goal and goal-request writes are already captured by trg_change_capture.
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

  IF p_entity_type IN ('goals', 'goal_requests') THEN
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
IS 'Appends canonical sync changes; goal and goal-request manual calls reuse the row already captured by the same transaction trigger.';
