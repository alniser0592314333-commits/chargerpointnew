import { query } from "./db.mjs";

const sql = `
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
    v_rec_order RECORD;
    v_rec_customer RECORD;
    v_base_price BIGINT;
    v_charger_applicable BOOLEAN;
    v_setting_charger_fee BIGINT;
    v_authoritative_charger_fee BIGINT;
    v_authoritative_discount BIGINT;
    v_authoritative_final_charge BIGINT;
    v_current_balance BIGINT;
    v_projected_balance BIGINT;
    v_has_charger BOOLEAN;
    v_customer_exempt BOOLEAN;
    v_goal RECORD;
    v_goal_req RECORD;
    v_goal_target INT;
    v_goal_duration INT;
    v_goal_bonus BIGINT;
    v_goal_expires TIMESTAMPTZ;
    v_goal_eval JSONB;
BEGIN
    -- 1. STRICT IDEMPOTENCY CHECK
    SELECT command_id, payload_hash, result_payload
    INTO v_existing_cmd
    FROM public.processed_commands
    WHERE command_id = p_command_id;

    IF v_existing_cmd.command_id IS NOT NULL THEN
        IF v_existing_cmd.payload_hash = p_payload_hash OR p_payload_hash = 'no_hash' THEN
            -- Exact idempotent retry: Return previous result
            RETURN jsonb_build_object(
                'success', TRUE,
                'idempotent', TRUE,
                'commandId', p_command_id,
                'result', v_existing_cmd.result_payload
            );
        ELSE
            -- Same command ID with DIFFERENT payload: REJECT
            RAISE EXCEPTION 'Idempotency Conflict: Command ID % already executed with different payload', p_command_id
                USING ERRCODE = '23505';
        END IF;
    END IF;

    -- 2. RESOLVE ACTOR
    IF auth.uid() IS NOT NULL THEN
        SELECT id, role, is_active INTO v_actor_id, v_admin_role, v_is_active
        FROM public.admins WHERE auth_user_id = auth.uid() LIMIT 1;
    END IF;

    IF v_actor_id IS NULL THEN
        SELECT id, role, is_active INTO v_actor_id, v_admin_role, v_is_active
        FROM public.admins WHERE role IN ('SUPER_ADMIN', 'Super Admin') AND is_active = true
        LIMIT 1;
    END IF;

    -- 3. ROUTE BY CANONICAL COMMAND TYPE
    CASE p_command_type

        -- ----------------------------------------------------
        -- A. CUSTOMER OPERATIONS
        -- ----------------------------------------------------
        WHEN 'CREATE_CUSTOMER' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            INSERT INTO public.customers (
                id, name, phone, status, is_active, notes, debt_limit_minor, charger_fee_exempt, version, created_at, updated_at
            )
            VALUES (
                v_entity_uuid,
                TRIM(p_payload->>'name'),
                NULLIF(TRIM(p_payload->>'phone'), ''),
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
                debt_limit_minor = EXCLUDED.debt_limit_minor,
                charger_fee_exempt = EXCLUDED.charger_fee_exempt,
                updated_at = NOW(),
                version = public.customers.version + 1;

            PERFORM public.record_canonical_change('customers', v_entity_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('customerId', v_entity_uuid);

        WHEN 'SOFT_DELETE_CUSTOMER' THEN
            v_entity_uuid := (p_payload->>'id')::UUID;
            UPDATE public.customers
            SET status = 'DELETED',
                is_active = FALSE,
                deleted_at = NOW(),
                updated_at = NOW(),
                version = version + 1
            WHERE id = v_entity_uuid;

            PERFORM public.record_canonical_change('customers', v_entity_uuid, 'TOMBSTONE', jsonb_build_object('id', v_entity_uuid, 'status', 'DELETED'), 1);
            v_result := jsonb_build_object('customerId', v_entity_uuid, 'status', 'DELETED');

        -- ----------------------------------------------------
        -- B. DEVICE TYPE OPERATIONS
        -- ----------------------------------------------------
        WHEN 'CREATE_DEVICE_TYPE' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            INSERT INTO public.device_types (
                id, name, name_ar, name_en, icon, base_price_minor, charger_fee_enabled, charger_fee_applicable, is_active, status, sort_order, version
            )
            VALUES (
                v_entity_uuid,
                TRIM(p_payload->>'name'),
                COALESCE(p_payload->>'nameAr', p_payload->>'name_ar', p_payload->>'name'),
                COALESCE(p_payload->>'nameEn', p_payload->>'name_en', p_payload->>'name'),
                COALESCE(p_payload->>'icon', 'smartphone'),
                COALESCE((p_payload->>'basePriceMinor')::BIGINT, (p_payload->>'base_price_minor')::BIGINT, 0),
                COALESCE((p_payload->>'chargerFeeEnabled')::BOOLEAN, (p_payload->>'charger_fee_enabled')::BOOLEAN, TRUE),
                COALESCE((p_payload->>'chargerFeeApplicable')::BOOLEAN, (p_payload->>'charger_fee_applicable')::BOOLEAN, TRUE),
                TRUE,
                'ACTIVE',
                COALESCE((p_payload->>'sortOrder')::INTEGER, (p_payload->>'sort_order')::INTEGER, 0),
                1
            )
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                name_ar = EXCLUDED.name_ar,
                name_en = EXCLUDED.name_en,
                base_price_minor = EXCLUDED.base_price_minor,
                charger_fee_enabled = EXCLUDED.charger_fee_enabled,
                charger_fee_applicable = EXCLUDED.charger_fee_applicable,
                sort_order = EXCLUDED.sort_order,
                updated_at = NOW(),
                version = public.device_types.version + 1;

            PERFORM public.record_canonical_change('device_types', v_entity_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('deviceTypeId', v_entity_uuid);

        WHEN 'RETIRE_DEVICE_TYPE' THEN
            v_entity_uuid := (p_payload->>'id')::UUID;
            UPDATE public.device_types
            SET status = 'RETIRED',
                is_active = FALSE,
                deleted_at = NOW(),
                updated_at = NOW(),
                version = version + 1
            WHERE id = v_entity_uuid;

            PERFORM public.record_canonical_change('device_types', v_entity_uuid, 'UPDATE', jsonb_build_object('id', v_entity_uuid, 'status', 'RETIRED'), 1);
            v_result := jsonb_build_object('deviceTypeId', v_entity_uuid, 'status', 'RETIRED');

        -- ----------------------------------------------------
        -- C. BUSINESS DAYS
        -- ----------------------------------------------------
        WHEN 'CREATE_BUSINESS_DAY', 'OPEN_DAY' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            INSERT INTO public.business_days (id, business_date, display_number, status, is_closed, opened_at, version)
            VALUES (
                v_entity_uuid,
                (COALESCE(p_payload->>'businessDate', p_payload->>'business_date', p_payload->>'date'))::DATE,
                COALESCE((p_payload->>'displayNumber')::INTEGER, 1),
                'OPEN',
                FALSE,
                NOW(),
                1
            )
            ON CONFLICT (business_date) DO UPDATE SET
                status = 'OPEN',
                is_closed = FALSE,
                updated_at = NOW()
            RETURNING id INTO v_entity_uuid;

            PERFORM public.record_canonical_change('business_days', v_entity_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('businessDayId', v_entity_uuid);

        WHEN 'CLOSE_BUSINESS_DAY' THEN
            v_entity_uuid := (p_payload->>'id')::UUID;
            UPDATE public.business_days
            SET status = 'CLOSED',
                is_closed = TRUE,
                closed_at = NOW(),
                closed_by = v_actor_id,
                updated_at = NOW(),
                version = version + 1
            WHERE id = v_entity_uuid;

            PERFORM public.record_canonical_change('business_days', v_entity_uuid, 'UPDATE', jsonb_build_object('id', v_entity_uuid, 'status', 'CLOSED', 'is_closed', TRUE), 1);
            v_result := jsonb_build_object('businessDayId', v_entity_uuid, 'status', 'CLOSED');

        -- ----------------------------------------------------
        -- D. ORDERS & ORDER ITEMS CREATION
        -- ----------------------------------------------------
        WHEN 'CREATE_ORDER' THEN
            v_order_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (p_payload->>'customerId')::UUID;

            SELECT status INTO v_rec_customer FROM public.customers WHERE id = v_customer_uuid;
            IF v_rec_customer.status = 'DELETED' THEN
                RAISE EXCEPTION 'Cannot create order: Customer % is soft-deleted/frozen', v_customer_uuid;
            END IF;

            INSERT INTO public.orders (id, day_id, customer_id, display_number, status, notes, version, created_at, updated_at)
            VALUES (
                v_order_uuid,
                (p_payload->>'dayId')::UUID,
                v_customer_uuid,
                COALESCE((p_payload->>'displayNumber')::INTEGER, 1),
                'pending'::order_status,
                COALESCE(p_payload->>'notes', ''),
                1,
                NOW(),
                NOW()
            )
            ON CONFLICT (id) DO UPDATE SET
                notes = EXCLUDED.notes,
                updated_at = NOW(),
                version = public.orders.version + 1;

            PERFORM public.record_canonical_change('orders', v_order_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('orderId', v_order_uuid);

        WHEN 'ADD_ORDER_ITEM' THEN
            v_item_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_order_uuid := (p_payload->>'orderId')::UUID;

            SELECT o.*, c.status AS cust_status, c.debt_limit_minor, c.charger_fee_exempt
            INTO v_rec_order
            FROM public.orders o
            JOIN public.customers c ON o.customer_id = c.id
            WHERE o.id = v_order_uuid;

            IF v_rec_order.cust_status = 'DELETED' THEN
                RAISE EXCEPTION 'Cannot add item: Customer % is soft-deleted/frozen', v_rec_order.customer_id;
            END IF;

            SELECT name, icon, base_price_minor, charger_fee_enabled, charger_fee_applicable, status
            INTO v_rec_item
            FROM public.device_types
            WHERE id = (p_payload->>'deviceTypeId')::UUID;

            IF v_rec_item.status = 'RETIRED' THEN
                RAISE EXCEPTION 'Cannot add item: Device type is retired';
            END IF;

            v_has_charger := COALESCE((p_payload->>'hasCharger')::BOOLEAN, (p_payload->>'has_charger')::BOOLEAN, TRUE);
            v_customer_exempt := COALESCE(v_rec_order.charger_fee_exempt, FALSE);
            v_charger_applicable := COALESCE(v_rec_item.charger_fee_enabled, TRUE) AND COALESCE(v_rec_item.charger_fee_applicable, TRUE);

            SELECT COALESCE(value_number, 500)
            INTO v_setting_charger_fee
            FROM public.system_settings
            WHERE key = 'default_charger_fee_minor';
            IF v_setting_charger_fee IS NULL THEN v_setting_charger_fee := 500; END IF;

            IF v_charger_applicable AND (NOT v_customer_exempt) AND (NOT v_has_charger) THEN
                v_authoritative_charger_fee := v_setting_charger_fee;
            ELSE
                v_authoritative_charger_fee := 0;
            END IF;

            v_base_price := COALESCE(v_rec_item.base_price_minor, 0);
            v_authoritative_discount := COALESCE((p_payload->>'discountMinor')::BIGINT, 0);
            v_authoritative_final_charge := GREATEST(0, v_base_price + v_authoritative_charger_fee - v_authoritative_discount);

            INSERT INTO public.order_items (
                id, order_id, device_type_id, item_sequence,
                operational_status, financial_status, payment_status, status,
                device_name_snapshot, device_icon_snapshot,
                base_price_snapshot_minor, charger_fee_snapshot_minor, discount_snapshot_minor, final_charge_snapshot_minor,
                has_charger, charger_fee_enabled_snapshot, customer_charger_fee_exempt_snapshot,
                unit_price_minor, total_price_minor, notes, version, created_at, updated_at
            )
            VALUES (
                v_item_uuid,
                v_order_uuid,
                (p_payload->>'deviceTypeId')::UUID,
                COALESCE((p_payload->>'itemSequence')::INTEGER, 1),
                'CHARGING',
                'UNRECOGNIZED',
                'UNPAID',
                'charging'::item_status,
                v_rec_item.name,
                v_rec_item.icon,
                v_base_price,
                v_authoritative_charger_fee,
                v_authoritative_discount,
                v_authoritative_final_charge,
                v_has_charger,
                v_charger_applicable,
                v_customer_exempt,
                v_authoritative_final_charge,
                v_authoritative_final_charge,
                NULL,
                1,
                NOW(),
                NOW()
            )
            ON CONFLICT (id) DO UPDATE SET
                base_price_snapshot_minor = EXCLUDED.base_price_snapshot_minor,
                charger_fee_snapshot_minor = EXCLUDED.charger_fee_snapshot_minor,
                discount_snapshot_minor = EXCLUDED.discount_snapshot_minor,
                final_charge_snapshot_minor = EXCLUDED.final_charge_snapshot_minor,
                total_price_minor = EXCLUDED.total_price_minor,
                updated_at = NOW(),
                version = public.order_items.version + 1;

            PERFORM public.record_canonical_change('order_items', v_item_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('orderItemId', v_item_uuid, 'provisionalFinalChargeMinor', v_authoritative_final_charge);

        -- ----------------------------------------------------
        -- E. SEMANTIC DELIVERY OPERATION
        -- ----------------------------------------------------
        WHEN 'DELIVER_ORDER_ITEM' THEN
            v_item_uuid := (COALESCE(p_payload->>'itemId', p_payload->>'orderItemId', p_payload->>'id'))::UUID;

            SELECT oi.*, o.customer_id, c.status AS cust_status, c.debt_limit_minor, c.charger_fee_exempt
            INTO v_rec_item
            FROM public.order_items oi
            JOIN public.orders o ON oi.order_id = o.id
            JOIN public.customers c ON o.customer_id = c.id
            WHERE oi.id = v_item_uuid;

            IF v_rec_item.id IS NULL THEN
                RAISE EXCEPTION 'Order Item Not Found: ID %', v_item_uuid USING ERRCODE = '23503';
            END IF;

            IF v_rec_item.cust_status = 'DELETED' THEN
                RAISE EXCEPTION 'Customer is soft-deleted/frozen. Cannot deliver item';
            END IF;

            -- Check if already recognized
            IF v_rec_item.financial_status = 'RECOGNIZED' THEN
                -- Idempotent return
                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'status', 'DELIVERED', 'alreadyRecognized', TRUE);
            ELSE
                SELECT base_price_minor, charger_fee_applicable
                INTO v_base_price, v_charger_applicable
                FROM public.device_types
                WHERE id = v_rec_item.device_type_id;

                IF v_base_price IS NULL THEN
                    RAISE EXCEPTION 'Device Type Not Found for Item: ID %', v_rec_item.device_type_id USING ERRCODE = '23503';
                END IF;

                SELECT COALESCE(value_number, 500)
                INTO v_setting_charger_fee
                FROM public.system_settings
                WHERE key = 'default_charger_fee_minor';
                IF v_setting_charger_fee IS NULL THEN v_setting_charger_fee := 500; END IF;

                IF v_charger_applicable AND (NOT v_rec_item.charger_fee_exempt) AND (NOT v_rec_item.has_charger) THEN
                    v_authoritative_charger_fee := v_setting_charger_fee;
                ELSE
                    v_authoritative_charger_fee := 0;
                END IF;

                v_authoritative_discount := COALESCE(v_rec_item.discount_snapshot_minor, 0);
                v_authoritative_final_charge := GREATEST(0, v_base_price + v_authoritative_charger_fee - v_authoritative_discount);

                v_current_balance := public.calculate_customer_authoritative_balance(v_rec_item.customer_id);
                v_projected_balance := v_current_balance - v_authoritative_final_charge;

                IF v_rec_item.debt_limit_minor > 0 AND v_projected_balance < (-v_rec_item.debt_limit_minor) THEN
                    RAISE EXCEPTION 'Debt Limit Exceeded: Customer debt limit % exceeded by projected balance %',
                        v_rec_item.debt_limit_minor, v_projected_balance;
                END IF;

                UPDATE public.order_items
                SET operational_status = 'DELIVERED',
                    financial_status = 'RECOGNIZED',
                    status = 'delivered',
                    base_price_snapshot_minor = v_base_price,
                    charger_fee_snapshot_minor = v_authoritative_charger_fee,
                    final_charge_snapshot_minor = v_authoritative_final_charge,
                    unit_price_minor = v_authoritative_final_charge,
                    total_price_minor = v_authoritative_final_charge,
                    delivered_at = NOW(),
                    financially_recognized_at = NOW(),
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_item_uuid;

                INSERT INTO public.financial_ledger (
                    event_type, amount_minor, order_id, order_item_id, customer_id, actor_admin_id, metadata, created_at
                )
                VALUES (
                    'CHARGE',
                    -v_authoritative_final_charge,
                    v_rec_item.order_id,
                    v_item_uuid,
                    v_rec_item.customer_id,
                    v_actor_id,
                    jsonb_build_object(
                        'itemSequence', v_rec_item.item_sequence,
                        'basePrice', v_base_price,
                        'chargerFee', v_authoritative_charger_fee,
                        'discount', v_authoritative_discount,
                        'deliveredAt', NOW()
                    ),
                    NOW()
                )
                RETURNING id INTO v_ledger_uuid;

                IF NOT EXISTS (
                    SELECT 1 FROM public.order_items
                    WHERE order_id = v_rec_item.order_id
                      AND operational_status NOT IN ('DELIVERED', 'CANCELLED')
                ) THEN
                    UPDATE public.orders SET status = 'delivered', updated_at = NOW(), version = version + 1
                    WHERE id = v_rec_item.order_id;
                    PERFORM public.record_canonical_change('orders', v_rec_item.order_id, 'UPDATE', jsonb_build_object('status', 'delivered'), 1);
                END IF;

                PERFORM public.record_canonical_change('order_items', v_item_uuid, 'UPDATE', jsonb_build_object(
                    'operational_status', 'DELIVERED',
                    'financial_status', 'RECOGNIZED',
                    'base_price_snapshot_minor', v_base_price,
                    'charger_fee_snapshot_minor', v_authoritative_charger_fee,
                    'final_charge_snapshot_minor', v_authoritative_final_charge,
                    'financially_recognized_at', NOW()
                ), 1);

                PERFORM public.record_canonical_change('financial_ledger', v_ledger_uuid, 'INSERT', jsonb_build_object(
                    'event_type', 'CHARGE',
                    'amount_minor', -v_authoritative_final_charge,
                    'order_item_id', v_item_uuid,
                    'customer_id', v_rec_item.customer_id
                ), 1);

                -- Authoritative Goal Evaluation Trigger
                v_goal_eval := public.evaluate_customer_active_goal(v_rec_item.customer_id);

                v_result := jsonb_build_object(
                    'orderItemId', v_item_uuid,
                    'status', 'DELIVERED',
                    'financialStatus', 'RECOGNIZED',
                    'finalChargeMinor', v_authoritative_final_charge,
                    'ledgerEntryId', v_ledger_uuid,
                    'goalEvaluation', v_goal_eval
                );
            END IF;

        -- ----------------------------------------------------
        -- F. CANCEL ORDER ITEM
        -- ----------------------------------------------------
        WHEN 'CANCEL_ORDER_ITEM' THEN
            v_item_uuid := (COALESCE(p_payload->>'itemId', p_payload->>'orderItemId', p_payload->>'id'))::UUID;

            SELECT oi.*, o.customer_id
            INTO v_rec_item
            FROM public.order_items oi
            JOIN public.orders o ON oi.order_id = o.id
            WHERE oi.id = v_item_uuid;

            IF v_rec_item.id IS NULL THEN
                RAISE EXCEPTION 'Order Item Not Found: ID %', v_item_uuid;
            END IF;

            IF v_rec_item.financial_status = 'RECOGNIZED' THEN
                -- Post-recognition semantic REVERSAL
                UPDATE public.order_items
                SET operational_status = 'CANCELLED',
                    financial_status = 'REVERSED',
                    status = 'cancelled',
                    cancelled_at = NOW(),
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_item_uuid;

                INSERT INTO public.financial_ledger (
                    event_type, amount_minor, order_id, order_item_id, customer_id, actor_admin_id, metadata, created_at
                )
                VALUES (
                    'REVERSAL',
                    v_rec_item.final_charge_snapshot_minor,
                    v_rec_item.order_id,
                    v_item_uuid,
                    v_rec_item.customer_id,
                    v_actor_id,
                    jsonb_build_object('reason', 'ORDER_ITEM_CANCELLED_POST_RECOGNITION', 'originalCharge', v_rec_item.final_charge_snapshot_minor),
                    NOW()
                )
                RETURNING id INTO v_ledger_uuid;

                PERFORM public.record_canonical_change('order_items', v_item_uuid, 'UPDATE', jsonb_build_object(
                    'operational_status', 'CANCELLED',
                    'financial_status', 'REVERSED',
                    'cancelled_at', NOW()
                ), 1);

                PERFORM public.record_canonical_change('financial_ledger', v_ledger_uuid, 'INSERT', jsonb_build_object(
                    'event_type', 'REVERSAL',
                    'amount_minor', v_rec_item.final_charge_snapshot_minor,
                    'order_item_id', v_item_uuid,
                    'customer_id', v_rec_item.customer_id
                ), 1);

                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'status', 'CANCELLED', 'financialStatus', 'REVERSED', 'reversalLedgerId', v_ledger_uuid);
            ELSE
                -- Pre-recognition cancellation: ZERO financial footprint
                UPDATE public.order_items
                SET operational_status = 'CANCELLED',
                    status = 'cancelled',
                    cancelled_at = NOW(),
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_item_uuid;

                PERFORM public.record_canonical_change('order_items', v_item_uuid, 'UPDATE', jsonb_build_object(
                    'operational_status', 'CANCELLED',
                    'cancelled_at', NOW()
                ), 1);

                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'status', 'CANCELLED', 'financialStatus', 'UNRECOGNIZED');
            END IF;

        -- ----------------------------------------------------
        -- G. POST PAYMENT & FIFO ALLOCATION
        -- ----------------------------------------------------
        WHEN 'POST_PAYMENT' THEN
            v_payment_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (p_payload->>'customerId')::UUID;
            v_authoritative_final_charge := (p_payload->>'amountMinor')::BIGINT;

            INSERT INTO public.payments (
                id, customer_id, amount_minor, payment_method, reference, actor_admin_id, command_id, notes, created_at
            )
            VALUES (
                v_payment_uuid,
                v_customer_uuid,
                v_authoritative_final_charge,
                COALESCE(p_payload->>'paymentMethod', 'CASH'),
                p_payload->>'reference',
                v_actor_id,
                p_command_id,
                p_payload->>'notes',
                NOW()
            );

            INSERT INTO public.financial_ledger (
                event_type, amount_minor, customer_id, actor_admin_id, reference_id, metadata, created_at
            )
            VALUES (
                'PAYMENT',
                v_authoritative_final_charge,
                v_customer_uuid,
                v_actor_id,
                v_payment_uuid,
                jsonb_build_object('paymentMethod', COALESCE(p_payload->>'paymentMethod', 'CASH')),
                NOW()
            )
            RETURNING id INTO v_ledger_uuid;

            -- Authoritative FIFO Allocation Loop
            DECLARE
                v_remaining_payment BIGINT := v_authoritative_final_charge;
                v_unpaid_item RECORD;
                v_alloc_amount BIGINT;
                v_item_already_allocated BIGINT;
                v_item_due BIGINT;
                v_alloc_uuid UUID;
            BEGIN
                FOR v_unpaid_item IN
                    SELECT oi.id, oi.order_id, oi.final_charge_snapshot_minor, oi.created_at
                    FROM public.order_items oi
                    JOIN public.orders o ON oi.order_id = o.id
                    WHERE o.customer_id = v_customer_uuid
                      AND oi.financial_status = 'RECOGNIZED'
                      AND oi.payment_status != 'PAID'
                    ORDER BY oi.created_at ASC, oi.item_sequence ASC
                LOOP
                    EXIT WHEN v_remaining_payment <= 0;

                    SELECT COALESCE(SUM(allocated_amount_minor), 0)
                    INTO v_item_already_allocated
                    FROM public.payment_allocations
                    WHERE order_item_id = v_unpaid_item.id;

                    v_item_due := v_unpaid_item.final_charge_snapshot_minor - v_item_already_allocated;

                    IF v_item_due > 0 THEN
                        v_alloc_amount := LEAST(v_remaining_payment, v_item_due);
                        v_alloc_uuid := gen_random_uuid();

                        INSERT INTO public.payment_allocations (
                            id, payment_id, order_item_id, order_id, allocated_amount_minor, created_at
                        )
                        VALUES (
                            v_alloc_uuid,
                            v_payment_uuid,
                            v_unpaid_item.id,
                            v_unpaid_item.order_id,
                            v_alloc_amount,
                            NOW()
                        );

                        v_remaining_payment := v_remaining_payment - v_alloc_amount;

                        IF (v_item_already_allocated + v_alloc_amount) >= v_unpaid_item.final_charge_snapshot_minor THEN
                            UPDATE public.order_items SET payment_status = 'PAID', updated_at = NOW() WHERE id = v_unpaid_item.id;
                        ELSE
                            UPDATE public.order_items SET payment_status = 'PARTIALLY_PAID', updated_at = NOW() WHERE id = v_unpaid_item.id;
                        END IF;

                        PERFORM public.record_canonical_change('payment_allocations', v_alloc_uuid, 'INSERT', jsonb_build_object(
                            'payment_id', v_payment_uuid,
                            'order_item_id', v_unpaid_item.id,
                            'allocated_amount_minor', v_alloc_amount
                        ), 1);
                    END IF;
                END LOOP;
            END;

            PERFORM public.record_canonical_change('payments', v_payment_uuid, 'INSERT', jsonb_build_object(
                'customer_id', v_customer_uuid,
                'amount_minor', v_authoritative_final_charge
            ), 1);

            PERFORM public.record_canonical_change('financial_ledger', v_ledger_uuid, 'INSERT', jsonb_build_object(
                'event_type', 'PAYMENT',
                'amount_minor', v_authoritative_final_charge,
                'customer_id', v_customer_uuid
            ), 1);

            v_result := jsonb_build_object('paymentId', v_payment_uuid, 'ledgerEntryId', v_ledger_uuid);

        -- ----------------------------------------------------
        -- H. GOAL COMMANDS (Phase 1 Canonical Baseline)
        -- ----------------------------------------------------
        WHEN 'CREATE_GOAL' THEN
            v_customer_uuid := (p_payload->>'customerId')::UUID;
            v_goal_target := (p_payload->>'targetQuantity')::INT;
            v_goal_duration := COALESCE((p_payload->>'durationDays')::INT, 7);
            v_goal_bonus := COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, 500);
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);

            -- Verify customer exists and is not deleted
            SELECT status INTO v_rec_customer FROM public.customers WHERE id = v_customer_uuid;
            IF v_rec_customer.status IS NULL THEN
                RAISE EXCEPTION 'Customer Not Found: ID %', v_customer_uuid USING ERRCODE = '23503';
            END IF;
            IF v_rec_customer.status = 'DELETED' THEN
                RAISE EXCEPTION 'Customer is soft-deleted/frozen. Cannot create goal';
            END IF;

            -- Invariant: Single active goal per customer
            IF EXISTS (SELECT 1 FROM public.goals WHERE customer_id = v_customer_uuid AND status = 'ACTIVE') THEN
                RAISE EXCEPTION 'Customer % already has an active goal. Only one active goal allowed.', v_customer_uuid;
            END IF;

            v_goal_expires := COALESCE(
                (p_payload->>'expiresAt')::TIMESTAMPTZ,
                NOW() + (v_goal_duration || ' days')::INTERVAL
            );

            INSERT INTO public.goals (
                id, customer_id, target_quantity, current_progress, bonus_amount_minor, duration_days, status, started_at, expires_at, version, created_at, updated_at
            )
            VALUES (
                v_entity_uuid,
                v_customer_uuid,
                v_goal_target,
                0,
                v_goal_bonus,
                v_goal_duration,
                'ACTIVE',
                COALESCE((p_payload->>'startedAt')::TIMESTAMPTZ, NOW()),
                v_goal_expires,
                1,
                NOW(),
                NOW()
            );

            PERFORM public.record_canonical_change('goals', v_entity_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('goalId', v_entity_uuid, 'status', 'ACTIVE');

        WHEN 'UPDATE_GOAL_CONFIG' THEN
            v_entity_uuid := (p_payload->>'id')::UUID;

            SELECT * INTO v_goal FROM public.goals WHERE id = v_entity_uuid FOR UPDATE;
            IF v_goal.id IS NULL THEN
                RAISE EXCEPTION 'Goal Not Found: ID %', v_entity_uuid USING ERRCODE = '23503';
            END IF;

            IF v_goal.status != 'ACTIVE' THEN
                RAISE EXCEPTION 'Goal % is in status % and cannot be modified. Completed/closed goals are immutable.', v_entity_uuid, v_goal.status;
            END IF;

            v_goal_target := COALESCE((p_payload->>'targetQuantity')::INT, v_goal.target_quantity);
            v_goal_duration := COALESCE((p_payload->>'durationDays')::INT, v_goal.duration_days);
            v_goal_bonus := COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, v_goal.bonus_amount_minor);
            v_goal_expires := COALESCE((p_payload->>'expiresAt')::TIMESTAMPTZ, v_goal.expires_at);

            -- Critical rule: If new target <= current progress, complete immediately & grant bonus
            IF v_goal_target <= v_goal.current_progress THEN
                INSERT INTO public.financial_ledger (
                    event_type, amount_minor, customer_id, reference_id, metadata, created_at
                )
                VALUES (
                    'BONUS',
                    v_goal_bonus,
                    v_goal.customer_id,
                    v_goal.id,
                    jsonb_build_object('reason', 'GOAL_COMPLETED_VIA_CONFIG_UPDATE', 'goalId', v_goal.id, 'targetQuantity', v_goal_target, 'bonusAmountMinor', v_goal_bonus),
                    NOW()
                )
                RETURNING id INTO v_ledger_uuid;

                UPDATE public.goals
                SET target_quantity = v_goal_target,
                    duration_days = v_goal_duration,
                    bonus_amount_minor = v_goal_bonus,
                    expires_at = v_goal_expires,
                    status = 'COMPLETED',
                    completed_at = NOW(),
                    bonus_ledger_id = v_ledger_uuid,
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_entity_uuid;

                PERFORM public.record_canonical_change('financial_ledger', v_ledger_uuid, 'INSERT', jsonb_build_object(
                    'event_type', 'BONUS',
                    'amount_minor', v_goal_bonus,
                    'customer_id', v_goal.customer_id,
                    'reference_id', v_goal.id
                ), 1);

                PERFORM public.record_canonical_change('goals', v_entity_uuid, 'UPDATE', jsonb_build_object(
                    'id', v_entity_uuid,
                    'target_quantity', v_goal_target,
                    'status', 'COMPLETED',
                    'completed_at', NOW(),
                    'bonus_ledger_id', v_ledger_uuid
                ), v_goal.version + 1);

                v_result := jsonb_build_object('goalId', v_entity_uuid, 'status', 'COMPLETED', 'bonusLedgerId', v_ledger_uuid);
            ELSE
                UPDATE public.goals
                SET target_quantity = v_goal_target,
                    duration_days = v_goal_duration,
                    bonus_amount_minor = v_goal_bonus,
                    expires_at = v_goal_expires,
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_entity_uuid;

                PERFORM public.record_canonical_change('goals', v_entity_uuid, 'UPDATE', jsonb_build_object(
                    'id', v_entity_uuid,
                    'target_quantity', v_goal_target,
                    'duration_days', v_goal_duration,
                    'bonus_amount_minor', v_goal_bonus,
                    'expires_at', v_goal_expires
                ), v_goal.version + 1);

                v_result := jsonb_build_object('goalId', v_entity_uuid, 'status', 'ACTIVE');
            END IF;

        WHEN 'RECORD_GOAL_REQUEST' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (p_payload->>'customerId')::UUID;

            INSERT INTO public.goal_requests (
                id, customer_id, requested_target, status, version, created_at, updated_at
            )
            VALUES (
                v_entity_uuid,
                v_customer_uuid,
                (p_payload->>'requestedTarget')::INT,
                'PENDING',
                1,
                NOW(),
                NOW()
            );

            PERFORM public.record_canonical_change('goal_requests', v_entity_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('requestId', v_entity_uuid, 'status', 'PENDING');

        WHEN 'APPROVE_GOAL_REQUEST' THEN
            v_entity_uuid := (p_payload->>'requestId')::UUID;

            SELECT * INTO v_goal_req FROM public.goal_requests WHERE id = v_entity_uuid FOR UPDATE;
            IF v_goal_req.id IS NULL THEN
                RAISE EXCEPTION 'Goal Request Not Found: ID %', v_entity_uuid USING ERRCODE = '23503';
            END IF;

            IF v_goal_req.status != 'PENDING' THEN
                RAISE EXCEPTION 'Goal request is already in status %', v_goal_req.status;
            END IF;

            IF EXISTS (SELECT 1 FROM public.goals WHERE customer_id = v_goal_req.customer_id AND status = 'ACTIVE') THEN
                RAISE EXCEPTION 'Customer % already has an active goal. Cannot approve new goal.', v_goal_req.customer_id;
            END IF;

            v_goal_target := COALESCE((p_payload->>'targetQuantity')::INT, v_goal_req.requested_target, 10);
            v_goal_duration := COALESCE((p_payload->>'durationDays')::INT, 7);
            v_goal_bonus := COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, 500);
            v_item_uuid := gen_random_uuid(); -- new goal ID

            INSERT INTO public.goals (
                id, customer_id, target_quantity, current_progress, bonus_amount_minor, duration_days, status, started_at, expires_at, version, created_at, updated_at
            )
            VALUES (
                v_item_uuid,
                v_goal_req.customer_id,
                v_goal_target,
                0,
                v_goal_bonus,
                v_goal_duration,
                'ACTIVE',
                NOW(),
                NOW() + (v_goal_duration || ' days')::INTERVAL,
                1,
                NOW(),
                NOW()
            );

            UPDATE public.goal_requests
            SET status = 'APPROVED',
                reviewed_by = v_actor_id,
                reviewed_at = NOW(),
                resulting_goal_id = v_item_uuid,
                updated_at = NOW(),
                version = version + 1
            WHERE id = v_entity_uuid;

            PERFORM public.record_canonical_change('goals', v_item_uuid, 'INSERT', jsonb_build_object(
                'id', v_item_uuid,
                'customer_id', v_goal_req.customer_id,
                'target_quantity', v_goal_target,
                'status', 'ACTIVE'
            ), 1);

            PERFORM public.record_canonical_change('goal_requests', v_entity_uuid, 'UPDATE', jsonb_build_object(
                'id', v_entity_uuid,
                'status', 'APPROVED',
                'resulting_goal_id', v_item_uuid
            ), v_goal_req.version + 1);

            v_result := jsonb_build_object('requestId', v_entity_uuid, 'goalId', v_item_uuid, 'status', 'APPROVED');

        WHEN 'REJECT_GOAL_REQUEST' THEN
            v_entity_uuid := (p_payload->>'requestId')::UUID;

            SELECT * INTO v_goal_req FROM public.goal_requests WHERE id = v_entity_uuid FOR UPDATE;
            IF v_goal_req.id IS NULL THEN
                RAISE EXCEPTION 'Goal Request Not Found: ID %', v_entity_uuid USING ERRCODE = '23503';
            END IF;

            IF v_goal_req.status != 'PENDING' THEN
                RAISE EXCEPTION 'Goal request is already in status %', v_goal_req.status;
            END IF;

            UPDATE public.goal_requests
            SET status = 'REJECTED',
                reviewed_by = v_actor_id,
                reviewed_at = NOW(),
                rejection_reason = p_payload->>'rejectionReason',
                updated_at = NOW(),
                version = version + 1
            WHERE id = v_entity_uuid;

            PERFORM public.record_canonical_change('goal_requests', v_entity_uuid, 'UPDATE', jsonb_build_object(
                'id', v_entity_uuid,
                'status', 'REJECTED',
                'rejection_reason', p_payload->>'rejectionReason'
            ), v_goal_req.version + 1);

            v_result := jsonb_build_object('requestId', v_entity_uuid, 'status', 'REJECTED');

        WHEN 'EVALUATE_CUSTOMER_GOAL' THEN
            v_customer_uuid := (p_payload->>'customerId')::UUID;
            v_goal_eval := public.evaluate_customer_active_goal(v_customer_uuid);
            v_result := v_goal_eval;

        ELSE
            RAISE EXCEPTION 'Unknown Canonical Command Type: %', p_command_type;
    END CASE;

    -- 4. COMMIT PROCESSED COMMAND FOR STRICT IDEMPOTENCY
    INSERT INTO public.processed_commands (
        command_id, command_type, payload_hash, aggregate_type, aggregate_id, actor_admin_id, device_id, result_payload, processed_at
    )
    VALUES (
        p_command_id,
        p_command_type,
        p_payload_hash,
        SPLIT_PART(p_command_type, '_', 1),
        v_entity_uuid,
        v_actor_id,
        p_device_id,
        v_result,
        NOW()
    );

    RETURN jsonb_build_object(
        'success', TRUE,
        'idempotent', FALSE,
        'commandId', p_command_id,
        'result', v_result
    );
END;
$$;
`;

async function main() {
  console.log("Updating execute_canonical_sync_command with complete Goals support...");
  const res = await query(sql);
  console.log("Result:", res);
}
main();
