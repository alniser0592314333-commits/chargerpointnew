-- Customer account authentication boundary.
-- This migration is committed to the feature branch only; it is not applied to production.
CREATE TABLE IF NOT EXISTS public.customer_account_links (
  customer_id uuid PRIMARY KEY REFERENCES public.customers(id) ON DELETE CASCADE,
  auth_user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  login_email text NOT NULL UNIQUE,
  auth_provider text NOT NULL DEFAULT 'password' CHECK (auth_provider IN ('password', 'google', 'apple', 'facebook')),
  account_status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (account_status IN ('ACTIVE', 'FROZEN', 'CANCELLED')),
  must_change_password boolean NOT NULL DEFAULT false,
  email_verified boolean NOT NULL DEFAULT false,
  terms_version text NOT NULL,
  terms_accepted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  password_changed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

-- One current device/session per customer. A newer successful login replaces the
-- session id here; all customer data reads must check this registry on the server.
CREATE TABLE IF NOT EXISTS public.customer_account_sessions (
  customer_id uuid PRIMARY KEY REFERENCES public.customer_account_links(customer_id) ON DELETE CASCADE,
  auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  auth_issued_at bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS customer_account_sessions_auth_user_idx
  ON public.customer_account_sessions(auth_user_id);

CREATE TABLE IF NOT EXISTS public.customer_account_reset_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  requested_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (statement_timestamp() + interval '2 hours'),
  processed_at timestamptz,
  processed_by uuid REFERENCES public.admins(id),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_account_one_pending_reset_idx
  ON public.customer_account_reset_requests(customer_id)
  WHERE status IN ('PENDING', 'PROCESSING');

CREATE TABLE IF NOT EXISTS public.customer_account_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  event_type text NOT NULL
    CHECK (event_type IN ('RESET_REQUESTED', 'TEMP_PASSWORD_ISSUED', 'PASSWORD_CHANGED', 'EMAIL_RESET_SENT', 'ACCOUNT_FROZEN', 'ACCOUNT_REACTIVATED', 'ACCOUNT_CANCELLED', 'TERMS_ACCEPTED')),
  request_id uuid REFERENCES public.customer_account_reset_requests(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  read_at timestamptz,
  read_by uuid REFERENCES public.admins(id)
);
CREATE INDEX IF NOT EXISTS customer_account_events_admin_inbox_idx
  ON public.customer_account_events(is_read, created_at DESC);

ALTER TABLE public.customer_account_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_account_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_account_reset_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_account_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.customer_account_links FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.customer_account_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.customer_account_reset_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.customer_account_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.customer_account_links TO service_role;
GRANT ALL ON TABLE public.customer_account_sessions TO service_role;
GRANT ALL ON TABLE public.customer_account_reset_requests TO service_role;
GRANT ALL ON TABLE public.customer_account_events TO service_role;


-- Server-side per-customer throttling for password and recovery actions.
CREATE TABLE IF NOT EXISTS public.customer_account_rate_limits (
  rate_key text NOT NULL,
  action text NOT NULL CHECK (action IN ('LOGIN', 'ACTIVATE', 'RESET_REQUEST', 'EMAIL_RESET', 'SOCIAL_ACTIVATE')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  window_started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (rate_key, action)
);
ALTER TABLE public.customer_account_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.customer_account_rate_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.customer_account_rate_limits TO service_role;

CREATE OR REPLACE FUNCTION public.customer_account_consume_rate_limit(
  p_rate_key text,
  p_action text,
  p_max_attempts integer,
  p_window_seconds integer,
  p_reset boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_attempts integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_rate_key IS NULL OR length(p_rate_key) < 8 OR length(p_rate_key) > 128
     OR p_action IS NULL OR p_action NOT IN ('LOGIN', 'ACTIVATE', 'RESET_REQUEST', 'EMAIL_RESET', 'SOCIAL_ACTIVATE')
     OR p_max_attempts IS NULL OR p_max_attempts < 1
     OR p_window_seconds IS NULL OR p_window_seconds < 1 OR p_window_seconds > 86400 THEN
    RETURN false;
  END IF;

  INSERT INTO public.customer_account_rate_limits AS current_rate (rate_key, action, attempts, window_started_at, updated_at)
  VALUES (p_rate_key, p_action, CASE WHEN p_reset THEN 0 ELSE 1 END, v_now, v_now)
  ON CONFLICT (rate_key, action) DO UPDATE SET
    attempts = CASE
      WHEN p_reset THEN 0
      WHEN current_rate.window_started_at <= v_now - make_interval(secs => p_window_seconds) THEN 1
      ELSE current_rate.attempts + 1
    END,
    window_started_at = CASE
      WHEN p_reset OR current_rate.window_started_at <= v_now - make_interval(secs => p_window_seconds) THEN v_now
      ELSE current_rate.window_started_at
    END,
    updated_at = v_now
  RETURNING attempts INTO v_attempts;

  RETURN p_reset OR v_attempts <= p_max_attempts;
END;
$function$;

REVOKE ALL ON FUNCTION public.customer_account_consume_rate_limit(text, text, integer, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_account_consume_rate_limit(text, text, integer, integer, boolean) TO service_role;


-- Preserve public order-QR status checks, but customer-QR status requires the
-- matching active customer account session and current terms acceptance.
CREATE OR REPLACE FUNCTION public.public_resolve_qr_payment_submission(p_public_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_target_id uuid;
  v_token_type text;
  v_result jsonb;
  v_session_id uuid;
BEGIN
  IF p_public_token IS NULL OR length(p_public_token) < 20 OR length(p_public_token) > 128 THEN
    RETURN NULL;
  END IF;

  SELECT qt.target_id, qt.token_type INTO v_target_id, v_token_type
  FROM public.qr_tokens qt
  WHERE qt.public_token = p_public_token
    AND qt.token_type IN ('ORDER', 'CUSTOMER')
    AND qt.is_active IS TRUE
    AND (qt.expires_at IS NULL OR qt.expires_at > statement_timestamp())
  LIMIT 1;

  IF v_target_id IS NULL OR v_token_type IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_token_type = 'ORDER' THEN
    SELECT jsonb_build_object(
      'status', s.status,
      'amount_minor', CASE WHEN s.status = 'APPROVED' THEN coalesce(p.amount_minor, s.amount_minor) ELSE NULL END,
      'payment_method', s.payment_method,
      'created_at', s.created_at,
      'reviewed_at', s.reviewed_at
    ) INTO v_result
    FROM public.qr_payment_submissions s
    JOIN public.orders o ON o.id = s.order_id
    JOIN public.customers c ON c.id = s.customer_id
    LEFT JOIN public.payments p ON p.id = s.payment_id
    WHERE s.order_id = v_target_id
      AND o.deleted_at IS NULL
      AND o.cancelled_at IS NULL
      AND c.deleted_at IS NULL
      AND c.is_active IS TRUE
      AND c.status <> 'DELETED'
    ORDER BY s.created_at DESC, s.updated_at DESC, s.id DESC
    LIMIT 1;
  ELSE
    IF auth.uid() IS NULL THEN RETURN NULL; END IF;
    BEGIN
      v_session_id := NULLIF(auth.jwt() ->> 'session_id', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN NULL;
    END;
    IF v_session_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.customer_account_links l
      JOIN public.customer_account_sessions cs
        ON cs.customer_id = l.customer_id AND cs.auth_user_id = l.auth_user_id
      JOIN public.customers c ON c.id = l.customer_id
      WHERE l.customer_id = v_target_id
        AND l.auth_user_id = auth.uid()
        AND l.account_status = 'ACTIVE'
        AND l.must_change_password IS FALSE
        AND l.terms_version = '2026-10-18-v1'
        AND cs.session_id = v_session_id
        AND cs.revoked_at IS NULL
        AND cs.expires_at > statement_timestamp()
        AND c.deleted_at IS NULL
        AND c.is_active IS TRUE
        AND c.status <> 'DELETED'
    ) THEN
      RETURN NULL;
    END IF;

    SELECT jsonb_build_object(
      'status', s.status,
      'amount_minor', CASE WHEN s.status = 'APPROVED' THEN coalesce(p.amount_minor, s.amount_minor) ELSE NULL END,
      'payment_method', s.payment_method,
      'created_at', s.created_at,
      'reviewed_at', s.reviewed_at
    ) INTO v_result
    FROM public.qr_payment_submissions s
    JOIN public.customers c ON c.id = s.customer_id
    LEFT JOIN public.payments p ON p.id = s.payment_id
    WHERE s.customer_id = v_target_id
      AND c.deleted_at IS NULL
      AND c.is_active IS TRUE
      AND c.status <> 'DELETED'
    ORDER BY s.created_at DESC, s.updated_at DESC, s.id DESC
    LIMIT 1;
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.public_resolve_qr_payment_submission(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.public_resolve_qr_payment_submission(text) TO anon, authenticated, service_role;

-- The old QR projection disclosed financial history to anyone holding the QR.
-- From this release forward, only the server-side customer-account function may
-- invoke it after verifying the customer's authenticated user and active session.
REVOKE ALL ON FUNCTION public.public_resolve_customer_portal(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_resolve_customer_portal(text) TO service_role;
