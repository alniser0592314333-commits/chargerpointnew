BEGIN;

-- Narrow, read-only customer profile retrieval. It is intentionally separate
-- from balances, debt limits, phone numbers, notes, orders, and financial history.
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
  v_quota jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public._cp_assert_active_admin_permission('customers:view');

  IF p_customer_code IS NULL
     OR pg_catalog.btrim(p_customer_code) !~* '^[A-Z0-9]{4}$' THEN
    RAISE EXCEPTION 'Customer code must be exactly four alphanumeric characters'
      USING ERRCODE = '22023';
  END IF;
  v_code := pg_catalog.upper(pg_catalog.btrim(p_customer_code));

  IF p_name_hint IS NOT NULL AND pg_catalog.btrim(p_name_hint) <> '' THEN
    IF pg_catalog.char_length(p_name_hint) > 64
       OR p_name_hint ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'Customer name hint must be 2 to 64 printable characters'
        USING ERRCODE = '22023';
    END IF;
    v_name_hint := pg_catalog.regexp_replace(pg_catalog.btrim(p_name_hint), '\s+', ' ', 'g');
    IF pg_catalog.char_length(v_name_hint) < 2 THEN
      RAISE EXCEPTION 'Customer name hint must be 2 to 64 printable characters'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- This RPC is independently callable; enforce its own tool quota.
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
    WHERE c.is_active IS TRUE
      AND c.deleted_at IS NULL
      AND COALESCE(c.status, '') <> 'DELETED'
      AND pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text, '-', ''), 4)) = v_code
      AND (
        v_name_hint IS NULL
        OR pg_catalog.strpos(pg_catalog.lower(c.name), pg_catalog.lower(v_name_hint)) > 0
      )
    ORDER BY c.name, c.id
    LIMIT 6
  ),
  ranked AS (
    SELECT
      candidates.*,
      pg_catalog.row_number() OVER (ORDER BY customer_name, customer_code) AS match_number
    FROM candidates
  )
  SELECT pg_catalog.jsonb_build_object(
    'matches',
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'customer_name', customer_name,
          'customer_code', customer_code,
          'status', customer_status,
          'is_active', is_active,
          'created_at', created_at,
          'charger_fee_exempt', charger_fee_exempt
        )
        ORDER BY match_number
      ) FILTER (WHERE match_number <= 5),
      '[]'::jsonb
    ),
    'match_count', LEAST(pg_catalog.count(*)::integer, 5),
    'has_more', pg_catalog.count(*) > 5
  )
  INTO v_result
  FROM ranked;

  RETURN COALESCE(v_result, pg_catalog.jsonb_build_object(
    'matches', '[]'::jsonb,
    'match_count', 0,
    'has_more', false
  ));
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_get_customer_profile(text, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_get_customer_profile(text, text)
  TO authenticated;

COMMIT;
