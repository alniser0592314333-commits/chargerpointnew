BEGIN;

-- Short-lived, Auth-session-bound proof that the admin actually performed a
-- successful customer lookup before Sarah can read a customer's profile,
-- financial summary, or orders. The table is never exposed to browser roles.
CREATE TABLE IF NOT EXISTS public.sarah_ai_customer_lookup_proofs (
  auth_user_id uuid NOT NULL,
  auth_session_id uuid NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  customer_code text NOT NULL CHECK (customer_code ~ '^[A-F0-9]{4}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (auth_user_id, auth_session_id, customer_id)
);

ALTER TABLE public.sarah_ai_customer_lookup_proofs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sarah_ai_customer_lookup_proofs FROM PUBLIC, anon, authenticated, service_role;

-- The existing customer lookup RPC now records its short-lived proof in
-- the same transaction as the lookup, so a successful result and its proof
-- cannot diverge and the normal lookup quota is charged only once.
CREATE OR REPLACE FUNCTION public.sarah_ai_lookup_customers(p_query text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_query text;
  v_session_id uuid;
  v_result jsonb;
  v_quota jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public._cp_assert_active_admin_permission('customers:view');
  IF auth.uid() IS NULL OR COALESCE(auth.jwt()->>'session_id','') = '' THEN
    RAISE EXCEPTION 'Authenticated session required' USING ERRCODE = '28000';
  END IF;
  v_session_id := (auth.jwt()->>'session_id')::uuid;

  IF p_query IS NULL OR pg_catalog.char_length(p_query) > 64 OR p_query ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Customer lookup query must be 2 to 64 printable characters' USING ERRCODE = '22023';
  END IF;
  v_query := pg_catalog.regexp_replace(pg_catalog.btrim(p_query), '\s+', ' ', 'g');
  IF pg_catalog.char_length(v_query) < 2 THEN
    RAISE EXCEPTION 'Customer lookup query must be 2 to 64 printable characters' USING ERRCODE = '22023';
  END IF;

  v_quota := public.sarah_ai_consume_my_quota('tool_hour');
  IF COALESCE((v_quota->>'allowed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_QUOTA_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;
  v_quota := public.sarah_ai_consume_my_quota('tool_day');
  IF COALESCE((v_quota->>'allowed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_DAILY_LIMIT_REACHED' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.sarah_ai_customer_lookup_proofs
  WHERE expires_at <= now();

  INSERT INTO public.sarah_ai_customer_lookup_proofs
    (auth_user_id, auth_session_id, customer_id, customer_code, expires_at)
  SELECT auth.uid(), v_session_id, candidate.id,
         pg_catalog.upper(pg_catalog.left(pg_catalog.replace(candidate.id::text, '-', ''), 4)),
         now() + interval '5 minutes'
  FROM (
    SELECT c.id
    FROM public.customers c
    WHERE c.is_active IS TRUE AND c.deleted_at IS NULL
      AND COALESCE(c.status, '') <> 'DELETED'
      AND (
        pg_catalog.strpos(pg_catalog.lower(c.name), pg_catalog.lower(v_query)) > 0
        OR pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text, '-', ''), 4)) = pg_catalog.upper(v_query)
      )
    ORDER BY c.name, c.id
    LIMIT 5
  ) candidate
  ON CONFLICT (auth_user_id, auth_session_id, customer_id)
  DO UPDATE SET customer_code = EXCLUDED.customer_code,
                created_at = now(),
                expires_at = now() + interval '5 minutes';

  WITH candidates AS (
    SELECT c.id,
      pg_catalog.left(pg_catalog.regexp_replace(pg_catalog.btrim(c.name), '[[:cntrl:]]', ' ', 'g'), 80) AS customer_name,
      pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text, '-', ''), 4)) AS customer_code
    FROM public.customers c
    WHERE c.is_active IS TRUE AND c.deleted_at IS NULL
      AND COALESCE(c.status, '') <> 'DELETED'
      AND (
        pg_catalog.strpos(pg_catalog.lower(c.name), pg_catalog.lower(v_query)) > 0
        OR pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text, '-', ''), 4)) = pg_catalog.upper(v_query)
      )
    ORDER BY c.name, c.id
    LIMIT 6
  ),
  ranked AS (
    SELECT candidates.*,
      pg_catalog.row_number() OVER (ORDER BY customer_name, id) AS match_number
    FROM candidates
  )
  SELECT pg_catalog.jsonb_build_object(
    'matches', COALESCE(
      pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'customer_name', customer_name,
        'customer_code', customer_code
      ) ORDER BY match_number) FILTER (WHERE match_number <= 5),
      '[]'::jsonb
    ),
    'match_count', LEAST(pg_catalog.count(*)::integer, 5),
    'has_more', pg_catalog.count(*) > 5
  )
  INTO v_result
  FROM ranked;

  RETURN COALESCE(v_result, pg_catalog.jsonb_build_object('matches','[]'::jsonb,'match_count',0,'has_more',false));
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_lookup_customers(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_lookup_customers(text) TO authenticated;

-- Replace the profile reader so a guessed four-character code alone is never
-- sufficient: a matching proof must belong to this exact Auth user and session.
CREATE OR REPLACE FUNCTION public.sarah_ai_get_customer_profile(
  p_customer_code text,
  p_name_hint text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_code text;
  v_name_hint text;
  v_result jsonb;
  v_session_id uuid;
  v_quota jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public._cp_assert_active_admin_permission('customers:view');

  IF auth.uid() IS NULL OR COALESCE(auth.jwt()->>'session_id','') = '' THEN
    RAISE EXCEPTION 'Authenticated session required' USING ERRCODE = '28000';
  END IF;
  v_session_id := (auth.jwt()->>'session_id')::uuid;

  IF p_customer_code IS NULL OR pg_catalog.btrim(p_customer_code) !~* '^[A-F0-9]{4}$' THEN
    RAISE EXCEPTION 'Customer code must be exactly four hexadecimal characters' USING ERRCODE = '22023';
  END IF;
  v_code := pg_catalog.upper(pg_catalog.btrim(p_customer_code));

  IF p_name_hint IS NOT NULL AND pg_catalog.btrim(p_name_hint) <> '' THEN
    IF pg_catalog.char_length(p_name_hint) > 64 OR p_name_hint ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'Customer name hint must be 2 to 64 printable characters' USING ERRCODE = '22023';
    END IF;
    v_name_hint := pg_catalog.regexp_replace(pg_catalog.btrim(p_name_hint), '\s+', ' ', 'g');
    IF pg_catalog.char_length(v_name_hint) < 2 THEN
      RAISE EXCEPTION 'Customer name hint must be 2 to 64 printable characters' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_quota := public.sarah_ai_consume_my_quota('tool_hour');
  IF COALESCE((v_quota->>'allowed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_QUOTA_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;
  v_quota := public.sarah_ai_consume_my_quota('tool_day');
  IF COALESCE((v_quota->>'allowed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_DAILY_LIMIT_REACHED' USING ERRCODE = 'P0001';
  END IF;

  WITH candidates AS (
    SELECT
      pg_catalog.left(pg_catalog.regexp_replace(pg_catalog.btrim(c.name), '[[:cntrl:]]', ' ', 'g'), 80) AS customer_name,
      pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text, '-', ''), 4)) AS customer_code,
      pg_catalog.left(COALESCE(c.status, ''), 32) AS customer_status,
      c.is_active,
      c.created_at,
      c.charger_fee_exempt
    FROM public.customers c
    JOIN public.sarah_ai_customer_lookup_proofs proof
      ON proof.customer_id = c.id
     AND proof.auth_user_id = auth.uid()
     AND proof.auth_session_id = v_session_id
     AND proof.customer_code = v_code
     AND proof.expires_at > now()
    WHERE c.is_active IS TRUE
      AND c.deleted_at IS NULL
      AND COALESCE(c.status, '') <> 'DELETED'
      AND pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text, '-', ''), 4)) = v_code
      AND (v_name_hint IS NULL OR pg_catalog.strpos(pg_catalog.lower(c.name), pg_catalog.lower(v_name_hint)) > 0)
    ORDER BY c.name, c.id
    LIMIT 6
  ),
  ranked AS (
    SELECT candidates.*,
      pg_catalog.row_number() OVER (ORDER BY customer_name, customer_code) AS match_number
    FROM candidates
  )
  SELECT pg_catalog.jsonb_build_object(
    'matches', COALESCE(
      pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'customer_name', customer_name,
        'customer_code', customer_code,
        'status', customer_status,
        'is_active', is_active,
        'created_at', created_at,
        'charger_fee_exempt', charger_fee_exempt
      ) ORDER BY match_number) FILTER (WHERE match_number <= 5),
      '[]'::jsonb
    ),
    'match_count', LEAST(pg_catalog.count(*)::integer, 5),
    'has_more', pg_catalog.count(*) > 5
  )
  INTO v_result
  FROM ranked;

  RETURN COALESCE(v_result, pg_catalog.jsonb_build_object('matches','[]'::jsonb,'match_count',0,'has_more',false));
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_get_customer_profile(text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_get_customer_profile(text, text) TO authenticated;

-- Financial read is isolated behind the exact customer-financial permission and
-- uses the authoritative ledger balance calculator, never client cache values.
CREATE OR REPLACE FUNCTION public.sarah_ai_get_customer_financial_summary(
  p_customer_code text,
  p_name_hint text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session_id uuid;
  v_code text;
  v_name_hint text;
  v_count integer;
  v_customer_id uuid;
  v_customer_name text;
  v_balance bigint;
  v_matches jsonb;
  v_quota jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public._cp_assert_active_admin_permission('customers:financial-view');

  IF auth.uid() IS NULL OR COALESCE(auth.jwt()->>'session_id','') = '' THEN
    RAISE EXCEPTION 'Authenticated session required' USING ERRCODE = '28000';
  END IF;
  v_session_id := (auth.jwt()->>'session_id')::uuid;
  IF p_customer_code IS NULL OR pg_catalog.btrim(p_customer_code) !~* '^[A-F0-9]{4}$' THEN
    RAISE EXCEPTION 'Customer code must be exactly four hexadecimal characters' USING ERRCODE = '22023';
  END IF;
  v_code := pg_catalog.upper(pg_catalog.btrim(p_customer_code));
  IF p_name_hint IS NOT NULL AND p_name_hint <> '' THEN
    IF pg_catalog.char_length(p_name_hint) > 64 OR p_name_hint ~ '[[:cntrl:]]'
       OR pg_catalog.char_length(pg_catalog.btrim(p_name_hint)) < 2 THEN
      RAISE EXCEPTION 'Customer name hint must be 2 to 64 printable characters' USING ERRCODE = '22023';
    END IF;
    v_name_hint := pg_catalog.btrim(p_name_hint);
  END IF;

  v_quota := public.sarah_ai_consume_my_quota('tool_hour');
  IF COALESCE((v_quota->>'allowed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_QUOTA_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;
  v_quota := public.sarah_ai_consume_my_quota('tool_day');
  IF COALESCE((v_quota->>'allowed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_DAILY_LIMIT_REACHED' USING ERRCODE = 'P0001';
  END IF;

  WITH matches AS (
    SELECT c.id, c.name
    FROM public.customers c
    JOIN public.sarah_ai_customer_lookup_proofs proof
      ON proof.customer_id = c.id
     AND proof.auth_user_id = auth.uid()
     AND proof.auth_session_id = v_session_id
     AND proof.customer_code = v_code
     AND proof.expires_at > now()
    WHERE c.is_active IS TRUE AND c.deleted_at IS NULL
      AND COALESCE(c.status, '') <> 'DELETED'
      AND pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text, '-', ''), 4)) = v_code
      AND (v_name_hint IS NULL OR pg_catalog.strpos(pg_catalog.lower(c.name), pg_catalog.lower(v_name_hint)) > 0)
    ORDER BY c.name, c.id
    LIMIT 6
  )
  SELECT count(*)::integer,
         (array_agg(id ORDER BY name, id))[1],
         (array_agg(name ORDER BY name, id))[1],
         COALESCE(jsonb_agg(jsonb_build_object(
           'customer_name', pg_catalog.left(name, 80),
           'customer_code', v_code
         ) ORDER BY name, id), '[]'::jsonb)
    INTO v_count, v_customer_id, v_customer_name, v_matches
  FROM matches;

  IF v_count = 0 THEN
    RETURN jsonb_build_object('matches','[]'::jsonb,'match_count',0);
  ELSIF v_count > 1 THEN
    RETURN jsonb_build_object('matches',v_matches,'match_count',v_count,'needs_disambiguation',true);
  END IF;

  v_balance := public.calculate_customer_authoritative_balance(v_customer_id);
  RETURN jsonb_build_object(
    'customer_name', pg_catalog.left(v_customer_name,80),
    'customer_code', v_code,
    'balance_minor', v_balance,
    'currency', 'ILS'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_get_customer_financial_summary(text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_get_customer_financial_summary(text, text) TO authenticated;

-- Bounded customer order history for admins with orders:view. The lookup proof
-- prevents arbitrary UUID/customer selection and is bound to the same Auth session.
CREATE OR REPLACE FUNCTION public.sarah_ai_get_customer_orders(
  p_customer_code text,
  p_name_hint text DEFAULT NULL,
  p_limit integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session_id uuid;
  v_code text;
  v_name_hint text;
  v_count integer;
  v_customer_id uuid;
  v_customer_name text;
  v_matches jsonb;
  v_orders jsonb;
  v_quota jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public._cp_assert_active_admin_permission('orders:view');

  IF auth.uid() IS NULL OR COALESCE(auth.jwt()->>'session_id','') = '' THEN
    RAISE EXCEPTION 'Authenticated session required' USING ERRCODE = '28000';
  END IF;
  v_session_id := (auth.jwt()->>'session_id')::uuid;
  IF p_customer_code IS NULL OR pg_catalog.btrim(p_customer_code) !~* '^[A-F0-9]{4}$' THEN
    RAISE EXCEPTION 'Customer code must be exactly four hexadecimal characters' USING ERRCODE = '22023';
  END IF;
  v_code := pg_catalog.upper(pg_catalog.btrim(p_customer_code));
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 20 THEN
    RAISE EXCEPTION 'Order limit must be between 1 and 20' USING ERRCODE = '22023';
  END IF;
  IF p_name_hint IS NOT NULL AND p_name_hint <> '' THEN
    IF pg_catalog.char_length(p_name_hint) > 64 OR p_name_hint ~ '[[:cntrl:]]'
       OR pg_catalog.char_length(pg_catalog.btrim(p_name_hint)) < 2 THEN
      RAISE EXCEPTION 'Customer name hint must be 2 to 64 printable characters' USING ERRCODE = '22023';
    END IF;
    v_name_hint := pg_catalog.btrim(p_name_hint);
  END IF;

  v_quota := public.sarah_ai_consume_my_quota('tool_hour');
  IF COALESCE((v_quota->>'allowed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_QUOTA_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;
  v_quota := public.sarah_ai_consume_my_quota('tool_day');
  IF COALESCE((v_quota->>'allowed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_DAILY_LIMIT_REACHED' USING ERRCODE = 'P0001';
  END IF;

  WITH matches AS (
    SELECT c.id, c.name
    FROM public.customers c
    JOIN public.sarah_ai_customer_lookup_proofs proof
      ON proof.customer_id = c.id
     AND proof.auth_user_id = auth.uid()
     AND proof.auth_session_id = v_session_id
     AND proof.customer_code = v_code
     AND proof.expires_at > now()
    WHERE c.is_active IS TRUE AND c.deleted_at IS NULL
      AND COALESCE(c.status, '') <> 'DELETED'
      AND pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text, '-', ''), 4)) = v_code
      AND (v_name_hint IS NULL OR pg_catalog.strpos(pg_catalog.lower(c.name), pg_catalog.lower(v_name_hint)) > 0)
    ORDER BY c.name, c.id
    LIMIT 6
  )
  SELECT count(*)::integer,
         (array_agg(id ORDER BY name, id))[1],
         (array_agg(name ORDER BY name, id))[1],
         COALESCE(jsonb_agg(jsonb_build_object(
           'customer_name', pg_catalog.left(name,80),
           'customer_code', v_code
         ) ORDER BY name, id), '[]'::jsonb)
    INTO v_count, v_customer_id, v_customer_name, v_matches
  FROM matches;

  IF v_count = 0 THEN
    RETURN jsonb_build_object('matches','[]'::jsonb,'match_count',0);
  ELSIF v_count > 1 THEN
    RETURN jsonb_build_object('matches',v_matches,'match_count',v_count,'needs_disambiguation',true);
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'business_date', d.business_date,
      'day_number', d.display_number,
      'order_number', o.display_number,
      'order_status', o.status,
      'created_at', o.created_at,
      'delivered_at', o.delivered_at,
      'items', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'device', COALESCE(i.device_name_snapshot, dt.name_ar, dt.name, 'جهاز'),
          'status', i.operational_status,
          'financial_status', i.financial_status,
          'charge_minor', i.final_charge_snapshot_minor,
          'charger_fee_minor', i.charger_fee_snapshot_minor,
          'discount_minor', i.discount_snapshot_minor,
          'delivered_at', i.delivered_at
        ) ORDER BY i.item_sequence, i.id)
        FROM public.order_items i
        LEFT JOIN public.device_types dt ON dt.id = i.device_type_id
        WHERE i.order_id = o.id AND i.deleted_at IS NULL
      ), '[]'::jsonb),
      'total_charge_minor', COALESCE((
        SELECT sum(i.final_charge_snapshot_minor)
        FROM public.order_items i
        WHERE i.order_id = o.id AND i.deleted_at IS NULL
      ), 0)
    ) ORDER BY d.business_date DESC NULLS LAST, o.created_at DESC, o.id
  ), '[]'::jsonb)
  INTO v_orders
  FROM (
    SELECT *
    FROM public.orders
    WHERE customer_id = v_customer_id AND deleted_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT p_limit
  ) o
  LEFT JOIN public.business_days d ON d.id = o.day_id;

  RETURN jsonb_build_object(
    'customer_name', pg_catalog.left(v_customer_name,80),
    'customer_code', v_code,
    'orders', COALESCE(v_orders,'[]'::jsonb),
    'order_count', COALESCE(jsonb_array_length(v_orders),0)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_get_customer_orders(text, text, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_get_customer_orders(text, text, integer) TO authenticated;


-- Durable request idempotency for Sarah's multi-command mutations. A request
-- is scoped to the authenticated Auth user and exact session; the model never
-- supplies actor IDs or chooses arbitrary RPC names.
CREATE TABLE IF NOT EXISTS public.sarah_ai_action_idempotency (
  auth_user_id uuid NOT NULL,
  auth_session_id uuid NOT NULL,
  request_id uuid NOT NULL,
  action_name text NOT NULL,
  request_payload jsonb NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (auth_user_id, auth_session_id, request_id)
);
ALTER TABLE public.sarah_ai_action_idempotency ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sarah_ai_action_idempotency FROM PUBLIC, anon, authenticated, service_role;

-- Create a complete order (order + all items) in one PostgreSQL transaction by
-- invoking the same canonical sync commands the app uses. If any item fails,
-- PostgreSQL rolls back the entire order and every processed-command row.
CREATE OR REPLACE FUNCTION public.sarah_ai_create_order_with_items(
  p_request_id uuid,
  p_customer_code text,
  p_name_hint text,
  p_items jsonb,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_session_id uuid;
  v_admin_id uuid;
  v_admin_role text;
  v_is_super_admin boolean := false;
  v_can_open_day boolean := false;
  v_can_override_debt boolean := false;
  v_existing_action text;
  v_existing_payload jsonb;
  v_request_payload jsonb;
  v_saved_result jsonb;
  v_result jsonb;
  v_code text;
  v_name_hint text;
  v_customer_id uuid;
  v_customer_name text;
  v_customer_count integer;
  v_customer_matches jsonb;
  v_debt_limit bigint;
  v_balance bigint;
  v_day_date date;
  v_day_id uuid;
  v_day_closed boolean;
  v_day_status text;
  v_day_number integer;
  v_order_id uuid;
  v_order_number integer;
  v_order_result jsonb;
  v_item jsonb;
  v_item_index integer := 0;
  v_item_name text;
  v_has_charger boolean;
  v_manual_text text;
  v_manual_price bigint;
  v_device_id uuid;
  v_device_name text;
  v_device_name_ar text;
  v_device_name_en text;
  v_device_count integer;
  v_is_other boolean;
  v_suggestions jsonb;
  v_item_id uuid;
  v_item_result jsonb;
  v_item_charge bigint;
  v_total_charge bigint := 0;
  v_resolved_items jsonb := '[]'::jsonb;
  v_created_items jsonb := '[]'::jsonb;
  v_quota jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public.assert_my_account_session_active();

  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'A stable request id is required' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR COALESCE(auth.jwt()->>'session_id','') = '' THEN
    RAISE EXCEPTION 'Authenticated session required' USING ERRCODE = '28000';
  END IF;
  v_session_id := (auth.jwt()->>'session_id')::uuid;

  v_admin_id := public._cp_assert_active_admin_permission('customers:view');
  PERFORM public._cp_assert_active_admin_permission('orders:create');
  PERFORM public._cp_assert_active_admin_permission('orders:edit');

  SELECT a.role INTO v_admin_role
  FROM public.admins a
  WHERE a.id = v_admin_id AND a.is_active IS TRUE;
  v_is_super_admin := COALESCE(v_admin_role IN ('SUPER_ADMIN','Super Admin'), false);

  IF p_customer_code IS NULL OR pg_catalog.btrim(p_customer_code) !~* '^[A-F0-9]{4}$' THEN
    RAISE EXCEPTION 'Customer code must be exactly four hexadecimal characters' USING ERRCODE = '22023';
  END IF;
  v_code := pg_catalog.upper(pg_catalog.btrim(p_customer_code));
  IF p_name_hint IS NOT NULL AND pg_catalog.btrim(p_name_hint) <> '' THEN
    IF pg_catalog.char_length(p_name_hint) > 64 OR p_name_hint ~ '[[:cntrl:]]'
       OR pg_catalog.char_length(pg_catalog.btrim(p_name_hint)) < 2 THEN
      RAISE EXCEPTION 'Customer name hint must be 2 to 64 printable characters' USING ERRCODE = '22023';
    END IF;
    v_name_hint := pg_catalog.regexp_replace(pg_catalog.btrim(p_name_hint), '\s+', ' ', 'g');
  END IF;

  IF p_items IS NULL OR pg_catalog.jsonb_typeof(p_items) <> 'array'
     OR pg_catalog.jsonb_array_length(p_items) < 1
     OR pg_catalog.jsonb_array_length(p_items) > 10 THEN
    RAISE EXCEPTION 'An order must contain between one and ten items' USING ERRCODE = '22023';
  END IF;
  IF p_notes IS NOT NULL AND (pg_catalog.char_length(p_notes) > 500 OR p_notes ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'Order notes are too long or contain control characters' USING ERRCODE = '22023';
  END IF;

  -- One request ID can only ever represent this action in this Auth session.
  DELETE FROM public.sarah_ai_action_idempotency
  WHERE created_at <= now() - interval '365 days';
  v_request_payload:=jsonb_build_object('customer_code',v_code,'name_hint',v_name_hint,'items',p_items,'notes',p_notes);
  INSERT INTO public.sarah_ai_action_idempotency(auth_user_id,auth_session_id,request_id,action_name,request_payload)
  VALUES(auth.uid(),v_session_id,p_request_id,'create_order_with_items',v_request_payload)
  ON CONFLICT(auth_user_id,auth_session_id,request_id) DO NOTHING;
  SELECT action_name,request_payload,result
  INTO v_existing_action,v_existing_payload,v_saved_result
  FROM public.sarah_ai_action_idempotency
  WHERE auth_user_id=auth.uid() AND auth_session_id=v_session_id AND request_id=p_request_id
  FOR UPDATE;
  IF v_existing_action IS DISTINCT FROM 'create_order_with_items' THEN
    RAISE EXCEPTION 'Request id was already used for a different action' USING ERRCODE = 'P0409';
  END IF;
  IF v_saved_result IS NOT NULL THEN
    IF v_existing_payload IS DISTINCT FROM v_request_payload THEN
      RAISE EXCEPTION 'Completed request id cannot be reused with different input' USING ERRCODE = 'P0409';
    END IF;
    RETURN v_saved_result || jsonb_build_object('idempotent_replay',true);
  END IF;
  -- A validation-only attempt has no side effects; the model may perform a
  -- lookup/clarification and retry within the same user turn before commit.
  IF v_existing_payload IS DISTINCT FROM v_request_payload THEN
    UPDATE public.sarah_ai_action_idempotency SET request_payload=v_request_payload
    WHERE auth_user_id=auth.uid() AND auth_session_id=v_session_id AND request_id=p_request_id;
  END IF;

  v_quota := public.sarah_ai_consume_my_quota('tool_hour');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_QUOTA_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;
  v_quota := public.sarah_ai_consume_my_quota('tool_day');
  IF COALESCE((v_quota->>'allowed')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'AI_TOOL_DAILY_LIMIT_REACHED' USING ERRCODE = 'P0001';
  END IF;

  -- Resolve the customer only from a successful lookup made in this same Auth
  -- session during the preceding five minutes.
  WITH matches AS (
    SELECT c.id,c.name,c.debt_limit_minor
    FROM public.customers c
    JOIN public.sarah_ai_customer_lookup_proofs proof
      ON proof.customer_id=c.id
     AND proof.auth_user_id=auth.uid()
     AND proof.auth_session_id=v_session_id
     AND proof.customer_code=v_code
     AND proof.expires_at>now()
    WHERE c.is_active IS TRUE AND c.deleted_at IS NULL
      AND COALESCE(c.status,'')<>'DELETED'
      AND pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text,'-',''),4))=v_code
      AND (v_name_hint IS NULL OR pg_catalog.strpos(pg_catalog.lower(c.name),pg_catalog.lower(v_name_hint))>0)
    ORDER BY c.name,c.id
    LIMIT 6
  )
  SELECT count(*)::integer,
         (array_agg(id ORDER BY name,id))[1],
         (array_agg(name ORDER BY name,id))[1],
         (array_agg(debt_limit_minor ORDER BY name,id))[1],
         COALESCE(jsonb_agg(jsonb_build_object('customer_name',pg_catalog.left(name,80),'customer_code',v_code) ORDER BY name,id),'[]'::jsonb)
  INTO v_customer_count,v_customer_id,v_customer_name,v_debt_limit,v_customer_matches
  FROM matches;

  IF v_customer_count=0 THEN
    v_result:=jsonb_build_object('ok',false,'error','CUSTOMER_LOOKUP_REQUIRED');
    RETURN v_result;
  ELSIF v_customer_count>1 THEN
    v_result:=jsonb_build_object('ok',false,'error','CUSTOMER_NEEDS_DISAMBIGUATION','matches',v_customer_matches);
    RETURN v_result;
  END IF;

  SELECT COALESCE(pg_catalog.sum(fl.amount_minor),0)
  INTO v_balance
  FROM public.financial_ledger fl
  WHERE fl.customer_id=v_customer_id;

  v_can_override_debt := v_is_super_admin OR EXISTS(
    SELECT 1 FROM public.get_effective_permissions(v_admin_id) ep
    WHERE ep.permission='orders:override-debt-limit'
  );
  IF NOT v_can_override_debt AND (
    (v_debt_limit<0 AND v_balance<v_debt_limit)
    OR (v_debt_limit>0 AND v_balance<(-v_debt_limit))
    OR (v_debt_limit=0 AND v_balance<0)
  ) THEN
    v_result:=jsonb_build_object('ok',false,'error','DEBT_LIMIT_EXCEEDED','balance_minor',v_balance,'debt_limit_minor',v_debt_limit);
    RETURN v_result;
  END IF;

  -- Validate every requested device and pricing override before creating any row.
  FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_items)
  LOOP
    v_item_index:=v_item_index+1;
    v_item_name:=pg_catalog.btrim(COALESCE(v_item->>'device_name',v_item->>'deviceName',''));
    IF v_item_name='' OR pg_catalog.char_length(v_item_name)>64
       OR v_item_name ~ '[[:cntrl:]]' THEN
      v_result:=jsonb_build_object('ok',false,'error','DEVICE_NAME_INVALID','item_index',v_item_index);
      RETURN v_result;
    END IF;
    IF pg_catalog.jsonb_typeof(COALESCE(v_item->'has_charger',v_item->'hasCharger')) IS DISTINCT FROM 'boolean' THEN
      v_result:=jsonb_build_object('ok',false,'error','ITEM_CHARGER_SELECTION_REQUIRED','item_index',v_item_index);
      RETURN v_result;
    END IF;
    v_has_charger:=COALESCE((v_item->>'has_charger')::boolean,(v_item->>'hasCharger')::boolean,false);
    v_manual_text:=NULLIF(COALESCE(v_item->>'manual_price_minor',v_item->>'manualPriceMinor'),'');
    IF v_manual_text IS NOT NULL AND v_manual_text !~ '^[0-9]{1,12}$' THEN
      v_result:=jsonb_build_object('ok',false,'error','MANUAL_PRICE_INVALID','item_index',v_item_index);
      RETURN v_result;
    END IF;
    v_manual_price:=v_manual_text::bigint;
    IF v_manual_price IS NOT NULL AND v_manual_price<=0 THEN
      v_result:=jsonb_build_object('ok',false,'error','MANUAL_PRICE_INVALID','item_index',v_item_index);
      RETURN v_result;
    END IF;

    SELECT count(*)::integer,
           (array_agg(dt.id ORDER BY dt.id))[1],
           (array_agg(dt.name ORDER BY dt.id))[1],
           (array_agg(dt.name_ar ORDER BY dt.id))[1],
           (array_agg(dt.name_en ORDER BY dt.id))[1]
    INTO v_device_count,v_device_id,v_device_name,v_device_name_ar,v_device_name_en
    FROM public.device_types dt
    WHERE dt.is_active IS TRUE AND dt.deleted_at IS NULL
      AND COALESCE(dt.status,'ACTIVE')='ACTIVE'
      AND (
        pg_catalog.lower(pg_catalog.btrim(dt.name))=pg_catalog.lower(v_item_name)
        OR pg_catalog.lower(pg_catalog.btrim(COALESCE(dt.name_ar,'')))=pg_catalog.lower(v_item_name)
        OR pg_catalog.lower(pg_catalog.btrim(COALESCE(dt.name_en,'')))=pg_catalog.lower(v_item_name)
      );
    IF v_device_count=0 THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('name',name,'name_ar',name_ar,'name_en',name_en) ORDER BY sort_order,name),'[]'::jsonb)
      INTO v_suggestions
      FROM (
        SELECT dt.name,dt.name_ar,dt.name_en,dt.sort_order
        FROM public.device_types dt
        WHERE dt.is_active IS TRUE AND dt.deleted_at IS NULL
          AND COALESCE(dt.status,'ACTIVE')='ACTIVE'
          AND (
            pg_catalog.lower(dt.name) LIKE '%'||pg_catalog.lower(v_item_name)||'%'
            OR pg_catalog.lower(COALESCE(dt.name_ar,'')) LIKE '%'||pg_catalog.lower(v_item_name)||'%'
            OR pg_catalog.lower(COALESCE(dt.name_en,'')) LIKE '%'||pg_catalog.lower(v_item_name)||'%'
          )
        ORDER BY dt.sort_order,dt.name
        LIMIT 5
      ) suggestions;
      v_result:=jsonb_build_object('ok',false,'error','DEVICE_TYPE_NOT_FOUND','item_index',v_item_index,'suggestions',v_suggestions);
      RETURN v_result;
    ELSIF v_device_count>1 THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('name',name,'name_ar',name_ar,'name_en',name_en) ORDER BY sort_order,name),'[]'::jsonb)
      INTO v_suggestions
      FROM (
        SELECT dt.name,dt.name_ar,dt.name_en,dt.sort_order
        FROM public.device_types dt
        WHERE dt.is_active IS TRUE AND dt.deleted_at IS NULL
          AND COALESCE(dt.status,'ACTIVE')='ACTIVE'
          AND (
            pg_catalog.lower(pg_catalog.btrim(dt.name))=pg_catalog.lower(v_item_name)
            OR pg_catalog.lower(pg_catalog.btrim(COALESCE(dt.name_ar,'')))=pg_catalog.lower(v_item_name)
            OR pg_catalog.lower(pg_catalog.btrim(COALESCE(dt.name_en,'')))=pg_catalog.lower(v_item_name)
          )
        ORDER BY dt.sort_order,dt.name
        LIMIT 5
      ) suggestions;
      v_result:=jsonb_build_object('ok',false,'error','DEVICE_TYPE_AMBIGUOUS','item_index',v_item_index,'suggestions',v_suggestions);
      RETURN v_result;
    END IF;

    v_is_other:=pg_catalog.lower(pg_catalog.btrim(COALESCE(v_device_name_ar,''))) IN ('أخرى','اخرى')
      OR pg_catalog.lower(pg_catalog.btrim(COALESCE(v_device_name_en,'')))='other'
      OR pg_catalog.lower(pg_catalog.btrim(COALESCE(v_device_name,''))) IN ('أخرى','اخرى','other');
    IF v_manual_price IS NOT NULL AND NOT v_is_other THEN
      v_result:=jsonb_build_object('ok',false,'error','MANUAL_PRICE_ONLY_FOR_OTHER','item_index',v_item_index);
      RETURN v_result;
    END IF;
    IF v_is_other AND v_manual_price IS NULL THEN
      v_result:=jsonb_build_object('ok',false,'error','MANUAL_PRICE_REQUIRED_FOR_OTHER','item_index',v_item_index);
      RETURN v_result;
    END IF;

    v_resolved_items:=v_resolved_items||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'device_type_id',v_device_id,
      'device_name',v_device_name,
      'has_charger',CASE WHEN v_manual_price IS NOT NULL THEN false ELSE v_has_charger END,
      'manual_price_minor',v_manual_price
    ));
  END LOOP;

  v_day_date:=(now() AT TIME ZONE 'Asia/Jerusalem')::date;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sarah_ai:business_day:'||v_day_date::text,0));
  SELECT d.id,d.is_closed,d.status INTO v_day_id,v_day_closed,v_day_status
  FROM public.business_days d
  WHERE d.business_date=v_day_date
  FOR UPDATE;

  IF NOT FOUND THEN
    v_can_open_day:=v_is_super_admin OR EXISTS(
      SELECT 1 FROM public.get_effective_permissions(v_admin_id) ep
      WHERE ep.permission='settings:manage'
    );
    IF NOT v_can_open_day THEN
      v_result:=jsonb_build_object('ok',false,'error','NO_OPEN_BUSINESS_DAY','business_date',v_day_date);
      RETURN v_result;
    END IF;
    v_day_id:=gen_random_uuid();
    SELECT COALESCE(max(display_number),0)+1 INTO v_day_number FROM public.business_days;
    INSERT INTO public.business_days(id,business_date,display_number,status,is_closed,opened_at,created_at,updated_at,version)
    VALUES(v_day_id,v_day_date,v_day_number,'OPEN',false,now(),now(),now(),1);
    PERFORM public.record_canonical_change('business_days',v_day_id,'INSERT',jsonb_build_object(
      'id',v_day_id,'businessDate',v_day_date,'displayNumber',v_day_number,
      'business_date',v_day_date,'display_number',v_day_number,
      'status','OPEN','isClosed',false,'is_closed',false,
      'openedAt',now(),'opened_at',now(),'version',1
    ),1);
  ELSIF v_day_closed IS TRUE OR v_day_status IS DISTINCT FROM 'OPEN' THEN
    v_result:=jsonb_build_object('ok',false,'error','BUSINESS_DAY_CLOSED','business_date',v_day_date);
    RETURN v_result;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_day_id::text,1));
  IF EXISTS(
    SELECT 1 FROM public.orders o
    WHERE o.day_id=v_day_id AND o.customer_id=v_customer_id
      AND o.deleted_at IS NULL AND COALESCE(o.status,'')<>'cancelled'
  ) THEN
    SELECT o.display_number INTO v_order_number
    FROM public.orders o
    WHERE o.day_id=v_day_id AND o.customer_id=v_customer_id
      AND o.deleted_at IS NULL AND COALESCE(o.status,'')<>'cancelled'
    ORDER BY o.created_at DESC,o.id
    LIMIT 1;
    v_result:=jsonb_build_object('ok',false,'error','ORDER_ALREADY_EXISTS','customer_name',v_customer_name,'order_number',v_order_number,'business_date',v_day_date);
    RETURN v_result;
  END IF;

  SELECT COALESCE(max(display_number),0)+1 INTO v_order_number
  FROM public.orders WHERE day_id=v_day_id;

  v_order_id:=p_request_id;
  v_order_result:=public.execute_sync_command(
    v_order_id,'CREATE_ORDER','orders',v_order_id,
    jsonb_build_object('id',v_order_id,'dayId',v_day_id,'customerId',v_customer_id,'displayNumber',v_order_number,'notes',COALESCE(pg_catalog.btrim(p_notes),'')),
    NULL
  );

  v_item_index:=0;
  FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(v_resolved_items)
  LOOP
    v_item_index:=v_item_index+1;
    v_item_id:=gen_random_uuid();
    v_item_result:=public.execute_sync_command(
      v_item_id,'ADD_ORDER_ITEM','order_items',v_order_id,
      pg_catalog.jsonb_strip_nulls(jsonb_build_object(
        'id',v_item_id,
        'orderId',v_order_id,
        'deviceTypeId',(v_item->>'device_type_id')::uuid,
        'hasCharger',(v_item->>'has_charger')::boolean,
        'itemSequence',v_item_index,
        'manualPriceMinor',(v_item->>'manual_price_minor')::bigint
      )),
      NULL
    );
    v_item_charge:=COALESCE(
      NULLIF(v_item_result->'result'->>'provisionalFinalChargeMinor','')::bigint,
      NULLIF(v_item_result->'result'->>'finalChargeMinor','')::bigint,
      0
    );
    v_total_charge:=v_total_charge+v_item_charge;
    v_created_items:=v_created_items||pg_catalog.jsonb_build_array(jsonb_build_object(
      'device',v_item->>'device_name',
      'has_charger',(v_item->>'has_charger')::boolean,
      'charge_minor',v_item_charge
    ));
  END LOOP;

  v_result:=jsonb_build_object(
    'ok',true,
    'order_id',v_order_id,
    'order_number',COALESCE(NULLIF(v_order_result->'result'->>'displayNumber','')::integer,v_order_number),
    'business_date',v_day_date,
    'customer_name',pg_catalog.left(v_customer_name,80),
    'items',v_created_items,
    'item_count',v_item_index,
    'total_charge_minor',v_total_charge,
    'currency','ILS'
  );
  UPDATE public.sarah_ai_action_idempotency SET result=v_result
  WHERE auth_user_id=auth.uid() AND auth_session_id=v_session_id AND request_id=p_request_id;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_create_order_with_items(uuid,text,text,jsonb,text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_create_order_with_items(uuid,text,text,jsonb,text) TO authenticated;

COMMIT;
