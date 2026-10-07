-- Canonical Local -> Online replacement contract.
-- Fixes legacy enum casts, preserves the current VARCHAR status model,
-- validates the complete FK graph before purge, and keeps replacement atomic.

CREATE OR REPLACE FUNCTION public.replace_online_business_data(
  p_entered_bin TEXT,
  p_payload JSONB
) RETURNS JSONB
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
DECLARE
  v_admin_id UUID;
  v_admin_role VARCHAR(50);
  v_is_active BOOLEAN;
  v_item JSONB;
  v_id TEXT;
  v_ref TEXT;
  v_payment TEXT;
  v_order TEXT;
  v_order_item TEXT;
  v_actor UUID;
  v_cmd UUID;
  v_sequence BIGINT;
  v_generation BIGINT;
  v_replacement UUID := gen_random_uuid();
  v_done TIMESTAMPTZ := NOW();
  v_n BIGINT;
  v_max_seq BIGINT;
  c_device INT := 0;
  c_days INT := 0;
  c_customers INT := 0;
  c_qr INT := 0;
  c_orders INT := 0;
  c_items INT := 0;
  c_payments INT := 0;
  c_ledger INT := 0;
  c_alloc INT := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_entered_bin IS NULL OR p_entered_bin !~ '^\d{4,}$' THEN
    RAISE EXCEPTION 'Invalid BIN: at least 4 numeric digits are required';
  END IF;

  SELECT id, role, is_active INTO v_admin_id, v_admin_role, v_is_active
  FROM public.admins WHERE auth_user_id = auth.uid() LIMIT 1;
  IF v_admin_id IS NULL THEN RAISE EXCEPTION 'Unauthorized: admin profile not found'; END IF;
  IF v_is_active IS NOT TRUE THEN RAISE EXCEPTION 'Forbidden: admin account is inactive'; END IF;
  IF v_admin_role NOT IN ('SUPER_ADMIN','Super Admin')
     AND NOT EXISTS (
       SELECT 1 FROM public.get_effective_permissions(v_admin_id)
       WHERE permission IN ('settings:manage','admin:manage','SUPER_ADMIN')
     ) THEN
    RAISE EXCEPTION 'Forbidden: settings:manage permission is required';
  END IF;
  IF public.verify_admin_bin(p_entered_bin) IS NOT TRUE THEN
    RAISE EXCEPTION 'Invalid BIN: Security verification failed';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('online_business_reset_lock'));
  PERFORM public._cp_guard_nonempty_replacement_payload(p_payload);

  -- Collection type and duplicate-ID preflight.
  FOREACH v_id IN ARRAY ARRAY[
    'device_types','business_days','customers','qr_tokens','orders',
    'order_items','payments','financial_ledger','payment_allocations'
  ] LOOP
    IF jsonb_typeof(COALESCE(p_payload->v_id,'[]'::jsonb)) <> 'array' THEN
      RAISE EXCEPTION 'Invalid replacement payload: % must be an array', v_id;
    END IF;
    SELECT q.id INTO v_ref
    FROM (
      SELECT value->>'id' id, COUNT(*) n
      FROM jsonb_array_elements(COALESCE(p_payload->v_id,'[]'::jsonb))
      GROUP BY value->>'id' HAVING COUNT(*) > 1 LIMIT 1
    ) q;
    IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'Duplicate ID % in %',v_ref,v_id; END IF;
  END LOOP;

  -- Parents.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'device_types','[]')) LOOP
    v_id:=v_item->>'id';
    IF v_id !~* '^[0-9a-f-]{36}$' OR NULLIF(trim(v_item->>'name'),'') IS NULL THEN
      RAISE EXCEPTION 'Invalid device type %',v_id;
    END IF;
  END LOOP;
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'business_days','[]')) LOOP
    v_id:=v_item->>'id'; v_ref:=COALESCE(v_item->>'business_date',v_item->>'businessDate',v_item->>'date');
    IF v_id !~* '^[0-9a-f-]{36}$' OR NULLIF(trim(v_ref),'') IS NULL THEN RAISE EXCEPTION 'Invalid business day %',v_id; END IF;
  END LOOP;
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'customers','[]')) LOOP
    v_id:=v_item->>'id';
    IF v_id !~* '^[0-9a-f-]{36}$' OR NULLIF(trim(v_item->>'name'),'') IS NULL THEN RAISE EXCEPTION 'Invalid customer %',v_id; END IF;
    IF COALESCE((v_item->>'debt_limit_minor')::BIGINT,(v_item->>'debtLimitMinor')::BIGINT,0)<0 THEN RAISE EXCEPTION 'Invalid debt limit for customer %',v_id; END IF;
  END LOOP;

  -- Orders -> days/customers.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'orders','[]')) LOOP
    v_id:=v_item->>'id'; v_ref:=COALESCE(v_item->>'day_id',v_item->>'dayId');
    IF v_id !~* '^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'Invalid order %',v_id; END IF;
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_payload->'business_days','[]')) x WHERE x->>'id'=v_ref) THEN RAISE EXCEPTION 'Order % references missing day %',v_id,v_ref; END IF;
    v_ref:=COALESCE(v_item->>'customer_id',v_item->>'customerId');
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_payload->'customers','[]')) x WHERE x->>'id'=v_ref) THEN RAISE EXCEPTION 'Order % references missing customer %',v_id,v_ref; END IF;
    IF COALESCE(v_item->>'status','pending') NOT IN ('pending','charging','delivered','cancelled') THEN RAISE EXCEPTION 'Unsupported order status for %',v_id; END IF;
  END LOOP;

  -- Items -> orders/device types.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'order_items',p_payload->'orderItems','[]')) LOOP
    v_id:=v_item->>'id'; v_ref:=COALESCE(v_item->>'order_id',v_item->>'orderId');
    IF v_id !~* '^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'Invalid order item %',v_id; END IF;
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_payload->'orders','[]')) x WHERE x->>'id'=v_ref) THEN RAISE EXCEPTION 'Item % references missing order %',v_id,v_ref; END IF;
    v_ref:=COALESCE(v_item->>'device_type_id',v_item->>'deviceTypeId');
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_payload->'device_types','[]')) x WHERE x->>'id'=v_ref) THEN RAISE EXCEPTION 'Item % references missing device type %',v_id,v_ref; END IF;
    IF COALESCE(v_item->>'status','charging') NOT IN ('charging','delivered','cancelled') THEN RAISE EXCEPTION 'Unsupported item status for %',v_id; END IF;
    IF COALESCE(v_item->>'operational_status',v_item->>'operationalStatus','CHARGING') NOT IN ('CHARGING','DELIVERED','CANCELLED') THEN RAISE EXCEPTION 'Unsupported operational status for %',v_id; END IF;
    IF COALESCE(v_item->>'financial_status',v_item->>'financialStatus','UNRECOGNIZED') NOT IN ('UNRECOGNIZED','RECOGNIZED','REVERSED') THEN RAISE EXCEPTION 'Unsupported financial status for %',v_id; END IF;
    IF COALESCE(v_item->>'payment_status',v_item->>'paymentStatus','UNPAID') NOT IN ('UNPAID','PARTIALLY_PAID','PAID') THEN RAISE EXCEPTION 'Unsupported payment status for %',v_id; END IF;
  END LOOP;

  -- Payments.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'payments','[]')) LOOP
    v_id:=v_item->>'id'; v_ref:=COALESCE(v_item->>'customer_id',v_item->>'customerId');
    IF v_id !~* '^[0-9a-f-]{36}$' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_payload->'customers','[]')) x WHERE x->>'id'=v_ref) THEN RAISE EXCEPTION 'Invalid payment/customer reference %',v_id; END IF;
    IF COALESCE((v_item->>'amount_minor')::BIGINT,(v_item->>'amountMinor')::BIGINT,0)<=0 THEN RAISE EXCEPTION 'Invalid payment amount %',v_id; END IF;
  END LOOP;

  -- Ledger references.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'financial_ledger',p_payload->'financialLedger','[]')) LOOP
    v_id:=v_item->>'id'; v_ref:=COALESCE(v_item->>'customer_id',v_item->>'customerId');
    IF v_id !~* '^[0-9a-f-]{36}$' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_payload->'customers','[]')) x WHERE x->>'id'=v_ref) THEN RAISE EXCEPTION 'Invalid ledger/customer reference %',v_id; END IF;
    v_ref:=COALESCE(v_item->>'order_id',v_item->>'orderId');
    IF v_ref IS NOT NULL AND v_ref<>'' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_payload->'orders','[]')) x WHERE x->>'id'=v_ref) THEN RAISE EXCEPTION 'Ledger % references missing order',v_id; END IF;
    v_ref:=COALESCE(v_item->>'order_item_id',v_item->>'orderItemId');
    IF v_ref IS NOT NULL AND v_ref<>'' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_payload->'order_items',p_payload->'orderItems','[]')) x WHERE x->>'id'=v_ref) THEN RAISE EXCEPTION 'Ledger % references missing item',v_id; END IF;
  END LOOP;

  -- Allocations. Missing order_item_id is accepted only for a single-item order.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'payment_allocations',p_payload->'paymentAllocations','[]')) LOOP
    v_id:=v_item->>'id'; v_payment:=COALESCE(v_item->>'payment_id',v_item->>'paymentId'); v_order:=COALESCE(v_item->>'order_id',v_item->>'orderId'); v_order_item:=COALESCE(v_item->>'order_item_id',v_item->>'orderItemId');
    IF v_id !~* '^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'Invalid allocation %',v_id; END IF;
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_payload->'payments','[]')) x WHERE x->>'id'=v_payment) THEN RAISE EXCEPTION 'Allocation % references missing payment',v_id; END IF;
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_payload->'orders','[]')) x WHERE x->>'id'=v_order) THEN RAISE EXCEPTION 'Allocation % references missing order',v_id; END IF;
    IF v_order_item IS NULL OR v_order_item='' THEN
      SELECT COUNT(*) INTO v_n FROM jsonb_array_elements(COALESCE(p_payload->'order_items',p_payload->'orderItems','[]')) x WHERE COALESCE(x->>'order_id',x->>'orderId')=v_order;
      IF v_n<>1 THEN RAISE EXCEPTION 'Allocation % cannot safely infer order_item_id',v_id; END IF;
    ELSE
      IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_payload->'order_items',p_payload->'orderItems','[]')) x WHERE x->>'id'=v_order_item AND COALESCE(x->>'order_id',x->>'orderId')=v_order) THEN RAISE EXCEPTION 'Allocation % has invalid order item',v_id; END IF;
    END IF;
    IF COALESCE((v_item->>'allocated_amount_minor')::BIGINT,(v_item->>'allocatedAmountMinor')::BIGINT,0)<=0 THEN RAISE EXCEPTION 'Invalid allocation amount %',v_id; END IF;
  END LOOP;

  -- QR preflight. The public token is preserved; its canonical hash is rebuilt.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'qr_tokens',p_payload->'qrTokens','[]')) LOOP
    v_id:=v_item->>'id'; v_ref:=COALESCE(v_item->>'target_id',v_item->>'targetId',v_item->>'entityId',v_item->>'entity_id');
    IF v_id IS NULL OR (v_id !~* '^[0-9a-f-]{36}$' AND v_id !~* '^[0-9a-f-]{36}:qr$') THEN RAISE EXCEPTION 'Invalid QR token id %',v_id; END IF;
    IF NULLIF(trim(COALESCE(v_item->>'public_token',v_item->>'publicToken',v_item->>'token')),'') IS NULL OR v_ref !~* '^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'Invalid QR token %',v_id; END IF;
  END LOOP;

  -- Advance the reset generation so stale pre-replacement outbox commands are rejected.
  UPDATE public.system_settings SET value_number=COALESCE(value_number,1)+1,updated_at=NOW()
  WHERE key='server_reset_generation' RETURNING value_number INTO v_generation;
  IF v_generation IS NULL THEN
    INSERT INTO public.system_settings(key,value_type,value_number,description)
    VALUES('server_reset_generation','number',2,'Server reset generation/incarnation counter')
    ON CONFLICT(key) DO UPDATE SET value_number=public.system_settings.value_number+1,updated_at=NOW()
    RETURNING value_number INTO v_generation;
  END IF;

  -- Transactional purge. FK triggers remain active; only user/audit triggers are disabled.
  ALTER TABLE public.customers DISABLE TRIGGER USER;
  ALTER TABLE public.orders DISABLE TRIGGER USER;
  ALTER TABLE public.order_items DISABLE TRIGGER USER;
  ALTER TABLE public.business_days DISABLE TRIGGER USER;
  ALTER TABLE public.device_types DISABLE TRIGGER USER;
  ALTER TABLE public.financial_ledger DISABLE TRIGGER USER;

  DELETE FROM public.payment_allocations;
  DELETE FROM public.financial_ledger;
  DELETE FROM public.payments;
  DELETE FROM public.order_items;
  DELETE FROM public.orders;
  DELETE FROM public.qr_tokens;
  DELETE FROM public.customers;
  DELETE FROM public.business_days;
  DELETE FROM public.device_types;
  DELETE FROM public.change_log;
  DELETE FROM public.processed_commands;

  -- Device types.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'device_types','[]')) LOOP
    INSERT INTO public.device_types(id,name,name_ar,name_en,icon,base_price_minor,charger_fee_enabled,charger_fee_applicable,is_active,status,sort_order,created_at,updated_at,deleted_at,version)
    VALUES((v_item->>'id')::UUID,COALESCE(v_item->>'name','Device'),COALESCE(v_item->>'name_ar',v_item->>'nameAr',v_item->>'name','Device'),COALESCE(v_item->>'name_en',v_item->>'nameEn',v_item->>'name','Device'),COALESCE(v_item->>'icon','smartphone'),COALESCE((v_item->>'base_price_minor')::BIGINT,(v_item->>'basePriceMinor')::BIGINT,0),COALESCE((v_item->>'charger_fee_enabled')::BOOLEAN,(v_item->>'chargerFeeEnabled')::BOOLEAN,TRUE),COALESCE((v_item->>'charger_fee_applicable')::BOOLEAN,(v_item->>'chargerFeeApplicable')::BOOLEAN,TRUE),COALESCE((v_item->>'is_active')::BOOLEAN,(v_item->>'isActive')::BOOLEAN,TRUE),COALESCE(v_item->>'status','ACTIVE'),COALESCE((v_item->>'sort_order')::INTEGER,(v_item->>'sortOrder')::INTEGER,0),COALESCE((v_item->>'created_at')::TIMESTAMPTZ,(v_item->>'createdAt')::TIMESTAMPTZ,NOW()),COALESCE((v_item->>'updated_at')::TIMESTAMPTZ,(v_item->>'updatedAt')::TIMESTAMPTZ,NOW()),NULLIF(COALESCE(v_item->>'deleted_at',v_item->>'deletedAt'),'')::TIMESTAMPTZ,COALESCE((v_item->>'version')::INTEGER,1));
    c_device:=c_device+1;
  END LOOP;

  -- Business days.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'business_days','[]')) LOOP
    INSERT INTO public.business_days(id,business_date,display_number,status,is_closed,opened_at,closed_at,closed_by,created_at,updated_at,version)
    VALUES((v_item->>'id')::UUID,(COALESCE(v_item->>'business_date',v_item->>'businessDate',v_item->>'date'))::DATE,COALESCE((v_item->>'display_number')::INTEGER,(v_item->>'displayNumber')::INTEGER,1),COALESCE(v_item->>'status',CASE WHEN COALESCE((v_item->>'is_closed')::BOOLEAN,(v_item->>'isClosed')::BOOLEAN,FALSE) THEN 'CLOSED' ELSE 'OPEN' END),COALESCE((v_item->>'is_closed')::BOOLEAN,(v_item->>'isClosed')::BOOLEAN,FALSE),NULLIF(COALESCE(v_item->>'opened_at',v_item->>'openedAt'),'')::TIMESTAMPTZ,NULLIF(COALESCE(v_item->>'closed_at',v_item->>'closedAt'),'')::TIMESTAMPTZ,NULLIF(COALESCE(v_item->>'closed_by',v_item->>'closedBy'),'')::UUID,COALESCE((v_item->>'created_at')::TIMESTAMPTZ,(v_item->>'createdAt')::TIMESTAMPTZ,NOW()),COALESCE((v_item->>'updated_at')::TIMESTAMPTZ,(v_item->>'updatedAt')::TIMESTAMPTZ,NOW()),COALESCE((v_item->>'version')::INTEGER,1));
    c_days:=c_days+1;
  END LOOP;

  -- Customers.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'customers','[]')) LOOP
    INSERT INTO public.customers(id,name,phone,status,is_active,notes,debt_limit_minor,charger_fee_exempt,created_at,updated_at,deleted_at,version)
    VALUES((v_item->>'id')::UUID,COALESCE(v_item->>'name','Customer'),NULLIF(COALESCE(v_item->>'phone',v_item->>'phone_number',v_item->>'phoneNumber'),'') ,COALESCE(v_item->>'status',CASE WHEN COALESCE((v_item->>'is_active')::BOOLEAN,(v_item->>'isActive')::BOOLEAN,TRUE) THEN 'ACTIVE' ELSE 'DELETED' END),COALESCE((v_item->>'is_active')::BOOLEAN,(v_item->>'isActive')::BOOLEAN,TRUE),COALESCE(v_item->>'notes',''),COALESCE((v_item->>'debt_limit_minor')::BIGINT,(v_item->>'debtLimitMinor')::BIGINT,0),COALESCE((v_item->>'charger_fee_exempt')::BOOLEAN,(v_item->>'chargerFeeExempt')::BOOLEAN,FALSE),COALESCE((v_item->>'created_at')::TIMESTAMPTZ,(v_item->>'createdAt')::TIMESTAMPTZ,NOW()),COALESCE((v_item->>'updated_at')::TIMESTAMPTZ,(v_item->>'updatedAt')::TIMESTAMPTZ,NOW()),NULLIF(COALESCE(v_item->>'deleted_at',v_item->>'deletedAt'),'')::TIMESTAMPTZ,COALESCE((v_item->>'version')::INTEGER,1));
    c_customers:=c_customers+1;
  END LOOP;

  -- QR tokens: stable public_token, canonical SHA-256 hash. Legacy :qr IDs get a fresh UUID.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'qr_tokens',p_payload->'qrTokens','[]')) LOOP
    v_id:=v_item->>'id';
    IF v_id ~* ':qr$' THEN v_id:=gen_random_uuid()::TEXT; END IF;
    v_ref:=COALESCE(v_item->>'public_token',v_item->>'publicToken',v_item->>'token');
    INSERT INTO public.qr_tokens(id,token_hash,public_token,token_type,target_id,is_active,expires_at,created_at)
    VALUES(v_id::UUID,encode(digest(v_ref,'sha256'),'hex'),v_ref,COALESCE(v_item->>'token_type',v_item->>'tokenType',v_item->>'entityType','ORDER')::qr_token_type,(COALESCE(v_item->>'target_id',v_item->>'targetId',v_item->>'entityId',v_item->>'entity_id'))::UUID,COALESCE((v_item->>'is_active')::BOOLEAN,(v_item->>'isActive')::BOOLEAN,TRUE),NULLIF(COALESCE(v_item->>'expires_at',v_item->>'expiresAt'),'')::TIMESTAMPTZ,COALESCE((v_item->>'created_at')::TIMESTAMPTZ,(v_item->>'createdAt')::TIMESTAMPTZ,NOW()));
    c_qr:=c_qr+1;
  END LOOP;

  -- Orders. Status is intentionally plain VARCHAR, not a legacy enum.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'orders','[]')) LOOP
    INSERT INTO public.orders(id,day_id,customer_id,display_number,status,notes,qr_token_id,charging_at,delivered_at,cancelled_at,created_at,updated_at,deleted_at,version)
    VALUES((v_item->>'id')::UUID,(COALESCE(v_item->>'day_id',v_item->>'dayId'))::UUID,(COALESCE(v_item->>'customer_id',v_item->>'customerId'))::UUID,COALESCE((v_item->>'display_number')::INTEGER,(v_item->>'displayNumber')::INTEGER,1),COALESCE(v_item->>'status','pending'),COALESCE(v_item->>'notes',''),NULLIF(COALESCE(v_item->>'qr_token_id',v_item->>'qrTokenId'),'')::UUID,NULLIF(COALESCE(v_item->>'charging_at',v_item->>'chargingAt'),'')::TIMESTAMPTZ,NULLIF(COALESCE(v_item->>'delivered_at',v_item->>'deliveredAt'),'')::TIMESTAMPTZ,NULLIF(COALESCE(v_item->>'cancelled_at',v_item->>'cancelledAt'),'')::TIMESTAMPTZ,COALESCE((v_item->>'created_at')::TIMESTAMPTZ,(v_item->>'createdAt')::TIMESTAMPTZ,NOW()),COALESCE((v_item->>'updated_at')::TIMESTAMPTZ,(v_item->>'updatedAt')::TIMESTAMPTZ,NOW()),NULLIF(COALESCE(v_item->>'deleted_at',v_item->>'deletedAt'),'')::TIMESTAMPTZ,COALESCE((v_item->>'version')::INTEGER,1));
    c_orders:=c_orders+1;
  END LOOP;

  -- Items: restore the self-reference in a second pass.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'order_items',p_payload->'orderItems','[]')) LOOP
    INSERT INTO public.order_items(id,order_id,device_type_id,item_sequence,operational_status,financial_status,payment_status,status,device_name_snapshot,device_icon_snapshot,base_price_snapshot_minor,charger_fee_snapshot_minor,discount_snapshot_minor,final_charge_snapshot_minor,unit_price_minor,total_price_minor,has_charger,charger_fee_enabled_snapshot,customer_charger_fee_exempt_snapshot,delivered_at,financially_recognized_at,cancelled_at,replacement_of_item_id,notes,created_at,updated_at,deleted_at,version)
    VALUES((v_item->>'id')::UUID,(COALESCE(v_item->>'order_id',v_item->>'orderId'))::UUID,(COALESCE(v_item->>'device_type_id',v_item->>'deviceTypeId'))::UUID,COALESCE((v_item->>'item_sequence')::INTEGER,(v_item->>'itemSequence')::INTEGER,1),COALESCE(v_item->>'operational_status',v_item->>'operationalStatus','CHARGING'),COALESCE(v_item->>'financial_status',v_item->>'financialStatus','UNRECOGNIZED'),COALESCE(v_item->>'payment_status',v_item->>'paymentStatus','UNPAID'),COALESCE(v_item->>'status','charging'),COALESCE(v_item->>'device_name_snapshot',v_item->>'deviceNameSnapshot',''),COALESCE(v_item->>'device_icon_snapshot',v_item->>'deviceIconSnapshot','smartphone'),COALESCE((v_item->>'base_price_snapshot_minor')::BIGINT,(v_item->>'basePriceSnapshotMinor')::BIGINT,0),COALESCE((v_item->>'charger_fee_snapshot_minor')::BIGINT,(v_item->>'chargerFeeSnapshotMinor')::BIGINT,0),COALESCE((v_item->>'discount_snapshot_minor')::BIGINT,(v_item->>'discountSnapshotMinor')::BIGINT,0),COALESCE((v_item->>'final_charge_snapshot_minor')::BIGINT,(v_item->>'finalChargeSnapshotMinor')::BIGINT,COALESCE((v_item->>'total_price_minor')::BIGINT,(v_item->>'totalPriceMinor')::BIGINT,0)),COALESCE((v_item->>'unit_price_minor')::BIGINT,(v_item->>'unitPriceMinor')::BIGINT,0),COALESCE((v_item->>'total_price_minor')::BIGINT,(v_item->>'totalPriceMinor')::BIGINT,0),COALESCE((v_item->>'has_charger')::BOOLEAN,(v_item->>'hasCharger')::BOOLEAN,FALSE),COALESCE((v_item->>'charger_fee_enabled_snapshot')::BOOLEAN,(v_item->>'chargerFeeEnabledSnapshot')::BOOLEAN,TRUE),COALESCE((v_item->>'customer_charger_fee_exempt_snapshot')::BOOLEAN,(v_item->>'customerChargerFeeExemptSnapshot')::BOOLEAN,FALSE),NULLIF(COALESCE(v_item->>'delivered_at',v_item->>'deliveredAt'),'')::TIMESTAMPTZ,NULLIF(COALESCE(v_item->>'financially_recognized_at',v_item->'financiallyRecognizedAt'),'')::TIMESTAMPTZ,NULLIF(COALESCE(v_item->>'cancelled_at',v_item->'cancelledAt'),'')::TIMESTAMPTZ,NULL,NULLIF(v_item->>'notes',''),COALESCE((v_item->>'created_at')::TIMESTAMPTZ,(v_item->>'createdAt')::TIMESTAMPTZ,NOW()),COALESCE((v_item->>'updated_at')::TIMESTAMPTZ,(v_item->>'updatedAt')::TIMESTAMPTZ,NOW()),NULLIF(COALESCE(v_item->>'deleted_at',v_item->>'deletedAt'),'')::TIMESTAMPTZ,COALESCE((v_item->>'version')::INTEGER,1));
    c_items:=c_items+1;
  END LOOP;
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'order_items',p_payload->'orderItems','[]')) LOOP
    v_ref:=COALESCE(v_item->>'replacement_of_item_id',v_item->>'replacementOfItemId');
    IF v_ref IS NOT NULL AND v_ref<>'' THEN UPDATE public.order_items SET replacement_of_item_id=v_ref::UUID WHERE id=(v_item->>'id')::UUID; END IF;
  END LOOP;

  -- Payments.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'payments','[]')) LOOP
    v_actor:=NULLIF(COALESCE(v_item->>'actor_admin_id',v_item->>'actorAdminId'),'')::UUID;
    v_cmd:=NULLIF(COALESCE(v_item->>'command_id',v_item->>'commandId'),'')::UUID;
    INSERT INTO public.payments(id,customer_id,amount_minor,payment_method,reference,actor_admin_id,command_id,notes,created_at)
    VALUES((v_item->>'id')::UUID,(COALESCE(v_item->>'customer_id',v_item->>'customerId'))::UUID,COALESCE((v_item->>'amount_minor')::BIGINT,(v_item->>'amountMinor')::BIGINT),COALESCE(v_item->>'payment_method',v_item->>'paymentMethod','CASH'),COALESCE(v_item->>'reference',''),v_actor,v_cmd,COALESCE(v_item->>'notes',''),COALESCE((v_item->>'created_at')::TIMESTAMPTZ,(v_item->>'createdAt')::TIMESTAMPTZ,NOW()));
    c_payments:=c_payments+1;
  END LOOP;

  -- Ledger.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'financial_ledger',p_payload->'financialLedger','[]')) LOOP
    v_sequence:=NULLIF(COALESCE(v_item->>'sequence_number',v_item->>'sequenceNumber'),'')::BIGINT;
    INSERT INTO public.financial_ledger(id,sequence_number,event_type,amount_minor,order_id,order_item_id,customer_id,actor_admin_id,reference_id,linked_ledger_id,metadata,created_at)
    VALUES((v_item->>'id')::UUID,COALESCE(v_sequence,nextval(pg_get_serial_sequence('public.financial_ledger','sequence_number'))),COALESCE(v_item->>'event_type',v_item->>'eventType','ORDER_ITEM_CHARGE'),COALESCE((v_item->>'amount_minor')::BIGINT,(v_item->>'amountMinor')::BIGINT,0),NULLIF(COALESCE(v_item->>'order_id',v_item->>'orderId'),'')::UUID,NULLIF(COALESCE(v_item->>'order_item_id',v_item->>'orderItemId'),'')::UUID,(COALESCE(v_item->>'customer_id',v_item->>'customerId'))::UUID,NULLIF(COALESCE(v_item->>'actor_admin_id',v_item->>'actorAdminId'),'')::UUID,NULLIF(COALESCE(v_item->>'reference_id',v_item->>'referenceId'),'')::UUID,NULLIF(COALESCE(v_item->>'linked_ledger_id',v_item->>'linkedLedgerId'),'')::UUID,COALESCE(v_item->'metadata','{}'),COALESCE((v_item->>'created_at')::TIMESTAMPTZ,(v_item->>'createdAt')::TIMESTAMPTZ,NOW()));
    c_ledger:=c_ledger+1;
  END LOOP;

  -- Allocations.
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'payment_allocations',p_payload->'paymentAllocations','[]')) LOOP
    v_payment:=COALESCE(v_item->>'payment_id',v_item->>'paymentId');
    v_order:=COALESCE(v_item->>'order_id',v_item->>'orderId');
    v_order_item:=COALESCE(v_item->>'order_item_id',v_item->>'orderItemId');
    IF v_order_item IS NULL OR v_order_item='' THEN
      SELECT oi.id::TEXT INTO v_order_item FROM public.order_items oi WHERE oi.order_id=v_order::UUID LIMIT 1;
    END IF;
    INSERT INTO public.payment_allocations(id,payment_id,order_item_id,order_id,allocated_amount_minor,created_at)
    VALUES((v_item->>'id')::UUID,v_payment::UUID,v_order_item::UUID,v_order::UUID,COALESCE((v_item->>'allocated_amount_minor')::BIGINT,(v_item->>'allocatedAmountMinor')::BIGINT),COALESCE((v_item->>'created_at')::TIMESTAMPTZ,(v_item->>'createdAt')::TIMESTAMPTZ,NOW()));
    c_alloc:=c_alloc+1;
  END LOOP;

  -- Post-rebuild financial/FK invariants. Any failure rolls back everything.
  IF EXISTS(
    SELECT 1 FROM public.payment_allocations pa JOIN public.payments p ON p.id=pa.payment_id
    GROUP BY pa.payment_id,p.amount_minor HAVING SUM(pa.allocated_amount_minor)>p.amount_minor
  ) THEN RAISE EXCEPTION 'Replacement rejected: allocations exceed payment amount'; END IF;
  IF EXISTS(SELECT 1 FROM public.financial_ledger l WHERE l.order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.orders o WHERE o.id=l.order_id)) THEN RAI    SE EXCEPTION 'Replacement rejected: orphan ledger order'; END IF;
  IF EXISTS(SELECT 1 FROM public.financial_ledger l WHERE l.order_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.order_items i WHERE i.id=l.order_item_id)) THEN RAISE EXCEPTION 'Replacement rejected: orphan ledger item'; END IF;

  SELECT MAX(sequence_number) INTO v_max_seq FROM public.financial_ledger;
  IF v_max_seq IS NOT NULL AND pg_get_serial_sequence('public.financial_ledger','sequence_number') IS NOT NULL THEN
    PERFORM setval(pg_get_serial_sequence('public.financial_ledger','sequence_number'),v_max_seq,TRUE);
  END IF;

  ALTER TABLE public.customers ENABLE TRIGGER USER;
  ALTER TABLE public.orders ENABLE TRIGGER USER;
  ALTER TABLE public.order_items ENABLE TRIGGER USER;
  ALTER TABLE public.business_days ENABLE TRIGGER USER;
  ALTER TABLE public.device_types ENABLE TRIGGER USER;
  ALTER TABLE public.financial_ledger ENABLE TRIGGER USER;

  RETURN jsonb_build_object(
    'success',TRUE,'operation','REPLACE_ONLINE_BUSINESS_DATA',
    'replacementId',v_replacement,'completedAt',v_done,'serverResetGeneration',v_generation,
    'counts',jsonb_build_object(
      'device_types',c_device,'business_days',c_days,'customers',c_customers,'qr_tokens',c_qr,
      'orders',c_orders,'order_items',c_items,'payments',c_payments,
      'financial_ledger',c_ledger,'payment_allocations',c_alloc
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.replace_online_business_data(TEXT,JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_online_business_data(TEXT,JSONB) TO authenticated;
