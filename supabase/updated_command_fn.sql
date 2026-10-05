CREATE OR REPLACE FUNCTION public.execute_canonical_sync_command(p_command_id uuid, p_command_type text, p_payload jsonb, p_payload_hash text DEFAULT 'no_hash'::text, p_device_id text DEFAULT 'default_device'::text, p_bin text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_existing_cmd RECORD;
    v_actor_id UUID := NULL;
    v_admin_role VARCHAR(50) := NULL;
    v_is_active BOOLEAN := TRUE;
    v_result JSONB := '{}'::jsonb;
    v_change_seq BIGINT;
    v_server_gen BIGINT;
    v_cmd_gen BIGINT;
    v_required_perm VARCHAR(100);

    -- Entity IDs & working variables
    v_entity_uuid UUID;
    v_current_version INT;
    v_expected_version INT;
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
    -- ==========================================
    -- 0. RESET GENERATION VALIDATION (STALE OUTBOX PROTECTION)
    -- ==========================================
    SELECT COALESCE(value_number, 1) INTO v_server_gen
    FROM public.system_settings
    WHERE key = 'server_reset_generation';

    -- Extract resetGeneration from payload if present, default to 1 for older clients
    v_cmd_gen := COALESCE((p_payload->>'resetGeneration')::BIGINT, (p_payload->>'reset_generation')::BIGINT, 1);

    IF v_cmd_gen < v_server_gen THEN
        RAISE EXCEPTION 'Reset Generation Mismatch: Command generation % is older than server reset generation %. Stale pre-reset command rejected.', v_cmd_gen, v_server_gen
        USING ERRCODE = 'P0002';
    END IF;

    -- ==========================================
    -- 1. STRICT IDEMPOTENCY CHECK
    -- ==========================================
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

    -- ==========================================
    -- 2. AUTHENTICATION & IDENTITY RESOLUTION
    -- ==========================================
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required: caller must be signed in via Supabase Auth'
            USING ERRCODE = 'P0001';
    END IF;

    SELECT id, role, is_active INTO v_actor_id, v_admin_role, v_is_active
    FROM public.admins WHERE auth_user_id = auth.uid() LIMIT 1;

    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Caller is not a registered admin profile'
            USING ERRCODE = 'P0001';
    END IF;

    IF v_is_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Forbidden: Admin account is inactive or disabled'
            USING ERRCODE = 'P0001';
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

            IF v_rec_item.financial_status = 'RECOGNIZED' THEN
                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'status', 'DELIVERED', 'alreadyRecognized', TRUE);
            ELSE
                -- Authoritative Immutability: Use EXISTING snapshots for recognition
                v_authoritative_final_charge := v_rec_item.final_charge_snapshot_minor;
                
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
                    delivered_at = NOW(),
                    financially_recognized_at = NOW(),
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_item_uuid;

                INSERT INTO public.financial_ledger (
                    event_type, amount_minor, order_id, order_item_id, customer_id, actor_admin_id, metadata, created_at
                )
                VALUES (
                    'ORDER_ITEM_CHARGE',
                    -v_authoritative_final_charge,
                    v_rec_item.order_id,
                    v_item_uuid,
                    v_rec_item.customer_id,
                    v_actor_id,
                    jsonb_build_object(
                        'itemSequence', v_rec_item.item_sequence,
                        'basePrice', v_rec_item.base_price_snapshot_minor,
                        'chargerFee', v_rec_item.charger_fee_snapshot_minor,
                        'discount', v_rec_item.discount_snapshot_minor,
                        'deliveredAt', NOW()
                    ),
                    NOW()
                )
                RETURNING id INTO v_entity_uuid;

                -- Update the order status if all items are delivered
                IF NOT EXISTS (
                    SELECT 1 FROM public.order_items 
                    WHERE order_id = v_rec_item.order_id 
                      AND status NOT IN ('delivered', 'cancelled')
                ) THEN
                    UPDATE public.orders SET status = 'delivered', updated_at = NOW(), version = version + 1
                    WHERE id = v_rec_item.order_id;
                END IF;

                PERFORM public.record_canonical_change('order_items', v_item_uuid, 'UPDATE', jsonb_build_object(
                    'financial_status', 'RECOGNIZED',
                    'operational_status', 'DELIVERED',
                    'base_price_snapshot_minor', v_rec_item.base_price_snapshot_minor,
                    'charger_fee_snapshot_minor', v_rec_item.charger_fee_snapshot_minor,
                    'final_charge_snapshot_minor', v_authoritative_final_charge
                ), 1);

                PERFORM public.record_canonical_change('financial_ledger', v_entity_uuid, 'INSERT', jsonb_build_object(
                    'event_type', 'ORDER_ITEM_CHARGE',
                    'amount_minor', v_authoritative_final_charge,
                    'order_item_id', v_item_uuid
                ), 1);

                v_result := jsonb_build_object(
                    'status', 'DELIVERED',
                    'orderItemId', v_item_uuid,
                    'ledgerEntryId', v_entity_uuid,
                    'financialStatus', 'RECOGNIZED',
                    'finalChargeMinor', v_authoritative_final_charge
                );
            END IF;
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
                IF EXISTS (
                    SELECT 1 FROM public.financial_ledger
                    WHERE order_item_id = v_item_uuid AND event_type = 'REVERSAL'
                ) THEN
                    RAISE EXCEPTION 'Financial Invariant Violation: Order item charge % has already been reversed', v_item_uuid;
                END IF;

                SELECT id, amount_minor
                INTO v_ledger_uuid, v_orig_charge_amount
                FROM public.financial_ledger
                WHERE order_item_id = v_item_uuid AND event_type IN ('ORDER_ITEM_CHARGE', 'ORDER_ITEM_CHARGE')
                ORDER BY created_at DESC
                LIMIT 1;

                v_orig_charge_amount := COALESCE(ABS(v_orig_charge_amount), v_rec_item.final_charge_snapshot_minor, 0);

                UPDATE public.order_items
                SET operational_status = 'CANCELLED',
                    financial_status = 'REVERSED',
                    status = 'cancelled',
                    cancelled_at = NOW(),
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_item_uuid;

                INSERT INTO public.financial_ledger (
                    event_type, amount_minor, order_id, order_item_id, customer_id, actor_admin_id, linked_ledger_id, metadata, created_at
                )
                VALUES (
                    'REVERSAL',
                    v_orig_charge_amount,
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

        WHEN 'POST_PAYMENT', 'CREATE_PAYMENT' THEN
            v_payment_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (COALESCE(p_payload->>'customerId', p_payload->>'customer_id'))::UUID;
            v_unallocated_amount := (COALESCE(p_payload->>'amountMinor', p_payload->>'amount_minor'))::BIGINT;

            IF v_unallocated_amount <= 0 THEN
                RAISE EXCEPTION 'Invalid Payment: Amount must be positive';
            END IF;

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

        ELSE
            RAISE EXCEPTION 'Unknown Canonical Command Type: %', p_command_type;
    END CASE;

    -- ==========================================
    -- 6. RECORD IN PROCESSED COMMANDS
    -- ==========================================
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
        'result', v_result,
        'serverProcessedAt', NOW()
    );
END;
$function$
