-- Migration 00034: Granular Finance, Reports & Server-Authoritative Action Guards

-- 1. Redefine execute_sync_command with granular finance action guards
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
                -- Resolve order status first to check if delivered
                DECLARE
                    v_order_status VARCHAR(50);
                    v_order_id UUID;
                BEGIN
                    v_order_id := safe_cast_uuid(COALESCE(p_payload->>'orderId', p_payload->>'order_id'));
                    SELECT status::VARCHAR INTO v_order_status FROM orders WHERE id = v_order_id;
                    IF v_order_status = 'delivered' THEN
                        v_required_perm := 'orders:correct';
                    ELSE
                        v_required_perm := 'orders:create';
                    END IF;
                END;
            WHEN 'DELIVERY_CHARGE' THEN
                v_required_perm := 'orders:deliver';
            WHEN 'PAYMENT' THEN
                v_required_perm := 'finance:create-payment';
            WHEN 'APPROVE_PAYMENT', 'APPROVE_PAYMENT_COMMAND' THEN
                v_required_perm := 'finance:approve-payment';
            WHEN 'REFUND', 'REFUND_COMMAND', 'CREATE_REFUND', 'CREATE_REFUND_COMMAND' THEN
                v_required_perm := 'finance:refund';
            WHEN 'CREATE_CUSTOMER_CREDIT', 'CREATE_CUSTOMER_CREDIT_COMMAND', 'CREDIT_ADJUSTMENT' THEN
                v_required_perm := 'finance:credit-adjustment';
            WHEN 'REVERSAL' THEN
                v_required_perm := 'orders:cancel';
            WHEN 'FINANCIAL_LEDGER', 'financial_ledger' THEN
                -- Dynamically inspect eventType in payload
                DECLARE
                    v_ev_type VARCHAR(100);
                BEGIN
                    v_ev_type := COALESCE(p_payload->>'eventType', p_payload->>'event_type');
                    IF v_ev_type IN ('CREDIT_ADJUSTMENT', 'CREDIT_USED') THEN
                        v_required_perm := 'finance:credit-adjustment';
                    ELSIF v_ev_type = 'REFUND' THEN
                        v_required_perm := 'finance:refund';
                    ELSIF v_ev_type = 'REVERSAL' THEN
                        v_required_perm := 'orders:cancel';
                    ELSIF v_ev_type = 'PAYMENT' THEN
                        v_required_perm := 'finance:create-payment';
                    ELSIF v_ev_type = 'APPROVE_PAYMENT' THEN
                        v_required_perm := 'finance:approve-payment';
                    ELSE
                        v_required_perm := 'finances:write';
                    END IF;
                END;
            ELSE
                v_required_perm := NULL;
        END CASE;

        IF v_required_perm IS NOT NULL THEN
            IF NOT EXISTS (
                SELECT 1 FROM get_effective_permissions(v_admin_id) 
                WHERE permission = v_required_perm
                   OR permission IN ('admin:manage', 'SUPER_ADMIN')
            ) THEN
                RAISE EXCEPTION 'Forbidden: Admin lacks required permission "%" for command "%"', v_required_perm, p_command_type;
            END IF;
        END IF;

        -- Extra independent checks for UPDATE_CUSTOMER options
        IF p_command_type = 'UPDATE_CUSTOMER' THEN
            IF p_payload ? 'isActive' OR p_payload ? 'is_active' THEN
                IF NOT EXISTS (
                    SELECT 1 FROM get_effective_permissions(v_admin_id)
                    WHERE permission = 'customers:deactivate' OR permission IN ('SUPER_ADMIN')
                ) THEN
                    RAISE EXCEPTION 'Forbidden: Admin lacks required permission "customers:deactivate"';
                END IF;
            END IF;

            IF p_payload ? 'chargerFeeExempt' OR p_payload ? 'charger_fee_exempt' THEN
                IF NOT EXISTS (
                    SELECT 1 FROM get_effective_permissions(v_admin_id)
                    WHERE permission = 'customers:charger-exemption' OR permission IN ('SUPER_ADMIN')
                ) THEN
                    RAISE EXCEPTION 'Forbidden: Admin lacks required permission "customers:charger-exemption"';
                END IF;
            END IF;

            IF p_payload ? 'debtLimitMinor' OR p_payload ? 'debt_limit_minor' THEN
                IF NOT EXISTS (
                    SELECT 1 FROM get_effective_permissions(v_admin_id)
                    WHERE permission = 'customers:debt-limit' OR permission IN ('SUPER_ADMIN')
                ) THEN
                    RAISE EXCEPTION 'Forbidden: Admin lacks required permission "customers:debt-limit"';
                END IF;
            END IF;
        END IF;

        -- Extra independent checks for CREATE_DEVICE_TYPE & UPDATE_DEVICE_TYPE
        IF p_command_type IN ('CREATE_DEVICE_TYPE', 'UPDATE_DEVICE_TYPE', 'device_types') THEN
            IF p_payload ? 'basePriceMinor' OR p_payload ? 'base_price_minor' THEN
                IF NOT EXISTS (
                    SELECT 1 FROM get_effective_permissions(v_admin_id)
                    WHERE permission = 'devices:pricing' OR permission IN ('SUPER_ADMIN')
                ) THEN
                    RAISE EXCEPTION 'Forbidden: Admin lacks required permission "devices:pricing" for changing prices';
                END IF;
            END IF;

            IF p_payload ? 'chargerFeeEnabled' OR p_payload ? 'charger_fee_enabled' THEN
                IF NOT EXISTS (
                    SELECT 1 FROM get_effective_permissions(v_admin_id)
                    WHERE permission = 'devices:charger-policy' OR permission IN ('SUPER_ADMIN')
                ) THEN
                    RAISE EXCEPTION 'Forbidden: Admin lacks required permission "devices:charger-policy" for changing charger fee policy';
                END IF;
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
                name = COALESCE(EXCLUDED.name, customers.name),
                phone = COALESCE(EXCLUDED.phone, customers.phone),
                debt_limit_minor = COALESCE(EXCLUDED.debt_limit_minor, customers.debt_limit_minor),
                charger_fee_exempt = COALESCE(EXCLUDED.charger_fee_exempt, customers.charger_fee_exempt),
                is_active = COALESCE(EXCLUDED.is_active, customers.is_active),
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
                name = COALESCE(EXCLUDED.name, device_types.name),
                icon = COALESCE(EXCLUDED.icon, device_types.icon),
                base_price_minor = COALESCE(EXCLUDED.base_price_minor, device_types.base_price_minor),
                charger_fee_enabled = COALESCE(EXCLUDED.charger_fee_enabled, device_types.charger_fee_enabled),
                is_active = COALESCE(EXCLUDED.is_active, device_types.is_active),
                sort_order = COALESCE(EXCLUDED.sort_order, device_types.sort_order),
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

    -- 6. ATOMIC REGISTRATION WITH RESULT
    v_result := jsonb_build_object(
        'success', TRUE,
        'command_id', p_command_id,
        'command_type', p_command_type,
        'actor_admin_id', v_admin_id,
        'processed_at', NOW()
    );

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


-- 2. Server-Authoritative RPC for Financial Reports / Sensitive Financial Data
CREATE OR REPLACE FUNCTION rpc_get_financial_report()
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
LANGUAGE plpgsql
AS $$
DECLARE
    v_admin_id UUID;
    v_admin_role VARCHAR(50);
    v_is_active BOOLEAN;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    SELECT id, role, is_active 
    INTO v_admin_id, v_admin_role, v_is_active
    FROM public.admins
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    IF NOT FOUND OR v_is_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Forbidden: Admin account not found or suspended';
    END IF;

    IF v_admin_role NOT IN ('SUPER_ADMIN', 'Super Admin') THEN
        IF NOT EXISTS (
            SELECT 1 FROM get_effective_permissions(v_admin_id)
            WHERE permission IN ('reports:view', 'finance:view', 'admin:manage', 'SUPER_ADMIN')
        ) THEN
            RAISE EXCEPTION 'Forbidden: Admin lacks required permission "reports:view"';
        END IF;
    END IF;

    RETURN (
        SELECT jsonb_build_object(
            'totalLedgerRecords', COUNT(*),
            'netBalanceMinor', COALESCE(SUM(amount_minor), 0),
            'generatedAt', NOW()
        ) FROM public.financial_ledger
    );
END;
$$;

GRANT EXECUTE ON FUNCTION rpc_get_financial_report() TO authenticated;
