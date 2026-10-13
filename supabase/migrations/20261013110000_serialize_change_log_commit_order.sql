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
SET search_path = public
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
SET search_path = public
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
SET search_path = public
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
