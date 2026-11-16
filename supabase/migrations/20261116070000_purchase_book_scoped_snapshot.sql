-- A bounded, account-scoped repair snapshot for Purchase Book.
-- The global change-log cursor is shared across accounts, while purchase deltas
-- are filtered by admin. This RPC lets a device repair older/missed purchase
-- rows without resetting the global cursor or downloading unrelated business data.
BEGIN;

CREATE OR REPLACE FUNCTION public.capture_purchase_book_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin_id uuid;
BEGIN
  PERFORM public._cp_assert_active_admin_permission('purchases:manage');
  v_admin_id := public.current_purchase_admin_id();

  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Active admin profile required for Purchase Book'
      USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'admin_id', v_admin_id,
    'purchase_suppliers', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.name, t.id) FROM public.purchase_suppliers t WHERE t.admin_id=v_admin_id), '[]'::jsonb),
    'purchase_items', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.name, t.id) FROM public.purchase_items t WHERE t.admin_id=v_admin_id), '[]'::jsonb),
    'purchase_payment_methods', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.name, t.id) FROM public.purchase_payment_methods t WHERE t.admin_id=v_admin_id), '[]'::jsonb),
    'purchase_months', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.year DESC, t.month_number DESC, t.id) FROM public.purchase_months t WHERE t.admin_id=v_admin_id), '[]'::jsonb),
    'purchase_weeks', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.start_date DESC, t.id) FROM public.purchase_weeks t WHERE t.admin_id=v_admin_id), '[]'::jsonb),
    'purchase_days', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.purchase_date DESC, t.id) FROM public.purchase_days t WHERE t.admin_id=v_admin_id), '[]'::jsonb),
    'purchase_orders', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.purchased_at DESC, t.id) FROM public.purchase_orders t WHERE t.admin_id=v_admin_id), '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.capture_purchase_book_snapshot() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.capture_purchase_book_snapshot() TO authenticated;

COMMIT;
