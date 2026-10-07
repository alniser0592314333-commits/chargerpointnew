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

  v := replace(v,
    $$  DELETE FROM public.payment_allocations;$$,
    $$  DELETE FROM public.order_number_reservations;
  DELETE FROM public.payment_allocations;$$);

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

  EXECUTE v;
END
$patch$;

REVOKE EXECUTE ON FUNCTION public.replace_online_business_data(text,jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.replace_online_business_data(text,jsonb) TO authenticated;
