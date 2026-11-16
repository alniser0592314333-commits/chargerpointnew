-- Debt reminders may be delivered to a registered customer device after the
-- short-lived customer portal session expires. Do not bypass Supabase Auth
-- session validity or the customer's active account/customer status.

CREATE OR REPLACE FUNCTION public.native_push_device_is_current(
  p_device_id uuid,
  p_allow_account_status_notice boolean,
  p_allow_expired_customer_app_session boolean
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
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
    WHERE d.id = p_device_id
      AND EXISTS (
        SELECT 1 FROM public.account_sessions admin_session
        WHERE admin_session.session_id = s.id
          AND admin_session.user_id = s.user_id
          AND admin_session.revoked_at IS NULL
      )
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
     AND (p_allow_account_status_notice IS TRUE OR c.is_active IS TRUE)
     AND c.deleted_at IS NULL
     AND c.status <> 'DELETED'
    WHERE d.id = p_device_id
      AND d.app_variant = 'customer'
      AND d.disabled_at IS NULL
      AND (
        p_allow_account_status_notice IS TRUE
        OR l.account_status = 'ACTIVE'
      )
      AND (
        p_allow_account_status_notice IS TRUE
        OR p_allow_expired_customer_app_session IS TRUE
        OR EXISTS (
          SELECT 1 FROM public.customer_account_sessions cs
          WHERE cs.customer_id = d.customer_id
            AND cs.auth_user_id = d.principal_id
            AND cs.session_id = s.id
            AND cs.revoked_at IS NULL
            AND cs.expires_at > now()
        )
      )
  );
$function$;

-- Preserve the existing two-argument contract for any older trusted caller.
CREATE OR REPLACE FUNCTION public.native_push_device_is_current(
  p_device_id uuid,
  p_allow_account_status_notice boolean DEFAULT false
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.native_push_device_is_current(
    p_device_id,
    p_allow_account_status_notice,
    false
  );
$function$;

REVOKE ALL ON FUNCTION public.native_push_device_is_current(uuid, boolean, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.native_push_device_is_current(uuid, boolean, boolean)
  TO service_role;

REVOKE ALL ON FUNCTION public.native_push_device_is_current(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.native_push_device_is_current(uuid, boolean)
  TO service_role;
