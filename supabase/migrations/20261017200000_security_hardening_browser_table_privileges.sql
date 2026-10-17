-- Security hardening: bind authenticated table reads to active administrator identities
-- and remove TRUNCATE from browser-facing roles.
--
-- The existing authenticated_read policies only checked that an Auth session was
-- active. They did not verify that auth.uid() belonged to an active admin. The app's
-- customer portal remains capability-QR based; customer Auth is not enabled by this
-- migration. This preserves existing administrator reads while rejecting arbitrary
-- authenticated users from these admin-data policies.
CREATE OR REPLACE FUNCTION public.is_active_admin_session()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT auth.uid() IS NOT NULL
     AND public.is_my_account_session_active() IS TRUE
     AND EXISTS (
       SELECT 1
       FROM public.admins AS a
       WHERE a.auth_user_id = auth.uid()
         AND a.is_active = TRUE
     );
$function$;

REVOKE ALL ON FUNCTION public.is_active_admin_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_admin_session() TO authenticated, service_role;

-- Replace the shared policy only where the current policy has the known name and
-- role. Preserve each table's other policies and grants.
DO $policies$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname = 'authenticated_read'
      AND cmd = 'SELECT'
      AND roles::text LIKE '%authenticated%'
  LOOP
    EXECUTE format(
      'DROP POLICY %I ON %I.%I',
      v_policy.policyname, v_policy.schemaname, v_policy.tablename
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I FOR SELECT TO authenticated USING (public.is_active_admin_session())',
      v_policy.policyname, v_policy.schemaname, v_policy.tablename
    );
  END LOOP;
END
$policies$;

-- RLS does not protect TRUNCATE. Remove grants from PUBLIC as well as browser roles
-- so an inherited PUBLIC grant cannot silently preserve the dangerous privilege.
DO $truncate$
DECLARE
  v_table record;
BEGIN
  FOR v_table IN
    SELECT format('%I.%I', n.nspname, c.relname) AS qualified_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format(
      'REVOKE TRUNCATE ON TABLE %s FROM PUBLIC, anon, authenticated',
      v_table.qualified_name
    );
  END LOOP;
END
$truncate$;

-- Public QR holders need submission status and the approved amount, not account balances.
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
BEGIN
  IF p_public_token IS NULL OR length(p_public_token) < 20 OR length(p_public_token) > 128 THEN
    RETURN NULL;
  END IF;

  SELECT qt.target_id, qt.token_type INTO v_target_id, v_token_type
  FROM public.qr_tokens qt
  WHERE qt.public_token = p_public_token
    AND qt.token_type IN ('ORDER', 'CUSTOMER')
    AND qt.is_active = true
    AND (qt.expires_at IS NULL OR qt.expires_at > now())
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
      AND c.is_active = true
      AND c.status <> 'DELETED'
    ORDER BY s.created_at DESC, s.updated_at DESC, s.id DESC
    LIMIT 1;
  ELSE
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
      AND c.is_active = true
      AND c.status <> 'DELETED'
    ORDER BY s.created_at DESC, s.updated_at DESC, s.id DESC
    LIMIT 1;
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.public_resolve_qr_payment_submission(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_resolve_qr_payment_submission(text) TO anon, authenticated;

-- Prevent future tables created by this migration owner from inheriting TRUNCATE
-- for PUBLIC or browser roles. Other owner-specific default privilege configurations
-- are otherwise left untouched.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE TRUNCATE ON TABLES FROM PUBLIC, anon, authenticated;
