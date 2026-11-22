-- Chunked, resumable authoritative bootstrap protocol.
-- The old all-in-one RPC remains available for older application builds.
-- A manifest pins reset generation + change-log high-water mark; table pages
-- are bounded and tenant-scoped. The client reconciles all writes after the
-- manifest sequence through the existing canonical delta pipeline.

BEGIN;

CREATE OR REPLACE FUNCTION public.begin_sync_bootstrap()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_admin_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  v_admin_id := public._cp_assert_active_admin_permission('sync:manage');
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Active admin profile required' USING ERRCODE = '42501';
  END IF;

  -- Both checkpoint values are read by one SQL statement, so reset generation
  -- and change-log high-water mark describe the same PostgreSQL snapshot.
  RETURN (
    SELECT jsonb_build_object(
      'schema_version', 2,
      'admin_id', v_admin_id,
      'captured_at', now(),
      'server_reset_generation',
        COALESCE((SELECT s.value_number FROM public.system_settings s WHERE s.key = 'server_reset_generation' LIMIT 1), 0),
      'max_change_sequence',
        COALESCE((SELECT max(c.sequence_id) FROM public.change_log c), 0),
      'page_size', 500,
      'collections', jsonb_build_array(
        'business_days', 'customers', 'device_types', 'orders', 'order_items',
        'financial_ledger', 'payments', 'payment_allocations', 'order_number_reservations',
        'qr_tokens', 'goals', 'goal_requests', 'system_settings',
        'purchase_suppliers', 'purchase_items', 'purchase_payment_methods',
        'purchase_months', 'purchase_weeks', 'purchase_days', 'purchase_orders'
      )
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.read_sync_bootstrap_page(
  p_entity_type text,
  p_after_id text DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_admin_id uuid;
  v_table_name text;
  v_key_column text := 'id';
  v_key_type text := 'uuid';
  v_cursor_predicate text;
  v_purchase_scoped boolean := false;
  v_scope_predicate text;
  v_sql text;
  v_result jsonb;
  v_limit integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  v_admin_id := public._cp_assert_active_admin_permission('sync:manage');
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Active admin profile required' USING ERRCODE = '42501';
  END IF;

  IF p_entity_type IS NULL OR p_entity_type = '' THEN
    RAISE EXCEPTION 'Bootstrap entity type is required' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'Bootstrap page limit must be between 1 and 500' USING ERRCODE = '22023';
  END IF;
  IF p_after_id = '' THEN
    RAISE EXCEPTION 'Bootstrap cursor cannot be an empty string' USING ERRCODE = '22023';
  END IF;

  v_limit := p_limit;
  CASE p_entity_type
    WHEN 'business_days' THEN v_table_name := 'business_days';
    WHEN 'customers' THEN v_table_name := 'customers';
    WHEN 'device_types' THEN v_table_name := 'device_types';
    WHEN 'orders' THEN v_table_name := 'orders';
    WHEN 'order_items' THEN v_table_name := 'order_items';
    WHEN 'financial_ledger' THEN v_table_name := 'financial_ledger';
    WHEN 'payments' THEN v_table_name := 'payments';
    WHEN 'payment_allocations' THEN v_table_name := 'payment_allocations';
    WHEN 'order_number_reservations' THEN v_table_name := 'order_number_reservations';
    WHEN 'qr_tokens' THEN v_table_name := 'qr_tokens';
    WHEN 'goals' THEN v_table_name := 'goals';
    WHEN 'goal_requests' THEN v_table_name := 'goal_requests';
    WHEN 'system_settings' THEN
      v_table_name := 'system_settings';
      v_key_column := 'key';
      v_key_type := 'text';
    WHEN 'purchase_suppliers' THEN v_table_name := 'purchase_suppliers'; v_purchase_scoped := true;
    WHEN 'purchase_items' THEN v_table_name := 'purchase_items'; v_purchase_scoped := true;
    WHEN 'purchase_payment_methods' THEN v_table_name := 'purchase_payment_methods'; v_purchase_scoped := true;
    WHEN 'purchase_months' THEN v_table_name := 'purchase_months'; v_purchase_scoped := true;
    WHEN 'purchase_weeks' THEN v_table_name := 'purchase_weeks'; v_purchase_scoped := true;
    WHEN 'purchase_days' THEN v_table_name := 'purchase_days'; v_purchase_scoped := true;
    WHEN 'purchase_orders' THEN v_table_name := 'purchase_orders'; v_purchase_scoped := true;
    ELSE
      RAISE EXCEPTION 'Unsupported bootstrap entity type: %', p_entity_type USING ERRCODE = '22023';
  END CASE;

  IF p_after_id IS NULL THEN
    v_cursor_predicate := 'TRUE';
  ELSIF v_key_type = 'uuid' THEN
    v_cursor_predicate := format('%I > $1::uuid', v_key_column);
  ELSE
    v_cursor_predicate := format('%I > $1', v_key_column);
  END IF;

  IF v_purchase_scoped THEN
    v_scope_predicate := 'AND admin_id = $2';
  ELSE
    -- Keep a fixed parameter signature for every allow-listed table while
    -- requiring the authenticated admin identity established above.
    v_scope_predicate := 'AND $2::uuid IS NOT NULL';
  END IF;

  IF v_key_type = 'uuid' THEN
    v_sql := format(
      'WITH page AS MATERIALIZED (
         SELECT * FROM public.%I
         WHERE %s %s
         ORDER BY %I ASC
         LIMIT ($3 + 1)
       ),
       bounded AS MATERIALIZED (
         SELECT * FROM page ORDER BY %I ASC LIMIT $3
       )
       SELECT jsonb_build_object(
         ''rows'', COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.%I) FROM bounded b), ''[]''::jsonb),
         ''next_cursor'', (SELECT b.%I::text FROM bounded b ORDER BY b.%I DESC LIMIT 1),
         ''has_more'', (SELECT count(*) > $3 FROM page)
       )',
      v_table_name, v_cursor_predicate, v_scope_predicate,
      v_key_column, v_key_column, v_key_column, v_key_column, v_key_column
    );
  ELSE
    v_sql := format(
      'WITH page AS MATERIALIZED (
         SELECT * FROM public.%I
         WHERE %s %s
         ORDER BY %I ASC
         LIMIT ($3 + 1)
       ),
       bounded AS MATERIALIZED (
         SELECT * FROM page ORDER BY %I ASC LIMIT $3
       )
       SELECT jsonb_build_object(
         ''rows'', COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.%I) FROM bounded b), ''[]''::jsonb),
         ''next_cursor'', (SELECT b.%I::text FROM bounded b ORDER BY b.%I DESC LIMIT 1),
         ''has_more'', (SELECT count(*) > $3 FROM page)
       )',
      v_table_name, v_cursor_predicate, v_scope_predicate,
      v_key_column, v_key_column, v_key_column, v_key_column, v_key_column
    );
  END IF;

  EXECUTE v_sql INTO v_result USING p_after_id, v_admin_id, v_limit;
  RETURN COALESCE(v_result, jsonb_build_object('rows', '[]'::jsonb, 'next_cursor', NULL, 'has_more', false))
    || jsonb_build_object('entity_type', p_entity_type);
END;
$function$;

-- Tenant-first composite indexes keep purchase-book keyset pages bounded.
CREATE INDEX IF NOT EXISTS purchase_suppliers_admin_id_id_bootstrap_idx ON public.purchase_suppliers (admin_id, id);
CREATE INDEX IF NOT EXISTS purchase_items_admin_id_id_bootstrap_idx ON public.purchase_items (admin_id, id);
CREATE INDEX IF NOT EXISTS purchase_payment_methods_admin_id_id_bootstrap_idx ON public.purchase_payment_methods (admin_id, id);
CREATE INDEX IF NOT EXISTS purchase_months_admin_id_id_bootstrap_idx ON public.purchase_months (admin_id, id);
CREATE INDEX IF NOT EXISTS purchase_weeks_admin_id_id_bootstrap_idx ON public.purchase_weeks (admin_id, id);
CREATE INDEX IF NOT EXISTS purchase_days_admin_id_id_bootstrap_idx ON public.purchase_days (admin_id, id);
CREATE INDEX IF NOT EXISTS purchase_orders_admin_id_id_bootstrap_idx ON public.purchase_orders (admin_id, id);

-- system_settings is part of the bootstrap read model but historically had
-- only a write-order trigger. Capture every direct writer, not only the
-- canonical SET_SYSTEM_SETTING command, so page/delta reconciliation is complete.

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

  IF p_entity_type = 'system_settings' AND COALESCE(p_payload->>'key', '') <> '' THEN
    SELECT cl.sequence_id INTO v_seq
    FROM public.change_log cl
    WHERE cl.entity_type = 'system_settings'
      AND cl.action = p_action
      AND cl.payload->>'key' = p_payload->>'key'
      AND cl.xmin = pg_current_xact_id()::xid
    ORDER BY cl.sequence_id DESC
    LIMIT 1;
    IF v_seq IS NOT NULL THEN RETURN v_seq; END IF;
  END IF;

  IF p_entity_type IN ('goals', 'goal_requests', 'financial_ledger') THEN
    SELECT cl.sequence_id INTO v_seq
    FROM public.change_log cl
    WHERE cl.entity_type = p_entity_type
      AND cl.entity_id = p_entity_id
      AND cl.action = p_action
      AND cl.version IS NOT DISTINCT FROM COALESCE(p_version, 1)
      AND cl.xmin = pg_current_xact_id()::xid
    ORDER BY cl.sequence_id DESC
    LIMIT 1;
    IF v_seq IS NOT NULL THEN RETURN v_seq; END IF;
  END IF;

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

  IF p_entity_type = 'system_settings' AND COALESCE(p_payload->>'key', '') <> '' THEN
    SELECT cl.sequence_id INTO v_seq
    FROM public.change_log cl
    WHERE cl.entity_type = 'system_settings'
      AND cl.action = p_action
      AND cl.payload->>'key' = p_payload->>'key'
      AND cl.xmin = pg_current_xact_id()::xid
    ORDER BY cl.sequence_id DESC
    LIMIT 1;
    IF v_seq IS NOT NULL THEN RETURN v_seq; END IF;
  END IF;

  INSERT INTO public.change_log(entity_type, entity_id, action, payload, version, changed_at)
  VALUES (p_entity_type, p_entity_id, p_action, COALESCE(p_payload, '{}'::jsonb), COALESCE(p_version, 1), NOW())
  RETURNING sequence_id INTO v_seq;
  RETURN v_seq;
END;
$function$;

CREATE OR REPLACE FUNCTION public.capture_system_settings_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_key text;
  v_action text;
  v_payload jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_key := OLD.key;
    v_action := 'DELETE';
    v_payload := to_jsonb(OLD);
  ELSIF TG_OP = 'INSERT' THEN
    v_key := NEW.key;
    v_action := 'INSERT';
    v_payload := to_jsonb(NEW);
  ELSE
    v_key := NEW.key;
    v_action := 'UPDATE';
    v_payload := to_jsonb(NEW);
  END IF;

  IF v_key IS NULL OR v_key = '' THEN
    RAISE EXCEPTION 'system_settings change requires a non-empty key';
  END IF;

  PERFORM public.record_canonical_change(
    'system_settings'::text,
    md5(v_key)::uuid,
    v_action,
    v_payload,
    1
  );

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_system_settings_change_capture ON public.system_settings;
CREATE TRIGGER trg_system_settings_change_capture
AFTER INSERT OR UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.capture_system_settings_change();

REVOKE ALL ON FUNCTION public.begin_sync_bootstrap() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.begin_sync_bootstrap() TO authenticated;

REVOKE ALL ON FUNCTION public.read_sync_bootstrap_page(text, text, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.read_sync_bootstrap_page(text, text, integer) TO authenticated;

COMMIT;
