BEGIN;

-- Sarah's first and only data capability is a bounded, read-only customer
-- name/code lookup. It executes under the caller JWT and re-checks both AI and
-- business permissions inside PostgreSQL.
CREATE OR REPLACE FUNCTION public.sarah_ai_lookup_customers(p_query text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_query text;
  v_result jsonb;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public._cp_assert_active_admin_permission('customers:view');

  IF p_query IS NULL
     OR pg_catalog.char_length(p_query) > 64
     OR p_query ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Customer lookup query must be 2 to 64 printable characters'
      USING ERRCODE = '22023';
  END IF;

  v_query := pg_catalog.regexp_replace(
    pg_catalog.btrim(p_query),
    '\s+',
    ' ',
    'g'
  );

  IF pg_catalog.char_length(v_query) < 2 THEN
    RAISE EXCEPTION 'Customer lookup query must be 2 to 64 printable characters'
      USING ERRCODE = '22023';
  END IF;

  WITH candidates AS (
    SELECT
      c.id,
      pg_catalog.left(pg_catalog.btrim(c.name), 80) AS customer_name,
      pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text, '-', ''), 4)) AS customer_code
    FROM public.customers c
    WHERE c.is_active IS TRUE
      AND c.deleted_at IS NULL
      AND COALESCE(c.status, '') <> 'DELETED'
      AND (
        pg_catalog.strpos(pg_catalog.lower(c.name), pg_catalog.lower(v_query)) > 0
        OR pg_catalog.upper(pg_catalog.left(pg_catalog.replace(c.id::text, '-', ''), 4)) = pg_catalog.upper(v_query)
      )
    ORDER BY c.name, c.id
    LIMIT 6
  ),
  ranked AS (
    SELECT
      candidates.*,
      pg_catalog.row_number() OVER (ORDER BY customer_name, id) AS match_number
    FROM candidates
  )
  SELECT pg_catalog.jsonb_build_object(
    'matches',
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'customer_name', customer_name,
          'customer_code', customer_code
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

REVOKE ALL ON FUNCTION public.sarah_ai_lookup_customers(text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_lookup_customers(text) TO authenticated;

COMMIT;
