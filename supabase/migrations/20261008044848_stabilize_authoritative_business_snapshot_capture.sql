-- Stabilize the authoritative cloud backup capture metadata clock.
-- now() is transaction-stable and preserves the single-statement snapshot contract.
-- One SQL statement gives every collection the same PostgreSQL statement snapshot,
-- avoiding inconsistent multi-REST-request cloud backups.
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
      'system_settings', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.key) FROM public.system_settings t), '[]'::jsonb),
      'change_log', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.sequence_id) FROM public.change_log t), '[]'::jsonb)
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.capture_authoritative_business_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.capture_authoritative_business_snapshot() FROM anon;
GRANT EXECUTE ON FUNCTION public.capture_authoritative_business_snapshot() TO authenticated;
