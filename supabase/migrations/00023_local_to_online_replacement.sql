/**
 * Supabase Migration: 00023_local_to_online_replacement.sql
 * Implements server-authoritative Local -> Online Business Data Replacement RPC (`replace_online_business_data`):
 * 1. Takes Local Business Data payload (including payment_allocations) and atomically replaces Online business state.
 * 2. Enforces caller authentication, active admin status, RBAC permissions (settings:manage / SUPER_ADMIN), and server-side BIN verification.
 * 3. Acquires transaction-scoped advisory lock ('online_business_reset_lock') for mutual exclusion with concurrent sync commands.
 * 4. Temporarily disables change_log & ledger immutability triggers during the atomic replacement transaction.
 * 5. Purges Online business data in strict Foreign Key dependency order (children before parents):
 *    payment_allocations -> financial_ledger -> payments -> order_items -> orders -> qr_tokens -> customers -> business_days -> device_types -> sync_conflicts -> change_log -> processed_commands
 * 6. Inserts Local business data in strict dependency order (parents before children):
 *    device_types -> business_days -> customers -> qr_tokens -> orders -> order_items -> payments -> financial_ledger -> payment_allocations
 * 7. Strictly preserves entity IDs (including payment_allocations.id) without synthetic generation or safe_cast fallback.
 * 8. Validates all allocation IDs (rejects null, empty, whitespace, and malformed UUIDs).
 * 9. Re-enables all triggers and returns atomic replacement summary counts.
 */

CREATE OR REPLACE FUNCTION replace_online_business_data(
    p_entered_bin TEXT,
    p_payload JSONB
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
    v_replacement_id UUID := gen_random_uuid();
    v_completed_at TIMESTAMPTZ := NOW();

    v_item JSONB;
    v_entity_uuid_str TEXT;
    v_payment_id_str TEXT;
    v_order_id_str TEXT;
    v_amount_val BIGINT;
    v_actor_admin_id UUID;
    v_cmd_id UUID;

    v_count_device_types INT := 0;
    v_count_business_days INT := 0;
    v_count_customers INT := 0;
    v_count_qr_tokens INT := 0;
    v_count_orders INT := 0;
    v_count_order_items INT := 0;
    v_count_payments INT := 0;
    v_count_financial_ledger INT := 0;
    v_count_payment_allocations INT := 0;
    v_count_goals INT := 0;
    v_count_goal_requests INT := 0;
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
            RAISE EXCEPTION 'Forbidden: Admin lacks settings:manage permission required for Online Replacement';
        END IF;
    END IF;

    -- 5. MANDATORY SERVER-SIDE BIN VERIFICATION
    v_bin_verified := verify_admin_bin(p_entered_bin);
    IF v_bin_verified IS NOT TRUE THEN
        RAISE EXCEPTION 'Invalid BIN: Security verification failed for Online Replacement';
    END IF;

    -- 6. ACQUIRE TRANSACTION-SCOPED ADVISORY LOCK (MUTUAL EXCLUSION WITH CONCURRENT SYNC)
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

    -- 8. ATOMIC BUSINESS DATA PURGE IN FK DEPENDENCY GRAPH ORDER (CHILDREN BEFORE PARENTS)
    DELETE FROM goal_requests WHERE true;
    DELETE FROM goals WHERE true;
    DELETE FROM payment_allocations WHERE true;
    DELETE FROM financial_ledger WHERE true;
    DELETE FROM payments WHERE true;
    DELETE FROM order_items WHERE true;
    DELETE FROM orders WHERE true;
    DELETE FROM qr_tokens WHERE true;
    DELETE FROM customers WHERE true;
    DELETE FROM business_days WHERE true;
    DELETE FROM device_types WHERE true;
    DELETE FROM sync_conflicts WHERE true;
    DELETE FROM change_log WHERE true;
    DELETE FROM processed_commands WHERE true;

    -- 9. ATOMIC RECONSTRUCTION FROM LOCAL PAYLOAD IN DEPENDENCY ORDER (PARENTS BEFORE CHILDREN)

    -- A) Device Types
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'device_types', p_payload->'deviceTypes', '[]'::jsonb))
    LOOP
        v_entity_uuid_str := v_item->>'id';
        IF v_entity_uuid_str IS NULL OR trim(v_entity_uuid_str) = '' OR v_entity_uuid_str !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Invalid device_type ID %: must be a valid UUID', v_entity_uuid_str;
        END IF;

        INSERT INTO device_types (id, name, name_ar, name_en, arabic_name, icon, base_price_minor, charger_fee_enabled, charger_fee_applicable, is_active, sort_order)
        VALUES (
            v_entity_uuid_str::UUID,
            COALESCE(NULLIF(v_item->>'name', ''), NULLIF(v_item->>'name_ar', ''), NULLIF(v_item->>'nameAr', ''), 'Device'),
            COALESCE(NULLIF(v_item->>'name_ar', ''), NULLIF(v_item->>'nameAr', ''), NULLIF(v_item->>'name', ''), 'Device'),
            COALESCE(NULLIF(v_item->>'name_en', ''), NULLIF(v_item->>'nameEn', ''), NULLIF(v_item->>'name', ''), 'Device'),
            COALESCE(NULLIF(v_item->>'name_ar', ''), NULLIF(v_item->>'nameAr', ''), NULLIF(v_item->>'name', ''), 'Device'),
            COALESCE(v_item->>'icon', 'smartphone'),
            COALESCE((v_item->>'base_price_minor')::BIGINT, (v_item->>'basePriceMinor')::BIGINT, 0),
            COALESCE((v_item->>'charger_fee_enabled')::BOOLEAN, (v_item->>'chargerFeeEnabled')::BOOLEAN, TRUE),
            COALESCE((v_item->>'charger_fee_applicable')::BOOLEAN, (v_item->>'chargerFeeApplicable')::BOOLEAN, (v_item->>'charger_fee_enabled')::BOOLEAN, (v_item->>'chargerFeeEnabled')::BOOLEAN, TRUE),
            COALESCE((v_item->>'is_active')::BOOLEAN, (v_item->>'isActive')::BOOLEAN, TRUE),
            COALESCE((v_item->>'sort_order')::INTEGER, (v_item->>'sortOrder')::INTEGER, 0)
        );
        v_count_device_types := v_count_device_types + 1;
    END LOOP;

    -- B) Business Days
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'business_days', p_payload->'businessDays', '[]'::jsonb))
    LOOP
        v_entity_uuid_str := v_item->>'id';
        IF v_entity_uuid_str IS NULL OR trim(v_entity_uuid_str) = '' OR v_entity_uuid_str !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Invalid business_day ID %: must be a valid UUID', v_entity_uuid_str;
        END IF;

        INSERT INTO business_days (id, business_date, is_closed)
        VALUES (
            v_entity_uuid_str::UUID,
            (COALESCE(v_item->>'business_date', v_item->>'businessDate', v_item->>'date'))::DATE,
            COALESCE((v_item->>'is_closed')::BOOLEAN, (v_item->>'isClosed')::BOOLEAN, FALSE)
        );
        v_count_business_days := v_count_business_days + 1;
    END LOOP;

    -- C) Customers
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'customers', '[]'::jsonb))
    LOOP
        v_entity_uuid_str := v_item->>'id';
        IF v_entity_uuid_str IS NULL OR trim(v_entity_uuid_str) = '' OR v_entity_uuid_str !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Invalid customer ID %: must be a valid UUID', v_entity_uuid_str;
        END IF;

        INSERT INTO customers (id, name, phone, debt_limit_minor, charger_fee_exempt, is_active)
        VALUES (
            v_entity_uuid_str::UUID,
            COALESCE(v_item->>'name', 'Customer'),
            v_item->>'phone',
            COALESCE((v_item->>'debt_limit_minor')::BIGINT, (v_item->>'debtLimitMinor')::BIGINT, 0),
            COALESCE((v_item->>'charger_fee_exempt')::BOOLEAN, (v_item->>'chargerFeeExempt')::BOOLEAN, FALSE),
            COALESCE((v_item->>'is_active')::BOOLEAN, (v_item->>'isActive')::BOOLEAN, TRUE)
        );
        v_count_customers := v_count_customers + 1;
    END LOOP;

    -- D) QR Tokens
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'qr_tokens', p_payload->'qrTokens', '[]'::jsonb))
    LOOP
        v_entity_uuid_str := v_item->>'id';
        IF v_entity_uuid_str IS NULL OR trim(v_entity_uuid_str) = '' OR v_entity_uuid_str !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Invalid qr_token ID %: must be a valid UUID', v_entity_uuid_str;
        END IF;

        INSERT INTO qr_tokens (id, token_hash, public_token, token_type, target_id, is_active)
        VALUES (
            v_entity_uuid_str::UUID,
            COALESCE(v_item->>'token_hash', v_item->>'tokenHash', v_item->>'public_token', v_item->>'publicToken'),
            COALESCE(v_item->>'public_token', v_item->>'publicToken'),
            (COALESCE(v_item->>'token_type', v_item->>'tokenType', 'CUSTOMER'))::qr_token_type,
            (COALESCE(v_item->>'target_id', v_item->>'targetId'))::UUID,
            COALESCE((v_item->>'is_active')::BOOLEAN, (v_item->>'isActive')::BOOLEAN, TRUE)
        );
        v_count_qr_tokens := v_count_qr_tokens + 1;
    END LOOP;

    -- E) Orders
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'orders', '[]'::jsonb))
    LOOP
        v_entity_uuid_str := v_item->>'id';
        IF v_entity_uuid_str IS NULL OR trim(v_entity_uuid_str) = '' OR v_entity_uuid_str !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Invalid order ID %: must be a valid UUID', v_entity_uuid_str;
        END IF;

        INSERT INTO orders (id, day_id, customer_id, display_number, status, notes)
        VALUES (
            v_entity_uuid_str::UUID,
            (COALESCE(v_item->>'day_id', v_item->>'dayId'))::UUID,
            (COALESCE(v_item->>'customer_id', v_item->>'customerId'))::UUID,
            COALESCE((v_item->>'display_number')::INTEGER, (v_item->>'displayNumber')::INTEGER, 1),
            (COALESCE(v_item->>'status', 'pending'))::order_status,
            v_item->>'notes'
        );
        v_count_orders := v_count_orders + 1;
    END LOOP;

    -- F) Order Items
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'order_items', p_payload->'orderItems', '[]'::jsonb))
    LOOP
        v_entity_uuid_str := v_item->>'id';
        IF v_entity_uuid_str IS NULL OR trim(v_entity_uuid_str) = '' OR v_entity_uuid_str !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Invalid order_item ID %: must be a valid UUID', v_entity_uuid_str;
        END IF;

        INSERT INTO order_items (
            id, order_id, device_type_id, item_sequence, status,
            device_name_snapshot, device_icon_snapshot, base_price_snapshot_minor,
            charger_fee_enabled_snapshot, customer_charger_fee_exempt_snapshot,
            charger_fee_snapshot_minor, has_charger, unit_price_minor, total_price_minor
        ) VALUES (
            v_entity_uuid_str::UUID,
            (COALESCE(v_item->>'order_id', v_item->>'orderId'))::UUID,
            (COALESCE(v_item->>'device_type_id', v_item->>'deviceTypeId'))::UUID,
            COALESCE((v_item->>'item_sequence')::INTEGER, (v_item->>'itemSequence')::INTEGER, 1),
            (COALESCE(v_item->>'status', 'charging'))::item_status,
            COALESCE(v_item->>'device_name_snapshot', v_item->>'deviceNameSnapshot', 'Device'),
            COALESCE(v_item->>'device_icon_snapshot', v_item->>'deviceIconSnapshot', 'smartphone'),
            COALESCE((v_item->>'base_price_snapshot_minor')::BIGINT, (v_item->>'basePriceSnapshotMinor')::BIGINT, 0),
            COALESCE((v_item->>'charger_fee_enabled_snapshot')::BOOLEAN, (v_item->>'chargerFeeEnabledSnapshot')::BOOLEAN, FALSE),
            COALESCE((v_item->>'customer_charger_fee_exempt_snapshot')::BOOLEAN, (v_item->>'customerChargerFeeExemptSnapshot')::BOOLEAN, FALSE),
            COALESCE((v_item->>'charger_fee_snapshot_minor')::BIGINT, (v_item->>'chargerFeeSnapshotMinor')::BIGINT, 0),
            COALESCE((v_item->>'has_charger')::BOOLEAN, (v_item->>'hasCharger')::BOOLEAN, FALSE),
            COALESCE((v_item->>'unit_price_minor')::BIGINT, (v_item->>'unitPriceMinor')::BIGINT, 0),
            COALESCE((v_item->>'total_price_minor')::BIGINT, (v_item->>'totalPriceMinor')::BIGINT, 0)
        );
        v_count_order_items := v_count_order_items + 1;
    END LOOP;

    -- G) Payments
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'payments', '[]'::jsonb))
    LOOP
        v_entity_uuid_str := v_item->>'id';
        IF v_entity_uuid_str IS NULL OR trim(v_entity_uuid_str) = '' OR v_entity_uuid_str !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Invalid payment ID %: must be a valid UUID', v_entity_uuid_str;
        END IF;

        v_actor_admin_id := COALESCE(
            CASE WHEN (v_item->>'actor_admin_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (v_item->>'actor_admin_id')::UUID ELSE NULL END,
            CASE WHEN (v_item->>'actorAdminId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (v_item->>'actorAdminId')::UUID ELSE NULL END,
            v_admin_id
        );

        v_cmd_id := COALESCE(
            CASE WHEN (v_item->>'command_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (v_item->>'command_id')::UUID ELSE NULL END,
            CASE WHEN (v_item->>'commandId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (v_item->>'commandId')::UUID ELSE NULL END,
            v_entity_uuid_str::UUID
        );

        INSERT INTO payments (id, customer_id, amount_minor, payment_method, reference, actor_admin_id, command_id, created_at)
        VALUES (
            v_entity_uuid_str::UUID,
            (COALESCE(v_item->>'customer_id', v_item->>'customerId'))::UUID,
            (COALESCE(v_item->>'amount_minor', v_item->>'amountMinor'))::INTEGER,
            COALESCE(v_item->>'payment_method', v_item->>'paymentMethod', 'CASH'),
            COALESCE(v_item->>'reference', 'Payment'),
            v_actor_admin_id,
            v_cmd_id,
            COALESCE((v_item->>'created_at')::TIMESTAMPTZ, (v_item->>'createdAt')::TIMESTAMPTZ, NOW())
        );
        v_count_payments := v_count_payments + 1;
    END LOOP;

    -- H) Financial Ledger
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'financial_ledger', p_payload->'financialLedger', '[]'::jsonb))
    LOOP
        v_entity_uuid_str := v_item->>'id';
        IF v_entity_uuid_str IS NULL OR trim(v_entity_uuid_str) = '' OR v_entity_uuid_str !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Invalid financial_ledger ID %: must be a valid UUID', v_entity_uuid_str;
        END IF;

        v_actor_admin_id := COALESCE(
            CASE WHEN (v_item->>'actor_admin_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (v_item->>'actor_admin_id')::UUID ELSE NULL END,
            CASE WHEN (v_item->>'actorAdminId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (v_item->>'actorAdminId')::UUID ELSE NULL END,
            v_admin_id
        );

        INSERT INTO financial_ledger (
            id, event_type, amount_minor, order_id, order_item_id, customer_id, actor_admin_id, reference_id, metadata, created_at
        ) VALUES (
            v_entity_uuid_str::UUID,
            (COALESCE(v_item->>'event_type', v_item->>'eventType', 'PAYMENT'))::ledger_event_type,
            (COALESCE(v_item->>'amount_minor', v_item->>'amountMinor'))::BIGINT,
            CASE WHEN (v_item->>'order_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (v_item->>'order_id')::UUID 
                 WHEN (v_item->>'orderId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (v_item->>'orderId')::UUID 
                 ELSE NULL END,
            CASE WHEN (v_item->>'order_item_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (v_item->>'order_item_id')::UUID 
                 WHEN (v_item->>'orderItemId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (v_item->>'orderItemId')::UUID 
                 ELSE NULL END,
            CASE WHEN (v_item->>'customer_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (v_item->>'customer_id')::UUID 
                 WHEN (v_item->>'customerId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (v_item->>'customerId')::UUID 
                 ELSE NULL END,
            v_actor_admin_id,
            CASE WHEN (v_item->>'reference_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (v_item->>'reference_id')::UUID 
                 WHEN (v_item->>'referenceId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (v_item->>'referenceId')::UUID 
                 ELSE NULL END,
            v_item->'metadata',
            COALESCE((v_item->>'created_at')::TIMESTAMPTZ, (v_item->>'createdAt')::TIMESTAMPTZ, NOW())
        );
        v_count_financial_ledger := v_count_financial_ledger + 1;
    END LOOP;

    -- I) Payment Allocations (STRICT VALIDATION & ID PRESERVATION)
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'payment_allocations', p_payload->'paymentAllocations', '[]'::jsonb))
    LOOP
        v_entity_uuid_str := v_item->>'id';
        -- Explicit validation: null, empty, whitespace, and malformed UUID are rejected
        IF v_entity_uuid_str IS NULL OR trim(v_entity_uuid_str) = '' THEN
            RAISE EXCEPTION 'Invalid allocation ID: ID cannot be null, empty, or whitespace';
        END IF;
        IF v_entity_uuid_str !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Invalid allocation ID %: malformed UUID format', v_entity_uuid_str;
        END IF;

        v_payment_id_str := COALESCE(v_item->>'payment_id', v_item->>'paymentId');
        v_order_id_str := COALESCE(v_item->>'order_id', v_item->>'orderId');
        v_amount_val := COALESCE((v_item->>'allocated_amount_minor')::BIGINT, (v_item->>'allocatedAmountMinor')::BIGINT);

        IF v_payment_id_str IS NULL OR v_payment_id_str !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Invalid payment_id % in allocation %: must be a valid UUID', v_payment_id_str, v_entity_uuid_str;
        END IF;
        IF v_order_id_str IS NULL OR v_order_id_str !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Invalid order_id % in allocation %: must be a valid UUID', v_order_id_str, v_entity_uuid_str;
        END IF;
        IF v_amount_val IS NULL OR v_amount_val <= 0 THEN
            RAISE EXCEPTION 'Invalid allocated_amount_minor % in allocation %: must be positive', v_amount_val, v_entity_uuid_str;
        END IF;

        -- FK existence check
        IF NOT EXISTS (SELECT 1 FROM payments WHERE id = v_payment_id_str::UUID) THEN
            RAISE EXCEPTION 'Foreign key violation: referenced payment % does not exist for allocation %', v_payment_id_str, v_entity_uuid_str;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM orders WHERE id = v_order_id_str::UUID) THEN
            RAISE EXCEPTION 'Foreign key violation: referenced order % does not exist for allocation %', v_order_id_str, v_entity_uuid_str;
        END IF;

        INSERT INTO payment_allocations (
            id,
            payment_id,
            order_id,
            allocated_amount_minor,
            created_at
        ) VALUES (
            v_entity_uuid_str::UUID,
            v_payment_id_str::UUID,
            v_order_id_str::UUID,
            v_amount_val,
            COALESCE((v_item->>'created_at')::TIMESTAMPTZ, (v_item->>'createdAt')::TIMESTAMPTZ, NOW())
        );
        v_count_payment_allocations := v_count_payment_allocations + 1;
    END LOOP;

    -- J) Goals (after financial_ledger because bonus_ledger_id references it)
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'goals', '[]'::jsonb))
    LOOP
        v_entity_uuid_str := v_item->>'id';
        IF v_entity_uuid_str IS NULL OR trim(v_entity_uuid_str) = '' OR v_entity_uuid_str !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Invalid goal ID %: must be a valid UUID', v_entity_uuid_str;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM customers WHERE id = (COALESCE(v_item->>'customer_id', v_item->>'customerId'))::UUID) THEN
            RAISE EXCEPTION 'Referenced customer % does not exist for goal %', v_item->>'customer_id', v_entity_uuid_str;
        END IF;
        INSERT INTO goals (id, customer_id, target_quantity, current_progress, bonus_amount_minor, duration_days, status, started_at, expires_at, completed_at, bonus_ledger_id, version, created_at, updated_at)
        VALUES (
            v_entity_uuid_str::UUID,
            (COALESCE(v_item->>'customer_id', v_item->>'customerId'))::UUID,
            COALESCE((v_item->>'target_quantity')::INTEGER, (v_item->>'targetQuantity')::INTEGER),
            COALESCE((v_item->>'current_progress')::INTEGER, (v_item->>'currentProgress')::INTEGER, 0),
            COALESCE((v_item->>'bonus_amount_minor')::BIGINT, (v_item->>'bonusAmountMinor')::BIGINT, 0),
            COALESCE((v_item->>'duration_days')::INTEGER, (v_item->>'durationDays')::INTEGER, 7),
            COALESCE(v_item->>'status', 'ACTIVE'),
            COALESCE((v_item->>'started_at')::TIMESTAMPTZ, (v_item->>'startedAt')::TIMESTAMPTZ, NOW()),
            COALESCE((v_item->>'expires_at')::TIMESTAMPTZ, (v_item->>'expiresAt')::TIMESTAMPTZ, NOW()),
            COALESCE((v_item->>'completed_at')::TIMESTAMPTZ, (v_item->>'completedAt')::TIMESTAMPTZ),
            NULLIF(COALESCE(v_item->>'bonus_ledger_id', v_item->>'bonusLedgerId'), '')::UUID,
            COALESCE((v_item->>'version')::INTEGER, 1),
            COALESCE((v_item->>'created_at')::TIMESTAMPTZ, (v_item->>'createdAt')::TIMESTAMPTZ, NOW()),
            COALESCE((v_item->>'updated_at')::TIMESTAMPTZ, (v_item->>'updatedAt')::TIMESTAMPTZ, NOW())
        );
        v_count_goals := v_count_goals + 1;
    END LOOP;

    -- K) Goal Requests
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'goal_requests', '[]'::jsonb))
    LOOP
        v_entity_uuid_str := v_item->>'id';
        IF v_entity_uuid_str IS NULL OR trim(v_entity_uuid_str) = '' OR v_entity_uuid_str !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Invalid goal request ID %: must be a valid UUID', v_entity_uuid_str;
        END IF;
        INSERT INTO goal_requests (id, customer_id, requested_target, status, reviewed_by, reviewed_at, rejection_reason, resulting_goal_id, version, created_at, updated_at)
        VALUES (
            v_entity_uuid_str::UUID,
            (COALESCE(v_item->>'customer_id', v_item->>'customerId'))::UUID,
            COALESCE((v_item->>'requested_target')::INTEGER, (v_item->>'requestedTarget')::INTEGER),
            COALESCE(v_item->>'status', 'PENDING'),
            NULLIF(COALESCE(v_item->>'reviewed_by', v_item->>'reviewedBy'), '')::UUID,
            COALESCE((v_item->>'reviewed_at')::TIMESTAMPTZ, (v_item->>'reviewedAt')::TIMESTAMPTZ),
            COALESCE(v_item->>'rejection_reason', v_item->>'rejectionReason'),
            NULLIF(COALESCE(v_item->>'resulting_goal_id', v_item->>'resultingGoalId'), '')::UUID,
            COALESCE((v_item->>'version')::INTEGER, 1),
            COALESCE((v_item->>'created_at')::TIMESTAMPTZ, (v_item->>'createdAt')::TIMESTAMPTZ, NOW()),
            COALESCE((v_item->>'updated_at')::TIMESTAMPTZ, (v_item->>'updatedAt')::TIMESTAMPTZ, NOW())
        );
        v_count_goal_requests := v_count_goal_requests + 1;
    END LOOP;

    -- 10. RE-ENABLE TRIGGERS
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

    -- 11. BUILD & RETURN AUDITED REPLACEMENT RESULT
    RETURN jsonb_build_object(
        'success', TRUE,
        'operation', 'REPLACE_ONLINE_BUSINESS_DATA',
        'replacementId', v_replacement_id,
        'completedAt', v_completed_at,
        'counts', jsonb_build_object(
            'device_types', v_count_device_types,
            'business_days', v_count_business_days,
            'customers', v_count_customers,
            'qr_tokens', v_count_qr_tokens,
            'orders', v_count_orders,
            'order_items', v_count_order_items,
            'payments', v_count_payments,
            'financial_ledger', v_count_financial_ledger,
            'payment_allocations', v_count_payment_allocations,
            'goals', v_count_goals,
            'goal_requests', v_count_goal_requests
        )
    );
END;
$$;

-- SECURITY PRIVILEGES
REVOKE EXECUTE ON FUNCTION replace_online_business_data(TEXT, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION replace_online_business_data(TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION replace_online_business_data(TEXT, JSONB) TO authenticated;
