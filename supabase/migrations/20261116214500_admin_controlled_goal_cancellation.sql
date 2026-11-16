-- Customer-initiated cancellation requests; only an authorized admin can cancel.
-- Reuses the goals row and existing customer-account event stream (no new table,
-- cron, polling, Edge Function, or periodic database work).
ALTER TABLE public.goals
  ADD COLUMN IF NOT EXISTS cancellation_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_request_reason text,
  ADD COLUMN IF NOT EXISTS cancellation_request_status text,
  ADD COLUMN IF NOT EXISTS cancellation_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_reviewed_by uuid REFERENCES public.admins(id),
  ADD COLUMN IF NOT EXISTS cancellation_review_reason text;

ALTER TABLE public.goals DROP CONSTRAINT IF EXISTS goals_status_check;
ALTER TABLE public.goals
  ADD CONSTRAINT goals_status_check
  CHECK (status = ANY (ARRAY['ACTIVE','COMPLETED','FAILED','CANCELLED']::text[]));

ALTER TABLE public.goals DROP CONSTRAINT IF EXISTS goals_cancellation_request_status_check;
ALTER TABLE public.goals
  ADD CONSTRAINT goals_cancellation_request_status_check
  CHECK (cancellation_request_status IS NULL OR cancellation_request_status IN ('PENDING','APPROVED','REJECTED'));

ALTER TABLE public.goals DROP CONSTRAINT IF EXISTS goals_cancellation_request_reason_check;
ALTER TABLE public.goals
  ADD CONSTRAINT goals_cancellation_request_reason_check
  CHECK (cancellation_request_reason IS NULL OR length(btrim(cancellation_request_reason)) BETWEEN 1 AND 500);

CREATE OR REPLACE FUNCTION public.admin_cancel_goal(
  p_goal_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_role text;
  v_allowed boolean := false;
  v_goal public.goals%ROWTYPE;
BEGIN
  v_admin_id := public._cp_assert_active_admin_permission(NULL);
  SELECT a.role INTO v_role FROM public.admins a WHERE a.id = v_admin_id AND a.is_active IS TRUE;
  IF upper(replace(trim(coalesce(v_role,'')), ' ', '_')) = 'SUPER_ADMIN' THEN
    v_allowed := true;
  ELSE
    SELECT coalesce(bool_or(ep.permission = 'goals:manage'), false)
      INTO v_allowed
    FROM public.get_effective_permissions__session_guarded_impl(v_admin_id) ep;
  END IF;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Missing required permission: goals:manage' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_goal FROM public.goals WHERE id = p_goal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Goal not found' USING ERRCODE='P0002'; END IF;
  IF v_goal.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Only an active goal can be cancelled' USING ERRCODE='P0001';
  END IF;
  IF v_goal.expires_at <= now() THEN
    PERFORM public.evaluate_customer_active_goal_internal(v_goal.customer_id);
    SELECT * INTO v_goal FROM public.goals WHERE id = p_goal_id FOR UPDATE;
    IF v_goal.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'Goal has already expired and was reconciled' USING ERRCODE='P0001';
    END IF;
  END IF;

  UPDATE public.goals
  SET status = 'CANCELLED',
      cancellation_reviewed_at = now(),
      cancellation_reviewed_by = v_admin_id,
      cancellation_review_reason = nullif(left(btrim(coalesce(p_reason,'')),500),''),
      updated_at = now(),
      version = version + 1
  WHERE id = p_goal_id;

  INSERT INTO public.customer_account_events(customer_id,event_type,payload)
  VALUES (v_goal.customer_id,'GOAL_CANCELLED_BY_ADMIN',
          jsonb_build_object('goal_id',p_goal_id,'reason',nullif(left(btrim(coalesce(p_reason,'')),500),'')));
  RETURN jsonb_build_object('ok',true,'goal_id',p_goal_id,'status','CANCELLED');
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_review_goal_cancellation(
  p_goal_id uuid,
  p_approve boolean,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_role text;
  v_allowed boolean := false;
  v_goal public.goals%ROWTYPE;
BEGIN
  v_admin_id := public._cp_assert_active_admin_permission(NULL);
  SELECT a.role INTO v_role FROM public.admins a WHERE a.id = v_admin_id AND a.is_active IS TRUE;
  IF upper(replace(trim(coalesce(v_role,'')), ' ', '_')) = 'SUPER_ADMIN' THEN
    v_allowed := true;
  ELSE
    SELECT coalesce(bool_or(ep.permission IN ('goals:approve','goals:manage')), false)
      INTO v_allowed
    FROM public.get_effective_permissions__session_guarded_impl(v_admin_id) ep;
  END IF;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Missing required permission: goals:approve' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_goal FROM public.goals WHERE id = p_goal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Goal not found' USING ERRCODE='P0002'; END IF;
  IF v_goal.status <> 'ACTIVE' OR v_goal.cancellation_request_status <> 'PENDING' THEN
    RAISE EXCEPTION 'No pending cancellation request exists for this active goal' USING ERRCODE='P0001';
  END IF;
  IF p_approve THEN
    IF v_goal.expires_at <= now() THEN
      PERFORM public.evaluate_customer_active_goal_internal(v_goal.customer_id);
      SELECT * INTO v_goal FROM public.goals WHERE id = p_goal_id FOR UPDATE;
      IF v_goal.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Goal expired before cancellation review; it was reconciled' USING ERRCODE='P0001';
      END IF;
    END IF;
    UPDATE public.goals
    SET status = 'CANCELLED',
        cancellation_request_status = 'APPROVED',
        cancellation_reviewed_at = now(),
        cancellation_reviewed_by = v_admin_id,
        cancellation_review_reason = nullif(left(btrim(coalesce(p_reason,'')),500),''),
        updated_at = now(), version = version + 1
    WHERE id = p_goal_id;
  ELSE
    UPDATE public.goals
    SET cancellation_request_status = 'REJECTED',
        cancellation_reviewed_at = now(),
        cancellation_reviewed_by = v_admin_id,
        cancellation_review_reason = nullif(left(btrim(coalesce(p_reason,'')),500),''),
        updated_at = now(), version = version + 1
    WHERE id = p_goal_id;
  END IF;

  INSERT INTO public.customer_account_events(customer_id,event_type,payload)
  VALUES (v_goal.customer_id,
          CASE WHEN p_approve THEN 'GOAL_CANCELLATION_APPROVED' ELSE 'GOAL_CANCELLATION_REJECTED' END,
          jsonb_build_object('goal_id',p_goal_id,'reason',nullif(left(btrim(coalesce(p_reason,'')),500),'')));
  RETURN jsonb_build_object('ok',true,'goal_id',p_goal_id,
                            'status',CASE WHEN p_approve THEN 'CANCELLED' ELSE 'ACTIVE' END,
                            'request_status',CASE WHEN p_approve THEN 'APPROVED' ELSE 'REJECTED' END);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_cancel_goal(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_review_goal_cancellation(uuid,boolean,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_cancel_goal(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_review_goal_cancellation(uuid,boolean,text) TO authenticated;

COMMENT ON FUNCTION public.admin_cancel_goal(uuid,text)
IS 'Cancels an ACTIVE goal only for admins with goals:manage; customers cannot directly cancel.';
COMMENT ON FUNCTION public.admin_review_goal_cancellation(uuid,boolean,text)
IS 'Approves or rejects a customer cancellation request; only admins with goals:approve or goals:manage may decide.';

-- Extend the existing compact admin read model without adding another query or
-- downloading the full operational snapshot.
DO $migration$
DECLARE
  v_signature regprocedure := 'public.get_admin_goals_page_data()'::regprocedure;
  v_definition text;
  v_anchor text := '''bonus_ledger_id'', g.bonus_ledger_id,';
  v_replacement text := '''bonus_ledger_id'', g.bonus_ledger_id,
          ''cancellation_requested_at'', g.cancellation_requested_at,
          ''cancellation_request_reason'', g.cancellation_request_reason,
          ''cancellation_request_status'', g.cancellation_request_status,
          ''cancellation_reviewed_at'', g.cancellation_reviewed_at,
          ''cancellation_reviewed_by'', g.cancellation_reviewed_by,
          ''cancellation_review_reason'', g.cancellation_review_reason,';
BEGIN
  v_definition := pg_get_functiondef(v_signature);
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'Admin goals read model changed; refusing unsafe projection rewrite';
  END IF;
  EXECUTE replace(v_definition,v_anchor,v_replacement);
END;
$migration$;

-- Extend both existing public customer portal read models. Only the customer's
-- own active goal is returned by these token-bound SECURITY DEFINER functions.
DO $migration$
DECLARE
  v_signature regprocedure;
  v_definition text;
  v_anchor text := '''target_quantity'', g.target_quantity,';
  v_replacement text := '''id'', g.id,
        ''target_quantity'', g.target_quantity,';
  v_signatures regprocedure[] := ARRAY[
    'public.public_resolve_customer_portal(text)'::regprocedure,
    'public.public_resolve_customer_portal(text,boolean)'::regprocedure
  ];
  v_item regprocedure;
BEGIN
  FOREACH v_item IN ARRAY v_signatures LOOP
    v_definition := pg_get_functiondef(v_item);
    IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor) <> 1 THEN
      RAISE EXCEPTION 'Customer portal resolver % changed; refusing unsafe projection rewrite',v_item;
    END IF;
    v_definition := replace(v_definition,v_anchor,v_replacement);
    v_anchor := '''bonus_recorded'', (g.bonus_ledger_id IS NOT NULL AND EXISTS (';
    v_replacement := '''cancellation_request_status'', g.cancellation_request_status,
        ''cancellation_requested_at'', g.cancellation_requested_at,
        ''cancellation_request_reason'', g.cancellation_request_reason,
        ''bonus_recorded'', (g.bonus_ledger_id IS NOT NULL AND EXISTS (';
    IF position(v_anchor in v_definition) = 0 THEN
      RAISE EXCEPTION 'Customer portal goal projection changed; refusing unsafe cancellation field insertion';
    END IF;
    v_definition := replace(v_definition,v_anchor,v_replacement);
    EXECUTE v_definition;
    v_anchor := '''target_quantity'', g.target_quantity,';
    v_replacement := '''id'', g.id,
        ''target_quantity'', g.target_quantity,';
  END LOOP;
END;
$migration$;

-- The Edge Function authenticates the customer's portal session and resolves
-- customer_id from the server-side account link. This narrowly scoped RPC makes
-- the request atomic and increments the goal version for offline sync.
CREATE OR REPLACE FUNCTION public.customer_request_goal_cancellation(
  p_customer_id uuid,
  p_goal_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_goal public.goals%ROWTYPE;
  v_reason text := btrim(coalesce(p_reason,''));
BEGIN
  IF p_customer_id IS NULL OR p_goal_id IS NULL OR length(v_reason) < 3 OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'A valid cancellation reason is required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_goal
  FROM public.goals
  WHERE id = p_goal_id AND customer_id = p_customer_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Goal not found' USING ERRCODE='P0002'; END IF;
  IF v_goal.status <> 'ACTIVE' OR v_goal.expires_at <= now() THEN
    RAISE EXCEPTION 'Only a current active goal can receive a cancellation request' USING ERRCODE='P0001';
  END IF;
  IF v_goal.cancellation_request_status = 'PENDING' THEN
    RETURN jsonb_build_object('ok',true,'already_pending',true,'status','PENDING');
  END IF;
  IF v_goal.cancellation_request_status = 'APPROVED' THEN
    RAISE EXCEPTION 'The goal cancellation request has already been approved' USING ERRCODE='P0001';
  END IF;

  UPDATE public.goals
  SET cancellation_requested_at = now(),
      cancellation_request_reason = v_reason,
      cancellation_request_status = 'PENDING',
      cancellation_reviewed_at = NULL,
      cancellation_reviewed_by = NULL,
      cancellation_review_reason = NULL,
      updated_at = now(),
      version = version + 1
  WHERE id = p_goal_id;

  INSERT INTO public.customer_account_events(customer_id,event_type,payload)
  VALUES (p_customer_id,'GOAL_CANCELLATION_REQUESTED',jsonb_build_object('goal_id',p_goal_id));
  RETURN jsonb_build_object('ok',true,'already_pending',false,'status','PENDING');
END;
$function$;

REVOKE ALL ON FUNCTION public.customer_request_goal_cancellation(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_request_goal_cancellation(uuid,uuid,text) TO service_role;
COMMENT ON FUNCTION public.customer_request_goal_cancellation(uuid,uuid,text)
IS 'Service-role-only endpoint for an already authenticated customer portal session; records a request but never cancels a goal.';

-- Keep cancelled goals visible in the customer's own goal history.
DO $migration$
DECLARE
  v_item regprocedure;
  v_definition text;
  v_anchor text := 'g.status IN (''ACTIVE'', ''COMPLETED'') OR g.completed_at IS NOT NULL';
  v_replacement text := 'g.status IN (''ACTIVE'', ''COMPLETED'', ''CANCELLED'') OR g.completed_at IS NOT NULL';
  v_signatures regprocedure[] := ARRAY[
    'public.public_resolve_customer_portal(text)'::regprocedure,
    'public.public_resolve_customer_portal(text,boolean)'::regprocedure
  ];
BEGIN
  FOREACH v_item IN ARRAY v_signatures LOOP
    v_definition := pg_get_functiondef(v_item);
    IF position(v_anchor in v_definition) = 0 THEN
      RAISE EXCEPTION 'Customer portal goal history filter changed in %',v_item;
    END IF;
    v_definition := replace(v_definition,v_anchor,v_replacement);
    EXECUTE v_definition;
  END LOOP;
END;
$migration$;

-- If the goal completes or expires before the admin reviews the request, close
-- the pending request in the same UPDATE/change-log event instead of leaving an
-- orphaned request that can no longer be approved.
CREATE OR REPLACE FUNCTION public.close_goal_cancellation_request_when_goal_ends()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF OLD.status = 'ACTIVE'
     AND NEW.status IN ('COMPLETED','FAILED')
     AND OLD.cancellation_request_status = 'PENDING' THEN
    NEW.cancellation_request_status := 'REJECTED';
    NEW.cancellation_reviewed_at := now();
    NEW.cancellation_reviewed_by := NULL;
    NEW.cancellation_review_reason := 'Goal ended before the administrator reviewed the cancellation request.';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.close_goal_cancellation_request_when_goal_ends()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_goal_close_pending_cancellation ON public.goals;
CREATE TRIGGER trg_goal_close_pending_cancellation
BEFORE UPDATE OF status ON public.goals
FOR EACH ROW
WHEN (OLD.status = 'ACTIVE' AND NEW.status IN ('COMPLETED','FAILED'))
EXECUTE FUNCTION public.close_goal_cancellation_request_when_goal_ends();

-- A direct administrator cancellation also resolves an already-pending
-- customer request as approved, so no stale pending card remains.
CREATE OR REPLACE FUNCTION public.admin_cancel_goal(
  p_goal_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_role text;
  v_allowed boolean := false;
  v_goal public.goals%ROWTYPE;
BEGIN
  v_admin_id := public._cp_assert_active_admin_permission(NULL);
  SELECT a.role INTO v_role FROM public.admins a WHERE a.id = v_admin_id AND a.is_active IS TRUE;
  IF upper(replace(trim(coalesce(v_role,'')), ' ', '_')) = 'SUPER_ADMIN' THEN
    v_allowed := true;
  ELSE
    SELECT coalesce(bool_or(ep.permission = 'goals:manage'), false)
      INTO v_allowed
    FROM public.get_effective_permissions__session_guarded_impl(v_admin_id) ep;
  END IF;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Missing required permission: goals:manage' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_goal FROM public.goals WHERE id = p_goal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Goal not found' USING ERRCODE='P0002'; END IF;
  IF v_goal.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Only an active goal can be cancelled' USING ERRCODE='P0001';
  END IF;
  IF v_goal.expires_at <= now() THEN
    PERFORM public.evaluate_customer_active_goal_internal(v_goal.customer_id);
    SELECT * INTO v_goal FROM public.goals WHERE id = p_goal_id FOR UPDATE;
    IF v_goal.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'Goal has already expired and was reconciled' USING ERRCODE='P0001';
    END IF;
  END IF;

  UPDATE public.goals
  SET status = 'CANCELLED',
      cancellation_request_status = CASE
        WHEN cancellation_request_status = 'PENDING' THEN 'APPROVED'
        ELSE cancellation_request_status END,
      cancellation_reviewed_at = now(),
      cancellation_reviewed_by = v_admin_id,
      cancellation_review_reason = nullif(left(btrim(coalesce(p_reason,'')),500),''),
      updated_at = now(),
      version = version + 1
  WHERE id = p_goal_id;

  INSERT INTO public.customer_account_events(customer_id,event_type,payload)
  VALUES (v_goal.customer_id,'GOAL_CANCELLED_BY_ADMIN',
          jsonb_build_object('goal_id',p_goal_id,'reason',nullif(left(btrim(coalesce(p_reason,'')),500),'')));
  RETURN jsonb_build_object('ok',true,'goal_id',p_goal_id,'status','CANCELLED');
END;
$function$;
