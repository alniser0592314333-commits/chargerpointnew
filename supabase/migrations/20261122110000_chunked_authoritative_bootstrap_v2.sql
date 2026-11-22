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
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  PERFORM public._cp_assert_active_admin_permission('sync:manage');

  -- Both checkpoint values are read by one SQL statement, so reset generation
  -- and change-log high-water mark describe the same PostgreSQL snapshot.
  RETURN (
    SELECT jsonb_build_object(
      'schema_version', 2,
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
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_admin_id uuid;
  v_table_name text;
  v_key_column text := 'id';
  v_key_type text := 'uuid';
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
         WHERE ($1 IS NULL OR %I > $1::uuid) %s
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
      v_table_name, v_key_column, v_scope_predicate,
      v_key_column, v_key_column, v_key_column, v_key_column, v_key_column
    );
  ELSE
    v_sql := format(
      'WITH page AS MATERIALIZED (
         SELECT * FROM public.%I
         WHERE ($1 IS NULL OR %I > $1) %s
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
      v_table_name, v_key_column, v_scope_predicate,
      v_key_column, v_key_column, v_key_column, v_key_column, v_key_column
    );
  END IF;

  EXECUTE v_sql INTO v_result USING p_after_id, v_admin_id, v_limit;
  RETURN COALESCE(v_result, jsonb_build_object('rows', '[]'::jsonb, 'next_cursor', NULL, 'has_more', false))
    || jsonb_build_object('entity_type', p_entity_type);
END;
$function$;

REVOKE ALL ON FUNCTION public.begin_sync_bootstrap() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.begin_sync_bootstrap() TO authenticated;

REVOKE ALL ON FUNCTION public.read_sync_bootstrap_page(text, text, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.read_sync_bootstrap_page(text, text, integer) TO authenticated;

COMMIT;
