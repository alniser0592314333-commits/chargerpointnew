-- Close two authenticated RPC paths that could mutate goal/QR state without
-- the application's corresponding permission. This is an RPC authorization-only
-- change: it does not alter rows, sync cursors, payload shape, or offline storage.

CREATE OR REPLACE FUNCTION public.evaluate_customer_active_goal(p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Evaluation can update goal progress and create a financial BONUS ledger row.
  -- Require the goal-view capability rather than relying on the UI to hide this RPC.
  PERFORM public._cp_assert_active_admin_permission('goals:view');
  RETURN public.evaluate_customer_active_goal__session_guarded_impl(p_customer_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.evaluate_customer_active_goal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.evaluate_customer_active_goal(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.adopt_customer_qr_token(
  p_customer_id uuid,
  p_public_token text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_existing_token text;
  v_token text;
BEGIN
  -- QR adoption changes the customer's active public capability token.
  -- Require customer-view permission in addition to a valid active admin session.
  PERFORM public._cp_assert_active_admin_permission('customers:view');

  IF COALESCE(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true))
       IS DISTINCT FROM 'service_role'
     AND public.is_active_admin_session() IS NOT TRUE
  THEN
    RAISE EXCEPTION 'Active administrator account required'
      USING ERRCODE = '42501';
  END IF;

  IF p_customer_id IS NULL
     OR p_public_token IS NULL
     OR p_public_token !~ '^[A-Za-z0-9_-]{24,64}$'
  THEN
    RAISE EXCEPTION 'Invalid legacy customer QR identity';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.customers AS c
    WHERE c.id = p_customer_id
      AND c.is_active = TRUE
      AND c.deleted_at IS NULL
      AND c.status <> 'DELETED'
  ) THEN
    RAISE EXCEPTION 'Active customer not found for legacy QR adoption';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('customer-qr:' || p_customer_id::text, 0));

  SELECT qt.public_token
    INTO v_existing_token
  FROM public.qr_tokens AS qt
  WHERE qt.target_id = p_customer_id
    AND qt.token_type = 'CUSTOMER'
    AND qt.is_active = TRUE
    AND (qt.expires_at IS NULL OR qt.expires_at > now())
  LIMIT 1;

  IF v_existing_token IS NOT NULL THEN
    RETURN v_existing_token;
  END IF;

  UPDATE public.qr_tokens
  SET is_active = FALSE
  WHERE target_id = p_customer_id
    AND token_type = 'CUSTOMER'
    AND is_active = TRUE;

  v_token := p_public_token;

  IF EXISTS (SELECT 1 FROM public.qr_tokens AS qt WHERE qt.public_token = v_token) THEN
    LOOP
      v_token := replace(replace(replace(encode(gen_random_bytes(24), 'base64'), '+', '-'), '/', '_'), '=', '');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.qr_tokens AS qt WHERE qt.public_token = v_token);
    END LOOP;
  END IF;

  INSERT INTO public.qr_tokens (
    id, token_hash, public_token, token_type, target_id, is_active, expires_at, created_at
  )
  VALUES (
    gen_random_uuid(),
    encode(digest(v_token, 'sha256'), 'hex'),
    v_token,
    'CUSTOMER',
    p_customer_id,
    TRUE,
    NULL,
    now()
  );

  RETURN v_token;
END;
$function$;

REVOKE ALL ON FUNCTION public.adopt_customer_qr_token(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adopt_customer_qr_token(uuid, text) TO authenticated, service_role;

-- Full bootstrap and delta pulls contain business-wide operational and financial
-- data. Require the explicit sync-management capability at the server boundary;
-- an active Auth/admin session alone is not sufficient.
CREATE OR REPLACE FUNCTION public.capture_sync_bootstrap_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._cp_assert_active_admin_permission('sync:manage');
  RETURN public.capture_sync_bootstrap_snapshot__session_guarded_impl();
END;
$function$;

REVOKE ALL ON FUNCTION public.capture_sync_bootstrap_snapshot() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.capture_sync_bootstrap_snapshot() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pull_canonical_changes(
  p_since_sequence bigint,
  p_limit integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._cp_assert_active_admin_permission('sync:manage');
  RETURN public.pull_canonical_changes__session_guarded_impl(p_since_sequence, p_limit);
END;
$function$;

REVOKE ALL ON FUNCTION public.pull_canonical_changes(bigint, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pull_canonical_changes(bigint, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
