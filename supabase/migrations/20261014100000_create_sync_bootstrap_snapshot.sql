-- Atomic, authenticated bootstrap snapshot for ordinary active application admins.
-- Keeps the initial read model and its change-log cursor in one PostgreSQL snapshot.
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
    RAISE EXCEPTION 'Authentication required: caller must be signed in';
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
      'captured_at', statement_timestamp(),
      'server_reset_generation',
        COALESCE((SELECT s.value_number FROM public.system_settings s WHERE s.key = 'server_reset_generation' LIMIT 1), 0),
      'max_change_sequence', COALESCE((SELECT max(t.sequence_id) FROM public.change_log t), 0),
      'business_days', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.business_days t), '[]'::jsonb),
      'customers', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.customers t), '[]'::jsonb),
      'device_types', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.device_types t), '[]'::jsonb),
      'orders', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.orders t), '[]'::jsonb),
      'order_items', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.order_items t), '[]'::jsonb),
      'financial_ledger', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.financial_ledger t), '[]'::jsonb),
      'payments', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.payments t), '[]'::jsonb),
      'payment_allocations', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.payment_allocations t), '[]'::jsonb),
      'order_number_reservations', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.order_number_reservations t), '[]'::jsonb),
      'qr_tokens', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.qr_tokens t), '[]'::jsonb),
      'goals', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.goals t), '[]'::jsonb),
      'goal_requests', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.goal_requests t), '[]'::jsonb)
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.capture_sync_bootstrap_snapshot() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.capture_sync_bootstrap_snapshot() TO authenticated;
