-- Enable only a trusted service-role server process to deliver pending items.
-- Preserve normal admin authentication and never attribute automation to a human.
DO $migration$
DECLARE
  v_definition text;
  v_old text := $old$    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required: caller must be signed in via Supabase Auth'
            USING ERRCODE = 'P0001';
    END IF;

    v_actor_id := auth.uid();
    SELECT id, role, is_active INTO v_actor_id, v_admin_role, v_is_active
    FROM public.admins WHERE auth_user_id = auth.uid() LIMIT 1;

    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Caller is not a registered admin profile'
            USING ERRCODE = 'P0001';
    END IF;

    IF v_is_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Forbidden: Admin account is inactive or disabled'
            USING ERRCODE = 'P0001';
    END IF;$old$;
  v_new text := $new$    IF COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role'
       AND p_command_type = 'DELIVER_ORDER_ITEM'
       AND COALESCE((p_payload->>'autoDelivery')::boolean, false) THEN
        v_actor_id := NULL;
        v_admin_role := 'SUPER_ADMIN';
        v_is_active := TRUE;
    ELSIF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required: caller must be signed in via Supabase Auth'
            USING ERRCODE = 'P0001';
    ELSE
        v_actor_id := auth.uid();
        SELECT id, role, is_active INTO v_actor_id, v_admin_role, v_is_active
        FROM public.admins WHERE auth_user_id = auth.uid() LIMIT 1;
        IF v_actor_id IS NULL THEN
            RAISE EXCEPTION 'Unauthorized: Caller is not a registered admin profile'
                USING ERRCODE = 'P0001';
        END IF;
        IF v_is_active IS NOT TRUE THEN
            RAISE EXCEPTION 'Forbidden: Admin account is inactive or disabled'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'execute_canonical_sync_command'
    AND pg_get_function_identity_arguments(p.oid) LIKE 'p_command_id uuid, p_command_type text, p_payload jsonb%';
  IF v_definition IS NULL OR position(v_old in v_definition) = 0 THEN
    RAISE EXCEPTION 'Canonical command authentication block did not match; refusing unsafe migration';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$migration$;
NOTIFY pgrst, 'reload schema';
-- The canonical RPC is intentionally not granted to anon/PUBLIC; explicitly allow
-- the trusted Edge Function's service_role to invoke the guarded dispatcher.
GRANT EXECUTE ON FUNCTION public.execute_canonical_sync_command(UUID, TEXT, JSONB, TEXT, TEXT, UUID) TO service_role;

