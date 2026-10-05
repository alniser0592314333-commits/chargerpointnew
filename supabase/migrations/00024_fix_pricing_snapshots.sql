/**
 * Supabase Migration: 00024_fix_pricing_snapshots.sql
 * 1. Adds customer_balance_snapshot_minor to orders table.
 * 2. Hardens execute_sync_command to require and validate pricing snapshots for ADD_ORDER_ITEM.
 * 3. Includes pricing snapshots in authoritative command results.
 */

-- 1. SCHEMA EVOLUTION
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_balance_snapshot_minor INTEGER;

-- 2. HARDENED COMMAND PROCESSOR
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
SET search_path = public, pg_temp
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
BEGIN
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
            WHEN 'ADD_ORDER_ITEM', 'UPDATE_ORDER_ITEM', 'order_items' THEN
                v_required_perm := 'orders:create';
            WHEN 'DELIVERY_CHARGE' THEN
                v_required_perm := 'orders:deliver';
            WHEN 'PAYMENT' THEN
                v_required_perm := 'finance:create-payment';
            WHEN 'REVERSAL' THEN
                v_required_perm := 'orders:cancel';
            WHEN 'FINANCIAL_LEDGER', 'financial_ledger' THEN
                v_required_perm := 'finances:write';
            ELSE
                v_required_perm := NULL;
        END CASE;

        IF v_required_perm IS NOT NULL THEN
            IF NOT EXISTS (
                SELECT 1 FROM get_effective_permissions(v_admin_id) 
                WHERE permission = v_required_perm
                   OR permission IN ('finances:write', 'customers:write', 'orders:write', 'admin:manage', 'SUPER_ADMIN')
            ) THEN
                RAISE EXCEPTION 'Forbidden: Admin lacks required permission "%" for command "%"', v_required_perm, p_command_type;
            END IF;
        END IF;
    END IF;

    -- 3. RESOLVE COMMAND UUID
    v_cmd_uuid := safe_cast_uuid(p_command_id);

    -- 4. IDEMPOTENCY CHECK
    SELECT result_payload INTO v_existing_result
    FROM processed_commands
    WHERE command_id = v_cmd_uuid;

    IF FOUND THEN
        RETURN v_existing_result;
    END IF;

    -- 5. ATOMIC BUSINESS MUTATION
    CASE p_command_type
        WHEN 'OPEN_DAY', 'UPDATE_DAY', 'business_days' THEN
            v_entity_uuid := safe_cast_uuid(COALESCE(p_payload->>'id', p_command_id));
            INSERT INTO business_days (id, business_date, is_closed)
            VALUES (
                v_entity_uuid,
                (COALESCE(p_payload->>'businessDate', p_payload->>'business_date'))::DATE,
                COALESCE((p_payload->>'isClosed')::BOOLEAN, (p_payload->>'is_closed')::BOOLEAN, FALSE)
            )
            ON CONFLICT (business_date) DO UPDATE SET
                is_closed = EXCLUDED.is_closed,
                updated_at = NOW();

        WHEN 'CREATE_CUSTOMER', 'UPDATE_CUSTOMER', 'customers' THEN
            v_entity_uuid := safe_cast_uuid(COALESCE(p_payload->>'id', p_command_id));
            INSERT INTO customers (id, name, phone, debt_limit_minor, charger_fee_exempt, is_active)
            VALUES (
                v_entity_uuid,
                p_payload->>'name',
                p_payload->>'phone',
                COALESCE((p_payload->>'debtLimitMinor')::BIGINT, (p_payload->>'debt_limit_minor')::BIGINT, 0),
                COALESCE((p_payload->>'chargerFeeExempt')::BOOLEAN, (p_payload->>'charger_fee_exempt')::BOOLEAN, FALSE),
                COALESCE((p_payload->>'isActive')::BOOLEAN, (p_payload->>'is_active')::BOOLEAN, TRUE)
            )
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                phone = EXCLUDED.phone,
                debt_limit_minor = EXCLUDED.debt_limit_minor,
                charger_fee_exempt = EXCLUDED.charger_fee_exempt,
                is_active = EXCLUDED.is_active,
                updated_at = NOW();

        WHEN 'CREATE_DEVICE_TYPE', 'UPDATE_DEVICE_TYPE', 'device_types' THEN
            v_entity_uuid := safe_cast_uuid(COALESCE(p_payload->>'id', p_command_id));
            INSERT INTO device_types (id, name, icon, base_price_minor, charger_fee_enabled, is_active, sort_order)
            VALUES (
                v_entity_uuid,
                p_payload->>'name',
                COALESCE(p_payload->>'icon', 'smartphone'),
                COALESCE((p_payload->>'basePriceMinor')::BIGINT, (p_payload->>'base_price_minor')::BIGINT, 0),
                COALESCE((p_payload->>'chargerFeeEnabled')::BOOLEAN, (p_payload->>'charger_fee_enabled')::BOOLEAN, TRUE),
                COALESCE((p_payload->>'isActive')::BOOLEAN, (p_payload->>'is_active')::BOOLEAN, TRUE),
                COALESCE((p_payload->>'sortOrder')::INTEGER, (p_payload->>'sort_order')::INTEGER, 0)
            )
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                icon = EXCLUDED.icon,
                base_price_minor = EXCLUDED.base_price_minor,
                charger_fee_enabled = EXCLUDED.charger_fee_enabled,
                is_active = EXCLUDED.is_active,
                sort_order = EXCLUDED.sort_order,
                updated_at = NOW();

        WHEN 'CREATE_ORDER', 'orders' THEN
            v_entity_uuid := safe_cast_uuid(COALESCE(p_payload->>'id', p_command_id));
            INSERT INTO orders (id, day_id, customer_id, display_number, status, notes, customer_balance_snapshot_minor)
            VALUES (
                v_entity_uuid,
                safe_cast_uuid(COALESCE(p_payload->>'dayId', p_payload->>'day_id')),
                safe_cast_uuid(COALESCE(p_payload->>'customerId', p_payload->>'customer_id')),
                COALESCE((p_payload->>'displayNumber')::INTEGER, (p_payload->>'display_number')::INTEGER, 1),
                (COALESCE(p_payload->>'status', 'charging'))::order_status,
                p_payload->>'notes',
                COALESCE((p_payload->>'customerBalanceSnapshotMinor')::INTEGER, (p_payload->>'customer_balance_snapshot_minor')::INTEGER)
            )
            ON CONFLICT (id) DO UPDATE SET
                status = EXCLUDED.status,
                notes = EXCLUDED.notes,
                updated_at = NOW();

        WHEN 'ADD_ORDER_ITEM', 'UPDATE_ORDER_ITEM', 'order_items' THEN
            -- VALIDATION: pricing snapshots are mandatory for new items to prevent zero-price regression
            IF p_payload->>'basePriceSnapshotMinor' IS NULL OR 
               p_payload->>'unitPriceMinor' IS NULL OR 
               p_payload->>'totalPriceMinor' IS NULL THEN
                RAISE EXCEPTION 'Validation Error: Missing required pricing snapshots (basePriceSnapshotMinor, unitPriceMinor, totalPriceMinor)';
            END IF;

            v_entity_uuid := safe_cast_uuid(COALESCE(p_payload->>'id', p_command_id));
            INSERT INTO order_items (
                id, order_id, device_type_id, item_sequence, status,
                device_name_snapshot, device_icon_snapshot, base_price_snapshot_minor,
                charger_fee_enabled_snapshot, customer_charger_fee_exempt_snapshot,
                charger_fee_snapshot_minor, has_charger, unit_price_minor, total_price_minor
            ) VALUES (
                v_entity_uuid,
                safe_cast_uuid(COALESCE(p_payload->>'orderId', p_payload->>'order_id')),
                safe_cast_uuid(COALESCE(p_payload->>'deviceTypeId', p_payload->>'device_type_id')),
                COALESCE((p_payload->>'itemSequence')::INTEGER, (p_payload->>'item_sequence')::INTEGER, 1),
                (COALESCE(p_payload->>'status', 'charging'))::item_status,
                COALESCE(p_payload->>'deviceNameSnapshot', p_payload->>'device_name_snapshot', 'Device'),
                COALESCE(p_payload->>'deviceIconSnapshot', p_payload->>'device_icon_snapshot', 'smartphone'),
                (p_payload->>'basePriceSnapshotMinor')::BIGINT,
                (COALESCE(p_payload->>'chargerFeeEnabledSnapshot', p_payload->>'charger_fee_enabled_snapshot', 'false'))::BOOLEAN,
                (COALESCE(p_payload->>'customerChargerFeeExemptSnapshot', p_payload->>'customer_charger_fee_exempt_snapshot', 'false'))::BOOLEAN,
                (COALESCE(p_payload->>'chargerFeeSnapshotMinor', p_payload->>'charger_fee_snapshot_minor', '0'))::BIGINT,
                (COALESCE(p_payload->>'hasCharger', p_payload->>'has_charger', 'false'))::BOOLEAN,
                (p_payload->>'unitPriceMinor')::BIGINT,
                (p_payload->>'totalPriceMinor')::BIGINT
            )
            ON CONFLICT (id) DO UPDATE SET
                status = EXCLUDED.status,
                updated_at = NOW();

        WHEN 'DELIVERY_CHARGE', 'PAYMENT', 'REVERSAL', 'FINANCIAL_LEDGER', 'financial_ledger' THEN
            v_entity_uuid := safe_cast_uuid(COALESCE(p_payload->>'id', p_command_id));
            IF NOT EXISTS (SELECT 1 FROM financial_ledger WHERE id = v_entity_uuid) THEN
                INSERT INTO financial_ledger (
                    id, event_type, amount_minor, order_id, order_item_id, customer_id, actor_admin_id, reference_id, metadata
                ) VALUES (
                    v_entity_uuid,
                    (COALESCE(p_payload->>'eventType', p_payload->>'event_type', 'PAYMENT'))::ledger_event_type,
                    (COALESCE(p_payload->>'amountMinor', p_payload->>'amount_minor'))::BIGINT,
                    safe_cast_uuid(COALESCE(p_payload->>'orderId', p_payload->>'order_id')),
                    safe_cast_uuid(COALESCE(p_payload->>'orderItemId', p_payload->>'order_item_id')),
                    safe_cast_uuid(COALESCE(p_payload->>'customerId', p_payload->>'customer_id')),
                    v_admin_id,
                    safe_cast_uuid(COALESCE(p_payload->>'referenceId', p_payload->>'reference_id')),
                    p_payload->'metadata'
                );
            END IF;

        ELSE
            NULL;
    END CASE;

    -- 6. ATOMIC REGISTRATION WITH AUTHORITATIVE PRICING SNAPSHOT IN RESULT
    v_result := jsonb_build_object(
        'success', TRUE,
        'command_id', p_command_id,
        'command_type', p_command_type,
        'actor_admin_id', v_admin_id,
        'processed_at', NOW()
    );

    -- If it was an ADD_ORDER_ITEM, include the pricing fields in the result payload for explicit client confirmation
    IF p_command_type = 'ADD_ORDER_ITEM' THEN
        v_result := v_result || jsonb_build_object('pricing', jsonb_build_object(
            'unitPriceMinor', (p_payload->>'unitPriceMinor')::BIGINT,
            'totalPriceMinor', (p_payload->>'totalPriceMinor')::BIGINT,
            'basePriceSnapshotMinor', (p_payload->>'basePriceSnapshotMinor')::BIGINT
        ));
    END IF;

    INSERT INTO processed_commands (
        command_id, actor_id, command_type, result_payload, processed_at
    ) VALUES (
        v_cmd_uuid, v_admin_id, p_command_type, v_result, NOW()
    )
    ON CONFLICT (command_id) DO UPDATE SET
        result_payload = EXCLUDED.result_payload;

    RETURN v_result;
END;
$$;

-- Ensure execute_command alias is also updated
CREATE OR REPLACE FUNCTION execute_command(
    p_command_id TEXT,
    p_command_type VARCHAR(100),
    p_aggregate_type VARCHAR(100) DEFAULT NULL,
    p_aggregate_id TEXT DEFAULT NULL,
    p_payload JSONB DEFAULT '{}'::jsonb,
    p_expected_version INTEGER DEFAULT NULL
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN execute_sync_command(
        p_command_id,
        p_command_type,
        p_aggregate_type,
        p_aggregate_id,
        p_payload,
        p_expected_version
    );
END;
$$;
