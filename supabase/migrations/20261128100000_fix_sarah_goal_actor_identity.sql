-- Fix Sarah goal creation identity binding.
--
-- execute_sync_command__session_guarded_impl passes auth.uid() as p_actor_id.
-- The goal-specific canonical command resolves v_actor_id to admins.id, so
-- comparing those two different identifier domains incorrectly rejects every
-- authenticated admin (including SUPER_ADMIN) with SQLSTATE 42501.
--
-- Keep the canonical admin lookup and role/permission checks intact; validate
-- the supplied actor against the authenticated user instead. The stored
-- actor_admin_id continues to use the resolved admins.id (v_actor_id).

DO $migration$
DECLARE
  v_definition text;
  v_old text := 'IF p_actor_id IS NOT NULL AND p_actor_id<>v_actor_id THEN';
  v_new text := 'IF p_actor_id IS NOT NULL AND p_actor_id<>auth.uid() THEN';
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.execute_canonical_sync_command_unlocked(uuid,text,jsonb,text,text,uuid)'::regprocedure
  )
  INTO v_definition;

  IF pg_catalog.strpos(v_definition, v_old) > 0 THEN
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
    EXECUTE v_definition;
  ELSIF pg_catalog.strpos(v_definition, v_new) = 0 THEN
    RAISE EXCEPTION 'Unexpected execute_canonical_sync_command_unlocked actor guard; refusing unsafe patch';
  END IF;
END;
$migration$;
