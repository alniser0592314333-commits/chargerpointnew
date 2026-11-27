-- Keep Sarah-created canonical sync commands current with the server reset generation.
-- This is intentionally scoped to the server-side Sarah order transaction; ordinary
-- client outbox commands still have to provide their own generation and remain stale-protected.
DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.sarah_ai_create_order_with_items(uuid,text,text,jsonb,text)'::regprocedure
  ) INTO v_definition;

  v_old := $old$'id',v_day_id,'businessDate',v_day_date,'isClosed',false,
        'createdAt',now(),'updatedAt',now(),'version',1$old$;
  v_new := $new$'id',v_day_id,'businessDate',v_day_date,'isClosed',false,
        'createdAt',now(),'updatedAt',now(),'version',1,
        'resetGeneration',(SELECT COALESCE(value_number,1)
          FROM public.system_settings WHERE key='server_reset_generation')$new$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'Sarah OPEN_DAY command payload signature changed; migration aborted';
  END IF;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := $old$'id',v_order_id,'dayId',v_day_id,'customerId',v_customer_id,'displayNumber',v_order_number,'notes',COALESCE(pg_catalog.btrim(p_notes),'')$old$;
  v_new := $new$'id',v_order_id,'dayId',v_day_id,'customerId',v_customer_id,'displayNumber',v_order_number,'notes',COALESCE(pg_catalog.btrim(p_notes),''),
      'resetGeneration',(SELECT COALESCE(value_number,1)
        FROM public.system_settings WHERE key='server_reset_generation')$new$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'Sarah CREATE_ORDER command payload signature changed; migration aborted';
  END IF;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  v_old := $old$'manualPriceMinor',(v_item->>'manual_price_minor')::bigint$old$;
  v_new := $new$'manualPriceMinor',(v_item->>'manual_price_minor')::bigint,
        'resetGeneration',(SELECT COALESCE(value_number,1)
          FROM public.system_settings WHERE key='server_reset_generation')$new$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'Sarah ADD_ORDER_ITEM command payload signature changed; migration aborted';
  END IF;
  v_definition := pg_catalog.replace(v_definition, v_old, v_new);

  EXECUTE v_definition;
END
$migration$;
