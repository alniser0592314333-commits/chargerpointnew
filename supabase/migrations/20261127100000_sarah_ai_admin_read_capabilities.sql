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
  WHERE auth_user_id = auth.uid() AND expires_at <= now();

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

COMMIT;
