-- Preserve the canonical sync dispatcher and all existing contracts while allowing
-- authenticated Super Admins to complete delivery even when a customer is over limit.
-- The UI warning is informational and must never turn into a server-side rejection
-- for Super Admin. The exact-match guard below fails closed if the deployed function
-- body has drifted from the audited canonical contract.
DO $migration$
DECLARE
    v_function_definition TEXT;
    v_old_guard TEXT := $old$
                IF (
                    (v_rec_item.debt_limit_minor > 0 AND v_projected_balance < (-v_rec_item.debt_limit_minor))
                    OR
                    (v_rec_item.debt_limit_minor < 0 AND v_projected_balance < v_rec_item.debt_limit_minor)
                    OR
                    (v_rec_item.debt_limit_minor = 0 AND v_projected_balance < 0)
                ) THEN
                    RAISE EXCEPTION 'Debt Limit Exceeded: Customer debt limit % exceeded by projected balance %',
                        v_rec_item.debt_limit_minor, v_projected_balance;
                END IF;
$old$;
    v_new_guard TEXT := $new$
                IF COALESCE(v_admin_role, '') NOT IN ('SUPER_ADMIN', 'Super Admin') AND (
                    (v_rec_item.debt_limit_minor > 0 AND v_projected_balance < (-v_rec_item.debt_limit_minor))
                    OR
                    (v_rec_item.debt_limit_minor < 0 AND v_projected_balance < v_rec_item.debt_limit_minor)
                    OR
                    (v_rec_item.debt_limit_minor = 0 AND v_projected_balance < 0)
                ) THEN
                    RAISE EXCEPTION 'Debt Limit Exceeded: Customer debt limit % exceeded by projected balance %',
                        v_rec_item.debt_limit_minor, v_projected_balance;
                END IF;
$new$;
    v_replaced_definition TEXT;
BEGIN
    SELECT pg_get_functiondef(
        'public.execute_canonical_sync_command(uuid,text,jsonb,text,text,uuid)'::regprocedure
    )
    INTO v_function_definition;

    IF v_function_definition IS NULL THEN
        RAISE EXCEPTION 'Canonical sync dispatcher was not found; refusing to alter debt-limit behavior';
    END IF;

    IF position(v_old_guard IN v_function_definition) = 0 THEN
        RAISE EXCEPTION 'Expected canonical debt-limit guard was not found; refusing an unsafe dispatcher rewrite';
    END IF;

    v_replaced_definition := replace(v_function_definition, v_old_guard, v_new_guard);

    IF v_replaced_definition = v_function_definition
       OR (length(v_function_definition) - length(replace(v_function_definition, v_old_guard, ''))) <> length(v_old_guard) THEN
        RAISE EXCEPTION 'Canonical debt-limit guard was not replaced exactly once; refusing an unsafe dispatcher rewrite';
    END IF;

    EXECUTE v_replaced_definition;
END;
$migration$;
