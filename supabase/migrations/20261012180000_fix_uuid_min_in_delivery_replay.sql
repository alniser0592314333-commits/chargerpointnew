-- Fix delivery replay for UUID ledger identifiers.
-- PostgreSQL has no MIN(uuid) aggregate. Preserve the prior intent of selecting
-- the lowest UUID deterministically while keeping the charge count and amount
-- calculation unchanged. This migration is safe if the live hotfix was already
-- applied: it becomes a no-op when the corrected expression is present.

BEGIN;

DO $migration$
DECLARE
    v_definition TEXT;
    v_old TEXT := 'SELECT COUNT(*), MIN(id), MIN(amount_minor)';
    v_new TEXT := 'SELECT COUNT(*), (array_agg(id ORDER BY id))[1], MIN(amount_minor)';
    v_occurrences INTEGER;
BEGIN
    SELECT pg_get_functiondef(
        'public.execute_canonical_sync_command(uuid,text,jsonb,text,text,uuid)'::regprocedure
    )
    INTO v_definition;

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
            'Cannot safely patch execute_canonical_sync_command: expected one old expression or the corrected expression, found % old occurrences',
            v_occurrences;
    END IF;
END;
$migration$;

COMMIT;
