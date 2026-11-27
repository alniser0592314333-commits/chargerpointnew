-- Regression contract for the Sarah CREATE_GOAL actor identity boundary.
-- The sync wrapper passes auth.uid(); the goal-specific command resolves
-- admins.id separately and must not compare those two UUID domains.

DO $goal_actor_identity_contract$
DECLARE
  v_definition text;
  v_normalized text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.execute_canonical_sync_command_unlocked(uuid,text,jsonb,text,text,uuid)'::regprocedure
  )
  INTO v_definition;

  v_normalized := pg_catalog.regexp_replace(v_definition, '[[:space:]]+', '', 'g');

  IF pg_catalog.strpos(
    v_normalized,
    'IFp_actor_idISNOTNULLANDp_actor_id<>auth.uid()THEN'
  ) = 0 THEN
    RAISE EXCEPTION 'Goal actor guard must compare p_actor_id with auth.uid()';
  END IF;

  IF pg_catalog.strpos(
    v_normalized,
    'IFp_actor_idISNOTNULLANDp_actor_id<>v_actor_idTHEN'
  ) > 0 THEN
    RAISE EXCEPTION 'Goal actor guard still compares auth user ID with admins.id';
  END IF;
END;
$goal_actor_identity_contract$;
