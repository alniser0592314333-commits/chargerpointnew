-- Migration 00115: Backend Financial Concurrency Safety via Pessimistic Row Locking (FOR UPDATE)
-- CANONICAL LOCK ORDER FOR FINANCIAL MUTATIONS:
-- 1. customers (FOR UPDATE)
-- 2. orders (FOR UPDATE)
-- 3. order_items (FOR UPDATE)
-- FIFO Payment Allocation Lock Order: ORDER BY oi.created_at ASC, oi.id ASC FOR UPDATE OF oi

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
    v_alloc_uuid UUID;
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
    v_unallocated_amount BIGINT;
    v_item_charge_due BIGINT;
    v_alloc_amount BIGINT;
    v_required_perm TEXT;
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
        SELECT id, role, is_active INTO v_actor_id, v_admin_role, v_is_active
        FROM public.admins
        WHERE id = v_actor_id OR auth_user_id = v_actor_id
        LIMIT 1;
    END IF;

    IF v_actor_id IS NULL THEN
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
    -- 4. BIN VERIFICATION
    -- ==========================================
    v_bin := p_payload->>'bin';
    IF v_bin IS NOT NULL AND v_bin <> '' THEN
        IF public.verify_admin_bin(v_bin) IS NOT TRUE THEN 
             RAISE EXCEPTION 'Invalid BIN' USING ERRCODE = 'P0003';
        END IF;
    END IF;

    -- ==========================================
    -- 5. COMMAND EXECUTION BRANCHES WITH CONCURRENCY LOCKS
    -- ==========================================
    CASE p_command_type
        WHEN 'OPEN_DAY' THEN
            v_order_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            INSERT INTO public.business_days (id, business_date, is_closed, opened_at, created_at, updated_at, version)
            VALUES (
                v_order_uuid,
                COALESCE(p_payload->>'businessDate', CURRENT_DATE::TEXT),
                FALSE,
                COALESCE((p_payload->>'openedAt')::TIMESTAMPTZ, NOW()),
                NOW(),
                NOW(),
                1
            )
            ON CONFLICT (id) DO UPDATE SET updated_at = NOW();
            PERFORM public.record_canonical_change('business_days', v_order_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('businessDayId', v_order_uuid);

        WHEN 'CREATE_CUSTOMER' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            INSERT INTO public.customers (
                id, name, phone, email, notes, debt_limit_minor, initial_balance_minor, is_active, charger_fee_exempt, version, created_at, updated_at
            )
            VALUES (
                v_entity_uuid,
                COALESCE(p_payload->>'name', 'Customer'),
                p_payload->>'phone',
                p_payload->>'email',
                COALESCE(p_payload->>'notes', ''),
                COALESCE((p_payload->>'debtLimitMinor')::BIGINT, (p_payload->>'debt_limit_minor')::BIGINT, 5000),
                COALESCE((p_payload->>'initialBalanceMinor')::BIGINT, (p_payload->>'initial_balance_minor')::BIGINT, 0),
                COALESCE((p_payload->>'isActive')::BOOLEAN, (p_payload->>'is_active')::BOOLEAN, TRUE),
                COALESCE((p_payload->>'chargerFeeExempt')::BOOLEAN, (p_payload->>'charger_fee_exempt')::BOOLEAN, FALSE),
                1,
                NOW(),
                NOW()
            )
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                phone = EXCLUDED.phone,
                debt_limit_minor = EXCLUDED.debt_limit_minor,
                version = customers.version + 1,
                updated_at = NOW();
            PERFORM public.record_canonical_change('customers', v_entity_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('customerId', v_entity_uuid);

        WHEN 'UPDATE_CUSTOMER' THEN
            v_entity_uuid := (p_payload->>'id')::UUID;
            -- Lock customer row for update
            PERFORM 1 FROM public.customers WHERE id = v_entity_uuid FOR UPDATE;
            UPDATE public.customers SET
                name = COALESCE(p_payload->>'name', name),
                phone = COALESCE(p_payload->>'phone', phone),
                notes = COALESCE(p_payload->>'notes', notes),
                debt_limit_minor = COALESCE((p_payload->>'debtLimitMinor')::BIGINT, (p_payload->>'debt_limit_minor')::BIGINT, debt_limit_minor),
                is_active = COALESCE((p_payload->>'isActive')::BOOLEAN, (p_payload->>'is_active')::BOOLEAN, is_active),
                charger_fee_exempt = COALESCE((p_payload->>'chargerFeeExempt')::BOOLEAN, (p_payload->>'charger_fee_exempt')::BOOLEAN, charger_fee_exempt),
                version = version + 1,
                updated_at = NOW()
            WHERE id = v_entity_uuid;
            PERFORM public.record_canonical_change('customers', v_entity_uuid, 'UPDATE', p_payload, (SELECT version FROM public.customers WHERE id = v_entity_uuid));
            v_result := jsonb_build_object('customerId', v_entity_uuid);

        WHEN 'CREATE_DEVICE_TYPE' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            INSERT INTO public.device_types (
                id, name, name_ar, name_en, icon, base_price_minor, charger_fee_enabled, status, is_active, sort_order, version, created_at, updated_at
            )
            VALUES (
                v_entity_uuid,
                COALESCE(p_payload->>'name', 'Device'),
                p_payload->>'nameAr',
                p_payload->>'nameEn',
                COALESCE(p_payload->>'icon', 'smartphone'),
                COALESCE((p_payload->>'basePriceMinor')::BIGINT, (p_payload->>'base_price_minor')::BIGINT, 0),
                COALESCE((p_payload->>'chargerFeeEnabled')::BOOLEAN, (p_payload->>'charger_fee_enabled')::BOOLEAN, TRUE),
                COALESCE((p_payload->>'status')::public.device_status, 'ACTIVE'),
                TRUE,
                COALESCE((p_payload->>'sortOrder')::INTEGER, (p_payload->>'sort_order')::INTEGER, 0),
                1,
                NOW(),
                NOW()
            )
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                base_price_minor = EXCLUDED.base_price_minor,
                version = device_types.version + 1,
                updated_at = NOW();
            PERFORM public.record_canonical_change('device_types', v_entity_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('deviceTypeId', v_entity_uuid);

        WHEN 'DELIVER_ORDER_ITEM' THEN
            v_item_uuid := (COALESCE(p_payload->>'itemId', p_payload->>'id', p_payload->>'orderItemId'))::UUID;
            
            -- CANONICAL LOCK ORDER: 1. customers, 2. orders, 3. order_items
            SELECT order_id INTO v_order_uuid FROM public.order_items WHERE id = v_item_uuid;
            IF v_order_uuid IS NULL THEN RAISE EXCEPTION 'Item not found'; END IF;
            
            SELECT customer_id INTO v_customer_uuid FROM public.orders WHERE id = v_order_uuid;
            IF v_customer_uuid IS NULL THEN RAISE EXCEPTION 'Order customer not found'; END IF;

            -- 1. Lock Customer FOR UPDATE
            PERFORM 1 FROM public.customers WHERE id = v_customer_uuid FOR UPDATE;
            
            -- 2. Lock Order FOR UPDATE
            PERFORM 1 FROM public.orders WHERE id = v_order_uuid FOR UPDATE;

            -- 3. Lock Target Order Item FOR UPDATE and re-read authoritative state AFTER lock
            SELECT oi.*, o.customer_id, c.debt_limit_minor INTO v_rec_item 
            FROM public.order_items oi 
            JOIN public.orders o ON oi.order_id = o.id 
            JOIN public.customers c ON o.customer_id = c.id 
            WHERE oi.id = v_item_uuid
            FOR UPDATE OF oi;

            IF v_rec_item.id IS NULL THEN RAISE EXCEPTION 'Item not found'; END IF;

            -- Idempotency / Already recognized check AFTER acquiring locks
            IF v_rec_item.financial_status = 'RECOGNIZED' THEN
                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'alreadyRecognized', TRUE);
            ELSE
                v_authoritative_final_charge := v_rec_item.final_charge_snapshot_minor;
                
                -- Update item state
                UPDATE public.order_items 
                SET status = 'delivered', operational_status = 'DELIVERED', financial_status = 'RECOGNIZED', 
                    delivered_at = NOW(), financially_recognized_at = NOW(), updated_at = NOW(), version = version + 1 
                WHERE id = v_item_uuid;

                -- Insert ledger entry
                INSERT INTO public.financial_ledger (event_type, amount_minor, order_id, order_item_id, customer_id, actor_admin_id, created_at)
                VALUES ('ORDER_ITEM_CHARGE', -v_authoritative_final_charge, v_rec_item.order_id, v_item_uuid, v_rec_item.customer_id, v_actor_id, NOW())
                RETURNING id INTO v_ledger_uuid;

                -- Server-authoritative parent order status update
                IF NOT EXISTS (
                    SELECT 1 FROM public.order_items 
                    WHERE order_id = v_rec_item.order_id 
                      AND status <> 'cancelled' 
                      AND status <> 'delivered'
                ) THEN
                    UPDATE public.orders 
                    SET status = 'delivered', updated_at = NOW(), version = version + 1 
                    WHERE id = v_rec_item.order_id;
                    PERFORM public.record_canonical_change('orders', v_rec_item.order_id, 'UPDATE', jsonb_build_object('status', 'delivered'), (SELECT version FROM public.orders WHERE id = v_rec_item.order_id));
                END IF;

                PERFORM public.record_canonical_change('order_items', v_item_uuid, 'UPDATE', jsonb_build_object('financial_status', 'RECOGNIZED'), 1);
                PERFORM public.record_canonical_change('financial_ledger', v_ledger_uuid, 'INSERT', jsonb_build_object('event_type', 'ORDER_ITEM_CHARGE', 'amount_minor', v_authoritative_final_charge), 1);

                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'status', 'DELIVERED', 'ledgerEntryId', v_ledger_uuid);
            END IF;

        WHEN 'POST_PAYMENT', 'CREATE_PAYMENT' THEN
            v_payment_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (COALESCE(p_payload->>'customerId', p_payload->>'customer_id'))::UUID;
            v_unallocated_amount := (COALESCE(p_payload->>'amountMinor', p_payload->>'amount_minor'))::BIGINT;

            IF v_unallocated_amount <= 0 THEN
                RAISE EXCEPTION 'Invalid Payment: Amount must be positive';
            END IF;

            -- CANONICAL LOCK: Lock customer row FOR UPDATE first
            PERFORM 1 FROM public.customers WHERE id = v_customer_uuid FOR UPDATE;

            -- 1. Create Payment record
            INSERT INTO public.payments (id, customer_id, amount_minor, payment_method, reference, actor_admin_id, command_id, created_at)
            VALUES (
                v_payment_uuid,
                v_customer_uuid,
                v_unallocated_amount,
                COALESCE(p_payload->>'paymentMethod', p_payload->>'payment_method', 'CASH'),
                COALESCE(p_payload->>'reference', ''),
                v_actor_id,
                p_command_id,
                NOW()
            );

            -- 2. Ledger Payment Entry
            INSERT INTO public.financial_ledger (
                event_type, amount_minor, customer_id, actor_admin_id, reference_id, created_at
            )
            VALUES (
                'PAYMENT',
                v_unallocated_amount,
                v_customer_uuid,
                v_actor_id,
                v_payment_uuid,
                NOW()
            )
            RETURNING id INTO v_ledger_uuid;

            -- 3. FIFO Allocation to oldest recognized outstanding items with deterministic FOR UPDATE locking in strict order
            FOR v_rec_item IN
                SELECT oi.id, oi.order_id, oi.final_charge_snapshot_minor,
                       COALESCE(SUM(pa.allocated_amount_minor), 0) AS paid_so_far
                FROM public.order_items oi
                JOIN public.orders o ON oi.order_id = o.id
                LEFT JOIN public.payment_allocations pa ON oi.id = pa.order_item_id
                WHERE o.customer_id = v_customer_uuid
                  AND oi.financial_status = 'RECOGNIZED'
                  AND oi.payment_status != 'PAID'
                GROUP BY oi.id, oi.order_id, oi.final_charge_snapshot_minor, oi.created_at
                ORDER BY oi.created_at ASC, oi.id ASC
                FOR UPDATE OF oi
            LOOP
                EXIT WHEN v_unallocated_amount <= 0;

                v_item_charge_due := v_rec_item.final_charge_snapshot_minor - v_rec_item.paid_so_far;
                IF v_item_charge_due > 0 THEN
                    IF v_unallocated_amount >= v_item_charge_due THEN
                        v_alloc_amount := v_item_charge_due;
                        v_unallocated_amount := v_unallocated_amount - v_item_charge_due;

                        UPDATE public.order_items SET payment_status = 'PAID', updated_at = NOW(), version = version + 1
                        WHERE id = v_rec_item.id;

                        PERFORM public.record_canonical_change('order_items', v_rec_item.id, 'UPDATE', jsonb_build_object('id', v_rec_item.id, 'payment_status', 'PAID'), 1);
                    ELSE
                        v_alloc_amount := v_unallocated_amount;
                        v_unallocated_amount := 0;

                        UPDATE public.order_items SET payment_status = 'PARTIALLY_PAID', updated_at = NOW(), version = version + 1
                        WHERE id = v_rec_item.id;

                        PERFORM public.record_canonical_change('order_items', v_rec_item.id, 'UPDATE', jsonb_build_object('id', v_rec_item.id, 'payment_status', 'PARTIALLY_PAID'), 1);
                    END IF;

                    INSERT INTO public.payment_allocations (
                        id, payment_id, order_item_id, order_id, allocated_amount_minor, created_at
                    )
                    VALUES (
                        gen_random_uuid(),
                        v_payment_uuid,
                        v_rec_item.id,
                        v_rec_item.order_id,
                        v_alloc_amount,
                        NOW()
                    )
                    RETURNING id INTO v_alloc_uuid;

                    PERFORM public.record_canonical_change('payment_allocations', v_alloc_uuid, 'INSERT', jsonb_build_object(
                        'id', v_alloc_uuid,
                        'payment_id', v_payment_uuid,
                        'order_item_id', v_rec_item.id,
                        'allocated_amount_minor', v_alloc_amount
                    ), 1);
                END IF;
            END LOOP;

            v_result := jsonb_build_object('paymentId', v_payment_uuid, 'amountMinor', v_unallocated_amount);

        WHEN 'CREATE_ORDER' THEN
            v_order_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (p_payload->>'customerId')::UUID;
            -- Lock customer row for order creation
            PERFORM 1 FROM public.customers WHERE id = v_customer_uuid FOR UPDATE;
            INSERT INTO public.orders (
                id,
                day_id,
                customer_id,
                display_number,
                status,
                notes,
                customer_balance_snapshot_minor,
                version,
                created_at,
                updated_at
            )
            VALUES (
                v_order_uuid,
                (p_payload->>'dayId')::UUID,
                v_customer_uuid,
                COALESCE((p_payload->>'displayNumber')::INTEGER, 1),
                (COALESCE(p_payload->>'status', 'pending'))::public.order_status,
                COALESCE(p_payload->>'notes', ''),
                COALESCE((p_payload->>'customerBalanceSnapshotMinor')::INTEGER, (p_payload->>'customer_balance_snapshot_minor')::INTEGER, 0),
                1,
                NOW(),
                NOW()
            )
            ON CONFLICT (id) DO UPDATE SET
                status = EXCLUDED.status,
                notes = EXCLUDED.notes,
                customer_balance_snapshot_minor = EXCLUDED.customer_balance_snapshot_minor,
                version = orders.version + 1,
                updated_at = NOW();
            PERFORM public.record_canonical_change('orders', v_order_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('orderId', v_order_uuid);

        WHEN 'ADD_ORDER_ITEM' THEN
            v_item_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_order_uuid := (p_payload->>'orderId')::UUID;
            -- Lock order row for item addition
            PERFORM 1 FROM public.orders WHERE id = v_order_uuid FOR UPDATE;
            v_entity_uuid := (p_payload->>'deviceTypeId')::UUID;
            SELECT name, icon, base_price_minor, charger_fee_applicable 
            INTO v_dev_name, v_dev_icon, v_base_price, v_charger_applicable 
            FROM public.device_types 
            WHERE id = v_entity_uuid;
            SELECT charger_fee_exempt, id 
            INTO v_customer_exempt, v_customer_uuid 
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

        ELSE
            v_result := jsonb_build_object('success', TRUE);
    END CASE;

    -- ==========================================
    -- 6. RECORD PROCESSED COMMAND & RETURN
    -- ==========================================
    INSERT INTO public.processed_commands (command_id, command_type, payload_hash, actor_admin_id, result_payload)
    VALUES (p_command_id, p_command_type, p_payload_hash, v_actor_id, v_result)
    ON CONFLICT (command_id) DO NOTHING;

    RETURN jsonb_build_object(
        'success', TRUE,
        'commandId', p_command_id,
        'serverVersion', 1,
        'rpcReached', TRUE,
        'result', v_result
    );
END;
$$;
