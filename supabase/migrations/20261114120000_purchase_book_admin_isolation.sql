-- Isolate every Purchase Book aggregate by its authenticated admin profile.
-- Existing purchase rows were explicitly cleared before this migration; no legacy
-- rows are reassigned to an arbitrary account.
BEGIN;

ALTER TABLE public.purchase_suppliers ADD COLUMN IF NOT EXISTS admin_id uuid REFERENCES public.admins(id);
ALTER TABLE public.purchase_items ADD COLUMN IF NOT EXISTS admin_id uuid REFERENCES public.admins(id);
ALTER TABLE public.purchase_payment_methods ADD COLUMN IF NOT EXISTS admin_id uuid REFERENCES public.admins(id);
ALTER TABLE public.purchase_months ADD COLUMN IF NOT EXISTS admin_id uuid REFERENCES public.admins(id);
ALTER TABLE public.purchase_weeks ADD COLUMN IF NOT EXISTS admin_id uuid REFERENCES public.admins(id);
ALTER TABLE public.purchase_days ADD COLUMN IF NOT EXISTS admin_id uuid REFERENCES public.admins(id);
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS admin_id uuid REFERENCES public.admins(id);

ALTER TABLE public.purchase_suppliers ALTER COLUMN admin_id SET NOT NULL;
ALTER TABLE public.purchase_items ALTER COLUMN admin_id SET NOT NULL;
ALTER TABLE public.purchase_payment_methods ALTER COLUMN admin_id SET NOT NULL;
ALTER TABLE public.purchase_months ALTER COLUMN admin_id SET NOT NULL;
ALTER TABLE public.purchase_weeks ALTER COLUMN admin_id SET NOT NULL;
ALTER TABLE public.purchase_days ALTER COLUMN admin_id SET NOT NULL;
ALTER TABLE public.purchase_orders ALTER COLUMN admin_id SET NOT NULL;

ALTER TABLE public.purchase_months DROP CONSTRAINT IF EXISTS purchase_months_year_month_number_key;
ALTER TABLE public.purchase_months ADD CONSTRAINT purchase_months_admin_year_month_key UNIQUE (admin_id, year, month_number);
ALTER TABLE public.purchase_days DROP CONSTRAINT IF EXISTS purchase_days_purchase_date_key;
ALTER TABLE public.purchase_days ADD CONSTRAINT purchase_days_admin_purchase_date_key UNIQUE (admin_id, purchase_date);

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='purchase_suppliers_id_admin_key' AND conrelid='public.purchase_suppliers'::regclass) THEN
    ALTER TABLE public.purchase_suppliers ADD CONSTRAINT purchase_suppliers_id_admin_key UNIQUE (id, admin_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='purchase_items_id_admin_key' AND conrelid='public.purchase_items'::regclass) THEN
    ALTER TABLE public.purchase_items ADD CONSTRAINT purchase_items_id_admin_key UNIQUE (id, admin_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='purchase_payment_methods_id_admin_key' AND conrelid='public.purchase_payment_methods'::regclass) THEN
    ALTER TABLE public.purchase_payment_methods ADD CONSTRAINT purchase_payment_methods_id_admin_key UNIQUE (id, admin_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='purchase_months_id_admin_key' AND conrelid='public.purchase_months'::regclass) THEN
    ALTER TABLE public.purchase_months ADD CONSTRAINT purchase_months_id_admin_key UNIQUE (id, admin_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='purchase_weeks_id_admin_key' AND conrelid='public.purchase_weeks'::regclass) THEN
    ALTER TABLE public.purchase_weeks ADD CONSTRAINT purchase_weeks_id_admin_key UNIQUE (id, admin_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='purchase_days_id_admin_key' AND conrelid='public.purchase_days'::regclass) THEN
    ALTER TABLE public.purchase_days ADD CONSTRAINT purchase_days_id_admin_key UNIQUE (id, admin_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='purchase_weeks_month_owner_fk' AND conrelid='public.purchase_weeks'::regclass) THEN
    ALTER TABLE public.purchase_weeks ADD CONSTRAINT purchase_weeks_month_owner_fk
      FOREIGN KEY (month_id, admin_id) REFERENCES public.purchase_months(id, admin_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='purchase_days_week_owner_fk' AND conrelid='public.purchase_days'::regclass) THEN
    ALTER TABLE public.purchase_days ADD CONSTRAINT purchase_days_week_owner_fk
      FOREIGN KEY (week_id, admin_id) REFERENCES public.purchase_weeks(id, admin_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='purchase_orders_day_owner_fk' AND conrelid='public.purchase_orders'::regclass) THEN
    ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_day_owner_fk
      FOREIGN KEY (purchase_day_id, admin_id) REFERENCES public.purchase_days(id, admin_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='purchase_orders_supplier_owner_fk' AND conrelid='public.purchase_orders'::regclass) THEN
    ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_supplier_owner_fk
      FOREIGN KEY (supplier_id, admin_id) REFERENCES public.purchase_suppliers(id, admin_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='purchase_orders_item_owner_fk' AND conrelid='public.purchase_orders'::regclass) THEN
    ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_item_owner_fk
      FOREIGN KEY (item_id, admin_id) REFERENCES public.purchase_items(id, admin_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='purchase_orders_method_owner_fk' AND conrelid='public.purchase_orders'::regclass) THEN
    ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_method_owner_fk
      FOREIGN KEY (payment_method_id, admin_id) REFERENCES public.purchase_payment_methods(id, admin_id) ON DELETE RESTRICT;
  END IF;
END;
$constraints$;

CREATE INDEX IF NOT EXISTS purchase_suppliers_admin_idx ON public.purchase_suppliers(admin_id);
CREATE INDEX IF NOT EXISTS purchase_items_admin_idx ON public.purchase_items(admin_id);
CREATE INDEX IF NOT EXISTS purchase_payment_methods_admin_idx ON public.purchase_payment_methods(admin_id);
CREATE INDEX IF NOT EXISTS purchase_months_admin_idx ON public.purchase_months(admin_id, year DESC, month_number DESC);
CREATE INDEX IF NOT EXISTS purchase_weeks_admin_idx ON public.purchase_weeks(admin_id, month_id, start_date DESC);
CREATE INDEX IF NOT EXISTS purchase_days_admin_idx ON public.purchase_days(admin_id, purchase_date DESC);
CREATE INDEX IF NOT EXISTS purchase_orders_admin_idx ON public.purchase_orders(admin_id, purchased_at DESC);

CREATE OR REPLACE FUNCTION public.current_purchase_admin_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT a.id FROM public.admins a
  WHERE a.auth_user_id=auth.uid() AND a.is_active IS TRUE
  LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION public.current_purchase_admin_id() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.current_purchase_admin_id() TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_purchase_book_admin_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE v_admin_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Purchase Book requires an authenticated admin' USING ERRCODE='42501';
  END IF;
  SELECT a.id INTO v_admin_id
  FROM public.admins a
  WHERE a.auth_user_id = auth.uid() AND a.is_active IS TRUE
  LIMIT 1;
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Active admin profile required for Purchase Book' USING ERRCODE='42501';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.admin_id IS DISTINCT FROM v_admin_id THEN
    RAISE EXCEPTION 'Purchase Book record belongs to another admin' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.admin_id IS DISTINCT FROM v_admin_id THEN
      RAISE EXCEPTION 'Purchase Book record belongs to another admin' USING ERRCODE='42501';
    END IF;
    RETURN OLD;
  END IF;

  NEW.admin_id := v_admin_id;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.enforce_purchase_book_admin_owner() FROM PUBLIC, anon, authenticated, service_role;

DO $block$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'purchase_suppliers','purchase_items','purchase_payment_methods',
    'purchase_months','purchase_weeks','purchase_days','purchase_orders'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS enforce_purchase_book_admin_owner ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER enforce_purchase_book_admin_owner BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.enforce_purchase_book_admin_owner()',
      t
    );
    EXECUTE format('DROP POLICY IF EXISTS purchase_book_admin_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY purchase_book_admin_isolation ON public.%I FOR ALL TO authenticated USING (admin_id = public.current_purchase_admin_id()) WITH CHECK (admin_id = public.current_purchase_admin_id())',
      t
    );
  END LOOP;
END;
$block$;

-- No direct table access: all mutations still pass through the canonical command RPC.
REVOKE ALL ON public.purchase_suppliers, public.purchase_items, public.purchase_payment_methods,
  public.purchase_months, public.purchase_weeks, public.purchase_days, public.purchase_orders
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.purchase_entity_belongs_to_admin(
  p_entity_type text, p_entity_id uuid, p_admin_id uuid
) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT CASE p_entity_type
    WHEN 'purchase_suppliers' THEN EXISTS (SELECT 1 FROM public.purchase_suppliers x WHERE x.id=p_entity_id AND x.admin_id=p_admin_id)
    WHEN 'purchase_items' THEN EXISTS (SELECT 1 FROM public.purchase_items x WHERE x.id=p_entity_id AND x.admin_id=p_admin_id)
    WHEN 'purchase_payment_methods' THEN EXISTS (SELECT 1 FROM public.purchase_payment_methods x WHERE x.id=p_entity_id AND x.admin_id=p_admin_id)
    WHEN 'purchase_months' THEN EXISTS (SELECT 1 FROM public.purchase_months x WHERE x.id=p_entity_id AND x.admin_id=p_admin_id)
    WHEN 'purchase_weeks' THEN EXISTS (SELECT 1 FROM public.purchase_weeks x WHERE x.id=p_entity_id AND x.admin_id=p_admin_id)
    WHEN 'purchase_days' THEN EXISTS (SELECT 1 FROM public.purchase_days x WHERE x.id=p_entity_id AND x.admin_id=p_admin_id)
    WHEN 'purchase_orders' THEN EXISTS (SELECT 1 FROM public.purchase_orders x WHERE x.id=p_entity_id AND x.admin_id=p_admin_id)
    ELSE false
  END;
$function$;

-- Keep the original snapshot implementation private under an internal name, then
-- expose a guarded wrapper that removes every other admin's purchase aggregates.
DO $rename$
BEGIN
  IF to_regprocedure('public.capture_sync_bootstrap_snapshot__session_guarded_impl()') IS NOT NULL
     AND to_regprocedure('public.capture_sync_bootstrap_snapshot__shared_unfiltered()') IS NULL THEN
    ALTER FUNCTION public.capture_sync_bootstrap_snapshot__session_guarded_impl()
      RENAME TO capture_sync_bootstrap_snapshot__shared_unfiltered;
  END IF;
END;
$rename$;
REVOKE ALL ON FUNCTION public.capture_sync_bootstrap_snapshot__shared_unfiltered() FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.capture_sync_bootstrap_snapshot__session_guarded_impl()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE v_admin_id uuid; v_active boolean; v_snapshot jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT id,is_active INTO v_admin_id,v_active FROM public.admins WHERE auth_user_id=auth.uid() LIMIT 1;
  IF v_admin_id IS NULL OR v_active IS NOT TRUE THEN RAISE EXCEPTION 'Active admin profile required'; END IF;
  v_snapshot := public.capture_sync_bootstrap_snapshot__shared_unfiltered();
  RETURN v_snapshot
    || jsonb_build_object(
      'purchase_suppliers', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.purchase_suppliers t WHERE t.admin_id=v_admin_id),'[]'::jsonb),
      'purchase_items', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.purchase_items t WHERE t.admin_id=v_admin_id),'[]'::jsonb),
      'purchase_payment_methods', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.purchase_payment_methods t WHERE t.admin_id=v_admin_id),'[]'::jsonb),
      'purchase_months', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.purchase_months t WHERE t.admin_id=v_admin_id),'[]'::jsonb),
      'purchase_weeks', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.purchase_weeks t WHERE t.admin_id=v_admin_id),'[]'::jsonb),
      'purchase_days', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.purchase_days t WHERE t.admin_id=v_admin_id),'[]'::jsonb),
      'purchase_orders', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.purchase_orders t WHERE t.admin_id=v_admin_id),'[]'::jsonb)
    );
END;
$function$;

DO $rename$
BEGIN
  IF to_regprocedure('public.capture_authoritative_business_snapshot__session_guarded_impl()') IS NOT NULL
     AND to_regprocedure('public.capture_authoritative_business_snapshot__shared_unfiltered()') IS NULL THEN
    ALTER FUNCTION public.capture_authoritative_business_snapshot__session_guarded_impl()
      RENAME TO capture_authoritative_business_snapshot__shared_unfiltered;
  END IF;
END;
$rename$;
REVOKE ALL ON FUNCTION public.capture_authoritative_business_snapshot__shared_unfiltered() FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.capture_authoritative_business_snapshot__session_guarded_impl()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE v_admin_id uuid; v_role text; v_active boolean; v_snapshot jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT id,role,is_active INTO v_admin_id,v_role,v_active FROM public.admins WHERE auth_user_id=auth.uid() LIMIT 1;
  IF v_admin_id IS NULL OR v_active IS NOT TRUE THEN RAISE EXCEPTION 'Active admin profile required'; END IF;
  IF v_role NOT IN ('SUPER_ADMIN','Super Admin') AND NOT EXISTS (
    SELECT 1 FROM public.get_effective_permissions(v_admin_id)
    WHERE permission IN ('settings:manage','admin:manage','SUPER_ADMIN')
  ) THEN RAISE EXCEPTION 'Forbidden: settings:manage permission required'; END IF;
  v_snapshot := public.capture_authoritative_business_snapshot__shared_unfiltered();
  RETURN v_snapshot
    || jsonb_build_object(
      'change_log_count', (SELECT count(*) FROM public.change_log t
        WHERE left(t.entity_type,9) <> 'purchase_'
          OR public.purchase_entity_belongs_to_admin(t.entity_type,t.entity_id,v_admin_id)),
      'change_log_fingerprint', (SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.sequence_id), ''))
        FROM public.change_log t
        WHERE left(t.entity_type,9) <> 'purchase_'
          OR public.purchase_entity_belongs_to_admin(t.entity_type,t.entity_id,v_admin_id)),
      'purchase_suppliers', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.purchase_suppliers t WHERE t.admin_id=v_admin_id),'[]'::jsonb),
      'purchase_items', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.purchase_items t WHERE t.admin_id=v_admin_id),'[]'::jsonb),
      'purchase_payment_methods', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.purchase_payment_methods t WHERE t.admin_id=v_admin_id),'[]'::jsonb),
      'purchase_months', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.purchase_months t WHERE t.admin_id=v_admin_id),'[]'::jsonb),
      'purchase_weeks', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.purchase_weeks t WHERE t.admin_id=v_admin_id),'[]'::jsonb),
      'purchase_days', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.purchase_days t WHERE t.admin_id=v_admin_id),'[]'::jsonb),
      'purchase_orders', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.purchase_orders t WHERE t.admin_id=v_admin_id),'[]'::jsonb)
    );
END;
$function$;

-- Authoritative paged delta: return shared changes plus this admin's purchase changes
-- while preserving a cursor over the admin-visible change-log sequence.
DO $rename$
BEGIN
  IF to_regprocedure('public.capture_authoritative_change_log_page__session_guarded_impl(bigint,bigint,integer)') IS NOT NULL
     AND to_regprocedure('public.capture_authoritative_change_log_page__shared_unfiltered(bigint,bigint,integer)') IS NULL THEN
    ALTER FUNCTION public.capture_authoritative_change_log_page__session_guarded_impl(bigint,bigint,integer)
      RENAME TO capture_authoritative_change_log_page__shared_unfiltered;
  END IF;
END;
$rename$;
REVOKE ALL ON FUNCTION public.capture_authoritative_change_log_page__shared_unfiltered(bigint,bigint,integer) FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.capture_authoritative_change_log_page__session_guarded_impl(
  p_after_sequence_id bigint, p_through_sequence_id bigint, p_limit integer DEFAULT 500
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE v_admin_id uuid; v_admin_role text; v_active boolean; v_limit integer := GREATEST(1,LEAST(COALESCE(p_limit,500),1000));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT id,role,is_active INTO v_admin_id,v_admin_role,v_active FROM public.admins WHERE auth_user_id=auth.uid() LIMIT 1;
  IF v_admin_id IS NULL OR v_active IS NOT TRUE THEN RAISE EXCEPTION 'Active admin profile required'; END IF;
  IF v_admin_role NOT IN ('SUPER_ADMIN','Super Admin') AND NOT EXISTS (
    SELECT 1 FROM public.get_effective_permissions(v_admin_id)
    WHERE permission IN ('settings:manage','admin:manage','SUPER_ADMIN')
  ) THEN RAISE EXCEPTION 'Forbidden: settings:manage permission required'; END IF;
  IF p_after_sequence_id < 0 OR p_through_sequence_id < p_after_sequence_id THEN RAISE EXCEPTION 'Invalid change-log page bounds'; END IF;
  RETURN (
    WITH scanned AS MATERIALIZED (
      SELECT t.* FROM public.change_log t
      WHERE t.sequence_id>p_after_sequence_id AND t.sequence_id<=p_through_sequence_id
      ORDER BY t.sequence_id LIMIT v_limit
    ), visible AS MATERIALIZED (
      SELECT s.* FROM scanned s
      WHERE left(s.entity_type,9) <> 'purchase_'
         OR public.purchase_entity_belongs_to_admin(s.entity_type,s.entity_id,v_admin_id)
    )
    SELECT jsonb_build_object(
      'rows',COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.sequence_id) FROM visible v),'[]'::jsonb),
      'next_after_sequence_id',COALESCE((SELECT max(sequence_id) FROM scanned),p_after_sequence_id),
      'current_count_through_sequence',(
        SELECT count(*) FROM public.change_log t
        WHERE t.sequence_id<=p_through_sequence_id
          AND (left(t.entity_type,9) <> 'purchase_'
            OR public.purchase_entity_belongs_to_admin(t.entity_type,t.entity_id,v_admin_id))
      ),
      'server_reset_generation',COALESCE((SELECT value_number FROM public.system_settings WHERE key='server_reset_generation' LIMIT 1),0),
      'change_log_fingerprint',CASE WHEN p_after_sequence_id=p_through_sequence_id THEN (
        SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY t.sequence_id),''))
        FROM public.change_log t
        WHERE t.sequence_id<=p_through_sequence_id
          AND (left(t.entity_type,9) <> 'purchase_'
            OR public.purchase_entity_belongs_to_admin(t.entity_type,t.entity_id,v_admin_id))
      ) ELSE NULL END
    )
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.capture_sync_bootstrap_snapshot__session_guarded_impl() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.capture_authoritative_business_snapshot__session_guarded_impl() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.capture_authoritative_change_log_page__session_guarded_impl(bigint,bigint,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.pull_canonical_changes__session_guarded_impl(bigint,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.purchase_entity_belongs_to_admin(text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Regular incremental pull uses the same visibility rule and advances over all
-- scanned rows so a busy different account cannot stall this account's cursor.
DO $rename$
BEGIN
  IF to_regprocedure('public.pull_canonical_changes__session_guarded_impl(bigint,integer)') IS NOT NULL
     AND to_regprocedure('public.pull_canonical_changes__shared_unfiltered(bigint,integer)') IS NULL THEN
    ALTER FUNCTION public.pull_canonical_changes__session_guarded_impl(bigint,integer)
      RENAME TO pull_canonical_changes__shared_unfiltered;
  END IF;
END;
$rename$;
REVOKE ALL ON FUNCTION public.pull_canonical_changes__shared_unfiltered(bigint,integer) FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.pull_canonical_changes__session_guarded_impl(
  p_since_sequence bigint, p_limit integer DEFAULT 500
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE v_admin_id uuid; v_active boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT id,is_active INTO v_admin_id,v_active FROM public.admins WHERE auth_user_id=auth.uid() LIMIT 1;
  IF v_admin_id IS NULL OR v_active IS NOT TRUE THEN RAISE EXCEPTION 'Active admin profile required'; END IF;
  IF p_since_sequence IS NULL OR p_since_sequence<0 THEN RAISE EXCEPTION 'Invalid change-log cursor'; END IF;
  RETURN (
    WITH page AS MATERIALIZED (
      SELECT * FROM public.change_log WHERE sequence_id>p_since_sequence
      ORDER BY sequence_id LIMIT LEAST(GREATEST(COALESCE(p_limit,500),1),500)
    ), visible AS (
      SELECT p.* FROM page p
      WHERE left(p.entity_type,9) <> 'purchase_'
         OR public.purchase_entity_belongs_to_admin(p.entity_type,p.entity_id,v_admin_id)
    )
    SELECT jsonb_build_object(
      'changes',COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.sequence_id) FROM visible v),'[]'::jsonb),
      'latestSequence',COALESCE((SELECT max(sequence_id) FROM page),p_since_sequence),
      'serverResetGeneration',(SELECT value_number FROM public.system_settings WHERE key='server_reset_generation' LIMIT 1)
    )
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.pull_canonical_changes__session_guarded_impl(bigint,integer) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pull_canonical_delta_changes(p_since_sequence bigint DEFAULT 0, p_limit integer DEFAULT 500)
RETURNS TABLE(sequence_id bigint, entity_type character varying, entity_id uuid, action character varying, payload jsonb, version integer, changed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
DECLARE v_admin_id uuid; v_active boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT id,is_active INTO v_admin_id,v_active FROM public.admins WHERE auth_user_id=auth.uid() LIMIT 1;
  IF v_admin_id IS NULL OR v_active IS NOT TRUE THEN RAISE EXCEPTION 'Active admin profile required'; END IF;
  PERFORM public._cp_assert_active_admin_permission('sync:manage');
  RETURN QUERY
  SELECT c.sequence_id,c.entity_type::varchar,c.entity_id,c.action::varchar,c.payload,c.version,c.changed_at
  FROM public.change_log c
  WHERE c.sequence_id>p_since_sequence
    AND (left(c.entity_type,9) <> 'purchase_'
      OR public.purchase_entity_belongs_to_admin(c.entity_type,c.entity_id,v_admin_id))
  ORDER BY c.sequence_id ASC
  LIMIT LEAST(COALESCE(p_limit,500),1000);
END;
$function$;

COMMIT;
