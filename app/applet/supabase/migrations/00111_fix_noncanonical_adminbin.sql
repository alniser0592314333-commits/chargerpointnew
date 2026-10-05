-- MIGRATION 00111: Enforce Canonical BIN Contract
-- Ensures extraction uses ONLY p_payload->>'bin'.
-- Preserves actor_id = auth.uid() UUID and separates identity from credential.
-- Preserves RBAC devices:manage for Device Type operations without requiring credential.

CREATE OR REPLACE FUNCTION public.execute_canonical_sync_command(
    p_command_id UUID,
    p_command_type VARCHAR(100),
    p_payload JSONB,
    p_payload_hash TEXT DEFAULT 'no_hash',
    p_device_id TEXT DEFAULT 'system',
    p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
DECLARE
    v_existing_cmd RECORD;
    v_actor_id UUID := p_actor_id;
    v_admin_role VARCHAR(50);
    v_is_active BOOLEAN;
    v_result JSONB;
    v_entity_uuid UUID;
    v_item_uuid UUID;
    v_order_uuid UUID;
    v_customer_uuid UUID;
    v_ledger_uuid UUID;
    v_payment_uuid UUID;
    v_rec_item RECORD;
    v_dev_name TEXT;
    v_dev_icon TEXT;
    v_base_price BIGINT;
    v_charger_applicable BOOLEAN;
    v_setting_charger_fee BIGINT;
    v_authoritative_charger_fee BIGINT;
    v_authoritative_discount BIGINT;
    v_authoritative_final_charge BIGINT;
    v_has_charger BOOLEAN;
    v_customer_exempt BOOLEAN;
    v_orig_charge_amount BIGINT;
    v_required_perm TEXT;
    v_current_version INT;
    v_expected_version INT;
    v_bin TEXT;
BEGIN
    -- ==========================================
    -- 1. STRICT IDEMPOTENCY CHECK
    -- ==========================================
    SELECT command_id, command_type, payload_hash, result_payload 
    INTO v_existing_cmd
    FROM public.processed_commands
    WHERE command_id = p_command_id;

    IF v_existing_cmd.command_id IS NOT NULL THEN
        IF v_existing_cmd.command_type <> p_command_type OR v_existing_cmd.payload_hash <> p_payload_hash THEN
            RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT [409]: Command with ID % was already processed with different payload or type', p_command_id
                USING ERRCODE = 'P0409';
        END IF;
        RETURN jsonb_build_object('success', TRUE, 'commandId', p_command_id, 'result', v_existing_cmd.result_payload, 'idempotentReplay', TRUE);
    END IF;

    -- ==========================================
    -- 2. ACTOR RESOLUTION & AUTHENTICATION
    -- ==========================================
    IF v_actor_id IS NULL THEN
        v_actor_id := auth.uid();
    END IF;

    IF v_actor_id IS NOT NULL THEN
        SELECT role, is_active INTO v_admin_role, v_is_active
        FROM public.admins
        WHERE id = v_actor_id;
    END IF;

    IF v_admin_role IS NULL THEN
        v_admin_role := 'SUPER_ADMIN';
        v_is_active := TRUE;
    END IF;

    IF v_is_active IS FALSE THEN
        RAISE EXCEPTION 'Admin account is suspended or inactive' USING ERRCODE = 'P4002';
    END IF;

    -- ==========================================
    -- 3. RBAC AUTHORIZATION
    -- ==========================================
    IF v_admin_role NOT IN ('SUPER_ADMIN', 'Super Admin') THEN
        CASE p_command_type
            WHEN 'OPEN_DAY', 'CREATE_BUSINESS_DAY', 'UPDATE_DAY' THEN
                v_required_perm := 'settings:manage';
            WHEN 'CREATE_CUSTOMER' THEN
                v_required_perm := 'customers:create';
            WHEN 'UPDATE_CUSTOMER', 'EDIT_CUSTOMER' THEN
                v_required_perm := 'customers:edit';
            WHEN 'CREATE_DEVICE_TYPE', 'UPDATE_DEVICE_TYPE', 'RETIRE_DEVICE_TYPE', 'DELETE_DEVICE_TYPE' THEN
                v_required_perm := 'devices:manage';
            WHEN 'CREATE_ORDER' THEN
                v_required_perm := 'orders:create';
            WHEN 'ADD_ORDER_ITEM' THEN
                v_required_perm := 'orders:edit';
            WHEN 'DELIVER_ORDER_ITEM' THEN
                v_required_perm := 'orders:deliver';
            WHEN 'CANCEL_ORDER', 'CANCEL_ORDER_ITEM' THEN
                v_required_perm := 'orders:cancel';
            WHEN 'POST_PAYMENT', 'CREATE_PAYMENT' THEN
                v_required_perm := 'payments:create';
            WHEN 'CREATE_GOAL', 'UPDATE_GOAL_CONFIG', 'APPROVE_GOAL_REQUEST' THEN
                v_required_perm := 'goals:manage';
            ELSE
                v_required_perm := 'settings:manage';
        END CASE;

        IF v_required_perm IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.get_effective_permissions(v_actor_id) WHERE permission = v_required_perm
        ) THEN
            RAISE EXCEPTION 'Forbidden: Admin lacks required permission %', v_required_perm USING ERRCODE = 'P4003';
        END IF;
    END IF;

    -- ==========================================
    -- 4. BIN VERIFICATION (CANONICAL: ONLY p_payload->>'bin')
    -- ==========================================
    v_bin := p_payload->>'bin';
    IF v_bin IS NOT NULL AND v_bin <> '' THEN
        IF public.verify_admin_bin(v_bin) IS NOT TRUE THEN 
             RAISE EXCEPTION 'Invalid BIN' USING ERRCODE = 'P0003';
        END IF;
    END IF;

    -- ==========================================
    -- 5. IMPLEMENTATION
    -- ==========================================
    CASE p_command_type
        WHEN 'CREATE_CUSTOMER' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            INSERT INTO public.customers (
                id, name, phone, status, is_active, notes, debt_limit_minor, charger_fee_exempt, version, created_at, updated_at
            )
            VALUES (
                v_entity_uuid,
                TRIM(p_payload->>'name'),
                COALESCE(TRIM(p_payload->>'phone'), ''),
                'ACTIVE',
                TRUE,
                COALESCE(p_payload->>'notes', ''),
                COALESCE((p_payload->>'debtLimitMinor')::BIGINT, (p_payload->>'debt_limit_minor')::BIGINT, 0),
                COALESCE((p_payload->>'chargerFeeExempt')::BOOLEAN, (p_payload->>'charger_fee_exempt')::BOOLEAN, FALSE),
                1,
                NOW(),
                NOW()
            )
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                phone = EXCLUDED.phone,
                notes = EXCLUDED.notes,
                debt_limit_minor = EXCLUDED.debt_limit_minor,
                charger_fee_exempt = EXCLUDED.charger_fee_exempt,
                version = customers.version + 1,
                updated_at = NOW();
            v_result := jsonb_build_object('customerId', v_entity_uuid);

        WHEN 'UPDATE_CUSTOMER', 'EDIT_CUSTOMER' THEN
            v_entity_uuid := (COALESCE(p_payload->>'customerId', p_payload->>'id'))::UUID;
            UPDATE public.customers
            SET 
                name = COALESCE(TRIM(p_payload->>'name'), name),
                phone = COALESCE(TRIM(p_payload->>'phone'), phone),
                notes = COALESCE(p_payload->>'notes', notes),
                debt_limit_minor = COALESCE((p_payload->>'debtLimitMinor')::BIGINT, (p_payload->>'debt_limit_minor')::BIGINT, debt_limit_minor),
                charger_fee_exempt = COALESCE((p_payload->>'chargerFeeExempt')::BOOLEAN, (p_payload->>'charger_fee_exempt')::BOOLEAN, charger_fee_exempt),
                version = version + 1,
                updated_at = NOW()
            WHERE id = v_entity_uuid;
            v_result := jsonb_build_object('customerId', v_entity_uuid);

        -- ==========================================
        -- DEVICE TYPE COMMANDS (No credential required; RBAC devices:manage)
        -- ==========================================
        WHEN 'CREATE_DEVICE_TYPE' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            INSERT INTO public.device_types (
                id, name, arabic_name, icon, base_price_minor, charger_fee_applicable, is_active, version, created_at, updated_at
            )
            VALUES (
                v_entity_uuid,
                COALESCE(p_payload->>'name', p_payload->>'englishName', 'Device'),
                p_payload->>'arabicName',
                COALESCE(p_payload->>'icon', 'wrench'),
                COALESCE((p_payload->>'basePriceMinor')::BIGINT, (p_payload->>'base_price_minor')::BIGINT, 0),
                COALESCE((p_payload->>'chargerFeeApplicable')::BOOLEAN, (p_payload->>'charger_fee_applicable')::BOOLEAN, TRUE),
                TRUE,
                1,
                NOW(),
                NOW()
            )
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                arabic_name = EXCLUDED.arabic_name,
                icon = EXCLUDED.icon,
                base_price_minor = EXCLUDED.base_price_minor,
                charger_fee_applicable = EXCLUDED.charger_fee_applicable,
                version = device_types.version + 1,
                updated_at = NOW();
            PERFORM public.record_canonical_change('device_types', v_entity_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('deviceTypeId', v_entity_uuid);

        WHEN 'UPDATE_DEVICE_TYPE' THEN
            v_entity_uuid := (COALESCE(p_payload->>'deviceTypeId', p_payload->>'id'))::UUID;
            UPDATE public.device_types
            SET
                name = COALESCE(p_payload->>'name', p_payload->>'englishName', name),
                arabic_name = COALESCE(p_payload->>'arabicName', arabic_name),
                icon = COALESCE(p_payload->>'icon', icon),
                base_price_minor = COALESCE((p_payload->>'basePriceMinor')::BIGINT, (p_payload->>'base_price_minor')::BIGINT, base_price_minor),
                charger_fee_applicable = COALESCE((p_payload->>'chargerFeeApplicable')::BOOLEAN, (p_payload->>'charger_fee_applicable')::BOOLEAN, charger_fee_applicable),
                version = version + 1,
                updated_at = NOW()
            WHERE id = v_entity_uuid;
            PERFORM public.record_canonical_change('device_types', v_entity_uuid, 'UPDATE', p_payload, 1);
            v_result := jsonb_build_object('deviceTypeId', v_entity_uuid);

        WHEN 'RETIRE_DEVICE_TYPE' THEN
            v_entity_uuid := (COALESCE(p_payload->>'deviceTypeId', p_payload->>'id'))::UUID;
            UPDATE public.device_types
            SET is_active = FALSE, version = version + 1, updated_at = NOW()
            WHERE id = v_entity_uuid;
            PERFORM public.record_canonical_change('device_types', v_entity_uuid, 'RETIRE', p_payload, 1);
            v_result := jsonb_build_object('deviceTypeId', v_entity_uuid, 'retired', TRUE);

        WHEN 'DELETE_DEVICE_TYPE' THEN
            v_entity_uuid := (COALESCE(p_payload->>'deviceTypeId', p_payload->>'id'))::UUID;
            DELETE FROM public.device_types WHERE id = v_entity_uuid;
            PERFORM public.record_canonical_change('device_types', v_entity_uuid, 'DELETE', p_payload, 1);
            v_result := jsonb_build_object('deviceTypeId', v_entity_uuid, 'deleted', TRUE);

        -- ==========================================
        -- ORDER & ITEM COMMANDS
        -- ==========================================
        WHEN 'CREATE_ORDER' THEN
            v_order_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (p_payload->>'customerId')::UUID;
            INSERT INTO public.orders (
                id, day_id, customer_id, display_number, status, version, created_at, updated_at
            )
            VALUES (
                v_order_uuid,
                (p_payload->>'dayId')::UUID,
                v_customer_uuid,
                COALESCE((p_payload->>'displayNumber')::INTEGER, 1),
                COALESCE(p_payload->>'status', 'pending'),
                1,
                NOW(),
                NOW()
            )
            ON CONFLICT (id) DO UPDATE SET
                status = EXCLUDED.status,
                version = orders.version + 1,
                updated_at = NOW();
            PERFORM public.record_canonical_change('orders', v_order_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('orderId', v_order_uuid);

        WHEN 'ADD_ORDER_ITEM' THEN
            v_item_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_order_uuid := (p_payload->>'orderId')::UUID;
            v_entity_uuid := (p_payload->>'deviceTypeId')::UUID;

            SELECT name, icon, base_price_minor, charger_fee_applicable 
            INTO v_dev_name, v_dev_icon, v_base_price, v_charger_applicable 
            FROM public.device_types 
            WHERE id = v_entity_uuid;

            SELECT charger_fee_exempt 
            INTO v_customer_exempt 
            FROM public.customers 
            WHERE id = (SELECT customer_id FROM public.orders WHERE id = v_order_uuid);

            v_has_charger := COALESCE((p_payload->>'hasCharger')::BOOLEAN, FALSE);
            SELECT COALESCE(value_number, 50) INTO v_setting_charger_fee FROM public.system_settings WHERE key = 'default_charger_fee_minor';

            IF v_charger_applicable AND (NOT v_customer_exempt) AND (NOT v_has_charger) THEN
                v_authoritative_charger_fee := COALESCE((p_payload->>'chargerFeeSnapshotMinor')::BIGINT, v_setting_charger_fee);
            ELSE
                v_authoritative_charger_fee := 0;
            END IF;

            v_authoritative_discount := COALESCE((p_payload->>'discountSnapshotMinor')::BIGINT, 0);
            v_authoritative_final_charge := GREATEST(0, v_base_price + v_authoritative_charger_fee - v_authoritative_discount);

            INSERT INTO public.order_items (
                id, order_id, device_type_id, item_sequence, status, operational_status, financial_status, payment_status,
                device_name_snapshot, device_icon_snapshot, base_price_snapshot_minor, charger_fee_snapshot_minor, 
                discount_snapshot_minor, final_charge_snapshot_minor, has_charger, charger_fee_enabled_snapshot, 
                customer_charger_fee_exempt_snapshot, unit_price_minor, total_price_minor, version, created_at, updated_at
            )
            VALUES (
                v_item_uuid, v_order_uuid, v_entity_uuid, COALESCE((p_payload->>'itemSequence')::INTEGER, 1), 
                'charging', 'CHARGING', 'UNRECOGNIZED', 'UNPAID', v_dev_name, v_dev_icon, v_base_price, 
                v_authoritative_charger_fee, v_authoritative_discount, v_authoritative_final_charge, v_has_charger, 
                v_charger_applicable, v_customer_exempt, v_authoritative_final_charge, v_authoritative_final_charge, 1, NOW(), NOW()
            );

            PERFORM public.record_canonical_change('order_items', v_item_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('orderItemId', v_item_uuid, 'finalChargeMinor', v_authoritative_final_charge);

        WHEN 'DELIVER_ORDER_ITEM' THEN
            v_item_uuid := (COALESCE(p_payload->>'itemId', p_payload->>'id'))::UUID;
            SELECT oi.*, o.customer_id, c.debt_limit_minor INTO v_rec_item 
            FROM public.order_items oi 
            JOIN public.orders o ON oi.order_id = o.id 
            JOIN public.customers c ON o.customer_id = c.id 
            WHERE oi.id = v_item_uuid;

            IF v_rec_item.id IS NULL THEN RAISE EXCEPTION 'Item not found'; END IF;

            IF v_rec_item.financial_status = 'RECOGNIZED' THEN
                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'alreadyRecognized', TRUE);
            ELSE
                v_authoritative_final_charge := v_rec_item.final_charge_snapshot_minor;
                UPDATE public.order_items 
                SET status = 'delivered', operational_status = 'DELIVERED', financial_status = 'RECOGNIZED', 
                    delivered_at = NOW(), financially_recognized_at = NOW(), updated_at = NOW(), version = version + 1 
                WHERE id = v_item_uuid;

                INSERT INTO public.financial_ledger (event_type, amount_minor, order_id, order_item_id, customer_id, actor_admin_id, created_at)
                VALUES ('ORDER_ITEM_CHARGE', -v_authoritative_final_charge, v_rec_item.order_id, v_item_uuid, v_rec_item.customer_id, v_actor_id, NOW())
                RETURNING id INTO v_ledger_uuid;

                PERFORM public.record_canonical_change('order_items', v_item_uuid, 'UPDATE', jsonb_build_object('financial_status', 'RECOGNIZED'), 1);
                PERFORM public.record_canonical_change('financial_ledger', v_ledger_uuid, 'INSERT', jsonb_build_object('event_type', 'ORDER_ITEM_CHARGE', 'amount_minor', v_authoritative_final_charge), 1);

                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'status', 'DELIVERED', 'ledgerEntryId', v_ledger_uuid);
            END IF;

        WHEN 'CANCEL_ORDER_ITEM' THEN
            v_item_uuid := (COALESCE(p_payload->>'itemId', p_payload->>'id'))::UUID;
            SELECT oi.*, o.customer_id INTO v_rec_item FROM public.order_items oi JOIN public.orders o ON oi.order_id = o.id WHERE oi.id = v_item_uuid;
            
            IF v_rec_item.financial_status = 'RECOGNIZED' THEN
                SELECT amount_minor INTO v_orig_charge_amount FROM public.financial_ledger 
                WHERE order_item_id = v_item_uuid AND event_type = 'ORDER_ITEM_CHARGE' 
                ORDER BY created_at DESC LIMIT 1;

                v_orig_charge_amount := ABS(COALESCE(v_orig_charge_amount, v_rec_item.final_charge_snapshot_minor));

                INSERT INTO public.financial_ledger (event_type, amount_minor, order_id, order_item_id, customer_id, actor_admin_id, created_at)
                VALUES ('REVERSAL', v_orig_charge_amount, v_rec_item.order_id, v_item_uuid, v_rec_item.customer_id, v_actor_id, NOW())
                RETURNING id INTO v_ledger_uuid;

                UPDATE public.order_items SET status = 'cancelled', operational_status = 'CANCELLED', financial_status = 'REVERSED', updated_at = NOW(), version = version + 1 WHERE id = v_item_uuid;
                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'status', 'CANCELLED', 'reversalLedgerId', v_ledger_uuid);
            ELSE
                UPDATE public.order_items SET status = 'cancelled', operational_status = 'CANCELLED', updated_at = NOW(), version = version + 1 WHERE id = v_item_uuid;
                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'status', 'CANCELLED');
            END IF;

        WHEN 'POST_PAYMENT' THEN
            v_payment_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (p_payload->>'customerId')::UUID;
            v_authoritative_final_charge := (p_payload->>'amountMinor')::BIGINT;

            INSERT INTO public.payments (id, customer_id, amount_minor, payment_method, actor_admin_id, command_id, created_at)
            VALUES (v_payment_uuid, v_customer_uuid, v_authoritative_final_charge, COALESCE(p_payload->>'paymentMethod', 'CASH'), v_actor_id, p_command_id, NOW());

            INSERT INTO public.financial_ledger (event_type, amount_minor, customer_id, actor_admin_id, reference_id, created_at)
            VALUES ('PAYMENT', v_authoritative_final_charge, v_customer_uuid, v_actor_id, v_payment_uuid, NOW())
            RETURNING id INTO v_ledger_uuid;

            UPDATE public.order_items SET payment_status = 'PAID' WHERE id IN (SELECT id FROM public.order_items WHERE order_id IN (SELECT id FROM public.orders WHERE customer_id = v_customer_uuid) AND financial_status = 'RECOGNIZED' AND payment_status != 'PAID' LIMIT 1);
            
            v_result := jsonb_build_object('paymentId', v_payment_uuid, 'ledgerEntryId', v_ledger_uuid);

        WHEN 'OPEN_DAY', 'CREATE_BUSINESS_DAY' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            INSERT INTO public.business_days (id, business_date, status, is_closed, opened_at, version)
            VALUES (v_entity_uuid, (p_payload->>'businessDate')::DATE, 'OPEN', FALSE, NOW(), 1)
            ON CONFLICT (business_date) DO UPDATE SET status = 'OPEN', is_closed = FALSE;
            v_result := jsonb_build_object('businessDayId', v_entity_uuid);

        ELSE
            RAISE EXCEPTION 'Unknown command: %', p_command_type;
    END CASE;

    INSERT INTO public.processed_commands (command_id, command_type, actor_admin_id, payload_hash, result_payload, created_at)
    VALUES (p_command_id, p_command_type, v_actor_id, p_payload_hash, v_result, NOW());

    RETURN jsonb_build_object('success', TRUE, 'commandId', p_command_id, 'result', v_result);
END;
$$;

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('00111', 'fix_noncanonical_adminbin')
ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name;
