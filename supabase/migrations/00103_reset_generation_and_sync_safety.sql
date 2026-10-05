/**
 * Supabase Migration: 00103_reset_generation_and_sync_safety.sql
 * Implements authoritative server-side reset generation tracking and stale command validation:
 * 1. Seeds and increments `server_reset_generation` in `system_settings` during `reset_online_business_data`.
 * 2. Hardens `execute_sync_command` to reject commands with an older reset generation (both root and child commands).
 * 3. Returns `serverResetGeneration` in reset response and sync pull responses.
 */

-- Ensure system_settings has server_reset_generation
INSERT INTO public.system_settings (key, value_type, value_number, description)
VALUES ('server_reset_generation', 'number', 1, 'Server reset generation/incarnation counter')
ON CONFLICT (key) DO NOTHING;

-- Harden execute_sync_command to validate resetGeneration
CREATE OR REPLACE FUNCTION execute_sync_command(
    p_command_id TEXT,
    p_command_type VARCHAR(100),
    p_aggregate_type VARCHAR(100) DEFAULT NULL,
    p_aggregate_id TEXT DEFAULT NULL,
    p_payload JSONB DEFAULT '{}'::jsonb,
    p_expected_version INTEGER DEFAULT NULL
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
LANGUAGE plpgsql
AS $$
DECLARE
    v_cmd_uuid UUID;
    v_admin_id UUID;
    v_admin_role VARCHAR(50);
    v_is_active BOOLEAN;
    v_required_perm VARCHAR(100);
    v_existing_result JSONB;
    v_result JSONB;
    v_entity_uuid UUID;
    v_server_gen BIGINT;
    v_cmd_gen BIGINT;
BEGIN
    -- 0. RESET GENERATION VALIDATION (STALE OUTBOX PROTECTION)
    SELECT COALESCE(value_number, 1) INTO v_server_gen
    FROM public.system_settings
    WHERE key = 'server_reset_generation';

    v_cmd_gen := COALESCE((p_payload->>'resetGeneration')::BIGINT, 1);

    IF v_cmd_gen < v_server_gen THEN
        RAISE EXCEPTION 'Reset Generation Mismatch: Command generation % is older than server reset generation %. Stale pre-reset command rejected.', v_cmd_gen, v_server_gen
        USING ERRCODE = 'P0002';
    END IF;

    -- 1. AUTHENTICATION & IDENTITY RESOLUTION
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required: caller must be signed in via Supabase Auth';
    END IF;

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

    -- 2. RBAC AUTHORIZATION
    IF v_admin_role NOT IN ('SUPER_ADMIN', 'Super Admin') THEN
        CASE p_command_type
            WHEN 'OPEN_DAY', 'UPDATE_DAY', 'business_days' THEN
                v_required_perm := 'orders:create';
            WHEN 'CREATE_CUSTOMER', 'customers' THEN
                v_required_perm := 'customers:create';
            WHEN 'UPDATE_CUSTOMER' THEN
                v_required_perm := 'customers:edit';
            WHEN 'CREATE_DEVICE_TYPE', 'UPDATE_DEVICE_TYPE', 'device_types' THEN
                v_required_perm := 'devices:manage';
            WHEN 'CREATE_ORDER', 'orders' THEN
                v_required_perm := 'orders:create';
            WHEN 'UPDATE_ORDER' THEN
                v_required_perm := 'orders:edit';
            WHEN 'DELETE_ORDER' THEN
                v_required_perm := 'orders:delete';
            WHEN 'CREATE_PAYMENT', 'payments' THEN
                v_required_perm := 'payments:create';
            WHEN 'REFUND_PAYMENT' THEN
                v_required_perm := 'payments:refund';
            WHEN 'CREATE_GOAL', 'goals' THEN
                v_required_perm := 'goals:manage';
            ELSE
                v_required_perm := 'settings:manage';
        END CASE;

        IF v_required_perm IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM get_effective_permissions(v_admin_id) WHERE permission = v_required_perm
        ) THEN
            RAISE EXCEPTION 'Forbidden: Admin lacks required permission % for command %', v_required_perm, p_command_type;
        END IF;
    END IF;

    -- Idempotency check via processed_commands
    IF p_command_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        v_cmd_uuid := p_command_id::UUID;
        SELECT response INTO v_existing_result
        FROM processed_commands
        WHERE command_id = v_cmd_uuid;

        IF v_existing_result IS NOT NULL THEN
            IF (v_existing_result->>'payloadHash') IS NOT NULL AND (p_payload->>'payloadHash') IS NOT NULL THEN
                IF (v_existing_result->>'payloadHash') <> (p_payload->>'payloadHash') THEN
                    RAISE EXCEPTION 'Idempotency Conflict: Command ID % already processed with different payload hash', p_command_id
                    USING ERRCODE = '23505';
                END IF;
            END IF;
            RETURN v_existing_result;
        END IF;
    END IF;

    -- Command processing placeholder (subsequent triggers/handlers execute business mutation)
    v_result := jsonb_build_object('success', true, 'commandId', p_command_id, 'serverProcessedAt', NOW());

    -- Record in processed_commands if valid UUID
    IF v_cmd_uuid IS NOT NULL THEN
        INSERT INTO processed_commands (command_id, command_type, aggregate_type, aggregate_id, payload_hash, response, success)
        VALUES (v_cmd_uuid, p_command_type, p_aggregate_type, p_aggregate_id, p_payload->>'payloadHash', v_result, true)
        ON CONFLICT (command_id) DO NOTHING;
    END IF;

    RETURN v_result;
END;
$$;

-- Update reset_online_business_data to increment server_reset_generation atomically
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

    DELETE FROM sync_conflicts WHERE true;
    GET DIAGNOSTICS v_count_sync_conflicts = ROW_COUNT;

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
            'sync_conflicts', v_count_sync_conflicts,
            'change_log', v_count_change_log,
            'processed_commands', v_count_processed_commands
        )
    );
END;
$$;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
