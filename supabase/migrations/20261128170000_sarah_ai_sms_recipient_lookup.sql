BEGIN;

-- Resolve a named customer for an explicitly requested SMS without exposing
-- customer phone numbers to Gemini or broadening the ordinary customer profile.
CREATE OR REPLACE FUNCTION public.sarah_ai_resolve_sms_recipient(p_query text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_query text;
  v_matches jsonb;
  v_count integer;
BEGIN
  PERFORM public.sarah_ai_assert_use_permission();
  PERFORM public._cp_assert_active_admin_permission('customers:view');
  PERFORM public._cp_assert_active_admin_permission('customers:send-sms');

  IF p_query IS NULL
     OR pg_catalog.char_length(p_query) > 64
     OR p_query ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'SMS recipient query must be 2 to 64 printable characters'
      USING ERRCODE = '22023';
  END IF;

  v_query := pg_catalog.regexp_replace(pg_catalog.btrim(p_query), '\s+', ' ', 'g');
  IF pg_catalog.char_length(v_query) < 2 THEN
    RAISE EXCEPTION 'SMS recipient query must be 2 to 64 printable characters'
      USING ERRCODE = '22023';
  END IF;

  WITH candidates AS (
    SELECT
      c.id,
      pg_catalog.left(pg_catalog.regexp_replace(pg_catalog.btrim(c.name), '[[:cntrl:]]', ' ', 'g'), 80) AS customer_name,
      NULLIF(pg_catalog.btrim(c.phone), '') AS phone
    FROM public.customers AS c
    WHERE c.is_active IS TRUE
      AND c.deleted_at IS NULL
      AND COALESCE(c.status, '') <> 'DELETED'
      AND pg_catalog.strpos(pg_catalog.lower(c.name), pg_catalog.lower(v_query)) > 0
    ORDER BY c.name, c.id
    LIMIT 3
  )
  SELECT
    pg_catalog.count(*)::integer,
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'customer_name', customer_name,
          'phone', phone
        )
        ORDER BY customer_name, id
      ),
      '[]'::jsonb
    )
  INTO v_count, v_matches
  FROM candidates;

  IF v_count = 0 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_count > 1 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'ambiguous');
  END IF;

  RETURN (
    v_matches->0
  ) || pg_catalog.jsonb_build_object('status',
    CASE WHEN NULLIF(v_matches->0->>'phone', '') IS NULL THEN 'phone_missing' ELSE 'resolved' END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_resolve_sms_recipient(text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sarah_ai_resolve_sms_recipient(text)
  TO authenticated;

COMMIT;
