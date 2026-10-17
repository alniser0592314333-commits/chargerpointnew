-- Administrative BIN reset is for other admin accounts only.
-- Self-service BIN changes must use the recent-password/current-BIN proof flow.
CREATE OR REPLACE FUNCTION public.rpc_update_admin_bin(
  p_target_admin_id uuid,
  p_new_bin text,
  p_caller_bin text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.assert_my_account_session_active();

  IF auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.admins AS target
    WHERE target.id = p_target_admin_id
      AND target.auth_user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Use the proof-gated self-service BIN change flow for your own account'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.rpc_update_admin_bin__session_guarded_impl(
    p_target_admin_id,
    p_new_bin,
    p_caller_bin
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_update_admin_bin(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_admin_bin(uuid, text, text) TO authenticated, service_role;

-- The parallel administrator password-reset RPC has the same self-target issue:
-- it updates auth.users directly and must remain a reset-for-others path only.
CREATE OR REPLACE FUNCTION public.rpc_update_admin_password(
  p_target_admin_id uuid,
  p_new_password text,
  p_caller_bin text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.assert_my_account_session_active();

  IF auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.admins AS target
    WHERE target.id = p_target_admin_id
      AND target.auth_user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Use the authenticated self-service password-change flow for your own account'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.rpc_update_admin_password__session_guarded_impl(
    p_target_admin_id,
    p_new_password,
    p_caller_bin
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_update_admin_password(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_admin_password(uuid, text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
