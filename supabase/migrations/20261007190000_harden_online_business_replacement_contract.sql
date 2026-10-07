-- Canonical Local -> Online replacement contract.\n-- Exact server RPC installed in project monthersafiadata.\n\nCREATE OR REPLACE FUNCTION public.replace_online_business_data(p_entered_bin text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_replacement_id uuid := gen_random_uuid();
  v_completed_at timestamptz := now();
  v_new_generation bigint;

  v_item jsonb;
  v_id uuid;
  v_order_id uuid;
  v_customer_id uuid;
  v_device_type_id uuid;
  v_payment_id uuid;
  v_order_item_id uuid;
  v_actor_admin_id uuid;
  v_command_id uuid;
  v_target_id uuid;
  v_linked_ledger_id uuid;
  v_alloc_amount bigint;
  v_seq bigint;
  v_internal_seq bigint;

  v_counts jsonb := '{}'::jsonb;
BEGIN
  /* ---------- AUTH / AUTHORIZATION ---------- */
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_entered_bin IS NULL OR trim(p_entered_bin) = '' OR p_entered_bin !~ '^[0-9]{4,}$' THEN
    RAISE EXCEPTION 'Invalid BIN format';
  END IF;

  SELECT a.id, a.role
    INTO v_admin_id, v_admin_role
  FROM public.admins a
  WHERE a.auth_user_id = auth.uid()
    AND a.is_active = true
  LIMIT 1;

  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: active admin profile not found';
  END IF;

  IF v_admin_role NOT IN ('SUPER_ADMIN','Super Admin')
     AND NOT EXISTS (
       SELECT 1
       FROM public.get_effective_permissions(v_admin_id)
       WHERE permission IN ('settings:manage','admin:manage','SUPER_ADMIN')
     )
  THEN
    RAISE EXCEPTION 'Forbidden: settings:manage permission required';
  END IF;

  IF public.verify_admin_bin(p_entered_bin) IS NOT TRUE THEN
    RAISE EXCEPTION 'Invalid BIN: security verification failed';
  END IF;

  PERFORM public._cp_guard_nonempty_replacement_payload(p_payload);

  /* ---------- GLOBAL REPLACEMENT LOCK ---------- */
  PERFORM pg_advisory_xact_lock(hashtext('online_business_reset_lock'));

  /* ---------- PAYLOAD SHAPE / DUPLICATE PREFLIGHT ---------- */
  IF jsonb_typeof(coalesce(p_payload->'device_types','[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'business_days','[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'customers','[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'qr_tokens','[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'orders','[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'order_items','[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'payments','[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'financial_ledger','[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'payment_allocations','[]'::jsonb)) <> 'array'
  THEN
    RAISE EXCEPTION 'Invalid replacement payload: all business collections must be arrays';
  END IF;

  /* Validate IDs and duplicate IDs before touching existing rows. */
  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'device_types','[]'::jsonb)) LOOP
    IF (v_item->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid device_type ID'; END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT (x->>'id') AS id, count(*) c
      FROM jsonb_array_elements(coalesce(p_payload->'device_types','[]'::jsonb)) x
      GROUP BY 1 HAVING count(*) > 1
    ) d
  ) THEN RAISE EXCEPTION 'Duplicate device_type ID in replacement payload'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'business_days','[]'::jsonb)) LOOP
    IF (v_item->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid business_day ID'; END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT (x->>'id') id,count(*) c FROM jsonb_array_elements(coalesce(p_payload->'business_days','[]'::jsonb)) x
      GROUP BY 1 HAVING count(*) > 1
    ) d
  ) THEN RAISE EXCEPTION 'Duplicate business_day ID in replacement payload'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'customers','[]'::jsonb)) LOOP
    IF (v_item->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid customer ID'; END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT (x->>'id') id,count(*) c FROM jsonb_array_elements(coalesce(p_payload->'customers','[]'::jsonb)) x
      GROUP BY 1 HAVING count(*) > 1
    ) d
  ) THEN RAISE EXCEPTION 'Duplicate customer ID in replacement payload'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'orders','[]'::jsonb)) LOOP
    IF (v_item->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid order ID'; END IF;
    IF lower(coalesce(v_item->>'status','pending')) NOT IN ('pending','charging','delivered','cancelled') THEN
      RAISE EXCEPTION 'Invalid order status %', v_item->>'status';
    END IF;
    IF (coalesce(v_item->>'day_id',v_item->>'dayId')) !~* '^[0-9a-f-]{36}$'
       OR (coalesce(v_item->>'customer_id',v_item->>'customerId')) !~* '^[0-9a-f-]{36}$'
    THEN RAISE EXCEPTION 'Order % has invalid customer/day reference', v_item->>'id'; END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT (x->>'id') id,count(*) c FROM jsonb_array_elements(coalesce(p_payload->'orders','[]'::jsonb)) x
      GROUP BY 1 HAVING count(*) > 1
    ) d
  ) THEN RAISE EXCEPTION 'Duplicate order ID in replacement payload'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'order_items',p_payload->'orderItems','[]'::jsonb)) LOOP
    IF (v_item->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid order_item ID'; END IF;
    IF lower(coalesce(v_item->>'status','charging')) NOT IN ('pending','charging','delivered','cancelled') THEN
      RAISE EXCEPTION 'Invalid order_item status %', v_item->>'status';
    END IF;
    IF upper(coalesce(v_item->>'operational_status',v_item->>'operationalStatus',
      case lower(coalesce(v_item->>'status','charging')) when 'delivered' then 'DELIVERED' when 'cancelled' then 'CANCELLED' else 'CHARGING' end))
      NOT IN ('CHARGING','DELIVERED','CANCELLED') THEN RAISE EXCEPTION 'Invalid operational status'; END IF;
    IF upper(coalesce(v_item->>'financial_status',v_item->>'financialStatus',
      case lower(coalesce(v_item->>'status','charging')) when 'delivered' then 'RECOGNIZED' else 'UNRECOGNIZED' end))
      NOT IN ('UNRECOGNIZED','RECOGNIZED','REVERSED') THEN RAISE EXCEPTION 'Invalid financial status'; END IF;
    IF upper(coalesce(v_item->>'payment_status',v_item->>'paymentStatus','UNPAID'))
      NOT IN ('UNPAID','PARTIALLY_PAID','PAID') THEN RAISE EXCEPTION 'Invalid payment status'; END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT (x->>'id') id,count(*) c FROM jsonb_array_elements(coalesce(p_payload->'order_items',p_payload->'orderItems','[]'::jsonb)) x
      GROUP BY 1 HAVING count(*) > 1
    ) d
  ) THEN RAISE EXCEPTION 'Duplicate order_item ID in replacement payload'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'payments','[]'::jsonb)) LOOP
    IF (v_item->>'id') !~* '^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'Invalid payment ID'; END IF;
    IF coalesce((v_item->>'amount_minor')::bigint,(v_item->>'amountMinor')::bigint,0) <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive'; END IF;
    IF (coalesce(v_item->>'customer_id',v_item->>'customerId')) !~* '^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'Payment has invalid customer_id'; END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT (x->>'id') id,count(*) c FROM jsonb_array_elements(coalesce(p_payload->'payments','[]'::jsonb)) x
      GROUP BY 1 HAVING count(*) > 1
    ) d
  ) THEN RAISE EXCEPTION 'Duplicate payment ID in replacement payload'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'payment_allocations',p_payload->'paymentAllocations','[]'::jsonb)) LOOP
    IF (v_item->>'id') !~* '^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'Invalid payment allocation ID'; END IF;
    IF coalesce((v_item->>'allocated_amount_minor')::bigint,(v_item->>'allocatedAmountMinor')::bigint,0) <= 0 THEN
      RAISE EXCEPTION 'Payment allocation amount must be positive';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT (x->>'id') id,count(*) c FROM jsonb_array_elements(coalesce(p_payload->'payment_allocations',p_payload->'paymentAllocations','[]'::jsonb)) x
      GROUP BY 1 HAVING count(*) > 1
    ) d
  ) THEN RAISE EXCEPTION 'Duplicate payment allocation ID in replacement payload'; END IF;

  /* ---------- RESET GENERATION: invalidate pre-reset outbox commands ---------- */
  UPDATE public.system_settings
  SET value_number = coalesce(value_number,1) + 1, updated_at = now()
  WHERE key = 'server_reset_generation'
  RETURNING value_number INTO v_new_generation;

  IF v_new_generation IS NULL THEN
    INSERT INTO public.system_settings(key,value_type,value_number,description)
    VALUES('server_reset_generation','number',2,'Server reset generation/incarnation counter')
    ON CONFLICT(key) DO UPDATE SET value_number=public.system_settings.value_number+1,updated_at=now()
    RETURNING value_number INTO v_new_generation;
  END IF;

  /* ---------- SUPPRESS ONLY CHANGE-CAPTURE WHILE REBUILDING ---------- */
  ALTER TABLE public.business_days DISABLE TRIGGER trg_change_capture;
  ALTER TABLE public.customers DISABLE TRIGGER trg_change_capture;
  ALTER TABLE public.device_types DISABLE TRIGGER trg_change_capture;
  ALTER TABLE public.orders DISABLE TRIGGER trg_change_capture;
  ALTER TABLE public.order_items DISABLE TRIGGER trg_change_capture;
  ALTER TABLE public.payments DISABLE TRIGGER trg_change_capture;
  ALTER TABLE public.payment_allocations DISABLE TRIGGER trg_change_capture;
  ALTER TABLE public.financial_ledger DISABLE TRIGGER trg_change_capture;
  ALTER TABLE public.qr_tokens DISABLE TRIGGER trg_change_capture;

  /* Clear dependent business data first. Sync history is intentionally reset
     because reset_generation above makes every pre-replacement command stale. */
  DELETE FROM public.payment_allocations WHERE true;
  DELETE FROM public.financial_ledger WHERE true;
  DELETE FROM public.payments WHERE true;
  DELETE FROM public.order_items WHERE true;
  DELETE FROM public.orders WHERE true;
  DELETE FROM public.qr_tokens WHERE true;
  DELETE FROM public.customers WHERE true;
  DELETE FROM public.business_days WHERE true;
  DELETE FROM public.device_types WHERE true;
  DELETE FROM public.change_log WHERE true;
  DELETE FROM public.processed_commands WHERE true;

  /* ---------- REBUILD PARENTS ---------- */
  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'device_types','[]'::jsonb)) LOOP
    v_id := (v_item->>'id')::uuid;
    INSERT INTO public.device_types(
      id,name,name_ar,name_en,icon,base_price_minor,charger_fee_enabled,is_active,
      sort_order,created_at,updated_at,deleted_at,version,status,charger_fee_applicable
    ) VALUES (
      v_id,
      coalesce(v_item->>'name','Device'),
      coalesce(v_item->>'name_ar',v_item->>'nameAr',v_item->>'name','Device'),
      coalesce(v_item->>'name_en',v_item->>'nameEn',v_item->>'name','Device'),
      coalesce(v_item->>'icon','smartphone'),
      coalesce((v_item->>'base_price_minor')::integer,(v_item->>'basePriceMinor')::integer,0),
      coalesce((v_item->>'charger_fee_enabled')::boolean,(v_item->>'chargerFeeEnabled')::boolean,true),
      coalesce((v_item->>'is_active')::boolean,(v_item->>'isActive')::boolean,true),
      coalesce((v_item->>'sort_order')::integer,(v_item->>'sortOrder')::integer,0),
      coalesce((v_item->>'created_at')::timestamptz,(v_item->>'createdAt')::timestamptz,now()),
      coalesce((v_item->>'updated_at')::timestamptz,(v_item->>'updatedAt')::timestamptz,now()),
      (v_item->>'deleted_at')::timestamptz,
      coalesce((v_item->>'version')::integer,1),
      coalesce(v_item->>'status',case when coalesce((v_item->>'is_active')::boolean,true) then 'ACTIVE' else 'RETIRED' end),
      coalesce((v_item->>'charger_fee_applicable')::boolean,(v_item->>'chargerFeeApplicable')::boolean,
               coalesce((v_item->>'charger_fee_enabled')::boolean,(v_item->>'chargerFeeEnabled')::boolean,true))
    );
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'business_days',p_payload->'businessDays','[]'::jsonb)) LOOP
    v_id := (v_item->>'id')::uuid;
    INSERT INTO public.business_days(
      id,business_date,display_number,status,is_closed,opened_at,closed_at,closed_by,created_at,updated_at,version
    ) VALUES (
      v_id,
      coalesce(v_item->>'business_date',v_item->>'businessDate',v_item->>'date')::date,
      coalesce((v_item->>'display_number')::integer,(v_item->>'displayNumber')::integer,1),
      coalesce(v_item->>'status',case when coalesce((v_item->>'is_closed')::boolean,(v_item->>'isClosed')::boolean,false) then 'CLOSED' else 'OPEN' end),
      coalesce((v_item->>'is_closed')::boolean,(v_item->>'isClosed')::boolean,false),
      coalesce((v_item->>'opened_at')::timestamptz,(v_item->>'openedAt')::timestamptz,now()),
      coalesce((v_item->>'closed_at')::timestamptz,(v_item->>'closedAt')::timestamptz),
      coalesce((v_item->>'closed_by')::uuid,(v_item->>'closedBy')::uuid),
      coalesce((v_item->>'created_at')::timestamptz,(v_item->>'createdAt')::timestamptz,now()),
      coalesce((v_item->>'updated_at')::timestamptz,(v_item->>'updatedAt')::timestamptz,now()),
      coalesce((v_item->>'version')::integer,1)
    );
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'customers','[]'::jsonb)) LOOP
    v_id := (v_item->>'id')::uuid;
    INSERT INTO public.customers(
      id,name,phone,status,is_active,notes,debt_limit_minor,charger_fee_exempt,
      created_at,updated_at,deleted_at,version
    ) VALUES (
      v_id,
      coalesce(v_item->>'name','Customer'),
      v_item->>'phone',
      coalesce(v_item->>'status',case when coalesce((v_item->>'is_active')::boolean,(v_item->>'isActive')::boolean,true) then 'ACTIVE' else 'DELETED' end),
      coalesce((v_item->>'is_active')::boolean,(v_item->>'isActive')::boolean,true),
      v_item->>'notes',
      coalesce((v_item->>'debt_limit_minor')::bigint,(v_item->>'debtLimitMinor')::bigint,0),
      coalesce((v_item->>'charger_fee_exempt')::boolean,(v_item->>'chargerFeeExempt')::boolean,false),
      coalesce((v_item->>'created_at')::timestamptz,(v_item->>'createdAt')::timestamptz,now()),
      coalesce((v_item->>'updated_at')::timestamptz,(v_item->>'updatedAt')::timestamptz,now()),
      (v_item->>'deleted_at')::timestamptz,
      coalesce((v_item->>'version')::integer,1)
    );
  END LOOP;

  /* ---------- QR: preserve durable identity, derive hash from public token ---------- */
  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'qr_tokens',p_payload->'qrTokens','[]'::jsonb)) LOOP
    v_id := (v_item->>'id')::uuid;
    v_target_id := coalesce(v_item->>'target_id',v_item->>'targetId',v_item->>'entityId',v_item->>'entity_id')::uuid;
    IF coalesce(v_item->>'public_token',v_item->>'publicToken',v_item->>'token') IS NULL
       OR trim(coalesce(v_item->>'public_token',v_item->>'publicToken',v_item->>'token')) = '' THEN
      RAISE EXCEPTION 'QR token % is missing public_token', v_id;
    END IF;

    INSERT INTO public.qr_tokens(id,token_hash,public_token,token_type,target_id,is_active,expires_at,created_at)
    VALUES (
      v_id,
      encode(digest(coalesce(v_item->>'public_token',v_item->>'publicToken',v_item->>'token'),'sha256'),'hex'),
      coalesce(v_item->>'public_token',v_item->>'publicToken',v_item->>'token'),
      coalesce(v_item->>'token_type',v_item->>'tokenType',v_item->>'entityType',v_item->>'entity_type','ORDER'),
      v_target_id,
      coalesce((v_item->>'is_active')::boolean,(v_item->>'isActive')::boolean,true),
      coalesce((v_item->>'expires_at')::timestamptz,(v_item->>'expiresAt')::timestamptz),
      coalesce((v_item->>'created_at')::timestamptz,(v_item->>'createdAt')::timestamptz,now())
    );
  END LOOP;

  /* ---------- ORDERS ---------- */
  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'orders','[]'::jsonb)) LOOP
    v_id := (v_item->>'id')::uuid;
    v_customer_id := coalesce(v_item->>'customer_id',v_item->>'customerId')::uuid;
    v_internal_seq := coalesce((v_item->>'internal_sequence')::bigint,(v_item->>'internalSequence')::bigint);
    IF v_internal_seq IS NULL OR v_internal_seq <= 0 THEN
      v_internal_seq := nextval('public.orders_internal_sequence_seq');
    END IF;

    INSERT INTO public.orders(
      id,day_id,customer_id,display_number,internal_sequence,status,customer_balance_snapshot_minor,
      notes,qr_token_id,charging_at,delivered_at,cancelled_at,created_at,updated_at,deleted_at,version
    ) VALUES (
      v_id,
      coalesce(v_item->>'day_id',v_item->>'dayId')::uuid,
      v_customer_id,
      coalesce((v_item->>'display_number')::integer,(v_item->>'displayNumber')::integer,1),
      v_internal_seq,
      coalesce(v_item->>'status','pending'),
      coalesce((v_item->>'customer_balance_snapshot_minor')::bigint,(v_item->>'customerBalanceSnapshotMinor')::bigint,0),
      v_item->>'notes',
      coalesce((v_item->>'qr_token_id')::uuid,(v_item->>'qrTokenId')::uuid),
      coalesce((v_item->>'charging_at')::timestamptz,(v_item->>'chargingAt')::timestamptz),
      coalesce((v_item->>'delivered_at')::timestamptz,(v_item->>'deliveredAt')::timestamptz),
      coalesce((v_item->>'cancelled_at')::timestamptz,(v_item->>'cancelledAt')::timestamptz),
      coalesce((v_item->>'created_at')::timestamptz,(v_item->>'createdAt')::timestamptz,now()),
      coalesce((v_item->>'updated_at')::timestamptz,(v_item->>'updatedAt')::timestamptz,now()),
      (v_item->>'deleted_at')::timestamptz,
      coalesce((v_item->>'version')::integer,1)
    );
  END LOOP;

  /* ---------- ORDER ITEMS ---------- */
  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'order_items',p_payload->'orderItems','[]'::jsonb)) LOOP
    v_id := (v_item->>'id')::uuid;
    v_order_id := coalesce(v_item->>'order_id',v_item->>'orderId')::uuid;
    v_device_type_id := coalesce(v_item->>'device_type_id',v_item->>'deviceTypeId')::uuid;

    INSERT INTO public.order_items(
      id,order_id,device_type_id,item_sequence,operational_status,financial_status,payment_status,status,
      device_name_snapshot,device_icon_snapshot,base_price_snapshot_minor,charger_fee_enabled_snapshot,
      customer_charger_fee_exempt_snapshot,charger_fee_snapshot_minor,discount_snapshot_minor,
      final_charge_snapshot_minor,has_charger,unit_price_minor,total_price_minor,
      replacement_of_item_id,delivered_at,financially_recognized_at,cancelled_at,deleted_at,created_at,updated_at,version
    ) VALUES (
      v_id,v_order_id,v_device_type_id,
      coalesce((v_item->>'item_sequence')::integer,(v_item->>'itemSequence')::integer,1),
      upper(coalesce(v_item->>'operational_status',v_item->>'operationalStatus',
        case lower(coalesce(v_item->>'status','charging')) when 'delivered' then 'DELIVERED' when 'cancelled' then 'CANCELLED' else 'CHARGING' end)),
      upper(coalesce(v_item->>'financial_status',v_item->>'financialStatus',
        case lower(coalesce(v_item->>'status','charging')) when 'delivered' then 'RECOGNIZED' else 'UNRECOGNIZED' end)),
      upper(coalesce(v_item->>'payment_status',v_item->>'paymentStatus','UNPAID')),
      lower(coalesce(v_item->>'status','charging')),
      coalesce(v_item->>'device_name_snapshot',v_item->>'deviceNameSnapshot',''),
      coalesce(v_item->>'device_icon_snapshot',v_item->>'deviceIconSnapshot','smartphone'),
      coalesce((v_item->>'base_price_snapshot_minor')::bigint,(v_item->>'basePriceSnapshotMinor')::bigint,0),
      coalesce((v_item->>'charger_fee_enabled_snapshot')::boolean,(v_item->>'chargerFeeEnabledSnapshot')::boolean,true),
      coalesce((v_item->>'customer_charger_fee_exempt_snapshot')::boolean,(v_item->>'customerChargerFeeExemptSnapshot')::boolean,false),
      coalesce((v_item->>'charger_fee_snapshot_minor')::bigint,(v_item->>'chargerFeeSnapshotMinor')::bigint,0),
      coalesce((v_item->>'discount_snapshot_minor')::bigint,(v_item->>'discountSnapshotMinor')::bigint,0),
      coalesce((v_item->>'final_charge_snapshot_minor')::bigint,(v_item->>'finalChargeSnapshotMinor')::bigint,
               (v_item->>'total_price_minor')::bigint,(v_item->>'totalPriceMinor')::bigint,0),
      coalesce((v_item->>'has_charger')::boolean,(v_item->>'hasCharger')::boolean,false),
      coalesce((v_item->>'unit_price_minor')::bigint,(v_item->>'unitPriceMinor')::bigint,0),
      coalesce((v_item->>'total_price_minor')::bigint,(v_item->>'totalPriceMinor')::bigint,0),
      coalesce((v_item->>'replacement_of_item_id')::uuid,(v_item->>'replacementOfItemId')::uuid),
      coalesce((v_item->>'delivered_at')::timestamptz,(v_item->>'deliveredAt')::timestamptz),
      coalesce((v_item->>'financially_recognized_at')::timestamptz,(v_item->>'financiallyRecognizedAt')::timestamptz),
      coalesce((v_item->>'cancelled_at')::timestamptz,(v_item->>'cancelledAt')::timestamptz),
      (v_item->>'deleted_at')::timestamptz,
      coalesce((v_item->>'created_at')::timestamptz,(v_item->>'createdAt')::timestamptz,now()),
      coalesce((v_item->>'updated_at')::timestamptz,(v_item->>'updatedAt')::timestamptz,now()),
      coalesce((v_item->>'version')::integer,1)
    );
  END LOOP;

  /* ---------- PAYMENTS ---------- */
  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'payments','[]'::jsonb)) LOOP
    v_id := (v_item->>'id')::uuid;
    v_customer_id := coalesce(v_item->>'customer_id',v_item->>'customerId')::uuid;
    v_actor_admin_id := CASE
      WHEN coalesce(v_item->>'actor_admin_id',v_item->>'actorAdminId') ~* '^[0-9a-f-]{36}$'
      THEN coalesce(v_item->>'actor_admin_id',v_item->>'actorAdminId')::uuid ELSE v_admin_id END;
    v_command_id := CASE
      WHEN coalesce(v_item->>'command_id',v_item->>'commandId') ~* '^[0-9a-f-]{36}$'
      THEN coalesce(v_item->>'command_id',v_item->>'commandId')::uuid ELSE v_id END;

    INSERT INTO public.payments(id,customer_id,amount_minor,payment_method,reference,actor_admin_id,command_id,created_at)
    VALUES (
      v_id,v_customer_id,
      coalesce((v_item->>'amount_minor')::bigint,(v_item->>'amountMinor')::bigint,0),
      coalesce(v_item->>'payment_method',v_item->>'paymentMethod','CASH'),
      v_item->>'reference',
      v_actor_admin_id,v_command_id,
      coalesce((v_item->>'created_at')::timestamptz,(v_item->>'createdAt')::timestamptz,now())
    );
  END LOOP;

  /* ---------- LEDGER ---------- */
  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'financial_ledger',p_payload->'financialLedger','[]'::jsonb)) LOOP
    v_id := (v_item->>'id')::uuid;
    v_customer_id := coalesce(v_item->>'customer_id',v_item->>'customerId')::uuid;
    v_seq := coalesce((v_item->>'sequence_number')::bigint,(v_item->>'sequenceNumber')::bigint);
    IF v_seq IS NULL OR v_seq <= 0 THEN
      v_seq := nextval('public.financial_ledger_sequence_number_seq');
    END IF;

    INSERT INTO public.financial_ledger(
      id,sequence_number,event_type,amount_minor,order_id,order_item_id,customer_id,actor_admin_id,
      reference_id,linked_ledger_id,metadata,created_at
    ) VALUES (
      v_id,v_seq,
      coalesce(v_item->>'event_type',v_item->>'eventType','ORDER_ITEM_CHARGE'),
      coalesce((v_item->>'amount_minor')::bigint,(v_item->>'amountMinor')::bigint,0),
      coalesce((v_item->>'order_id')::uuid,(v_item->>'orderId')::uuid),
      coalesce((v_item->>'order_item_id')::uuid,(v_item->>'orderItemId')::uuid),
      v_customer_id,
      CASE WHEN coalesce(v_item->>'actor_admin_id',v_item->>'actorAdminId') ~* '^[0-9a-f-]{36}$' THEN coalesce(v_item->>'actor_admin_id',v_item->>'actorAdminId')::uuid ELSE v_admin_id END,
      coalesce((v_item->>'reference_id')::uuid,(v_item->>'referenceId')::uuid),
      NULL,
      coalesce(v_item->'metadata','{}'::jsonb),
      coalesce((v_item->>'created_at')::timestamptz,(v_item->>'createdAt')::timestamptz,now())
    );
  END LOOP;

  /* Second pass for self-references. */
  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'financial_ledger',p_payload->'financialLedger','[]'::jsonb)) LOOP
    IF coalesce(v_item->>'linked_ledger_id',v_item->>'linkedLedgerId') IS NOT NULL THEN
      UPDATE public.financial_ledger
      SET linked_ledger_id = coalesce(v_item->>'linked_ledger_id',v_item->>'linkedLedgerId')::uuid
      WHERE id = (v_item->>'id')::uuid;
    END IF;
  END LOOP;

  /* ---------- ALLOCATIONS ---------- */
  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'payment_allocations',p_payload->'paymentAllocations','[]'::jsonb)) LOOP
    v_id := (v_item->>'id')::uuid;
    v_payment_id := coalesce(v_item->>'payment_id',v_item->>'paymentId')::uuid;
    v_order_id := CASE WHEN coalesce(v_item->>'order_id',v_item->>'orderId') ~* '^[0-9a-f-]{36}$' THEN coalesce(v_item->>'order_id',v_item->>'orderId')::uuid ELSE NULL END;
    v_order_item_id := CASE WHEN coalesce(v_item->>'order_item_id',v_item->>'orderItemId') ~* '^[0-9a-f-]{36}$' THEN coalesce(v_item->>'order_item_id',v_item->>'orderItemId')::uuid ELSE NULL END;
    v_alloc_amount := coalesce((v_item->>'allocated_amount_minor')::bigint,(v_item->>'allocatedAmountMinor')::bigint,0);

    IF NOT EXISTS (SELECT 1 FROM public.payments WHERE id=v_payment_id) THEN RAISE EXCEPTION 'Allocation references missing payment %',v_payment_id; END IF;
    IF v_order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.orders WHERE id=v_order_id) THEN RAISE EXCEPTION 'Allocation references missing order %',v_order_id; END IF;
    IF v_order_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.order_items WHERE id=v_order_item_id) THEN RAISE EXCEPTION 'Allocation references missing order item %',v_order_item_id; END IF;

    INSERT INTO public.payment_allocations(id,payment_id,order_item_id,order_id,allocated_amount_minor,created_at)
    VALUES(v_id,v_payment_id,v_order_item_id,v_order_id,v_alloc_amount,
      coalesce((v_item->>'created_at')::timestamptz,(v_item->>'createdAt')::timestamptz,now()));
  END LOOP;

  /* ---------- ORDER ITEM SELF-REFERENCE SECOND PASS ---------- */
  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'order_items',p_payload->'orderItems','[]'::jsonb)) LOOP
    IF coalesce(v_item->>'replacement_of_item_id',v_item->>'replacementOfItemId') IS NOT NULL THEN
      UPDATE public.order_items
      SET replacement_of_item_id=coalesce(v_item->>'replacement_of_item_id',v_item->>'replacementOfItemId')::uuid
      WHERE id=(v_item->>'id')::uuid;
    END IF;
  END LOOP;

  /* ---------- POST-REBUILD INVARIANTS ---------- */
  IF EXISTS (
    SELECT 1
    FROM public.payment_allocations pa
    GROUP BY pa.payment_id
    HAVING sum(pa.allocated_amount_minor) >
           (SELECT p.amount_minor FROM public.payments p WHERE p.id=pa.payment_id)
  ) THEN
    RAISE EXCEPTION 'Replacement rejected: payment allocations exceed payment amount';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.qr_tokens q
    WHERE q.token_hash <> encode(digest(q.public_token,'sha256'),'hex')
  ) THEN
    RAISE EXCEPTION 'Replacement rejected: QR token hash invariant failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.order_items oi
    LEFT JOIN public.orders o ON o.id=oi.order_id
    LEFT JOIN public.device_types dt ON dt.id=oi.device_type_id
    WHERE o.id IS NULL OR dt.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Replacement rejected: orphan order item detected';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.orders o
    LEFT JOIN public.customers c ON c.id=o.customer_id
    LEFT JOIN public.business_days d ON d.id=o.day_id
    WHERE c.id IS NULL OR d.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Replacement rejected: orphan order detected';
  END IF;

  /* Re-enable capture before successful commit. Any exception before this point
     aborts the whole transaction, so DELETE/INSERT changes and trigger state roll back. */
  ALTER TABLE public.business_days ENABLE TRIGGER trg_change_capture;
  ALTER TABLE public.customers ENABLE TRIGGER trg_change_capture;
  ALTER TABLE public.device_types ENABLE TRIGGER trg_change_capture;
  ALTER TABLE public.orders ENABLE TRIGGER trg_change_capture;
  ALTER TABLE public.order_items ENABLE TRIGGER trg_change_capture;
  ALTER TABLE public.payments ENABLE TRIGGER trg_change_capture;
  ALTER TABLE public.payment_allocations ENABLE TRIGGER trg_change_capture;
  ALTER TABLE public.financial_ledger ENABLE TRIGGER trg_change_capture;
  ALTER TABLE public.qr_tokens ENABLE TRIGGER trg_change_capture;

  v_counts := jsonb_build_object(
    'device_types',(select count(*) from public.device_types),
    'business_days',(select count(*) from public.business_days),
    'customers',(select count(*) from public.customers),
    'qr_tokens',(select count(*) from public.qr_tokens),
    'orders',(select count(*) from public.orders),
    'order_items',(select count(*) from public.order_items),
    'payments',(select count(*) from public.payments),
    'financial_ledger',(select count(*) from public.financial_ledger),
    'payment_allocations',(select count(*) from public.payment_allocations)
  );

  RETURN jsonb_build_object(
    'success',true,
    'operation','REPLACE_ONLINE_BUSINESS_DATA',
    'replacementId',v_replacement_id,
    'completedAt',v_completed_at,
    'serverResetGeneration',v_new_generation,
    'counts',v_counts
  );
END;
$function$
\n\nREVOKE EXECUTE ON FUNCTION public.replace_online_business_data(text,jsonb) FROM public, anon;\nGRANT EXECUTE ON FUNCTION public.replace_online_business_data(text,jsonb) TO authenticated;\n