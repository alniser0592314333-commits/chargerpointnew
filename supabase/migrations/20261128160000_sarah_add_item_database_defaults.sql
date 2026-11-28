-- Apply Sarah's phone and charger defaults inside the existing-order RPC too.
-- A NULL device type means a generic phone and resolves to the active Xiaomi
-- catalog row. A NULL charger flag means no charger. Explicit catalog IDs and
-- explicit true/false charger values remain unchanged.

DO $migration$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  v_def := pg_catalog.pg_get_functiondef(
    'public.sarah_ai_add_item_to_existing_order(uuid,text,text,uuid,uuid,boolean,bigint)'::regprocedure
  );

  v_old := '  v_device_active boolean;' || E'\n';
  v_new := v_old || '  v_resolved_device_type_id uuid;' || E'\n';
  IF pg_catalog.strpos(v_def, v_old) = 0 THEN
    RAISE EXCEPTION 'Sarah existing-order RPC declaration patch did not match';
  END IF;
  v_def := pg_catalog.replace(v_def, v_old, v_new);

  v_old := $old$
  IF p_request_id IS NULL OR p_order_id IS NULL OR p_device_type_id IS NULL
     OR p_customer_code IS NULL OR pg_catalog.btrim(p_customer_code) !~* '^[A-F0-9]{4}$'
     OR p_has_charger IS NULL
     OR (p_manual_price_minor IS NOT NULL AND p_manual_price_minor <= 0) THEN
$old$;
  v_new := $new$
  IF p_request_id IS NULL OR p_order_id IS NULL
     OR p_customer_code IS NULL OR pg_catalog.btrim(p_customer_code) !~* '^[A-F0-9]{4}$'
     OR (p_manual_price_minor IS NOT NULL AND p_manual_price_minor <= 0) THEN
$new$;
  IF pg_catalog.strpos(v_def, v_old) = 0 THEN
    RAISE EXCEPTION 'Sarah existing-order RPC optional device/charger validation patch did not match';
  END IF;
  v_def := pg_catalog.replace(v_def, v_old, v_new);

  v_old := $old$
  SELECT count(*)::integer, bool_and(dt.is_active IS TRUE AND dt.deleted_at IS NULL
    AND COALESCE(dt.status,'ACTIVE') NOT IN ('RETIRED','DELETED'))
    INTO v_device_count,v_device_active
  FROM public.device_types dt
  WHERE dt.id=p_device_type_id;
$old$;
  v_new := $new$
  v_resolved_device_type_id := p_device_type_id;
  IF v_resolved_device_type_id IS NULL THEN
    SELECT dt.id INTO v_resolved_device_type_id
    FROM public.device_types dt
    WHERE dt.is_active IS TRUE
      AND dt.deleted_at IS NULL
      AND COALESCE(dt.status,'ACTIVE')='ACTIVE'
      AND pg_catalog.lower(pg_catalog.btrim(COALESCE(dt.name_ar,dt.name))) IN ('هاتف شاومي','هاتف شاومي')
    ORDER BY dt.sort_order,dt.id
    LIMIT 1;
  END IF;
  IF v_resolved_device_type_id IS NULL THEN
    RAISE EXCEPTION 'Default Xiaomi phone type is unavailable in the active catalog' USING ERRCODE='22023';
  END IF;

  SELECT count(*)::integer, bool_and(dt.is_active IS TRUE AND dt.deleted_at IS NULL
    AND COALESCE(dt.status,'ACTIVE') NOT IN ('RETIRED','DELETED'))
    INTO v_device_count,v_device_active
  FROM public.device_types dt
  WHERE dt.id=v_resolved_device_type_id;
$new$;
  IF pg_catalog.strpos(v_def, v_old) = 0 THEN
    RAISE EXCEPTION 'Sarah existing-order RPC Xiaomi catalog fallback patch did not match';
  END IF;
  v_def := pg_catalog.replace(v_def, v_old, v_new);

  v_old := '''deviceTypeId'',p_device_type_id,';
  v_new := '''deviceTypeId'',v_resolved_device_type_id,';
  IF pg_catalog.strpos(v_def, v_old) = 0 THEN
    RAISE EXCEPTION 'Sarah existing-order RPC resolved device payload patch did not match';
  END IF;
  v_def := pg_catalog.replace(v_def, v_old, v_new);

  v_old := '''hasCharger'',p_has_charger,';
  v_new := '''hasCharger'',COALESCE(p_has_charger,false),';
  IF pg_catalog.strpos(v_def, v_old) = 0 THEN
    RAISE EXCEPTION 'Sarah existing-order RPC charger payload patch did not match';
  END IF;
  v_def := pg_catalog.replace(v_def, v_old, v_new);

  EXECUTE v_def;
END
$migration$;
