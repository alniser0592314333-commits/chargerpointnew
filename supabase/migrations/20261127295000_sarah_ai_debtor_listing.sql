-- Authoritative, permission-gated debtor listing for Sarah.
CREATE OR REPLACE FUNCTION public.sarah_ai_list_customers_above_debt_threshold(
  p_min_balance_minor bigint DEFAULT 10000,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_rows jsonb;
  v_count integer;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public._cp_assert_active_admin_permission('customers:view');
  PERFORM public._cp_assert_active_admin_permission('customers:financial-view');
  PERFORM public.assert_my_account_session_active();

  IF p_min_balance_minor IS NULL OR p_min_balance_minor < 0
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'Invalid debtor query bounds' USING ERRCODE = '22023';
  END IF;

  WITH balances AS MATERIALIZED (
    SELECT c.id, c.name,
           public.calculate_customer_authoritative_balance(c.id) AS balance_minor
    FROM public.customers c
    WHERE c.is_active IS TRUE
      AND c.deleted_at IS NULL
      AND COALESCE(c.status, '') <> 'DELETED'
  ),
  debtors AS (
    SELECT id, name, balance_minor
    FROM balances
    WHERE balance_minor < -p_min_balance_minor
    ORDER BY balance_minor ASC, name ASC, id ASC
    LIMIT p_limit + 1
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'customer_id', id,
      'customer_name', left(name, 80),
      'balance_minor', balance_minor,
      'debt_minor', abs(balance_minor),
      'currency', 'ILS'
    ) ORDER BY balance_minor ASC, name ASC, id ASC) FILTER (WHERE row_number <= p_limit), '[]'::jsonb),
    count(*)::integer
  INTO v_rows, v_count
  FROM (
    SELECT *, row_number() OVER (ORDER BY balance_minor ASC, name ASC, id ASC) AS row_number
    FROM debtors
  ) ranked;

  RETURN jsonb_build_object(
    'customers', v_rows,
    'count', LEAST(v_count, p_limit),
    'has_more', v_count > p_limit,
    'min_debt_minor', p_min_balance_minor,
    'currency', 'ILS'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_list_customers_above_debt_threshold(bigint, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sarah_ai_list_customers_above_debt_threshold(bigint, integer) TO authenticated;
