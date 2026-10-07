-- Final hardening for Local -> Online business replacement.
-- Keeps the canonical replacement function aligned with the live schema,
-- preserves order-number reservations, validates QR identities, and refuses
-- destructive replacement when cloud-only dependent records exist.

DO $patch$
DECLARE
  v text;
BEGIN
  SELECT pg_get_functiondef('public.replace_online_business_data(text,jsonb)'::regprocedure) INTO v;

  v := replace(v,
    $$OR jsonb_typeof(coalesce(p_payload->'payment_allocations','[]'::jsonb)) <> 'array'$$,
    $$OR jsonb_typeof(coalesce(p_payload->'payment_allocations','[]'::jsonb)) <> 'array'
     OR jsonb_typeof(coalesce(p_payload->'order_number_reservations','[]'::jsonb)) <> 'array'$$);

  v := replace(v,
    $$  IF EXISTS (
    SELECT 1 FROM (
      SELECT (x->>'id') id,count(*) c FROM jsonb_array_elements(coalesce(p_payload->'payment_allocations',p_payload->'paymentAllocations','[]'::jsonb)) x
      GROUP BY 1 HAVING count(*) > 1
    ) d
  ) THEN RAISE EXCEPTION 'Duplicate payment allocation ID in replacement payload'; END IF;

  /* ---------- RESET GENERATION: invalidate pre-reset outbox commands ---------- */$$,
    $$  IF EXISTS (
    SELECT 1 FROM (
      SELECT (x->>'id') id,count(*) c FROM jsonb_array_elements(coalesce(p_payload->'payment_allocations',p_payload->'paymentAllocations','[]'::jsonb)) x
      GROUP BY 1 HAVING count(*) > 1
    ) d
  ) THEN RAISE EXCEPTION 'Duplicate payment allocation ID in replacement payload'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'order_number_reservations','[]'::jsonb)) LOOP
    IF (v_item->>'id') !~* '^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'Invalid order number reservation ID'; END IF;
    IF coalesce(v_item->>'business_day_id',v_item->>'businessDayId') !~* '^[0-9a-f-]{36}$'
       OR coalesce(v_item->>'device_id',v_item->>'deviceId') !~* '^[0-9a-f-]{36}$'
    THEN RAISE EXCEPTION 'Order number reservation % has invalid reference', v_item->>'id'; END IF;
    IF coalesce((v_item->>'start_number')::integer,(v_item->>'startNumber')::integer,0) <= 0
       OR coalesce((v_item->>'end_number')::integer,(v_item->>'endNumber')::integer,0) <
          coalesce((v_item->>'start_number')::integer,(v_item->>'startNumber')::integer,0)
       OR coalesce((v_item->>'next_number')::integer,(v_item->>'nextNumber')::integer,0) <
          coalesce((v_item->>'start_number')::integer,(v_item->>'startNumber')::integer,0)
       OR coalesce((v_item->>'next_number')::integer,(v_item->>'nextNumber')::integer,0) >
          coalesce((v_item->>'end_number')::integer,(v_item->>'endNumber')::integer,0) + 1
    THEN RAISE EXCEPTION 'Order number reservation % has invalid range', v_item->>'id'; END IF;
    IF upper(coalesce(v_item->>'status','ACTIVE')) NOT IN ('ACTIVE','EXHAUSTED')
    THEN RAISE EXCEPTION 'Order number reservation % has invalid status', v_item->>'id'; END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM (
      SELECT (x->>'id') id,count(*) c FROM jsonb_array_elements(coalesce(p_payload->'order_number_reservations','[]'::jsonb)) x
      GROUP BY 1 HAVING count(*) > 1
    ) d
  ) THEN RAISE EXCEPTION 'Duplicate order number reservation ID in replacement payload'; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'qr_tokens','[]'::jsonb)) LOOP
    IF (v_item->>'id') !~* '^[0-9a-f-]{36}$' THEN RAISE EXCEPTION 'Invalid QR token ID'; END IF;
    IF coalesce(v_item->>'public_token',v_item->>'publicToken',v_item->>'token') IS NULL
       OR trim(coalesce(v_item->>'public_token',v_item->>'publicToken',v_item->>'token')) = '' THEN
      RAISE EXCEPTION 'QR token % is missing public_token',v_item->>'id';
    END IF;
    IF upper(coalesce(v_item->>'token_type',v_item->>'tokenType',v_item->>'entityType',v_item->>'entity_type','ORDER')) NOT IN ('ORDER','CUSTOMER')
    THEN RAISE EXCEPTION 'QR token % has invalid token type',v_item->>'id'; END IF;
    IF coalesce(v_item->>'target_id',v_item->>'targetId',v_item->>'entityId',v_item->>'entity_id') !~* '^[0-9a-f-]{36}$'
    THEN RAISE EXCEPTION 'QR token % has invalid target_id',v_item->>'id'; END IF;
  END LOOP;

  /* ---------- EXTERNAL DEPENDENCY SAFETY GATE ---------- */
  IF EXISTS (SELECT 1 FROM public.customer_delivery_push_logs)
     OR EXISTS (SELECT 1 FROM public.customer_requests)
     OR EXISTS (SELECT 1 FROM public.notifications)
     OR EXISTS (SELECT 1 FROM public.goals)
     OR EXISTS (SELECT 1 FROM public.goal_requests)
     OR EXISTS (SELECT 1 FROM public.qr_payment_submissions)
  THEN
    RAISE EXCEPTION 'Replacement blocked: auxiliary cloud records reference core business data and are not part of the local replacement snapshot';
  END IF;

  /* ---------- RESET GENERATION: invalidate pre-reset outbox commands ---------- */$$);

  v := replace(v,
    $$  ALTER TABLE public.qr_tokens DISABLE TRIGGER trg_change_capture;$$,
    $$  ALTER TABLE public.qr_tokens DISABLE TRIGGER trg_change_capture;
  ALTER TABLE public.order_number_reservations DISABLE TRIGGER trg_change_capture;$$);

  /* Guard every destructive DELETE in the generated function.
     Fail closed if any expected bare DELETE survives the patch. */
  v := replace(v, $$DELETE FROM public.order_number_reservations;$$, $$DELETE FROM public.order_number_reservations WHERE true;$$);
  v := replace(v, $$DELETE FROM public.payment_allocations;$$, $$DELETE FROM public.payment_allocations WHERE true;$$);
  v := replace(v, $$DELETE FROM public.financial_ledger;$$, $$DELETE FROM public.financial_ledger WHERE true;$$);
  v := replace(v, $$DELETE FROM public.payments;$$, $$DELETE FROM public.payments WHERE true;$$);
  v := replace(v, $$DELETE FROM public.order_items;$$, $$DELETE FROM public.order_items WHERE true;$$);
  v := replace(v, $$DELETE FROM public.orders;$$, $$DELETE FROM public.orders WHERE true;$$);
  v := replace(v, $$DELETE FROM public.qr_tokens;$$, $$DELETE FROM public.qr_tokens WHERE true;$$);
  v := replace(v, $$DELETE FROM public.customers;$$, $$DELETE FROM public.customers WHERE true;$$);
  v := replace(v, $$DELETE FROM public.business_days;$$, $$DELETE FROM public.business_days WHERE true;$$);
  v := replace(v, $$DELETE FROM public.device_types;$$, $$DELETE FROM public.device_types WHERE true;$$);
  v := replace(v, $$DELETE FROM public.change_log;$$, $$DELETE FROM public.change_log WHERE true;$$);
  v := replace(v, $$DELETE FROM public.processed_commands;$$, $$DELETE FROM public.processed_commands WHERE true;$$);

  IF position($$DELETE FROM public.order_number_reservations;$$ in v) > 0
     OR position($$DELETE FROM public.payment_allocations;$$ in v) > 0
     OR position($$DELETE FROM public.financial_ledger;$$ in v) > 0
     OR position($$DELETE FROM public.payments;$$ in v) > 0
     OR position($$DELETE FROM public.order_items;$$ in v) > 0
     OR position($$DELETE FROM public.orders;$$ in v) > 0
     OR position($$DELETE FROM public.qr_tokens;$$ in v) > 0
     OR position($$DELETE FROM public.customers;$$ in v) > 0
     OR position($$DELETE FROM public.business_days;$$ in v) > 0
     OR position($$DELETE FROM public.device_types;$$ in v) > 0
     OR position($$DELETE FROM public.change_log;$$ in v) > 0
     OR position($$DELETE FROM public.processed_commands;$$ in v) > 0
  THEN
    RAISE EXCEPTION 'Replacement hardening failed: an unguarded DELETE remains in replace_online_business_data';
  END IF;

  v := replace(v,
    $$  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'business_days',p_payload->'businessDays','[]'::jsonb)) LOOP
    v_id := (v_item->>'id')::uuid;$$,
    $$  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'order_number_reservations','[]'::jsonb)) LOOP
    v_id := (v_item->>'id')::uuid;
    INSERT INTO public.order_number_reservations(
      id,business_day_id,device_id,start_number,end_number,next_number,status,command_id,created_at,updated_at,version
    ) VALUES (
      v_id,
      coalesce(v_item->>'business_day_id',v_item->>'businessDayId')::uuid,
      coalesce(v_item->>'device_id',v_item->>'deviceId')::uuid,
      coalesce((v_item->>'start_number')::integer,(v_item->>'startNumber')::integer),
      coalesce((v_item->>'end_number')::integer,(v_item->>'endNumber')::integer),
      coalesce((v_item->>'next_number')::integer,(v_item->>'nextNumber')::integer),
      upper(coalesce(v_item->>'status','ACTIVE')),
      CASE WHEN coalesce(v_item->>'command_id',v_item->>'commandId') ~* '^[0-9a-f-]{36}$' THEN coalesce(v_item->>'command_id',v_item->>'commandId')::uuid ELSE NULL END,
      coalesce((v_item->>'created_at')::timestamptz,(v_item->>'createdAt')::timestamptz,now()),
      coalesce((v_item->>'updated_at')::timestamptz,(v_item->>'updatedAt')::timestamptz,now()),
      coalesce((v_item->>'version')::integer,1)
    );
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'business_days',p_payload->'businessDays','[]'::jsonb)) LOOP
    v_id := (v_item->>'id')::uuid;$$);

  v := replace(v,
    $$  ALTER TABLE public.qr_tokens ENABLE TRIGGER trg_change_capture;$$,
    $$  ALTER TABLE public.qr_tokens ENABLE TRIGGER trg_change_capture;
  ALTER TABLE public.order_number_reservations ENABLE TRIGGER trg_change_capture;$$);

  v := replace(v,
    $  /* ---------- POST-REBUILD INVARIANTS ---------- */$,
    $  /* ---------- POST-REBUILD INVARIANTS ---------- */
  IF EXISTS (
    SELECT 1
    FROM public.qr_tokens q
    LEFT JOIN public.orders o ON upper(q.token_type) = 'ORDER' AND o.id = q.target_id
    LEFT JOIN public.customers c ON upper(q.token_type) = 'CUSTOMER' AND c.id = q.target_id
    WHERE (upper(q.token_type) = 'ORDER' AND o.id IS NULL)
       OR (upper(q.token_type) = 'CUSTOMER' AND c.id IS NULL)
  ) THEN
    RAISE EXCEPTION 'Replacement rejected: QR token target does not exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.qr_tokens q
    WHERE q.is_active = true
    GROUP BY q.target_id, q.token_type
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Replacement rejected: duplicate active QR target';
  END IF;$);

  /* Preserve GENERATED ALWAYS identity values from the offline snapshot by
     explicitly overriding the system-generated value. Then advance both
     backing sequences so future inserts remain collision-free. */
  v := replace(v,
    $    ) VALUES (
      v_id,
      coalesce((v_item->>'day_id',v_item->>'dayId')::uuid,$,
    $    ) OVERRIDING SYSTEM VALUE VALUES (
      v_id,
      coalesce((v_item->>'day_id',v_item->>'dayId')::uuid,$);

  v := replace(v,
    $    INSERT INTO public.financial_ledger(
      id,sequence_number,event_type,amount_minor,order_id,order_item_id,customer_id,actor_admin_id,
      reference_id,linked_ledger_id,metadata,created_at
    ) VALUES ($,
    $    INSERT INTO public.financial_ledger(
      id,sequence_number,event_type,amount_minor,order_id,order_item_id,customer_id,actor_admin_id,
      reference_id,linked_ledger_id,metadata,created_at
    ) OVERRIDING SYSTEM VALUE VALUES ($);

  v := replace(v,
    $    INSERT INTO public.orders(
      id,day_id,customer_id,display_number,internal_sequence,status,customer_balance_snapshot_minor,
      notes,qr_token_id,charging_at,delivered_at,cancelled_at,created_at,updated_at,deleted_at,version
    ) VALUES ($,
    $    INSERT INTO public.orders(
      id,day_id,customer_id,display_number,internal_sequence,status,customer_balance_snapshot_minor,
      notes,qr_token_id,charging_at,delivered_at,cancelled_at,created_at,updated_at,deleted_at,version
    ) OVERRIDING SYSTEM VALUE VALUES ($);

  v := replace(v,
    $  /* Second pass for self-references. */$,
    $  /* ---------- IDENTITY SEQUENCE REPAIR ---------- */
  PERFORM setval('public.orders_internal_sequence_seq',
    GREATEST(COALESCE((SELECT max(internal_sequence) FROM public.orders),0),1),
    (SELECT count(*) > 0 FROM public.orders));
  PERFORM setval('public.financial_ledger_sequence_number_seq',
    GREATEST(COALESCE((SELECT max(sequence_number) FROM public.financial_ledger),0),1),
    (SELECT count(*) > 0 FROM public.financial_ledger));

  /* Second pass for self-references. */$);

  EXECUTE v;
END
$patch$;

REVOKE EXECUTE ON FUNCTION public.replace_online_business_data(text,jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.replace_online_business_data(text,jsonb) TO authenticated;
