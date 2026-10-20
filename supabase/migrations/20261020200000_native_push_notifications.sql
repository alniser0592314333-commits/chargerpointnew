-- Native Android push delivery reuses the existing payment/account event records.
-- This is device-registration and delivery-idempotency metadata, not a parallel inbox.
-- Required secrets: Vault native_push_function_url and native_push_dispatch_secret.
-- The URL must target /functions/v1/native-push; the dispatch secret must match the
-- Edge Function secret PUSH_DISPATCH_SECRET. Missing Vault values never block business writes.

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA net;

-- Generate the dispatch credential inside Vault instead of asking operators to
-- copy a secret between database and Edge Function settings.
DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'native_push_dispatch_secret'
  ) THEN
    PERFORM vault.create_secret(
      encode(public.gen_random_bytes(32), 'hex'),
      'native_push_dispatch_secret',
      'Shared authentication credential for database-triggered native push dispatch'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'native_push_function_url'
  ) THEN
    PERFORM vault.create_secret(
      'https://ydhcyamtgioyrxfarkwk.supabase.co/functions/v1/native-push',
      'native_push_function_url',
      'Native push Edge Function endpoint for asynchronous database-trigger dispatch'
    );
  END IF;
END;
$block$;

-- Preserve the existing canonical event-type contract; push dispatch filters
-- supported event types without restricting future account event writes.

CREATE TABLE IF NOT EXISTS public.native_push_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  token text NOT NULL UNIQUE CHECK (length(token) BETWEEN 32 AND 4096),
  app_variant text NOT NULL CHECK (app_variant IN ('admin', 'customer')),
  principal_id uuid NOT NULL,
  customer_id uuid NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  auth_session_id text NOT NULL CHECK (auth_session_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  platform text NOT NULL CHECK (platform IN ('android', 'ios')),
  locale text NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar', 'en')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz NULL,
  CONSTRAINT native_push_device_identity_check CHECK (
    (app_variant = 'customer' AND customer_id IS NOT NULL)
    OR (app_variant = 'admin' AND customer_id IS NULL)
  ),
  CONSTRAINT native_push_devices_variant_device_key UNIQUE (app_variant, device_id)
);

CREATE INDEX IF NOT EXISTS native_push_devices_active_variant_idx
  ON public.native_push_devices (app_variant, customer_id)
  WHERE disabled_at IS NULL;

CREATE TABLE IF NOT EXISTS public.native_push_delivery_attempts (
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 256),
  device_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('SENDING', 'SENT', 'FAILED')),
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 3),
  sent_at timestamptz NULL,
  error_code text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_key, device_id)
);

ALTER TABLE public.native_push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.native_push_delivery_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.native_push_devices FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.native_push_delivery_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.native_push_devices TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.native_push_delivery_attempts TO service_role;

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

  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-dispatch-secret', v_secret
    ),
    body := jsonb_build_object(
      'action', 'dispatch',
      'source', p_source,
      'recordId', p_record_id::text,
      'operation', p_operation,
      'newStatus', p_new_status
    ),
    timeout_milliseconds := 1500
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Native push enqueue failed for %.%: %', p_source, p_record_id, SQLSTATE;
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_native_push_event(text, uuid, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.verify_native_push_dispatch_secret(p_secret text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, vault
AS $function$
  SELECT COALESCE(p_secret, '') <> ''
     AND EXISTS (
       SELECT 1
       FROM vault.decrypted_secrets
       WHERE name = 'native_push_dispatch_secret'
         AND decrypted_secret = p_secret
     );
$function$;

REVOKE ALL ON FUNCTION public.verify_native_push_dispatch_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_native_push_dispatch_secret(text) TO service_role;

-- Called by the Edge Function before each send. Device tokens are not enough:
-- the underlying Auth session and the corresponding admin/customer session must
-- still be valid. Generic account-status/recovery alerts may bypass the app-level
-- customer session revocation, but never a deleted/expired Supabase Auth session.
CREATE OR REPLACE FUNCTION public.native_push_device_is_current(
  p_device_id uuid,
  p_allow_account_status_notice boolean DEFAULT false
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.native_push_devices d
    JOIN auth.sessions s
      ON s.id = d.auth_session_id::uuid
     AND (s.not_after IS NULL OR s.not_after > now())
    JOIN public.admins a
      ON a.id = d.principal_id
     AND a.auth_user_id = s.user_id
     AND a.is_active = true
    JOIN public.account_sessions admin_session
      ON admin_session.session_id = s.id
     AND admin_session.user_id = s.user_id
     AND admin_session.revoked_at IS NULL
    WHERE d.id = p_device_id
      AND d.app_variant = 'admin'
      AND d.disabled_at IS NULL

    UNION ALL

    SELECT 1
    FROM public.native_push_devices d
    JOIN auth.sessions s
      ON s.id = d.auth_session_id::uuid
     AND s.user_id = d.principal_id
     AND (s.not_after IS NULL OR s.not_after > now())
    JOIN public.customer_account_links l
      ON l.customer_id = d.customer_id
     AND l.auth_user_id = d.principal_id
    JOIN public.customers c
      ON c.id = l.customer_id
     AND c.is_active = true
     AND c.deleted_at IS NULL
     AND c.status <> 'DELETED'
    WHERE d.id = p_device_id
      AND d.app_variant = 'customer'
      AND d.disabled_at IS NULL
      AND (
        p_allow_account_status_notice IS TRUE
        OR (
          l.account_status = 'ACTIVE'
          AND EXISTS (
            SELECT 1 FROM public.customer_account_sessions cs
            WHERE cs.customer_id = d.customer_id
              AND cs.auth_user_id = d.principal_id
              AND cs.session_id = s.id
              AND cs.revoked_at IS NULL
              AND cs.expires_at > now()
          )
        )
      )
  );
$function$;

REVOKE ALL ON FUNCTION public.native_push_device_is_current(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.native_push_device_is_current(uuid, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_native_push_delivery(
  p_event_key text,
  p_device_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_claimed boolean := false;
BEGIN
  INSERT INTO public.native_push_delivery_attempts (
    event_key, device_id, status, attempt_count, updated_at
  )
  VALUES (p_event_key, p_device_id, 'SENDING', 1, now())
  ON CONFLICT (event_key, device_id) DO UPDATE
    SET status = 'SENDING',
        attempt_count = public.native_push_delivery_attempts.attempt_count + 1,
        error_code = NULL,
        updated_at = now()
    WHERE public.native_push_delivery_attempts.attempt_count < 3
      AND (
        public.native_push_delivery_attempts.status = 'FAILED'
        OR (
          public.native_push_delivery_attempts.status = 'SENDING'
          AND public.native_push_delivery_attempts.updated_at < now() - interval '2 minutes'
        )
      )
  RETURNING true INTO v_claimed;

  RETURN COALESCE(v_claimed, false);
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_native_push_delivery(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_native_push_delivery(text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.trigger_native_push_for_qr_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status <> 'PENDING' THEN
    RETURN NEW;
  END IF;
  PERFORM public.enqueue_native_push_event(
    'qr_payment_submissions', NEW.id, TG_OP, NEW.status::text
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_native_push_for_customer_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM public.enqueue_native_push_event(
    'customer_account_events', NEW.id, TG_OP, NEW.event_type::text
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_native_push_for_goal_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;
  PERFORM public.enqueue_native_push_event(
    'goal_requests', NEW.id, TG_OP, NEW.status::text
  );
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trigger_native_push_for_qr_payment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trigger_native_push_for_customer_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trigger_native_push_for_goal_request() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS native_push_qr_payment_submission ON public.qr_payment_submissions;
CREATE TRIGGER native_push_qr_payment_submission
AFTER INSERT OR UPDATE OF status ON public.qr_payment_submissions
FOR EACH ROW EXECUTE FUNCTION public.trigger_native_push_for_qr_payment();

DROP TRIGGER IF EXISTS native_push_customer_account_event ON public.customer_account_events;
CREATE TRIGGER native_push_customer_account_event
AFTER INSERT ON public.customer_account_events
FOR EACH ROW EXECUTE FUNCTION public.trigger_native_push_for_customer_event();

DROP TRIGGER IF EXISTS native_push_goal_request_reviewed ON public.goal_requests;
CREATE TRIGGER native_push_goal_request_reviewed
AFTER UPDATE OF status ON public.goal_requests
FOR EACH ROW EXECUTE FUNCTION public.trigger_native_push_for_goal_request();

COMMENT ON TABLE public.native_push_devices IS
  'FCM device bindings for authenticated admin/customer installations; no notification content is stored here.';
COMMENT ON TABLE public.native_push_delivery_attempts IS
  'Idempotency and delivery diagnostics for native push; canonical notification content remains in existing business event tables.';
