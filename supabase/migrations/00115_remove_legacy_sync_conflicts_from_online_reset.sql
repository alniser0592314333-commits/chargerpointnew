/**
 * Migration 00115: Remove legacy sync_conflicts dependency from Online Business Reset.
 *
 * Root cause: the canonical schema no longer contains public.sync_conflicts, but
 * the reset RPC installed by migration 00103 still executes DELETE FROM sync_conflicts.
 * PostgreSQL therefore aborts the entire reset transaction with SQLSTATE 42P01.
 *
 * This migration intentionally replaces only reset_online_business_data. It does not
 * create a compatibility table because sync_conflicts is not part of the authoritative
 * canonical schema and recreating it would preserve obsolete architecture.
 */

CREATE OR REPLACE FUNCTION reset_online_business_data(
    p_entered_bin TEXT
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
DECLARE
    v_admin_id UUID;
    v_admin_role VARCHAR(50);
    v_is_active BOOLEAN;
    v_bin_verified BOOLEAN := FALSE;
    v_reset_id UUID := gen_random_uuid();
    v_completed_at TIMESTAMPTZ := NOW();
    v_new_reset_generation BIGINT := 1;
    
    v_count_goal_requests INT := 0;
    v_count_goals INT := 0;
    v_count_payment_allocations INT := 0;
    v_count_financial_ledger INT := 0;
    v_count_payments INT := 0;
    v_count_order_items INT := 0;
    v_count_orders INT := 0;
    v_count_qr_tokens INT := 0;
    v_count_customers INT := 0;
    v_count_business_days INT := 0;
    v_count_device_types INT := 0;
    v_count_change_log INT := 0;
    v_count_processed_commands INT := 0;
BEGIN
    -- 1. AUTHENTICATION PREFLIGHT
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required: caller must be signed in via Supabase Auth';
    END IF;

    -- 2. MANDATORY NON-EMPTY BIN FORMAT VALIDATION
    IF p_entered_bin IS NULL OR trim(p_entered_bin) = '' THEN
        RAISE EXCEPTION 'Invalid BIN: Entered BIN cannot be empty, null, or whitespace';
    END IF;

    -- 3. RESOLVE CALLER ADMIN RECORD FROM auth.uid()
    SELECT id, role, is_active
    INTO v_admin_id, v_admin_role, v_is_active
    FROM admins
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    IF v_admin_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Caller is not a registered admin profile';
    END IF;

    IF v_is_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Forbidden: Admin account is inactive or disabled';
    END IF;

    -- 4. AUTHORIZATION PREFLIGHT CHECK
    IF v_admin_role NOT IN ('SUPER_ADMIN', 'Super Admin') THEN
        IF NOT EXISTS (
            SELECT 1 FROM get_effective_permissions(v_admin_id) 
            WHERE permission IN ('settings:manage', 'admin:manage', 'SUPER_ADMIN')
        ) THEN
            RAISE EXCEPTION 'Forbidden: Admin lacks settings:manage permission required for Online Reset';
        END IF;
    END IF;

    -- 5. MANDATORY SERVER-SIDE BIN VERIFICATION
    v_bin_verified := verify_admin_bin(p_entered_bin);
    IF v_bin_verified IS NOT TRUE THEN
        RAISE EXCEPTION 'Invalid BIN: Security verification failed for Online Reset';
    END IF;

    -- 6. ACQUIRE TRANSACTION-SCOPED ADVISORY LOCK
    PERFORM pg_advisory_xact_lock(hashtext('online_business_reset_lock'));

    -- 7. INCREMENT SERVER RESET GENERATION AUTHORITATIVELY
    UPDATE public.system_settings
    SET value_number = COALESCE(value_number, 1) + 1, updated_at = NOW()
    WHERE key = 'server_reset_generation'
    RETURNING value_number INTO v_new_reset_generation;

    IF v_new_reset_generation IS NULL THEN
        INSERT INTO public.system_settings (key, value_type, value_number, description)
        VALUES ('server_reset_generation', 'number', 2, 'Server reset generation/incarnation counter')
        ON CONFLICT (key) DO UPDATE SET value_number = public.system_settings.value_number + 1, updated_at = NOW()
        RETURNING value_number INTO v_new_reset_generation;
    END IF;

    -- 8. DISABLE CHANGE LOG & IMMUTABILITY TRIGGERS TEMPORARILY WITHIN THIS TRANSACTION
    BEGIN
        ALTER TABLE customers DISABLE TRIGGER trg_log_customers;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
        ALTER TABLE orders DISABLE TRIGGER trg_log_orders;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
        ALTER TABLE order_items DISABLE TRIGGER trg_log_order_items;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
        ALTER TABLE business_days DISABLE TRIGGER trg_log_business_days;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
        ALTER TABLE device_types DISABLE TRIGGER trg_log_device_types;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    BEGIN
        ALTER TABLE financial_ledger DISABLE TRIGGER trg_immutable_financial_ledger;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- 9. ATOMIC BUSINESS DATA PURGE IN FK DEPENDENCY GRAPH ORDER (WITH EXPLICIT WHERE true CLAUSES)
    DELETE FROM goal_requests WHERE true;
    GET DIAGNOSTICS v_count_goal_requests = ROW_COUNT;

    DELETE FROM goals WHERE true;
    GET DIAGNOSTICS v_count_goals = ROW_COUNT;

    DELETE FROM payment_allocations WHERE true;
    GET DIAGNOSTICS v_count_payment_allocations = ROW_COUNT;

    DELETE FROM financial_ledger WHERE true;
    GET DIAGNOSTICS v_count_financial_ledger = ROW_COUNT;

    DELETE FROM payments WHERE true;
    GET DIAGNOSTICS v_count_payments = ROW_COUNT;

    DELETE FROM order_items WHERE true;
    GET DIAGNOSTICS v_count_order_items = ROW_COUNT;

    DELETE FROM orders WHERE true;
    GET DIAGNOSTICS v_count_orders = ROW_COUNT;

    DELETE FROM qr_tokens WHERE true;
    GET DIAGNOSTICS v_count_qr_tokens = ROW_COUNT;

    DELETE FROM customers WHERE true;
    GET DIAGNOSTICS v_count_customers = ROW_COUNT;

    DELETE FROM business_days WHERE true;
    GET DIAGNOSTICS v_count_business_days = ROW_COUNT;

    DELETE FROM device_types WHERE true;
    GET DIAGNOSTICS v_count_device_types = ROW_COUNT;
    DELETE FROM change_log WHERE true;
    GET DIAGNOSTICS v_count_change_log = ROW_COUNT;

    DELETE FROM processed_commands WHERE true;
    GET DIAGNOSTICS v_count_processed_commands = ROW_COUNT;

    -- 10. RE-ENABLE TRIGGERS PRIOR TO TRANSACTION COMMIT
    BEGIN
        ALTER TABLE customers ENABLE TRIGGER trg_log_customers;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
        ALTER TABLE orders ENABLE TRIGGER trg_log_orders;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
        ALTER TABLE order_items ENABLE TRIGGER trg_log_order_items;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
        ALTER TABLE business_days ENABLE TRIGGER trg_log_business_days;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
        ALTER TABLE device_types ENABLE TRIGGER trg_log_device_types;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    BEGIN
        ALTER TABLE financial_ledger ENABLE TRIGGER trg_immutable_financial_ledger;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- 11. RETURN AUTHORITATIVE JSONB RESULT
    RETURN jsonb_build_object(
        'success', TRUE,
        'operation', 'ONLINE_RESET',
        'resetId', v_reset_id,
        'serverResetGeneration', v_new_reset_generation,
        'completedAt', v_completed_at,
        'deletedCounts', jsonb_build_object(
            'goal_requests', v_count_goal_requests,
            'goals', v_count_goals,
            'payment_allocations', v_count_payment_allocations,
            'financial_ledger', v_count_financial_ledger,
            'payments', v_count_payments,
            'order_items', v_count_order_items,
            'orders', v_count_orders,
            'qr_tokens', v_count_qr_tokens,
            'customers', v_count_customers,
            'business_days', v_count_business_days,
            'device_types', v_count_device_types,
            'change_log', v_count_change_log,
            'processed_commands', v_count_processed_commands
        )
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION reset_online_business_data(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reset_online_business_data(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION reset_online_business_data(TEXT) TO authenticated;

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('00115', 'remove_legacy_sync_conflicts_from_online_reset')
ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name;
