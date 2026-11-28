-- Enforce one active administrator application session per Auth subject.
-- A new password/biometric Auth session is a deliberate new sign-in. Reuse of the
-- same Auth session (refresh, app resume, route changes) does not INSERT a row and
-- therefore does not revoke the current device. Customer portal sessions are separate.

ALTER TABLE public.account_sessions
  ADD COLUMN IF NOT EXISTS revocation_reason text;

CREATE OR REPLACE FUNCTION public.enforce_single_active_admin_session()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_auth_created_at timestamptz;
  v_auth_not_after timestamptz;
  v_is_active_admin boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.revoked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.created_at, s.not_after
    INTO v_auth_created_at, v_auth_not_after
  FROM auth.sessions s
  WHERE s.id = NEW.session_id
    AND s.user_id = NEW.user_id;

  -- Only a real, currently valid, recently created Auth session can establish
  -- a new device. Old sessions are never promoted by this trigger.
  IF NOT FOUND
     OR v_auth_created_at IS NULL
     OR v_auth_created_at < now() - interval '5 minutes'
     OR (v_auth_not_after IS NOT NULL AND v_auth_not_after <= now()) THEN
    RETURN NEW;
  END IF;

  IF to_regclass('public.admins') IS NULL THEN
    RETURN NEW;
  END IF;

  EXECUTE $admin_check$
    SELECT EXISTS (
      SELECT 1 FROM public.admins a
      WHERE a.auth_user_id = $1
        AND a.is_active IS TRUE
        AND a.disabled_at IS NULL
    )
  $admin_check$
  INTO v_is_active_admin
  USING NEW.user_id;

  IF NOT v_is_active_admin THEN
    RETURN NEW;
  END IF;

  -- Serialize simultaneous sign-ins for one account. The last transaction
  -- to register a fresh Auth session wins; different accounts do not block.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 7242026));

  UPDATE public.account_sessions a
  SET revoked_at = COALESCE(a.revoked_at, clock_timestamp()),
      revoked_by_session_id = NEW.session_id,
      revocation_reason = 'new_login'
  WHERE a.user_id = NEW.user_id
    AND a.session_id <> NEW.session_id
    AND a.revoked_at IS NULL;

  -- Revoke the old refresh-token families and mark their Auth sessions as
  -- ended. Their already-issued JWTs may live until exp, but the application
  -- session guard rejects them immediately because account_sessions is revoked.
  UPDATE auth.refresh_tokens rt
  SET revoked = true, updated_at = now()
  WHERE rt.user_id = NEW.user_id::text
    AND rt.session_id IN (
      SELECT s.id
      FROM auth.sessions s
      WHERE s.user_id = NEW.user_id
        AND s.id <> NEW.session_id
    )
    AND rt.revoked IS NOT TRUE;

  UPDATE auth.sessions s
  SET not_after = LEAST(COALESCE(s.not_after, now()), now())
  WHERE s.user_id = NEW.user_id
    AND s.id <> NEW.session_id
    AND (s.not_after IS NULL OR s.not_after > now());

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_single_active_admin_session()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS account_sessions_single_active_admin_login
  ON public.account_sessions;

CREATE TRIGGER account_sessions_single_active_admin_login
AFTER INSERT ON public.account_sessions
FOR EACH ROW
EXECUTE FUNCTION public.enforce_single_active_admin_session();

-- Return the current session plus a bounded recent history. This avoids an
-- unbounded settings list while preserving evidence of automatically replaced logins.
CREATE OR REPLACE FUNCTION public.get_my_account_sessions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_current_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL OR v_current_session_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated current session required'
      USING ERRCODE = '28000';
  END IF;

  IF public.is_my_account_session_active() IS NOT TRUE THEN
    RAISE EXCEPTION 'Current application session is not active'
      USING ERRCODE = '28000';
  END IF;

  SELECT COALESCE(jsonb_agg(row_data ORDER BY is_current DESC, last_seen_at DESC), '[]'::jsonb)
    INTO v_result
  FROM (
    SELECT
      jsonb_build_object(
        'session_id', a.session_id,
        'user_agent', COALESCE(a.user_agent, s.user_agent),
        'created_at', a.created_at,
        'last_seen_at', GREATEST(a.last_seen_at, COALESCE(s.updated_at, a.last_seen_at)),
        'client_type', a.client_type,
        'session_expires_at', a.session_expires_at,
        'is_expired', a.session_expires_at <= now() OR (s.not_after IS NOT NULL AND s.not_after <= now()),
        'is_current', a.session_id = v_current_session_id,
        'revoked_at', a.revoked_at,
        'revoked_by_session_id', a.revoked_by_session_id,
        'revocation_reason', a.revocation_reason
      ) AS row_data,
      (a.session_id = v_current_session_id) AS is_current,
      a.last_seen_at
    FROM public.account_sessions a
    JOIN auth.sessions s
      ON s.id = a.session_id
     AND s.user_id = v_user_id
    WHERE a.user_id = v_user_id
    ORDER BY (a.session_id = v_current_session_id) DESC, a.last_seen_at DESC
    LIMIT 25
  ) recent;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_my_account_sessions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_account_sessions() TO authenticated;

NOTIFY pgrst, 'reload schema';
