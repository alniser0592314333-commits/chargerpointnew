-- Allow enough time for a cold Edge Function start plus Google OAuth and FCM.
-- The dispatch remains best-effort and does not wait inside the business transaction.
CREATE OR REPLACE FUNCTION public.enqueue_native_push_event(
  p_source text,
  p_record_id uuid,
  p_operation text,
  p_new_status text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, vault, net
AS $function$
DECLARE
  v_url text;
  v_secret text;
  v_pg_net_schema text;
  v_request_id bigint;
BEGIN
  SELECT decrypted_secret INTO v_url
  FROM vault.decrypted_secrets
  WHERE name = 'native_push_function_url'
  LIMIT 1;

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'native_push_dispatch_secret'
  LIMIT 1;

  IF COALESCE(v_url, '') = '' OR COALESCE(v_secret, '') = '' THEN
    RETURN;
  END IF;

  SELECT n.nspname INTO v_pg_net_schema
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'http_post'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) =
      'url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer'
  ORDER BY (n.nspname = 'net') DESC
  LIMIT 1;

  IF COALESCE(v_pg_net_schema, '') = '' THEN
    RAISE WARNING 'Native push enqueue skipped: pg_net http_post function not found';
    RETURN;
  END IF;

  EXECUTE format('SELECT %I.http_post($1, $4, $2, $3, $5)', v_pg_net_schema)
    INTO v_request_id
    USING
      v_url,
      '{}'::jsonb,
      jsonb_build_object(
        'Content-Type', 'application/json',
        'x-push-dispatch-secret', v_secret
      ),
      jsonb_build_object(
        'action', 'dispatch',
        'source', p_source,
        'recordId', p_record_id::text,
        'operation', p_operation,
        'newStatus', p_new_status
      ),
      10000;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Native push enqueue failed for %.%: %', p_source, p_record_id, SQLSTATE;
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_native_push_event(text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
