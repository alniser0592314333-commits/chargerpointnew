-- Fix the deployed native-push enqueue call for the pg_net signature in this project.
-- The installed net.http_post requires the params argument; omitting it raises 42883
-- before any outbound request is queued. Keep push best-effort and business writes safe.

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

  -- Push is best-effort: it must never roll back an authoritative business write.
  IF COALESCE(v_url, '') = '' OR COALESCE(v_secret, '') = '' THEN
    RETURN;
  END IF;

  SELECT n.nspname INTO v_pg_net_schema
  FROM pg_catalog.pg_extension e
  JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_net';

  IF COALESCE(v_pg_net_schema, '') = '' THEN
    RETURN;
  END IF;

  -- pg_net's current signature is http_post(url, params, headers, body,
  -- timeout_milliseconds). Supplying params explicitly avoids SQLSTATE 42883.
  EXECUTE format(
    'SELECT %I.http_post(url := $1, params := $2, headers := $3, body := $4, timeout_milliseconds := $5)',
    v_pg_net_schema
  )
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
    1500;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Native push enqueue failed for %.%: %', p_source, p_record_id, SQLSTATE;
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_native_push_event(text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
