-- Isolated PostgreSQL fixture for 20261116211000_goal_expiry_reconciliation.sql.
-- Runs only in the GitHub Actions postgres:17 service; never against production.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END;
$$;

CREATE TABLE public.admins (
  id uuid PRIMARY KEY,
  role text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE public.customers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE public.goals (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  target_quantity integer NOT NULL,
  current_progress integer NOT NULL DEFAULT 0,
  bonus_amount_minor bigint NOT NULL,
  duration_days integer NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  bonus_ledger_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX uq_goals_one_active_customer
  ON public.goals(customer_id) WHERE status = 'ACTIVE';

CREATE TABLE public.goal_requests (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  requested_target integer,
  status text NOT NULL,
  reviewed_by uuid,
  reviewed_at timestamptz,
  rejection_reason text,
  resulting_goal_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE public.financial_ledger (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  amount_minor bigint NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  actor_admin_id uuid,
  reference_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.change_log (
  sequence_id bigserial PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL,
  version integer NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_log_entity_idx
  ON public.change_log(entity_type, entity_id, sequence_id);

CREATE TABLE public.push_events (
  source text,
  record_id uuid,
  operation text,
  new_status text
);

CREATE OR REPLACE FUNCTION public.record_canonical_change(
  p_entity_type text, p_entity_id uuid, p_action text, p_payload jsonb, p_version integer
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_seq bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('chargerpointnew:change_log:commit_order', 0));
  INSERT INTO public.change_log(entity_type, entity_id, action, payload, version, changed_at)
  VALUES (p_entity_type, p_entity_id, p_action, COALESCE(p_payload, '{}'::jsonb), COALESCE(p_version, 1), now())
  RETURNING sequence_id INTO v_seq;
  RETURN v_seq;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_change_capture()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_payload jsonb;
  v_id uuid;
  v_version integer;
  v_action text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_payload := to_jsonb(OLD);
    v_id := OLD.id;
    v_version := nullif(v_payload->>'version', '')::integer;
    v_action := 'DELETE';
  ELSE
    v_payload := to_jsonb(NEW);
    v_id := NEW.id;
    v_version := nullif(v_payload->>'version', '')::integer;
    v_action := CASE WHEN TG_OP = 'INSERT' THEN 'INSERT' ELSE 'UPDATE' END;
  END IF;
  PERFORM public.record_canonical_change(TG_TABLE_NAME, v_id, v_action, v_payload, v_version);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_goal_change_capture
AFTER INSERT OR UPDATE OR DELETE ON public.goals
FOR EACH ROW EXECUTE FUNCTION public.trg_change_capture();
CREATE TRIGGER trg_request_change_capture
AFTER INSERT OR UPDATE OR DELETE ON public.goal_requests
FOR EACH ROW EXECUTE FUNCTION public.trg_change_capture();
CREATE TRIGGER trg_ledger_change_capture
AFTER INSERT OR UPDATE OR DELETE ON public.financial_ledger
FOR EACH ROW EXECUTE FUNCTION public.trg_change_capture();

CREATE OR REPLACE FUNCTION public._cp_assert_active_admin_permission(p_required_permission text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT current_setting('test.admin_id')::uuid;
$$;

CREATE OR REPLACE FUNCTION public.get_effective_permissions__session_guarded_impl(p_admin_id uuid)
RETURNS TABLE(permission text)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT 'goals:view'::text;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_native_push_event(
  p_source text, p_record_id uuid, p_operation text, p_new_status text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  INSERT INTO public.push_events(source, record_id, operation, new_status)
  VALUES (p_source, p_record_id, p_operation, p_new_status);
$$;

CREATE OR REPLACE FUNCTION public.trigger_native_push_for_goal_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status
     AND upper(COALESCE(NEW.status, '')) = 'COMPLETED'
     AND NEW.customer_id IS NOT NULL THEN
    PERFORM public.enqueue_native_push_event('goals', NEW.id, 'UPDATE', 'COMPLETED');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER native_push_goal_completion
AFTER UPDATE ON public.goals
FOR EACH ROW EXECUTE FUNCTION public.trigger_native_push_for_goal_completion();

CREATE OR REPLACE FUNCTION public.evaluate_customer_active_goal_internal(p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_goal public.goals%ROWTYPE;
  v_bonus_id uuid;
BEGIN
  SELECT * INTO v_goal
  FROM public.goals
  WHERE customer_id = p_customer_id
    AND status = 'ACTIVE'
    AND expires_at <= now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN '{}'::jsonb;
  END IF;

  IF v_goal.current_progress >= v_goal.target_quantity THEN
    v_bonus_id := gen_random_uuid();
    INSERT INTO public.financial_ledger(id, event_type, amount_minor, customer_id, reference_id, created_at)
    VALUES (v_bonus_id, 'BONUS', v_goal.bonus_amount_minor, v_goal.customer_id, v_goal.id, now());

    UPDATE public.goals
    SET status = 'COMPLETED',
        completed_at = now(),
        bonus_ledger_id = v_bonus_id,
        updated_at = now(),
        version = version + 1
    WHERE id = v_goal.id;
  ELSE
    UPDATE public.goals
    SET status = 'FAILED',
        updated_at = now(),
        version = version + 1
    WHERE id = v_goal.id;
  END IF;

  RETURN jsonb_build_object('goalId', v_goal.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_goals_page_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_admin_id uuid;
BEGIN
  v_admin_id := public._cp_assert_active_admin_permission(NULL);
  RETURN '{}'::jsonb;
END;
$$;


CREATE OR REPLACE FUNCTION public.execute_canonical_sync_command_unlocked(
  p_command_id uuid,
  p_command_type text,
  p_payload jsonb,
  p_payload_hash text,
  p_device_id text,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $
DECLARE
  v_rec_goal_request public.goal_requests%ROWTYPE;
  v_entity_uuid uuid;
BEGIN
  IF p_command_type = 'APPROVE_GOAL_REQUEST' THEN
    SELECT * INTO v_rec_goal_request
    FROM public.goal_requests
    WHERE id = (p_payload->>'requestId')::uuid
    FOR UPDATE;

    v_entity_uuid := COALESCE((p_payload->>'resultingGoalId')::UUID, gen_random_uuid());

    INSERT INTO public.goals(
      id, customer_id, target_quantity, current_progress, bonus_amount_minor,
      duration_days, status, started_at, expires_at, created_at, updated_at, version
    )
    VALUES (
      v_entity_uuid,
      v_rec_goal_request.customer_id,
      COALESCE((p_payload->>'targetQuantity')::INTEGER, v_rec_goal_request.requested_target, 10),
      0,
      COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, 500),
      COALESCE((p_payload->>'durationDays')::INTEGER, 7),
      'ACTIVE',
      now(),
      COALESCE((p_payload->>'expiresAt')::TIMESTAMPTZ, now() + make_interval(days => COALESCE((p_payload->>'durationDays')::INTEGER, 7))),
      now(),
      now(),
      1
    );

    RETURN jsonb_build_object('goalId', v_entity_uuid);
  END IF;

  RETURN '{}'::jsonb;
END;
$;

CREATE OR REPLACE FUNCTION public.public_resolve_customer_portal(p_public_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_customer_id uuid;
BEGIN
  v_customer_id := p_public_token::uuid;
  IF v_customer_id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object('customer_id', v_customer_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.public_resolve_customer_portal(p_public_token text, p_include_history boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_customer_id uuid;
BEGIN
  v_customer_id := p_public_token::uuid;
  IF v_customer_id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object('customer_id', v_customer_id, 'include_history', p_include_history);
END;
$$;
