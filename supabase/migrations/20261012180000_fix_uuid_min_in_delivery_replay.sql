-- Fix delivery replay for UUID ledger identifiers.
-- PostgreSQL has no MIN(uuid) aggregate. Preserve the prior intent of selecting
-- the lowest UUID deterministically while keeping the charge count and amount
-- calculation unchanged.
--
-- Deployment drift note:
-- The production hotfix may already be present, and the commit-order migration
-- renames the dispatcher implementation to execute_canonical_sync_command_unlocked.
-- Select the implementation function when it exists; otherwise target the
-- original dispatcher. This keeps the migration safe both before and after the
-- wrapper/implementation split without patching the public lock wrapper.

BEGIN;

DO $migration$
DECLARE
    v_target regprocedure;
    v_definition TEXT;
    v_old TEXT := 'SELECT COUNT(*), MIN(id), MIN(amount_minor)';
    v_new TEXT := 'SELECT COUNT(*), (array_agg(id ORDER BY id))[1], MIN(amount_minor)';
    v_occurrences INTEGER;
BEGIN
    v_target := to_regprocedure(
        'public.execute_canonical_sync_command_unlocked(uuid,text,jsonb,text,text,uuid)'
    );

    IF v_target IS NULL THEN
        v_target := to_regprocedure(
            'public.execute_canonical_sync_command(uuid,text,jsonb,text,text,uuid)'
        );
    END IF;

    IF v_target IS NULL THEN
        RAISE EXCEPTION
            'Cannot safely patch delivery replay: canonical dispatcher implementation was not found';
    END IF;

    SELECT pg_get_functiondef(v_target) INTO v_definition;

    v_occurrences :=
        (length(v_definition) - length(replace(v_definition, v_old, '')))
        / length(v_old);

    IF v_occurrences = 1 THEN
        v_definition := replace(v_definition, v_old, v_new);
        EXECUTE v_definition;
    ELSIF v_occurrences = 0 AND position(v_new IN v_definition) > 0 THEN
        -- The fix has already been applied (for example, by an emergency hotfix).
        NULL;
    ELSE
        RAISE EXCEPTION
            'Cannot safely patch delivery replay in %: expected one old expression or the corrected expression, found % old occurrences',
            v_target,
            v_occurrences;
    END IF;
END;
$migration$;

COMMIT;
