CREATE OR REPLACE FUNCTION public.capture_sync_bootstrap_snapshot()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $function$ BEGIN
  PERFORM public._cp_assert_active_admin_permission('sync:manage');
  RETURN public.capture_sync_bootstrap_snapshot__session_guarded_impl();
END; $function$;

CREATE OR REPLACE FUNCTION public.capture_authoritative_business_snapshot()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $function$ BEGIN
  PERFORM public.assert_my_account_session_active();
  RETURN public.capture_authoritative_business_snapshot__session_guarded_impl();
END; $function$;

CREATE OR REPLACE FUNCTION public.capture_authoritative_change_log_page(
  p_after_sequence_id bigint,p_through_sequence_id bigint,p_limit integer DEFAULT 500
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $function$ BEGIN
  PERFORM public.assert_my_account_session_active();
  RETURN public.capture_authoritative_change_log_page__session_guarded_impl($1,$2,$3);
END; $function$;

CREATE OR REPLACE FUNCTION public.pull_canonical_changes(p_since_sequence bigint,p_limit integer DEFAULT 500)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $function$ BEGIN
  PERFORM public._cp_assert_active_admin_permission('sync:manage');
  RETURN public.pull_canonical_changes__session_guarded_impl($1,$2);
END; $function$;

BEGIN;

DELETE FROM public.change_log;

INSERT INTO public.admins(id,auth_user_id,role,is_active) VALUES
 ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000011','SUPER_ADMIN',true),
 ('10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000012','SUPER_ADMIN',true);

SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000011',true);
INSERT INTO public.purchase_suppliers(id,name) VALUES ('30000000-0000-4000-8000-000000000001','Supplier A');
INSERT INTO public.purchase_items(id,name) VALUES ('31000000-0000-4000-8000-000000000001','Item A');
INSERT INTO public.purchase_payment_methods(id,name) VALUES ('32000000-0000-4000-8000-000000000001','Method A');
INSERT INTO public.purchase_months(id,year,month_number,start_date,end_date) VALUES ('40000000-0000-4000-8000-000000000001',2026,11,'2026-11-01','2026-11-30');
INSERT INTO public.purchase_weeks(id,month_id,start_date,end_date) VALUES ('41000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','2026-11-07','2026-11-13');
INSERT INTO public.purchase_days(id,week_id,purchase_date) VALUES ('42000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001','2026-11-11');

SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000012',true);
INSERT INTO public.purchase_suppliers(id,name) VALUES ('30000000-0000-4000-8000-000000000002','Supplier B');
INSERT INTO public.purchase_items(id,name) VALUES ('31000000-0000-4000-8000-000000000002','Item B');
INSERT INTO public.purchase_payment_methods(id,name) VALUES ('32000000-0000-4000-8000-000000000002','Method B');
INSERT INTO public.purchase_months(id,year,month_number,start_date,end_date) VALUES ('40000000-0000-4000-8000-000000000002',2026,11,'2026-11-01','2026-11-30');
INSERT INTO public.purchase_weeks(id,month_id,start_date,end_date) VALUES ('41000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000002','2026-11-07','2026-11-13');
INSERT INTO public.purchase_days(id,week_id,purchase_date) VALUES ('42000000-0000-4000-8000-000000000002','41000000-0000-4000-8000-000000000002','2026-11-11');

DO $owner_assertions$
DECLARE v_a uuid; v_b uuid; v_snapshot jsonb; v_page jsonb; v_final_page jsonb; v_changes jsonb; v_delta_count integer; v_rejected boolean := false;
BEGIN
  SELECT admin_id INTO v_a FROM public.purchase_suppliers WHERE id='30000000-0000-4000-8000-000000000001';
  SELECT admin_id INTO v_b FROM public.purchase_suppliers WHERE id='30000000-0000-4000-8000-000000000002';
  IF v_a <> '10000000-0000-4000-8000-000000000001' OR v_b <> '10000000-0000-4000-8000-000000000002' THEN
    RAISE EXCEPTION 'Purchase owner trigger did not bind rows to the authenticated admin';
  END IF;

  v_snapshot := public.capture_sync_bootstrap_snapshot();
  IF jsonb_array_length(v_snapshot->'purchase_suppliers') <> 1
     OR v_snapshot->'purchase_suppliers'->0->>'name' <> 'Supplier B' THEN
    RAISE EXCEPTION 'Bootstrap snapshot leaked another admin purchase supplier';
  END IF;

  INSERT INTO public.change_log(entity_type,entity_id,action,payload,version) VALUES
    ('purchase_suppliers','30000000-0000-4000-8000-000000000001','INSERT','{"id":"30000000-0000-4000-8000-000000000001","name":"Supplier A"}',1),
    ('purchase_suppliers','30000000-0000-4000-8000-000000000002','INSERT','{"id":"30000000-0000-4000-8000-000000000002","name":"Supplier B"}',1);

  v_snapshot := public.capture_authoritative_business_snapshot();
  v_page := public.capture_authoritative_change_log_page(0,(SELECT max(sequence_id) FROM public.change_log),500);
  v_final_page := public.capture_authoritative_change_log_page((SELECT max(sequence_id) FROM public.change_log),(SELECT max(sequence_id) FROM public.change_log),500);
  IF (SELECT count(*) FROM jsonb_array_elements(v_page->'rows') r WHERE r->>'entity_type'='purchase_suppliers') <> 1
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_page->'rows') r WHERE r->>'entity_type'='purchase_suppliers' AND r->>'entity_id'='30000000-0000-4000-8000-000000000001')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_page->'rows') r WHERE r->>'entity_type'='purchase_suppliers' AND r->>'entity_id'='30000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'Admin delta page leaked or lost a purchase change: %', v_page;
  END IF;
  IF (v_final_page->>'current_count_through_sequence')::integer <> (v_snapshot->>'change_log_count')::integer THEN
    RAISE EXCEPTION 'Admin delta count checkpoint mismatch: final %, snapshot %', v_final_page, v_snapshot;
  END IF;
  IF v_final_page->>'change_log_fingerprint' <> v_snapshot->>'change_log_fingerprint' THEN
    RAISE EXCEPTION 'Admin delta fingerprint checkpoint mismatch: final %, snapshot %', v_final_page, v_snapshot;
  END IF;

  v_changes := public.pull_canonical_changes(0,500);
  IF (SELECT count(*) FROM jsonb_array_elements(v_changes->'changes') r WHERE r->>'entity_type'='purchase_suppliers') <> 1
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_changes->'changes') r WHERE r->>'entity_type'='purchase_suppliers' AND r->>'entity_id'='30000000-0000-4000-8000-000000000001')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_changes->'changes') r WHERE r->>'entity_type'='purchase_suppliers' AND r->>'entity_id'='30000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'Incremental change feed leaked or lost an admin purchase change: %', v_changes;
  END IF;

  SELECT count(*) INTO v_delta_count FROM public.pull_canonical_delta_changes(0,500)
  WHERE entity_type='purchase_suppliers';
  IF v_delta_count <> 1 THEN RAISE EXCEPTION 'Canonical delta table function did not isolate purchase changes'; END IF;

  BEGIN
    UPDATE public.purchase_suppliers SET name='stolen edit'
    WHERE id='30000000-0000-4000-8000-000000000001';
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Admin B updated Admin A purchase supplier'; END IF;

  v_rejected := false;
  BEGIN
    INSERT INTO public.purchase_orders(id,purchase_day_id,supplier_id,item_id,amount_minor,currency)
    VALUES ('50000000-0000-4000-8000-000000000002',
      '42000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000001',
      '31000000-0000-4000-8000-000000000002',100,'ILS');
  EXCEPTION WHEN foreign_key_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Cross-admin purchase foreign key was accepted'; END IF;
END;
$owner_assertions$;

ROLLBACK;
