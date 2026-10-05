CREATE OR REPLACE FUNCTION public.execute_canonical_sync_command(p_command_id uuid, p_command_type text, p_payload jsonb, p_payload_hash text DEFAULT 'no_hash'::text, p_device_id text DEFAULT 'default_device'::text, p_bin text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_active_goal RECORD;
    v_goal_bonus_ledger_id UUID;
    v_goal_uuid UUID;
    v_req_uuid UUID;

    v_existing_cmd RECORD;
    v_actor_id UUID := NULL;
    v_admin_role VARCHAR(50) := NULL;
    v_is_active BOOLEAN := TRUE;
    v_result JSONB := '{}'::jsonb;
    v_change_seq BIGINT;

    -- Entity IDs & working variables
    v_entity_uuid UUID;
    v_day_uuid UUID;
    v_order_uuid UUID;
    v_item_uuid UUID;
    v_customer_uuid UUID;
    v_device_type_uuid UUID;
    v_payment_uuid UUID;
    v_ledger_uuid UUID;
    v_alloc_uuid UUID;

    -- Financial & calculation variables
    v_customer_status VARCHAR(20);
    v_base_price BIGINT;
    v_charger_applicable BOOLEAN;
    v_customer_exempt BOOLEAN;
    v_has_charger BOOLEAN;
    v_setting_charger_fee BIGINT;
    v_authoritative_charger_fee BIGINT;
    v_authoritative_discount BIGINT;
    v_authoritative_final_charge BIGINT;
    v_current_balance BIGINT;
    v_projected_balance BIGINT;
    v_debt_limit BIGINT;
    v_unallocated_amount BIGINT;
    v_item_charge_due BIGINT;
    v_alloc_amount BIGINT;
    v_rec_item RECORD;
    v_orig_charge_amount BIGINT;
    v_dev_name VARCHAR(200);
    v_dev_icon VARCHAR(100);
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
            -- Safe retirement: NEVER hard-delete historical referenced device types
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
            v_day_uuid := (COALESCE(p_payload->>'dayId', p_payload->>'day_id', p_payload->>'id'))::UUID;
            
            IF NOT EXISTS (SELECT 1 FROM public.business_days WHERE id = v_day_uuid) THEN
                RAISE EXCEPTION 'Business Day Not Found: ID %', v_day_uuid;
            END IF;

            UPDATE public.business_days
            SET status = 'CLOSED',
                is_closed = TRUE,
                closed_at = NOW(),
                closed_by = v_actor_id,
                updated_at = NOW(),
                version = version + 1
            WHERE id = v_day_uuid;

            PERFORM public.record_canonical_change('business_days', v_day_uuid, 'UPDATE', jsonb_build_object('id', v_day_uuid, 'status', 'CLOSED'), 1);
            v_result := jsonb_build_object('businessDayId', v_day_uuid, 'status', 'CLOSED');

        -- ----------------------------------------------------
        -- D. ORDERS & ORDER ITEMS
        -- ----------------------------------------------------
        WHEN 'CREATE_ORDER' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (COALESCE(p_payload->>'customerId', p_payload->>'customer_id'))::UUID;
            v_day_uuid := (COALESCE(p_payload->>'dayId', p_payload->>'day_id'))::UUID;

            -- Customer must exist and not be DELETED
            SELECT status INTO v_customer_status FROM public.customers WHERE id = v_customer_uuid;
            IF v_customer_status IS NULL THEN
                RAISE EXCEPTION 'Customer Not Found: ID %', v_customer_uuid USING ERRCODE = '23503';
            END IF;
            IF v_customer_status = 'DELETED' THEN
                RAISE EXCEPTION 'Customer Is Deleted/Frozen: Cannot create order for soft-deleted customer %', v_customer_uuid;
            END IF;

            -- Business Day must exist
            IF NOT EXISTS (SELECT 1 FROM public.business_days WHERE id = v_day_uuid) THEN
                RAISE EXCEPTION 'Business Day Not Found: ID %', v_day_uuid USING ERRCODE = '23503';
            END IF;

            INSERT INTO public.orders (
                id, day_id, customer_id, display_number, status, notes, version, created_at, updated_at
            )
            VALUES (
                v_entity_uuid,
                v_day_uuid,
                v_customer_uuid,
                COALESCE((p_payload->>'displayNumber')::INTEGER, (p_payload->>'display_number')::INTEGER, 1),
                'charging',
                COALESCE(p_payload->>'notes', ''),
                1,
                NOW(),
                NOW()
            )
            ON CONFLICT (id) DO UPDATE SET
                notes = EXCLUDED.notes,
                updated_at = NOW(),
                version = public.orders.version + 1;

            PERFORM public.record_canonical_change('orders', v_entity_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('orderId', v_entity_uuid);

        WHEN 'ADD_ORDER_ITEM' THEN
            v_item_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_order_uuid := (COALESCE(p_payload->>'orderId', p_payload->>'order_id'))::UUID;
            v_device_type_uuid := (COALESCE(p_payload->>'deviceTypeId', p_payload->>'device_type_id'))::UUID;

            -- Check order exists
            IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id = v_order_uuid) THEN
                RAISE EXCEPTION 'Order Not Found: ID %', v_order_uuid USING ERRCODE = '23503';
            END IF;

            -- Check device type exists and is active
            SELECT name, icon, base_price_minor, charger_fee_applicable
            INTO v_dev_name, v_dev_icon, v_base_price, v_charger_applicable
            FROM public.device_types
            WHERE id = v_device_type_uuid;

            IF v_base_price IS NULL THEN
                RAISE EXCEPTION 'Device Type Not Found: ID %', v_device_type_uuid USING ERRCODE = '23503';
            END IF;

            -- Retrieve customer rules
            SELECT c.charger_fee_exempt
            INTO v_customer_exempt
            FROM public.orders o
            JOIN public.customers c ON o.customer_id = c.id
            WHERE o.id = v_order_uuid;

            v_has_charger := COALESCE((p_payload->>'hasCharger')::BOOLEAN, (p_payload->>'has_charger')::BOOLEAN, FALSE);
            
            -- Tentative charger fee & discount calculation (provisional preview only, NOT financially final)
            IF v_charger_applicable AND (NOT v_customer_exempt) AND (NOT v_has_charger) THEN
                v_authoritative_charger_fee := COALESCE((p_payload->>'chargerFeeSnapshotMinor')::BIGINT, (p_payload->>'charger_fee_snapshot_minor')::BIGINT, 500);
            ELSE
                v_authoritative_charger_fee := 0;
            END IF;

            v_authoritative_discount := COALESCE((p_payload->>'discountSnapshotMinor')::BIGINT, (p_payload->>'discount_snapshot_minor')::BIGINT, 0);
            v_authoritative_final_charge := GREATEST(0, v_base_price + v_authoritative_charger_fee - v_authoritative_discount);

            -- Canonical reopening: If order was previously 'delivered', reopen order status to 'charging'
            UPDATE public.orders
            SET status = 'charging', updated_at = NOW(), version = version + 1
            WHERE id = v_order_uuid AND status = 'delivered';

            -- Insert item in UNRECOGNIZED financial state (financially_recognized_at is NULL)
            INSERT INTO public.order_items (
                id, order_id, device_type_id, item_sequence,
                operational_status, financial_status, payment_status,
                device_name_snapshot, device_icon_snapshot,
                base_price_snapshot_minor, charger_fee_snapshot_minor, discount_snapshot_minor, final_charge_snapshot_minor,
                has_charger, charger_fee_enabled_snapshot, customer_charger_fee_exempt_snapshot,
                unit_price_minor, total_price_minor, financially_recognized_at, version, created_at, updated_at
            )
            VALUES (
                v_item_uuid,
                v_order_uuid,
                v_device_type_uuid,
                COALESCE((p_payload->>'itemSequence')::INTEGER, (p_payload->>'item_sequence')::INTEGER, 1),
                'CHARGING',
                'UNRECOGNIZED',
                'UNPAID',
                COALESCE(v_dev_name, ''),
                COALESCE(v_dev_icon, 'smartphone'),
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
        -- E. SEMANTIC DELIVERY OPERATION (Authoritative Price Calculation & Financial Recognition)
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
                -- 1. Fetch current active device type authoritative price
                SELECT base_price_minor, charger_fee_applicable
                INTO v_base_price, v_charger_applicable
                FROM public.device_types
                WHERE id = v_rec_item.device_type_id;

                IF v_base_price IS NULL THEN
                    RAISE EXCEPTION 'Device Type Not Found for Item: ID %', v_rec_item.device_type_id USING ERRCODE = '23503';
                END IF;

                -- 2. Fetch system settings default charger fee
                SELECT COALESCE(value_number, 500)
                INTO v_setting_charger_fee
                FROM public.system_settings
                WHERE key = 'default_charger_fee_minor';
                IF v_setting_charger_fee IS NULL THEN v_setting_charger_fee := 500; END IF;

                -- 3. Calculate authoritative price at delivery / recognition
                IF v_charger_applicable AND (NOT v_rec_item.charger_fee_exempt) AND (NOT v_rec_item.has_charger) THEN
                    v_authoritative_charger_fee := v_setting_charger_fee;
                ELSE
                    v_authoritative_charger_fee := 0;
                END IF;

                v_authoritative_discount := COALESCE(v_rec_item.discount_snapshot_minor, 0);
                v_authoritative_final_charge := GREATEST(0, v_base_price + v_authoritative_charger_fee - v_authoritative_discount);

                -- 4. Authoritative debt limit check
                v_current_balance := public.calculate_customer_authoritative_balance(v_rec_item.customer_id);
                v_projected_balance := v_current_balance - v_authoritative_final_charge;

                IF v_rec_item.debt_limit_minor > 0 AND v_projected_balance < (-v_rec_item.debt_limit_minor) THEN
                    RAISE EXCEPTION 'Debt Limit Exceeded: Customer debt limit % exceeded by projected balance %',
                        v_rec_item.debt_limit_minor, v_projected_balance;
                END IF;

                -- 5. Freeze authoritative snapshots into order_items
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

                -- 6. Write immutable Financial Ledger entry
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

                -- 7. Check if all items in order are delivered -> update order
                IF NOT EXISTS (
                    SELECT 1 FROM public.order_items
                    WHERE order_id = v_rec_item.order_id
                      AND operational_status NOT IN ('DELIVERED', 'CANCELLED')
                ) THEN
                    UPDATE public.orders SET status = 'delivered', updated_at = NOW(), version = version + 1
                    WHERE id = v_rec_item.order_id;
                    PERFORM public.record_canonical_change('orders', v_rec_item.order_id, 'UPDATE', jsonb_build_object('status', 'delivered'), 1);
                END IF;

                -- 8. Record canonical changes
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

                
                -- 9. Authoritative Goal Progress Integration
                SELECT * INTO v_active_goal
                FROM public.goals
                WHERE customer_id = v_rec_item.customer_id
                  AND status = 'ACTIVE'
                  AND expires_at > NOW()
                FOR UPDATE;

                IF v_active_goal.id IS NOT NULL THEN
                    v_active_goal.current_progress := v_active_goal.current_progress + 1;
                    IF v_active_goal.current_progress >= v_active_goal.target_quantity THEN
                        -- Goal Completed!
                        IF v_active_goal.bonus_amount_minor > 0 THEN
                            INSERT INTO public.financial_ledger (
                                id, customer_id, event_type, amount_minor, metadata, created_at
                            )
                            VALUES (
                                gen_random_uuid(),
                                v_rec_item.customer_id,
                                'BONUS',
                                v_active_goal.bonus_amount_minor,
                                jsonb_build_object('goalId', v_active_goal.id, 'type', 'GOAL_COMPLETION_BONUS'),
                                NOW()
                            )
                            RETURNING id INTO v_goal_bonus_ledger_id;

                            PERFORM public.record_canonical_change('financial_ledger', v_goal_bonus_ledger_id, 'INSERT', jsonb_build_object(
                                'event_type', 'BONUS',
                                'amount_minor', v_active_goal.bonus_amount_minor,
                                'customer_id', v_rec_item.customer_id
                            ), 1);
                        END IF;

                        UPDATE public.goals
                        SET current_progress = v_active_goal.current_progress,
                            status = 'COMPLETED',
                            completed_at = NOW(),
                            bonus_ledger_id = v_goal_bonus_ledger_id,
                            updated_at = NOW(),
                            version = version + 1
                        WHERE id = v_active_goal.id;

                        PERFORM public.record_canonical_change('goals', v_active_goal.id, 'UPDATE', jsonb_build_object(
                            'id', v_active_goal.id,
                            'current_progress', v_active_goal.current_progress,
                            'status', 'COMPLETED',
                            'completed_at', NOW(),
                            'bonus_ledger_id', v_goal_bonus_ledger_id
                        ), v_active_goal.version + 1);
                    ELSE
                        UPDATE public.goals
                        SET current_progress = v_active_goal.current_progress,
                            updated_at = NOW(),
                            version = version + 1
                        WHERE id = v_active_goal.id;

                        PERFORM public.record_canonical_change('goals', v_active_goal.id, 'UPDATE', jsonb_build_object(
                            'id', v_active_goal.id,
                            'current_progress', v_active_goal.current_progress
                        ), v_active_goal.version + 1);
                    END IF;
                END IF;

                v_result := jsonb_build_object(
                    'orderItemId', v_item_uuid,
                    'status', 'DELIVERED',
                    'financialStatus', 'RECOGNIZED',
                    'finalChargeMinor', v_authoritative_final_charge,
                    'ledgerEntryId', v_ledger_uuid
                );
            END IF;

        -- ----------------------------------------------------
        -- F. SEMANTIC CANCELLATION & REVERSAL (Pre vs Post Recognition)
        -- ----------------------------------------------------
        WHEN 'CANCEL_ORDER_ITEM' THEN
            v_item_uuid := (COALESCE(p_payload->>'itemId', p_payload->>'orderItemId', p_payload->>'id'))::UUID;

            SELECT oi.*, o.customer_id
            INTO v_rec_item
            FROM public.order_items oi
            JOIN public.orders o ON oi.order_id = o.id
            WHERE oi.id = v_item_uuid;

            IF v_rec_item.id IS NULL THEN
                RAISE EXCEPTION 'Order Item Not Found: ID %', v_item_uuid USING ERRCODE = '23503';
            END IF;

            IF v_rec_item.operational_status = 'CANCELLED' THEN
                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'status', 'CANCELLED', 'alreadyCancelled', TRUE);
            ELSIF v_rec_item.financial_status = 'UNRECOGNIZED' THEN
                -- Before financial recognition: No financial reversal
                UPDATE public.order_items
                SET operational_status = 'CANCELLED',
                    status = 'cancelled',
                    cancelled_at = NOW(),
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_item_uuid;

                PERFORM public.record_canonical_change('order_items', v_item_uuid, 'UPDATE', jsonb_build_object(
                    'operational_status', 'CANCELLED',
                    'status', 'cancelled'
                ), 1);

                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'status', 'CANCELLED', 'reversalCreated', FALSE);
            ELSIF v_rec_item.financial_status = 'RECOGNIZED' THEN
                -- After financial recognition: Create linked REVERSAL event
                IF EXISTS (
                    SELECT 1 FROM public.financial_ledger
                    WHERE order_item_id = v_item_uuid AND event_type = 'REVERSAL'
                ) THEN
                    RAISE EXCEPTION 'Financial Invariant Violation: Order item charge % has already been reversed', v_item_uuid;
                END IF;

                SELECT id, amount_minor
                INTO v_ledger_uuid, v_orig_charge_amount
                FROM public.financial_ledger
                WHERE order_item_id = v_item_uuid AND event_type = 'CHARGE'
                ORDER BY created_at DESC
                LIMIT 1;

                UPDATE public.order_items
                SET operational_status = 'CANCELLED',
                    financial_status = 'REVERSED',
                    status = 'cancelled',
                    cancelled_at = NOW(),
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_item_uuid;

                -- Insert append-only linked REVERSAL entry
                INSERT INTO public.financial_ledger (
                    event_type, amount_minor, order_id, order_item_id, customer_id, actor_admin_id, linked_ledger_id, metadata, created_at
                )
                VALUES (
                    'REVERSAL',
                    ABS(v_orig_charge_amount),
                    v_rec_item.order_id,
                    v_item_uuid,
                    v_rec_item.customer_id,
                    v_actor_id,
                    v_ledger_uuid,
                    jsonb_build_object('reason', COALESCE(p_payload->>'reason', 'Cancellation after recognition'), 'cancelledAt', NOW()),
                    NOW()
                )
                RETURNING id INTO v_entity_uuid;

                PERFORM public.record_canonical_change('order_items', v_item_uuid, 'UPDATE', jsonb_build_object(
                    'operational_status', 'CANCELLED',
                    'financial_status', 'REVERSED',
                    'status', 'cancelled'
                ), 1);

                PERFORM public.record_canonical_change('financial_ledger', v_entity_uuid, 'INSERT', jsonb_build_object(
                    'event_type', 'REVERSAL',
                    'amount_minor', ABS(v_orig_charge_amount),
                    'order_item_id', v_item_uuid,
                    'linked_ledger_id', v_ledger_uuid
                ), 1);

                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'status', 'CANCELLED', 'financialStatus', 'REVERSED', 'reversalLedgerId', v_entity_uuid);
            END IF;

        -- ----------------------------------------------------
        -- G. SEMANTIC PAYMENT & FIFO ITEM ALLOCATION
        -- ----------------------------------------------------
        WHEN 'POST_PAYMENT' THEN
            v_payment_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (COALESCE(p_payload->>'customerId', p_payload->>'customer_id'))::UUID;
            v_unallocated_amount := (COALESCE(p_payload->>'amountMinor', p_payload->>'amount_minor'))::BIGINT;

            IF v_unallocated_amount <= 0 THEN
                RAISE EXCEPTION 'Invalid Payment: Amount must be positive';
            END IF;

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

            -- 2. Ledger Payment Entry (positive amount increases customer credit/reduces debt)
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

            -- 3. FIFO Allocation to oldest recognized outstanding items
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
                ORDER BY oi.created_at ASC
            LOOP
                EXIT WHEN v_unallocated_amount <= 0;

                v_item_charge_due := v_rec_item.final_charge_snapshot_minor - v_rec_item.paid_so_far;
                IF v_item_charge_due > 0 THEN
                    IF v_unallocated_amount >= v_item_charge_due THEN
                        v_alloc_amount := v_item_charge_due;
                        v_unallocated_amount := v_unallocated_amount - v_item_charge_due;

                        -- Mark Item fully PAID
                        UPDATE public.order_items SET payment_status = 'PAID', updated_at = NOW(), version = version + 1
                        WHERE id = v_rec_item.id;

                        PERFORM public.record_canonical_change('order_items', v_rec_item.id, 'UPDATE', jsonb_build_object('id', v_rec_item.id, 'payment_status', 'PAID'), 1);
                    ELSE
                        v_alloc_amount := v_unallocated_amount;
                        v_unallocated_amount := 0;

                        -- Mark Item PARTIALLY_PAID
                        UPDATE public.order_items SET payment_status = 'PARTIALLY_PAID', updated_at = NOW(), version = version + 1
                        WHERE id = v_rec_item.id;

                        PERFORM public.record_canonical_change('order_items', v_rec_item.id, 'UPDATE', jsonb_build_object('id', v_rec_item.id, 'payment_status', 'PARTIALLY_PAID'), 1);
                    END IF;

                    -- Insert Allocation record at item level
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

            -- 4. Record changes for payment and ledger
            PERFORM public.record_canonical_change('payments', v_payment_uuid, 'INSERT', p_payload, 1);
            PERFORM public.record_canonical_change('financial_ledger', v_ledger_uuid, 'INSERT', jsonb_build_object(
                'event_type', 'PAYMENT',
                'amount_minor', (COALESCE(p_payload->>'amountMinor', p_payload->>'amount_minor'))::BIGINT,
                'customer_id', v_customer_uuid
            ), 1);

            v_result := jsonb_build_object(
                'paymentId', v_payment_uuid,
                'totalAmountMinor', (COALESCE(p_payload->>'amountMinor', p_payload->>'amount_minor'))::BIGINT,
                'customerCreditRemainder', v_unallocated_amount
            );

        -- ----------------------------------------------------
        -- H. SYSTEM SETTINGS
        -- ----------------------------------------------------
        WHEN 'SET_SYSTEM_SETTING' THEN
            INSERT INTO public.system_settings (key, value_type, value_string, value_number, value_boolean, value_json, updated_at, updated_by)
            VALUES (
                p_payload->>'key',
                p_payload->>'valueType',
                p_payload->>'valueString',
                (p_payload->>'valueNumber')::BIGINT,
                (p_payload->>'valueBoolean')::BOOLEAN,
                p_payload->'valueJson',
                NOW(),
                v_actor_id
            )
            ON CONFLICT (key) DO UPDATE SET
                value_string = EXCLUDED.value_string,
                value_number = EXCLUDED.value_number,
                value_boolean = EXCLUDED.value_boolean,
                value_json = EXCLUDED.value_json,
                updated_at = NOW(),
                updated_by = v_actor_id;

            PERFORM public.record_canonical_change('system_settings', p_command_id, 'UPDATE', p_payload, 1);
            v_result := jsonb_build_object('key', p_payload->>'key', 'updated', TRUE);

        
        -- ----------------------------------------------------
        -- I. GOAL COMMANDS
        -- ----------------------------------------------------
        WHEN 'CREATE_GOAL' THEN
            v_goal_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (p_payload->>'customerId')::UUID;

            IF EXISTS (SELECT 1 FROM public.goals WHERE customer_id = v_customer_uuid AND status = 'ACTIVE') THEN
                RAISE EXCEPTION 'Customer already has an active goal. Only one active goal allowed.' USING ERRCODE = '23505';
            END IF;

            INSERT INTO public.goals (
                id, customer_id, target_quantity, current_progress, bonus_amount_minor, duration_days,
                status, started_at, expires_at, version, created_at, updated_at
            )
            VALUES (
                v_goal_uuid,
                v_customer_uuid,
                (p_payload->>'targetQuantity')::INT,
                0,
                COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, 0),
                COALESCE((p_payload->>'durationDays')::INT, 7),
                'ACTIVE',
                NOW(),
                NOW() + (COALESCE((p_payload->>'durationDays')::INT, 7) || ' days')::INTERVAL,
                1,
                NOW(),
                NOW()
            );

            PERFORM public.record_canonical_change('goals', v_goal_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('goalId', v_goal_uuid, 'status', 'ACTIVE');

        WHEN 'EDIT_GOAL' THEN
            v_goal_uuid := (p_payload->>'goalId')::UUID;
            SELECT * INTO v_active_goal FROM public.goals WHERE id = v_goal_uuid FOR UPDATE;
            IF v_active_goal.id IS NULL THEN
                RAISE EXCEPTION 'Goal not found: %', v_goal_uuid USING ERRCODE = '23503';
            END IF;
            IF v_active_goal.status != 'ACTIVE' THEN
                RAISE EXCEPTION 'Cannot edit non-active goal: %', v_active_goal.status;
            END IF;

            IF p_payload ? 'targetQuantity' AND (p_payload->>'targetQuantity')::INT <= v_active_goal.current_progress THEN
                IF v_active_goal.bonus_amount_minor > 0 THEN
                    INSERT INTO public.financial_ledger (id, customer_id, event_type, amount_minor, metadata, created_at)
                    VALUES (
                        gen_random_uuid(),
                        v_active_goal.customer_id,
                        'BONUS',
                        v_active_goal.bonus_amount_minor,
                        jsonb_build_object('goalId', v_active_goal.id, 'type', 'GOAL_COMPLETION_BONUS'),
                        NOW()
                    )
                    RETURNING id INTO v_goal_bonus_ledger_id;

                    PERFORM public.record_canonical_change('financial_ledger', v_goal_bonus_ledger_id, 'INSERT', jsonb_build_object(
                        'event_type', 'BONUS',
                        'amount_minor', v_active_goal.bonus_amount_minor,
                        'customer_id', v_active_goal.customer_id
                    ), 1);
                END IF;

                UPDATE public.goals
                SET target_quantity = (p_payload->>'targetQuantity')::INT,
                    status = 'COMPLETED',
                    completed_at = NOW(),
                    bonus_ledger_id = v_goal_bonus_ledger_id,
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_goal_uuid;

                v_result := jsonb_build_object('goalId', v_goal_uuid, 'status', 'COMPLETED');
            ELSE
                UPDATE public.goals
                SET target_quantity = COALESCE((p_payload->>'targetQuantity')::INT, target_quantity),
                    bonus_amount_minor = COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, bonus_amount_minor),
                    duration_days = COALESCE((p_payload->>'durationDays')::INT, duration_days),
                    expires_at = CASE WHEN p_payload ? 'durationDays' THEN started_at + ((p_payload->>'durationDays')::INT || ' days')::INTERVAL ELSE expires_at END,
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_goal_uuid;

                v_result := jsonb_build_object('goalId', v_goal_uuid, 'status', 'ACTIVE');
            END IF;

            PERFORM public.record_canonical_change('goals', v_goal_uuid, 'UPDATE', p_payload, v_active_goal.version + 1);

        WHEN 'REQUEST_GOAL' THEN
            v_req_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (p_payload->>'customerId')::UUID;

            INSERT INTO public.goal_requests (
                id, customer_id, requested_target, status, version, created_at, updated_at
            )
            VALUES (
                v_req_uuid,
                v_customer_uuid,
                (p_payload->>'requestedTarget')::INT,
                'PENDING',
                1,
                NOW(),
                NOW()
            );

            PERFORM public.record_canonical_change('goal_requests', v_req_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('requestId', v_req_uuid, 'status', 'PENDING');

        WHEN 'REVIEW_GOAL_REQUEST' THEN
            v_req_uuid := (p_payload->>'requestId')::UUID;
            IF (p_payload->>'decision') = 'APPROVE' THEN
                v_goal_uuid := gen_random_uuid();
                INSERT INTO public.goals (
                    id, customer_id, target_quantity, current_progress, bonus_amount_minor, duration_days,
                    status, started_at, expires_at, version, created_at, updated_at
                )
                VALUES (
                    v_goal_uuid,
                    (p_payload->>'customerId')::UUID,
                    (p_payload->>'targetQuantity')::INT,
                    0,
                    COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, 0),
                    COALESCE((p_payload->>'durationDays')::INT, 7),
                    'ACTIVE',
                    NOW(),
                    NOW() + (COALESCE((p_payload->>'durationDays')::INT, 7) || ' days')::INTERVAL,
                    1,
                    NOW(),
                    NOW()
                );

                UPDATE public.goal_requests
                SET status = 'APPROVED',
                    reviewed_by = v_actor_id,
                    reviewed_at = NOW(),
                    resulting_goal_id = v_goal_uuid,
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_req_uuid;

                PERFORM public.record_canonical_change('goals', v_goal_uuid, 'INSERT', jsonb_build_object('id', v_goal_uuid), 1);
                PERFORM public.record_canonical_change('goal_requests', v_req_uuid, 'UPDATE', jsonb_build_object('status', 'APPROVED', 'resultingGoalId', v_goal_uuid), 2);

                v_result := jsonb_build_object('requestId', v_req_uuid, 'status', 'APPROVED', 'goalId', v_goal_uuid);
            ELSE
                UPDATE public.goal_requests
                SET status = 'REJECTED',
                    reviewed_by = v_actor_id,
                    reviewed_at = NOW(),
                    rejection_reason = p_payload->>'rejectionReason',
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_req_uuid;

                PERFORM public.record_canonical_change('goal_requests', v_req_uuid, 'UPDATE', jsonb_build_object('status', 'REJECTED'), 2);

                v_result := jsonb_build_object('requestId', v_req_uuid, 'status', 'REJECTED');
            END IF;
ELSE
            RAISE EXCEPTION 'Unknown Canonical Command Type: %', p_command_type;
    END CASE;

    -- 4. RECORD IN PROCESSED COMMANDS
    INSERT INTO public.processed_commands (
        command_id, command_type, actor_admin_id, payload_hash, result_payload, created_at
    )
    VALUES (
        p_command_id, p_command_type, v_actor_id, p_payload_hash, v_result, NOW()
    );

    RETURN jsonb_build_object(
        'success', TRUE,
        'commandId', p_command_id,
        'commandType', p_command_type,
        'result', v_result
    );
END;
$function$
