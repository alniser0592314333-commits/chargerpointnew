/**
 * Supabase Migration: 00022_fix_online_reset_where_clause_and_device_types.sql
 * Fixes Online Business Reset RPC (`reset_online_business_data`):
 * 1. Adds explicit `WHERE true` clauses to all DELETE statements to resolve SQLSTATE 21000 ("DELETE requires a WHERE clause").
 * 2. Includes `device_types` in the scope of Online Full Reset, so after Online Reset device_types count = 0.
 * 3. Maintains atomic transaction semantics, advisory locking, mandatory server-side BIN verification, and RBAC authorization.
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
    
    v_count_payment_allocations INT := 0;
    v_count_financial_ledger INT := 0;
    v_count_payments INT := 0;
    v_count_order_items INT := 0;
    v_count_orders INT := 0;
    v_count_qr_tokens INT := 0;
    v_count_customers INT := 0;
    v_count_business_days INT := 0;
    v_count_device_types INT := 0;
    v_count_sync_conflicts INT := 0;
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

    -- 6. ACQUIRE TRANSACTION-SCOPED ADVISORY LOCK (MUTUAL EXCLUSION WITH CONCURRENT EXECUTE_SYNC_COMMAND)
    PERFORM pg_advisory_xact_lock(hashtext('online_business_reset_lock'));

    -- 7. DISABLE CHANGE LOG & IMMUTABILITY TRIGGERS TEMPORARILY WITHIN THIS TRANSACTION
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
        ALTER TABLE financial_ledger DISABLE TRIGGER trg_prevent_ledger_tampering;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
        ALTER TABLE financial_ledger DISABLE TRIGGER trg_prevent_ledger_delete;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- 8. ATOMIC BUSINESS DATA PURGE IN FK DEPENDENCY GRAPH ORDER (WITH EXPLICIT WHERE true CLAUSES)
    -- 1) payment_allocations
    DELETE FROM payment_allocations WHERE true;
    GET DIAGNOSTICS v_count_payment_allocations = ROW_COUNT;

    -- 2) financial_ledger
    DELETE FROM financial_ledger WHERE true;
    GET DIAGNOSTICS v_count_financial_ledger = ROW_COUNT;

    -- 3) payments
    DELETE FROM payments WHERE true;
    GET DIAGNOSTICS v_count_payments = ROW_COUNT;

    -- 4) order_items
    DELETE FROM order_items WHERE true;
    GET DIAGNOSTICS v_count_order_items = ROW_COUNT;

    -- 5) orders
    DELETE FROM orders WHERE true;
    GET DIAGNOSTICS v_count_orders = ROW_COUNT;

    -- 6) qr_tokens
    DELETE FROM qr_tokens WHERE true;
    GET DIAGNOSTICS v_count_qr_tokens = ROW_COUNT;

    -- 7) customers
    DELETE FROM customers WHERE true;
    GET DIAGNOSTICS v_count_customers = ROW_COUNT;

    -- 8) business_days
    DELETE FROM business_days WHERE true;
    GET DIAGNOSTICS v_count_business_days = ROW_COUNT;

    -- 9) device_types
    DELETE FROM device_types WHERE true;
    GET DIAGNOSTICS v_count_device_types = ROW_COUNT;

    -- 10) sync_conflicts
    DELETE FROM sync_conflicts WHERE true;
    GET DIAGNOSTICS v_count_sync_conflicts = ROW_COUNT;

    -- 11) change_log
    DELETE FROM change_log WHERE true;
    GET DIAGNOSTICS v_count_change_log = ROW_COUNT;

    -- 12) processed_commands
    DELETE FROM processed_commands WHERE true;
    GET DIAGNOSTICS v_count_processed_commands = ROW_COUNT;

    -- 9. RE-ENABLE TRIGGERS PRIOR TO TRANSACTION COMMIT
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
        ALTER TABLE financial_ledger ENABLE TRIGGER trg_prevent_ledger_tampering;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
        ALTER TABLE financial_ledger ENABLE TRIGGER trg_prevent_ledger_delete;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- 10. RETURN AUTHORITATIVE JSONB RESULT
    RETURN jsonb_build_object(
        'success', TRUE,
        'operation', 'ONLINE_RESET',
        'resetId', v_reset_id,
        'completedAt', v_completed_at,
        'deletedCounts', jsonb_build_object(
            'payment_allocations', v_count_payment_allocations,
            'financial_ledger', v_count_financial_ledger,
            'payments', v_count_payments,
            'order_items', v_count_order_items,
            'orders', v_count_orders,
            'qr_tokens', v_count_qr_tokens,
            'customers', v_count_customers,
            'business_days', v_count_business_days,
            'device_types', v_count_device_types,
            'sync_conflicts', v_count_sync_conflicts,
            'change_log', v_count_change_log,
            'processed_commands', v_count_processed_commands
        )
    );
END;
$$;
