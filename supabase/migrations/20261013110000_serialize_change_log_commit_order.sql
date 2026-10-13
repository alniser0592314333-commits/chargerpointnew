-- Keep change_log sequence allocation in transaction-commit order.
--
-- PostgreSQL sequences are allocated before a transaction commits. A client that
-- advances its cursor past a later committed sequence can otherwise miss an
-- earlier sequence that becomes visible only after that cursor has advanced.
-- A transaction-scoped advisory lock is acquired BEFORE row changes on every
-- table already captured by trg_change_capture. This serializes canonical write
-- transactions only for the duration of their transaction, ensuring a later
-- change-log sequence cannot become visible before an earlier one.
--
-- This migration is intentionally additive and must be deployed/tested before
-- enabling client polling in production. It is not applied automatically here.

CREATE OR REPLACE FUNCTION public.lock_canonical_change_log_writes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('chargerpointnew:change_log:commit_order', 0));
  RETURN NULL;
END;
$function$;

-- Install BEFORE STATEMENT locks so concurrent writes wait before acquiring
-- row locks. That ordering avoids the common row-lock-then-global-lock deadlock.
DO $migration$
DECLARE
  v_table_name text;
BEGIN
  FOR v_table_name IN
    SELECT DISTINCT c.relname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND t.tgname = 'trg_change_capture'
      AND NOT t.tgisinternal
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_change_log_write_lock ON public.%I', v_table_name);
    EXECUTE format(
      'CREATE TRIGGER trg_change_log_write_lock
       BEFORE INSERT OR UPDATE OR DELETE ON public.%I
       FOR EACH STATEMENT EXECUTE FUNCTION public.lock_canonical_change_log_writes()',
      v_table_name
    );
  END LOOP;

  -- Some canonical commands record a system_settings change explicitly rather
  -- than through trg_change_capture, so protect that table as well.
  IF to_regclass('public.system_settings') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_change_log_write_lock ON public.system_settings;
    CREATE TRIGGER trg_change_log_write_lock
      BEFORE INSERT OR UPDATE OR DELETE ON public.system_settings
      FOR EACH STATEMENT EXECUTE FUNCTION public.lock_canonical_change_log_writes();
  END IF;
END;
$migration$;

-- Acquire the same transaction lock at RPC entry, before the canonical
-- dispatcher takes any SELECT ... FOR UPDATE row locks. Statement triggers still
-- protect direct DML, but trigger-only locking can invert lock order when a
-- dispatcher locks rows before its first UPDATE/INSERT/DELETE.
ALTER FUNCTION public.execute_canonical_sync_command(uuid, text, jsonb, text, text, uuid)
  RENAME TO execute_canonical_sync_command_unlocked;

CREATE FUNCTION public.execute_canonical_sync_command(
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
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('chargerpointnew:change_log:commit_order', 0));
  RETURN public.execute_canonical_sync_command_unlocked(
    p_command_id, p_command_type, p_payload, p_payload_hash, p_device_id, p_actor_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.execute_canonical_sync_command_unlocked(uuid, text, jsonb, text, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.execute_canonical_sync_command(uuid, text, jsonb, text, text, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.execute_canonical_sync_command(uuid, text, jsonb, text, text, uuid)
  TO authenticated, service_role;

-- The legacy service-role-only dispatcher has the same pre-row-lock requirement.
ALTER FUNCTION public.execute_sync_command_impl(uuid, text, text, uuid, jsonb, integer)
  RENAME TO execute_sync_command_impl_unlocked;

CREATE FUNCTION public.execute_sync_command_impl(
  p_command_id uuid,
  p_command_type text,
  p_aggregate_type text DEFAULT NULL::text,
  p_aggregate_id uuid DEFAULT NULL::uuid,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_expected_version integer DEFAULT NULL::integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('chargerpointnew:change_log:commit_order', 0));
  RETURN public.execute_sync_command_impl_unlocked(
    p_command_id, p_command_type, p_aggregate_type, p_aggregate_id, p_payload, p_expected_version
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.execute_sync_command_impl_unlocked(uuid, text, text, uuid, jsonb, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.execute_sync_command_impl(uuid, text, text, uuid, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.execute_sync_command_impl(uuid, text, text, uuid, jsonb, integer)
  TO service_role;

-- Return a delta page and reset generation in one authenticated RPC and one
-- PostgreSQL statement snapshot, avoiding a second REST request on every poll.
CREATE OR REPLACE FUNCTION public.pull_canonical_changes(
  p_since_sequence bigint,
  p_limit integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  WITH page AS MATERIALIZED (
    SELECT sequence_id, entity_type, entity_id, action, payload, version, changed_at
    FROM public.change_log
    WHERE sequence_id > p_since_sequence
    ORDER BY sequence_id ASC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 500)
  )
  SELECT jsonb_build_object(
    'changes', COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.sequence_id) FROM page), '[]'::jsonb),
    'latestSequence', COALESCE((SELECT MAX(sequence_id) FROM page), p_since_sequence),
    'serverResetGeneration', (
      SELECT value_number FROM public.system_settings WHERE key = 'server_reset_generation' LIMIT 1
    )
  );
$function$;

REVOKE ALL ON FUNCTION public.pull_canonical_changes(bigint, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pull_canonical_changes(bigint, integer) TO authenticated, service_role;

-- Keep the same lock for direct canonical change-recording calls too. In normal
-- table-trigger paths the statement trigger has already acquired it, so this is
-- re-entrant within the same transaction.
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
SET search_path = ''
AS $function$
DECLARE
  v_seq bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('chargerpointnew:change_log:commit_order', 0));
  INSERT INTO public.change_log(entity_type, entity_id, action, payload, version, changed_at)
  VALUES (p_entity_type, p_entity_id, p_action, COALESCE(p_payload, '{}'::jsonb), COALESCE(p_version, 1), NOW())
  RETURNING sequence_id INTO v_seq;
  RETURN v_seq;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_canonical_change(
  p_entity_type character varying,
  p_entity_id uuid,
  p_action character varying,
  p_payload jsonb,
  p_version integer DEFAULT 1
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_seq bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('chargerpointnew:change_log:commit_order', 0));
  INSERT INTO public.change_log(entity_type, entity_id, action, payload, version, changed_at)
  VALUES (p_entity_type, p_entity_id, p_action, COALESCE(p_payload, '{}'::jsonb), COALESCE(p_version, 1), NOW())
  RETURNING sequence_id INTO v_seq;
  RETURN v_seq;
END;
$function$;

-- Change-log insertion is an internal trigger/dispatcher operation, not a
-- public RPC. Trigger and dispatcher SECURITY DEFINER owners can still call it.
REVOKE ALL ON FUNCTION public.record_canonical_change(text, uuid, text, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_canonical_change(character varying, uuid, character varying, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_canonical_change(text, uuid, text, jsonb, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_canonical_change(character varying, uuid, character varying, jsonb, integer)
  TO service_role;


-- Capture the first-device business snapshot and its change-log fence in one
-- PostgreSQL statement snapshot. The client must checkpoint the returned
-- generation + max sequence only after all returned rows have been installed.
-- This avoids hydrating from independent REST snapshots and then accidentally
-- clearing that snapshot during the first generation reconciliation.
CREATE OR REPLACE FUNCTION public.capture_sync_bootstrap_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_admin_id uuid;
  v_is_active boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT a.id, a.is_active
    INTO v_admin_id, v_is_active
  FROM public.admins a
  WHERE a.auth_user_id = auth.uid()
  LIMIT 1;

  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: active admin profile not found';
  END IF;
  IF v_is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Forbidden: admin account is inactive or disabled';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'schema_version', 1,
      'captured_at', now(),
      'server_reset_generation',
        COALESCE((SELECT s.value_number FROM public.system_settings s WHERE s.key = 'server_reset_generation' LIMIT 1), 0),
      'max_change_sequence',
        COALESCE((SELECT MAX(c.sequence_id) FROM public.change_log c), 0),
      'customers',
        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.customers t), '[]'::jsonb),
      'business_days',
        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.business_days t), '[]'::jsonb),
      'device_types',
        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.device_types t), '[]'::jsonb),
      'orders',
        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.orders t), '[]'::jsonb),
      'order_items',
        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.order_items t), '[]'::jsonb),
      'financial_ledger',
        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.financial_ledger t), '[]'::jsonb),
      'payments',
        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.payments t), '[]'::jsonb),
      'payment_allocations',
        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.payment_allocations t), '[]'::jsonb),
      'order_number_reservations',
        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.order_number_reservations t), '[]'::jsonb),
      'qr_tokens',
        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.qr_tokens t), '[]'::jsonb),
      'goals',
        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.goals t), '[]'::jsonb),
      'goal_requests',
        COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.goal_requests t), '[]'::jsonb)
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.capture_sync_bootstrap_snapshot() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.capture_sync_bootstrap_snapshot() TO authenticated;

-- Refresh PostgREST's function cache after renaming internal RPC implementations.
NOTIFY pgrst, 'reload schema';
