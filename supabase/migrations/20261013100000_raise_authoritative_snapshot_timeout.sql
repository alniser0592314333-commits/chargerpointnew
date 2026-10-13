-- Fetch the authoritative business snapshot without embedding the entire change_log
-- in one PostgREST response. The business tables and change-log fence are captured
-- in one SQL statement; immutable change_log rows are then paged up to that fence.
-- The client validates the count/reset generation again after paging and aborts if
-- the checkpoint changed, so restore never proceeds with a partial history.
CREATE OR REPLACE FUNCTION public.capture_authoritative_business_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = 'public', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_is_active boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required: caller must be signed in'; END IF;
  SELECT a.id, a.role, a.is_active INTO v_admin_id, v_admin_role, v_is_active
  FROM public.admins a WHERE a.auth_user_id = auth.uid() LIMIT 1;
  IF v_admin_id IS NULL THEN RAISE EXCEPTION 'Unauthorized: active admin profile not found'; END IF;
  IF v_is_active IS NOT TRUE THEN RAISE EXCEPTION 'Forbidden: admin account is inactive or disabled'; END IF;
  IF v_admin_role NOT IN ('SUPER_ADMIN', 'Super Admin')
     AND NOT EXISTS (
       SELECT 1 FROM public.get_effective_permissions(v_admin_id)
       WHERE permission IN ('settings:manage', 'admin:manage', 'SUPER_ADMIN')
     )
  THEN RAISE EXCEPTION 'Forbidden: settings:manage permission required for authoritative backup'; END IF;

  RETURN (
    SELECT jsonb_build_object(
      'schema_version', 1,
      'captured_at', now(),
      'server_reset_generation',
        COALESCE((SELECT s.value_number FROM public.system_settings s WHERE s.key = 'server_reset_generation' LIMIT 1), 0),
      'change_log_count', (SELECT count(*) FROM public.change_log),
      'max_change_sequence', COALESCE((SELECT max(t.sequence_id) FROM public.change_log t), 0),
      'change_log_fingerprint', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.sequence_id), '')) FROM public.change_log t),
      'customers', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.customers t), '[]'::jsonb),
      'business_days', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.business_days t), '[]'::jsonb),
      'orders', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.orders t), '[]'::jsonb),
      'order_items', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.order_items t), '[]'::jsonb),
      'financial_ledger', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.financial_ledger t), '[]'::jsonb),
      'payments', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.payments t), '[]'::jsonb),
      'payment_allocations', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.payment_allocations t), '[]'::jsonb),
      'device_types', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.device_types t), '[]'::jsonb),
      'qr_tokens', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.qr_tokens t), '[]'::jsonb),
      'order_number_reservations', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.order_number_reservations t), '[]'::jsonb),
      'goals', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.goals t), '[]'::jsonb),
      'goal_requests', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.goal_requests t), '[]'::jsonb),
      'system_settings', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.key) FROM public.system_settings t), '[]'::jsonb)
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.capture_authoritative_change_log_page(
  p_after_sequence_id bigint,
  p_through_sequence_id bigint,
  p_limit integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = 'public', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_is_active boolean;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 500), 1000));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required: caller must be signed in'; END IF;
  SELECT a.id, a.role, a.is_active INTO v_admin_id, v_admin_role, v_is_active
  FROM public.admins a WHERE a.auth_user_id = auth.uid() LIMIT 1;
  IF v_admin_id IS NULL THEN RAISE EXCEPTION 'Unauthorized: active admin profile not found'; END IF;
  IF v_is_active IS NOT TRUE THEN RAISE EXCEPTION 'Forbidden: admin account is inactive or disabled'; END IF;
  IF v_admin_role NOT IN ('SUPER_ADMIN', 'Super Admin')
     AND NOT EXISTS (
       SELECT 1 FROM public.get_effective_permissions(v_admin_id)
       WHERE permission IN ('settings:manage', 'admin:manage', 'SUPER_ADMIN')
     )
  THEN RAISE EXCEPTION 'Forbidden: settings:manage permission required for authoritative backup'; END IF;
  IF p_after_sequence_id < 0 OR p_through_sequence_id < 0 OR p_after_sequence_id > p_through_sequence_id THEN
    RAISE EXCEPTION 'Invalid authoritative change-log page bounds';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'rows', COALESCE((SELECT jsonb_agg(to_jsonb(page_row) ORDER BY page_row.sequence_id)
        FROM (
          SELECT t.* FROM public.change_log t
          WHERE t.sequence_id > p_after_sequence_id
            AND t.sequence_id <= p_through_sequence_id
          ORDER BY t.sequence_id
          LIMIT v_limit
        ) page_row), '[]'::jsonb),
      'next_after_sequence_id', COALESCE((
        SELECT max(page_row.sequence_id) FROM (
          SELECT t.sequence_id FROM public.change_log t
          WHERE t.sequence_id > p_after_sequence_id
            AND t.sequence_id <= p_through_sequence_id
          ORDER BY t.sequence_id
          LIMIT v_limit
        ) page_row
      ), p_after_sequence_id),
      'current_count_through_sequence', (SELECT count(*) FROM public.change_log WHERE sequence_id <= p_through_sequence_id),
      'server_reset_generation', COALESCE((SELECT s.value_number FROM public.system_settings s WHERE s.key = 'server_reset_generation' LIMIT 1), 0),
      'change_log_fingerprint', CASE WHEN p_after_sequence_id = p_through_sequence_id THEN (
        SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.sequence_id), ''))
        FROM public.change_log t WHERE t.sequence_id <= p_through_sequence_id
      ) ELSE NULL END
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.capture_authoritative_business_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.capture_authoritative_business_snapshot() FROM anon;
GRANT EXECUTE ON FUNCTION public.capture_authoritative_business_snapshot() TO authenticated;
REVOKE ALL ON FUNCTION public.capture_authoritative_change_log_page(bigint, bigint, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.capture_authoritative_change_log_page(bigint, bigint, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.capture_authoritative_change_log_page(bigint, bigint, integer) TO authenticated;
