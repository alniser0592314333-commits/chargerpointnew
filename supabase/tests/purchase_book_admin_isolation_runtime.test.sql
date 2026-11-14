BEGIN;

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
DECLARE v_a uuid; v_b uuid; v_snapshot jsonb; v_page jsonb; v_changes jsonb; v_delta_count integer; v_rejected boolean := false;
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
  IF jsonb_array_length(v_page->'rows') <> 1
     OR v_page->'rows'->0->>'entity_id' <> '30000000-0000-4000-8000-000000000002'
     OR (v_page->>'current_count_through_sequence')::integer <> (v_snapshot->>'change_log_count')::integer
     OR v_page->>'change_log_fingerprint' <> v_snapshot->>'change_log_fingerprint' THEN
    RAISE EXCEPTION 'Authoritative delta paging leaked or lost account-scoped purchase changes';
  END IF;

  v_changes := public.pull_canonical_changes(0,500);
  IF jsonb_array_length(v_changes->'changes') <> 1
     OR v_changes->'changes'->0->>'entity_id' <> '30000000-0000-4000-8000-000000000002' THEN
    RAISE EXCEPTION 'Incremental change feed leaked another admin purchase change';
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
