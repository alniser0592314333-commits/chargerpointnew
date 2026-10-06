-- MIGRATION 00112: Final Canonical Business Contract
-- Unifies client/server field contracts, authoritative pricing, order numbering,
-- delivery/cancellation transitions, financial allocation, change-log payloads,
-- and RBAC for all production mutations.

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
            WHEN 'OPEN_DAY', 'CREATE_BUSINESS_DAY', 'UPDATE_DAY', 'CLOSE_DAY' THEN
                v_required_perm := 'settings:manage';
            WHEN 'CREATE_CUSTOMER' THEN
                v_required_perm := 'customers:create';
            WHEN 'UPDATE_CUSTOMER', 'EDIT_CUSTOMER' THEN
                v_required_perm := 'customers:edit';
            WHEN 'CREATE_DEVICE_TYPE', 'UPDATE_DEVICE_TYPE', 'RETIRE_DEVICE_TYPE', 'DELETE_DEVICE_TYPE' THEN
                v_required_perm := 'devices:manage';
            WHEN 'CREATE_ORDER' THEN
                v_required_perm := 'orders:create';
            WHEN 'UPDATE_ORDER', 'EDIT_ORDER' THEN
                v_required_perm := 'orders:edit';
            WHEN 'ADD_ORDER_ITEM' THEN
                v_required_perm := 'orders:edit';
            WHEN 'DELIVER_ORDER_ITEM' THEN
                v_required_perm := 'orders:deliver';
            WHEN 'CANCEL_ORDER', 'CANCEL_ORDER_ITEM' THEN
                v_required_perm := 'orders:cancel';
            WHEN 'POST_PAYMENT', 'CREATE_PAYMENT' THEN
                v_required_perm := 'payments:create';
            WHEN 'CREATE_CUSTOMER_CREDIT', 'CONSUME_CUSTOMER_CREDIT', 'CREATE_REFUND' THEN
                v_required_perm := 'finance:credit-adjustment';
            WHEN 'CREATE_GOAL', 'UPDATE_GOAL_CONFIG', 'UPDATE_GOAL_PROGRESS' THEN
                v_required_perm := 'goals:manage';
            WHEN 'APPROVE_GOAL_REQUEST', 'RECORD_GOAL_REQUEST', 'REJECT_GOAL_REQUEST' THEN
                v_required_perm := 'goals:approve';
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

            SELECT to_jsonb(c) INTO v_result FROM public.customers c WHERE c.id = v_entity_uuid;
            PERFORM public.record_canonical_change('customers', v_entity_uuid, 'INSERT', v_result, (v_result->>'version')::INTEGER);
            v_result := jsonb_build_object('customerId', v_entity_uuid, 'entity', v_result);

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

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'P0404';
            END IF;

            SELECT to_jsonb(c) INTO v_result FROM public.customers c WHERE c.id = v_entity_uuid;
            PERFORM public.record_canonical_change('customers', v_entity_uuid, 'UPDATE', v_result, (v_result->>'version')::INTEGER);
            v_result := jsonb_build_object('customerId', v_entity_uuid, 'entity', v_result);

        -- ==========================================
        -- DEVICE TYPE COMMANDS (No BIN required; RBAC devices:manage)
        -- ==========================================
        WHEN 'CREATE_DEVICE_TYPE' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            INSERT INTO public.device_types (
                id, name, name_ar, name_en, arabic_name, icon, base_price_minor,
                charger_fee_enabled, charger_fee_applicable, is_active, sort_order,
                version, created_at, updated_at
            )
            VALUES (
                v_entity_uuid,
                COALESCE(NULLIF(TRIM(p_payload->>'name'), ''), NULLIF(TRIM(p_payload->>'arabicName'), ''), 'Device'),
                COALESCE(NULLIF(TRIM(p_payload->>'arabicName'), ''), NULLIF(TRIM(p_payload->>'name'), ''), 'Device'),
                COALESCE(NULLIF(TRIM(p_payload->>'englishName'), ''), NULLIF(TRIM(p_payload->>'name'), ''), NULLIF(TRIM(p_payload->>'arabicName'), ''), 'Device'),
                COALESCE(NULLIF(TRIM(p_payload->>'arabicName'), ''), NULLIF(TRIM(p_payload->>'name'), ''), 'Device'),
                COALESCE(p_payload->>'icon', 'wrench'),
                COALESCE((p_payload->>'basePriceMinor')::BIGINT, (p_payload->>'base_price_minor')::BIGINT, 0),
                COALESCE((p_payload->>'chargerFeeEnabled')::BOOLEAN, (p_payload->>'charger_fee_enabled')::BOOLEAN,
                         (p_payload->>'chargerFeeApplicable')::BOOLEAN, (p_payload->>'charger_fee_applicable')::BOOLEAN, TRUE),
                COALESCE((p_payload->>'chargerFeeApplicable')::BOOLEAN, (p_payload->>'charger_fee_applicable')::BOOLEAN,
                         (p_payload->>'chargerFeeEnabled')::BOOLEAN, (p_payload->>'charger_fee_enabled')::BOOLEAN, TRUE),
                COALESCE((p_payload->>'isActive')::BOOLEAN, (p_payload->>'is_active')::BOOLEAN, TRUE),
                CASE
                  WHEN COALESCE((p_payload->>'sortOrder')::INTEGER, (p_payload->>'sort_order')::INTEGER, 0) > 0
                    THEN COALESCE((p_payload->>'sortOrder')::INTEGER, (p_payload->>'sort_order')::INTEGER)
                  ELSE COALESCE((SELECT MAX(sort_order) + 1 FROM public.device_types), 1)
                END,
                1,
                NOW(),
                NOW()
            )
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                name_ar = EXCLUDED.name_ar,
                name_en = EXCLUDED.name_en,
                arabic_name = EXCLUDED.arabic_name,
                icon = EXCLUDED.icon,
                base_price_minor = EXCLUDED.base_price_minor,
                charger_fee_enabled = EXCLUDED.charger_fee_enabled,
                charger_fee_applicable = EXCLUDED.charger_fee_applicable,
                is_active = EXCLUDED.is_active,
                sort_order = EXCLUDED.sort_order,
                version = device_types.version + 1,
                updated_at = NOW();

            SELECT to_jsonb(d) INTO v_result
            FROM public.device_types d
            WHERE d.id = v_entity_uuid;

            PERFORM public.record_canonical_change('device_types', v_entity_uuid, 'INSERT', v_result, 1);
            v_result := jsonb_build_object('deviceTypeId', v_entity_uuid, 'entity', v_result);

        WHEN 'UPDATE_DEVICE_TYPE' THEN
            v_entity_uuid := (COALESCE(p_payload->>'deviceTypeId', p_payload->>'id'))::UUID;
            UPDATE public.device_types
            SET
                name = COALESCE(NULLIF(TRIM(p_payload->>'name'), ''), NULLIF(TRIM(p_payload->>'arabicName'), ''), name),
                name_ar = COALESCE(NULLIF(TRIM(p_payload->>'arabicName'), ''), NULLIF(TRIM(p_payload->>'name'), ''), name_ar),
                name_en = COALESCE(NULLIF(TRIM(p_payload->>'englishName'), ''), NULLIF(TRIM(p_payload->>'nameEn'), ''), NULLIF(TRIM(p_payload->>'name'), ''), name_en),
                arabic_name = COALESCE(NULLIF(TRIM(p_payload->>'arabicName'), ''), NULLIF(TRIM(p_payload->>'name'), ''), arabic_name),
                icon = COALESCE(p_payload->>'icon', icon),
                base_price_minor = COALESCE((p_payload->>'basePriceMinor')::BIGINT, (p_payload->>'base_price_minor')::BIGINT, base_price_minor),
                charger_fee_enabled = COALESCE((p_payload->>'chargerFeeEnabled')::BOOLEAN, (p_payload->>'charger_fee_enabled')::BOOLEAN,
                                               (p_payload->>'chargerFeeApplicable')::BOOLEAN, (p_payload->>'charger_fee_applicable')::BOOLEAN, charger_fee_enabled),
                charger_fee_applicable = COALESCE((p_payload->>'chargerFeeApplicable')::BOOLEAN, (p_payload->>'charger_fee_applicable')::BOOLEAN,
                                                  (p_payload->>'chargerFeeEnabled')::BOOLEAN, (p_payload->>'charger_fee_enabled')::BOOLEAN, charger_fee_applicable),
                is_active = COALESCE((p_payload->>'isActive')::BOOLEAN, (p_payload->>'is_active')::BOOLEAN, is_active),
                sort_order = COALESCE((p_payload->>'sortOrder')::INTEGER, (p_payload->>'sort_order')::INTEGER, sort_order),
                version = version + 1,
                updated_at = NOW()
            WHERE id = v_entity_uuid;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Device type not found' USING ERRCODE = 'P0404';
            END IF;

            SELECT to_jsonb(d) INTO v_result FROM public.device_types d WHERE d.id = v_entity_uuid;
            PERFORM public.record_canonical_change('device_types', v_entity_uuid, 'UPDATE', v_result, (v_result->>'version')::INTEGER);
            v_result := jsonb_build_object('deviceTypeId', v_entity_uuid, 'entity', v_result);

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
            IF NOT EXISTS (SELECT 1 FROM public.business_days WHERE id = (p_payload->>'dayId')::UUID AND is_closed = FALSE) THEN
                RAISE EXCEPTION 'Business day not found or closed' USING ERRCODE = 'P0404';
            END IF;

            IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = v_customer_uuid AND is_active = TRUE) THEN
                RAISE EXCEPTION 'Customer not found or inactive' USING ERRCODE = 'P0404';
            END IF;

            -- The server owns the final display number. A local/offline client
            -- may propose a number, but the authoritative next number is chosen
            -- under a transaction lock so two devices cannot claim the same number.
            PERFORM pg_advisory_xact_lock(hashtextextended((p_payload->>'dayId'), 0));

            INSERT INTO public.orders (
                id, day_id, customer_id, display_number, status, notes, version, created_at, updated_at
            )
            SELECT
                v_order_uuid,
                (p_payload->>'dayId')::UUID,
                v_customer_uuid,
                COALESCE(MAX(o.display_number), 0) + 1,
                COALESCE(p_payload->>'status', 'pending'),
                COALESCE(p_payload->>'notes', ''),
                1,
                NOW(),
                NOW()
            FROM public.orders o
            WHERE o.day_id = (p_payload->>'dayId')::UUID
            ON CONFLICT (id) DO UPDATE SET
                day_id = EXCLUDED.day_id,
                customer_id = EXCLUDED.customer_id,
                display_number = EXCLUDED.display_number,
                status = EXCLUDED.status,
                notes = EXCLUDED.notes,
                version = orders.version + 1,
                updated_at = NOW();

            SELECT to_jsonb(o) INTO v_result FROM public.orders o WHERE o.id = v_order_uuid;
            PERFORM public.record_canonical_change('orders', v_order_uuid, 'INSERT', v_result, (v_result->>'version')::INTEGER);
            v_result := jsonb_build_object('orderId', v_order_uuid, 'entity', v_result);

        WHEN 'ADD_ORDER_ITEM' THEN
            v_item_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_order_uuid := (p_payload->>'orderId')::UUID;
            v_entity_uuid := (p_payload->>'deviceTypeId')::UUID;

            SELECT name, icon, base_price_minor, charger_fee_enabled, charger_fee_applicable
            INTO v_dev_name, v_dev_icon, v_base_price, v_charger_applicable
            FROM public.device_types
            WHERE id = v_entity_uuid
              AND is_active = TRUE
              AND status = 'ACTIVE';

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Device type not found or inactive' USING ERRCODE = 'P0404';
            END IF;

            SELECT c.charger_fee_exempt
            INTO v_customer_exempt
            FROM public.orders o
            JOIN public.customers c ON c.id = o.customer_id
            WHERE o.id = v_order_uuid
              AND LOWER(COALESCE(o.status::text, '')) <> 'cancelled';

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Order not found, cancelled, or customer unavailable' USING ERRCODE = 'P0404';
            END IF;

            v_has_charger := COALESCE((p_payload->>'hasCharger')::BOOLEAN, FALSE);
            SELECT COALESCE(value_number, 50)
            INTO v_setting_charger_fee
            FROM public.system_settings
            WHERE key = 'default_charger_fee_minor';

            IF v_charger_applicable AND (NOT v_customer_exempt) AND (NOT v_has_charger) THEN
                v_authoritative_charger_fee := COALESCE(v_setting_charger_fee, 50);
            ELSE
                v_authoritative_charger_fee := 0;
            END IF;

            -- Discounts are not accepted as an arbitrary client-side price override.
            -- A future discount workflow must explicitly authorize and record it.
            v_authoritative_discount := 0;
            v_authoritative_final_charge := GREATEST(0, v_base_price + v_authoritative_charger_fee);

            SELECT COALESCE(MAX(item_sequence), 0) + 1 INTO v_current_version
            FROM public.order_items
            WHERE order_id = v_order_uuid;

            INSERT INTO public.order_items (
                id, order_id, device_type_id, item_sequence, status, operational_status, financial_status, payment_status,
                device_name_snapshot, device_icon_snapshot, base_price_snapshot_minor, charger_fee_snapshot_minor, 
                discount_snapshot_minor, final_charge_snapshot_minor, has_charger, charger_fee_enabled_snapshot, 
                customer_charger_fee_exempt_snapshot, unit_price_minor, total_price_minor, version, created_at, updated_at
            )
            VALUES (
                v_item_uuid, v_order_uuid, v_entity_uuid, COALESCE(NULLIF((v_current_version)::INTEGER, 0), 1), 
                'charging', 'CHARGING', 'UNRECOGNIZED', 'UNPAID', v_dev_name, v_dev_icon, v_base_price, 
                v_authoritative_charger_fee, v_authoritative_discount, v_authoritative_final_charge, v_has_charger, 
                v_charger_applicable, v_customer_exempt, v_authoritative_final_charge, v_authoritative_final_charge, 1, NOW(), NOW()
            );

            SELECT to_jsonb(i) INTO v_result FROM public.order_items i WHERE i.id = v_item_uuid;
            PERFORM public.record_canonical_change('order_items', v_item_uuid, 'INSERT', v_result, (v_result->>'version')::INTEGER);
            v_result := jsonb_build_object('orderItemId', v_item_uuid, 'finalChargeMinor', v_authoritative_final_charge, 'entity', v_result);

        WHEN 'DELIVER_ORDER_ITEM' THEN
            v_item_uuid := (COALESCE(p_payload->>'itemId', p_payload->>'id'))::UUID;
            SELECT oi.*, o.customer_id, c.debt_limit_minor INTO v_rec_item 
            FROM public.order_items oi 
            JOIN public.orders o ON oi.order_id = o.id 
            JOIN public.customers c ON o.customer_id = c.id 
            WHERE oi.id = v_item_uuid;

            IF v_rec_item.id IS NULL THEN RAISE EXCEPTION 'Item not found'; END IF;
            IF LOWER(COALESCE(v_rec_item.status::text, '')) = 'cancelled' THEN
                RAISE EXCEPTION 'Cancelled order item cannot be delivered' USING ERRCODE = 'P0409';
            END IF;
            IF LOWER(COALESCE((SELECT o2.status::text FROM public.orders o2 WHERE o2.id = v_rec_item.order_id), '')) = 'cancelled' THEN
                RAISE EXCEPTION 'Cancelled order cannot be delivered' USING ERRCODE = 'P0409';
            END IF;

            IF v_rec_item.financial_status = 'RECOGNIZED' THEN
                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'alreadyRecognized', TRUE);
            ELSE
                v_authoritative_final_charge := v_rec_item.final_charge_snapshot_minor;

                -- Authoritative server-side debt-limit check. Client-side
                -- validation is only a UX guard and cannot be trusted.
                IF v_admin_role NOT IN ('SUPER_ADMIN', 'Super Admin') THEN
                    SELECT COALESCE(SUM(fl.amount_minor), 0)
                    INTO v_orig_charge_amount
                    FROM public.financial_ledger fl
                    WHERE fl.customer_id = v_rec_item.customer_id;

                    IF (v_orig_charge_amount - v_authoritative_final_charge) < -v_rec_item.debt_limit_minor THEN
                        RAISE EXCEPTION 'Debt limit exceeded' USING ERRCODE = 'P0429';
                    END IF;
                END IF;

                UPDATE public.order_items 
                SET status = 'delivered', operational_status = 'DELIVERED', financial_status = 'RECOGNIZED', 
                    delivered_at = NOW(), financially_recognized_at = NOW(), updated_at = NOW(), version = version + 1 
                WHERE id = v_item_uuid;

                INSERT INTO public.financial_ledger (event_type, amount_minor, order_id, order_item_id, customer_id, actor_admin_id, created_at)
                VALUES ('ORDER_ITEM_CHARGE', -v_authoritative_final_charge, v_rec_item.order_id, v_item_uuid, v_rec_item.customer_id, v_actor_id, NOW())
                RETURNING id INTO v_ledger_uuid;

                SELECT to_jsonb(i) INTO v_result FROM public.order_items i WHERE i.id = v_item_uuid;
                PERFORM public.record_canonical_change('order_items', v_item_uuid, 'UPDATE', v_result, (v_result->>'version')::INTEGER);

                SELECT to_jsonb(l) INTO v_result
                FROM public.financial_ledger l
                WHERE l.id = v_ledger_uuid;
                PERFORM public.record_canonical_change('financial_ledger', v_ledger_uuid, 'INSERT', v_result, 1);

                -- Order status is derived from its active items. Once every
                -- active item is delivered, the order becomes delivered too.
                UPDATE public.orders o
                SET status = 'delivered',
                    updated_at = NOW(),
                    version = o.version + 1,
                WHERE o.id = v_rec_item.order_id
                  AND NOT EXISTS (
                    SELECT 1 FROM public.order_items oi
                    WHERE oi.order_id = o.id
                      AND oi.status NOT IN ('delivered', 'cancelled')
                  );

                IF FOUND THEN
                    SELECT to_jsonb(o) INTO v_result FROM public.orders o WHERE o.id = v_rec_item.order_id;
                    PERFORM public.record_canonical_change('orders', v_rec_item.order_id, 'UPDATE', v_result, (v_result->>'version')::INTEGER);
                END IF;

                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'status', 'DELIVERED', 'ledgerEntryId', v_ledger_uuid);
            END IF;

        WHEN 'CANCEL_ORDER' THEN
            v_order_uuid := (COALESCE(p_payload->>'orderId', p_payload->>'id'))::UUID;

            SELECT * INTO v_rec_item
            FROM public.orders
            WHERE id = v_order_uuid;

            IF v_rec_item.id IS NULL THEN
                RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0404';
            END IF;
            IF v_rec_item.status NOT IN ('pending','charging') THEN
                RAISE EXCEPTION 'Only pending or charging orders can be cancelled' USING ERRCODE = 'P0409';
            END IF;

            -- Reverse every recognized item exactly once.
            FOR v_rec_item IN
                SELECT oi.*, o.customer_id
                FROM public.order_items oi
                JOIN public.orders o ON o.id = oi.order_id
                WHERE oi.order_id = v_order_uuid
                  AND oi.financial_status = 'RECOGNIZED'
            LOOP
                SELECT COALESCE(SUM(ABS(fl.amount_minor)), 0)
                INTO v_orig_charge_amount
                FROM public.financial_ledger fl
                WHERE fl.order_item_id = v_rec_item.id
                  AND fl.event_type = 'ORDER_ITEM_CHARGE';

                IF v_orig_charge_amount > 0
                   AND NOT EXISTS (
                     SELECT 1 FROM public.financial_ledger fl2
                     WHERE fl2.order_item_id = v_rec_item.id
                       AND fl2.event_type IN ('REVERSAL', 'REFUND')
                   )
                THEN
                    INSERT INTO public.financial_ledger (
                        event_type, amount_minor, order_id, order_item_id, customer_id, actor_admin_id, created_at
                    )
                    VALUES (
                        'REVERSAL', v_orig_charge_amount, v_order_uuid, v_rec_item.id,
                        v_rec_item.customer_id, v_actor_id, NOW()
                    )
                    RETURNING id INTO v_ledger_uuid;

                    PERFORM public.record_canonical_change(
                        'financial_ledger',
                        v_ledger_uuid,
                        'INSERT',
                        (SELECT to_jsonb(l) FROM public.financial_ledger l WHERE l.id = v_ledger_uuid),
                        1
                    );
                END IF;

                UPDATE public.order_items
                SET status = 'cancelled',
                    operational_status = 'CANCELLED',
                    financial_status = 'REVERSED',
                    cancelled_at = NOW(),
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_rec_item.id;

                SELECT to_jsonb(i) INTO v_result FROM public.order_items i WHERE i.id = v_rec_item.id;
                PERFORM public.record_canonical_change('order_items', v_rec_item.id, 'UPDATE', v_result, (v_result->>'version')::INTEGER);
            END LOOP;

            UPDATE public.orders
            SET status = 'cancelled',
                updated_at = NOW(),
                version = version + 1
            WHERE id = v_order_uuid;

            SELECT to_jsonb(o) INTO v_result FROM public.orders o WHERE o.id = v_order_uuid;
            PERFORM public.record_canonical_change('orders', v_order_uuid, 'UPDATE', v_result, (v_result->>'version')::INTEGER);
            v_result := jsonb_build_object('orderId', v_order_uuid, 'status', 'cancelled', 'entity', v_result);

        WHEN 'UPDATE_ORDER' THEN
            v_order_uuid := (COALESCE(p_payload->>'orderId', p_payload->>'id'))::UUID;
            SELECT * INTO v_rec_item FROM public.orders WHERE id = v_order_uuid;
            IF v_rec_item.id IS NULL THEN
                RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0404';
            END IF;
            IF p_payload ? 'status' AND p_payload->>'status' IS DISTINCT FROM v_rec_item.status THEN
                IF NOT (
                    (v_rec_item.status = 'pending' AND p_payload->>'status' IN ('charging','cancelled')) OR
                    (v_rec_item.status = 'charging' AND p_payload->>'status' IN ('delivered','cancelled'))
                ) THEN
                    RAISE EXCEPTION 'Invalid order status transition from % to %', v_rec_item.status, p_payload->>'status' USING ERRCODE = 'P0409';
                END IF;
            END IF;
            UPDATE public.orders
            SET
                status = COALESCE(p_payload->>'status', status),
                notes = COALESCE(p_payload->>'notes', notes),
                updated_at = NOW(),
                version = version + 1
            WHERE id = v_order_uuid;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Order not found' USING ERRCODE = 'P0404';
            END IF;

            SELECT to_jsonb(o) INTO v_result FROM public.orders o WHERE o.id = v_order_uuid;
            PERFORM public.record_canonical_change('orders', v_order_uuid, 'UPDATE', v_result, (v_result->>'version')::INTEGER);
            v_result := jsonb_build_object('orderId', v_order_uuid, 'entity', v_result);

        WHEN 'CANCEL_ORDER_ITEM' THEN
            v_item_uuid := (COALESCE(p_payload->>'itemId', p_payload->>'id'))::UUID;
            SELECT oi.*, o.customer_id INTO v_rec_item FROM public.order_items oi JOIN public.orders o ON oi.order_id = o.id WHERE oi.id = v_item_uuid;
            IF v_rec_item.id IS NULL THEN
                RAISE EXCEPTION 'Order item not found' USING ERRCODE = 'P0404';
            END IF;
            IF v_rec_item.status <> 'charging' THEN
                RAISE EXCEPTION 'Only charging order items can be cancelled' USING ERRCODE = 'P0409';
            END IF;
            
            IF v_rec_item.financial_status = 'RECOGNIZED' THEN
                SELECT amount_minor INTO v_orig_charge_amount FROM public.financial_ledger 
                WHERE order_item_id = v_item_uuid AND event_type = 'ORDER_ITEM_CHARGE' 
                ORDER BY created_at DESC LIMIT 1;

                v_orig_charge_amount := ABS(COALESCE(v_orig_charge_amount, v_rec_item.final_charge_snapshot_minor));

                INSERT INTO public.financial_ledger (event_type, amount_minor, order_id, order_item_id, customer_id, actor_admin_id, created_at)
                VALUES ('REVERSAL', v_orig_charge_amount, v_rec_item.order_id, v_item_uuid, v_rec_item.customer_id, v_actor_id, NOW())
                RETURNING id INTO v_ledger_uuid;

                UPDATE public.order_items SET status = 'cancelled', operational_status = 'CANCELLED', financial_status = 'REVERSED', cancelled_at = NOW(), updated_at = NOW(), version = version + 1 WHERE id = v_item_uuid;
                SELECT to_jsonb(i) INTO v_result FROM public.order_items i WHERE i.id = v_item_uuid;
                PERFORM public.record_canonical_change('order_items', v_item_uuid, 'UPDATE', v_result, (v_result->>'version')::INTEGER);
                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'status', 'CANCELLED', 'reversalLedgerId', v_ledger_uuid, 'entity', v_result);
            ELSE
                UPDATE public.order_items SET status = 'cancelled', operational_status = 'CANCELLED', cancelled_at = NOW(), updated_at = NOW(), version = version + 1 WHERE id = v_item_uuid;
                SELECT to_jsonb(i) INTO v_result FROM public.order_items i WHERE i.id = v_item_uuid;
                PERFORM public.record_canonical_change('order_items', v_item_uuid, 'UPDATE', v_result, (v_result->>'version')::INTEGER);
                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'status', 'CANCELLED', 'entity', v_result);
            END IF;

        WHEN 'POST_PAYMENT', 'CREATE_PAYMENT' THEN
            v_payment_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (p_payload->>'customerId')::UUID;
            v_authoritative_final_charge := (p_payload->>'amountMinor')::BIGINT;

            IF v_authoritative_final_charge IS NULL OR v_authoritative_final_charge <= 0 THEN
                RAISE EXCEPTION 'Payment amount must be positive' USING ERRCODE = 'P0422';
            END IF;

            IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = v_customer_uuid AND is_active = TRUE) THEN
                RAISE EXCEPTION 'Customer not found or inactive' USING ERRCODE = 'P0404';
            END IF;

            INSERT INTO public.payments (
                id, customer_id, amount_minor, payment_method, reference, actor_admin_id, command_id, notes, created_at
            )
            VALUES (
                v_payment_uuid,
                v_customer_uuid,
                v_authoritative_final_charge,
                COALESCE(p_payload->>'paymentMethod', 'CASH'),
                COALESCE(p_payload->>'reference', ''),
                v_actor_id,
                p_command_id,
                COALESCE(p_payload->>'notes', ''),
                NOW()
            );

            INSERT INTO public.financial_ledger (
                event_type, amount_minor, customer_id, actor_admin_id, reference_id, metadata, created_at
            )
            VALUES (
                'PAYMENT', v_authoritative_final_charge, v_customer_uuid, v_actor_id, v_payment_uuid,
                COALESCE(p_payload->'metadata', '{}'::jsonb), NOW()
            )
            RETURNING id INTO v_ledger_uuid;

            -- FIFO allocation against authoritative recognized order-item charges.
            FOR v_rec_item IN
                SELECT
                    oi.id,
                    oi.order_id,
                    oi.final_charge_snapshot_minor,
                    GREATEST(
                        0,
                        oi.final_charge_snapshot_minor
                        - COALESCE((
                            SELECT SUM(pa.allocated_amount_minor)
                            FROM public.payment_allocations pa
                            WHERE pa.order_item_id = oi.id
                        ), 0)
                    ) AS outstanding
                FROM public.order_items oi
                JOIN public.orders o ON o.id = oi.order_id
                WHERE o.customer_id = v_customer_uuid
                  AND oi.financial_status = 'RECOGNIZED'
                  AND oi.status = 'delivered'
                ORDER BY COALESCE(oi.delivered_at, oi.created_at), oi.id
            LOOP
                EXIT WHEN v_authoritative_final_charge <= 0;
                IF v_rec_item.outstanding > 0 THEN
                    v_orig_charge_amount := LEAST(v_authoritative_final_charge, v_rec_item.outstanding);

                    INSERT INTO public.payment_allocations (
                        payment_id, order_item_id, order_id, allocated_amount_minor, created_at
                    )
                    VALUES (
                        v_payment_uuid, v_rec_item.id, v_rec_item.order_id, v_orig_charge_amount, NOW()
                    )
                    RETURNING id INTO v_ledger_uuid;

                    PERFORM public.record_canonical_change(
                        'payment_allocations',
                        v_ledger_uuid,
                        'INSERT',
                        (SELECT to_jsonb(a) FROM public.payment_allocations a WHERE a.id = v_ledger_uuid),
                        1
                    );

                    v_authoritative_final_charge := v_authoritative_final_charge - v_orig_charge_amount;

                    IF v_orig_charge_amount = v_rec_item.outstanding THEN
                        UPDATE public.order_items
                        SET payment_status = 'PAID',
                            updated_at = NOW(),
                            version = version + 1
                        WHERE id = v_rec_item.id;

                        SELECT to_jsonb(oi) INTO v_result FROM public.order_items oi WHERE oi.id = v_rec_item.id;
                        PERFORM public.record_canonical_change('order_items', v_rec_item.id, 'UPDATE', v_result, (v_result->>'version')::INTEGER);
                    ELSE
                        UPDATE public.order_items
                        SET payment_status = 'PARTIAL',
                            updated_at = NOW(),
                            version = version + 1
                        WHERE id = v_rec_item.id;

                        SELECT to_jsonb(oi) INTO v_result FROM public.order_items oi WHERE oi.id = v_rec_item.id;
                        PERFORM public.record_canonical_change('order_items', v_rec_item.id, 'UPDATE', v_result, (v_result->>'version')::INTEGER);
                    END IF;
                END IF;
            END LOOP;

            IF v_authoritative_final_charge > 0 THEN
                INSERT INTO public.financial_ledger (
                    event_type, amount_minor, customer_id, actor_admin_id, reference_id, metadata, created_at
                )
                VALUES (
                    'CREDIT_ADJUSTMENT', v_authoritative_final_charge, v_customer_uuid, v_actor_id, v_payment_uuid,
                    jsonb_build_object('source', 'payment_overflow'), NOW()
                )
                RETURNING id INTO v_ledger_uuid;

                PERFORM public.record_canonical_change(
                    'financial_ledger',
                    v_ledger_uuid,
                    'INSERT',
                    (SELECT to_jsonb(l) FROM public.financial_ledger l WHERE l.id = v_ledger_uuid),
                    1
                );
            END IF;

            PERFORM public.record_canonical_change(
                'payments',
                v_payment_uuid,
                'INSERT',
                (SELECT to_jsonb(p) FROM public.payments p WHERE p.id = v_payment_uuid),
                1
            );

            v_result := jsonb_build_object('paymentId', v_payment_uuid);
        WHEN 'CREATE_CUSTOMER_CREDIT' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (p_payload->>'customerId')::UUID;
            v_authoritative_final_charge := (p_payload->>'amountMinor')::BIGINT;
            IF v_authoritative_final_charge IS NULL OR v_authoritative_final_charge <= 0 THEN
                RAISE EXCEPTION 'Invalid credit amount' USING ERRCODE = 'P0422';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM customers WHERE id = v_customer_uuid AND is_active = TRUE) THEN
                RAISE EXCEPTION 'Customer not found or inactive' USING ERRCODE = 'P0404';
            END IF;
            INSERT INTO financial_ledger (id, event_type, amount_minor, customer_id, actor_admin_id, reference_id, created_at)
            VALUES (v_entity_uuid, 'CREDIT_ADJUSTMENT', v_authoritative_final_charge, v_customer_uuid, v_actor_id, v_entity_uuid, NOW())
            ON CONFLICT (id) DO NOTHING;
            SELECT to_jsonb(l) INTO v_result FROM financial_ledger l WHERE l.id = v_entity_uuid;
            PERFORM public.record_canonical_change('financial_ledger', v_entity_uuid, 'INSERT', v_result, 1);

        WHEN 'CONSUME_CUSTOMER_CREDIT' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (p_payload->>'customerId')::UUID;
            v_authoritative_final_charge := (p_payload->>'amountMinor')::BIGINT;
            IF v_authoritative_final_charge IS NULL OR v_authoritative_final_charge <= 0 THEN
                RAISE EXCEPTION 'Invalid credit consumption amount' USING ERRCODE = 'P0422';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM customers WHERE id = v_customer_uuid AND is_active = TRUE) THEN
                RAISE EXCEPTION 'Customer not found or inactive' USING ERRCODE = 'P0404';
            END IF;
            INSERT INTO financial_ledger (id, event_type, amount_minor, order_id, customer_id, actor_admin_id, reference_id, created_at)
            VALUES (v_entity_uuid, 'CREDIT_USED', -v_authoritative_final_charge, NULLIF((p_payload->>'orderId'), '')::UUID, v_customer_uuid, v_actor_id, v_entity_uuid, NOW())
            ON CONFLICT (id) DO NOTHING;
            SELECT to_jsonb(l) INTO v_result FROM financial_ledger l WHERE l.id = v_entity_uuid;
            PERFORM public.record_canonical_change('financial_ledger', v_entity_uuid, 'INSERT', v_result, 1);

        WHEN 'CREATE_REFUND' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (p_payload->>'customerId')::UUID;
            v_authoritative_final_charge := (p_payload->>'amountMinor')::BIGINT;
            IF v_authoritative_final_charge IS NULL OR v_authoritative_final_charge <= 0 THEN
                RAISE EXCEPTION 'Invalid refund amount' USING ERRCODE = 'P0422';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM customers WHERE id = v_customer_uuid) THEN
                RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'P0404';
            END IF;
            INSERT INTO financial_ledger (id, event_type, amount_minor, customer_id, actor_admin_id, reference_id, created_at)
            VALUES (v_entity_uuid, 'REFUND', -v_authoritative_final_charge, v_customer_uuid, v_actor_id, NULLIF((p_payload->>'referenceEventId'), '')::UUID, NOW())
            ON CONFLICT (id) DO NOTHING;
            SELECT to_jsonb(l) INTO v_result FROM financial_ledger l WHERE l.id = v_entity_uuid;
            PERFORM public.record_canonical_change('financial_ledger', v_entity_uuid, 'INSERT', v_result, 1);

        WHEN 'CREATE_GOAL' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (p_payload->>'customerId')::UUID;
            INSERT INTO goals (id, customer_id, target_quantity, current_progress, bonus_amount_minor, duration_days, status, started_at, expires_at, version, created_at, updated_at)
            VALUES (
                v_entity_uuid, v_customer_uuid,
                (p_payload->>'targetQuantity')::INTEGER, 0,
                COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, 0),
                COALESCE((p_payload->>'durationDays')::INTEGER, 7), 'ACTIVE',
                COALESCE((p_payload->>'startedAt')::TIMESTAMPTZ, NOW()),
                COALESCE((p_payload->>'expiresAt')::TIMESTAMPTZ, NOW()), 1, NOW(), NOW()
            )
            ON CONFLICT (id) DO NOTHING;
            SELECT to_jsonb(g) INTO v_result FROM goals g WHERE g.id = v_entity_uuid;
            PERFORM public.record_canonical_change('goals', v_entity_uuid, 'INSERT', v_result, (v_result->>'version')::INTEGER);

        WHEN 'UPDATE_GOAL_CONFIG', 'UPDATE_GOAL_PROGRESS' THEN
            v_entity_uuid := (COALESCE(p_payload->>'goalId', p_payload->>'id'))::UUID;
            IF NOT EXISTS (SELECT 1 FROM goals WHERE id = v_entity_uuid) THEN
                RAISE EXCEPTION 'Goal not found' USING ERRCODE = 'P0404';
            END IF;
            UPDATE goals
            SET target_quantity = COALESCE((p_payload->>'targetQuantity')::INTEGER, target_quantity),
                duration_days = COALESCE((p_payload->>'durationDays')::INTEGER, duration_days),
                bonus_amount_minor = COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, bonus_amount_minor),
                current_progress = COALESCE((p_payload->>'currentProgress')::INTEGER, current_progress),
                status = COALESCE(p_payload->>'status', status),
                expires_at = COALESCE((p_payload->>'expiresAt')::TIMESTAMPTZ, expires_at),
                completed_at = COALESCE((p_payload->>'completedAt')::TIMESTAMPTZ, completed_at),
                bonus_ledger_id = COALESCE(NULLIF((p_payload->>'bonusLedgerId'), '')::UUID, bonus_ledger_id),
                version = version + 1,
                updated_at = NOW()
            WHERE id = v_entity_uuid;

            IF COALESCE((p_payload->>'bonusGranted')::BOOLEAN, FALSE)
               AND NULLIF(p_payload->>'bonusLedgerId', '') IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM financial_ledger WHERE id = (p_payload->>'bonusLedgerId')::UUID) THEN
                INSERT INTO financial_ledger (id, event_type, amount_minor, customer_id, actor_admin_id, reference_id, metadata, created_at)
                SELECT (p_payload->>'bonusLedgerId')::UUID, 'BONUS', g.bonus_amount_minor, g.customer_id, v_actor_id, g.id,
                       jsonb_build_object('reason', CASE WHEN p_command_type = 'UPDATE_GOAL_PROGRESS' THEN 'GOAL_COMPLETED' ELSE 'GOAL_COMPLETED_VIA_CONFIG_UPDATE' END, 'goalId', g.id), NOW()
                FROM goals g WHERE g.id = v_entity_uuid;
            END IF;
            SELECT to_jsonb(g) INTO v_result FROM goals g WHERE g.id = v_entity_uuid;
            PERFORM public.record_canonical_change('goals', v_entity_uuid, 'UPDATE', v_result, (v_result->>'version')::INTEGER);

        WHEN 'RECORD_GOAL_REQUEST' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            INSERT INTO goal_requests (id, customer_id, requested_target, status, version, created_at, updated_at)
            VALUES (v_entity_uuid, (p_payload->>'customerId')::UUID, (p_payload->>'requestedTarget')::INTEGER, 'PENDING', 1, NOW(), NOW())
            ON CONFLICT (id) DO NOTHING;
            SELECT to_jsonb(r) INTO v_result FROM goal_requests r WHERE r.id = v_entity_uuid;
            PERFORM public.record_canonical_change('goal_requests', v_entity_uuid, 'INSERT', v_result, (v_result->>'version')::INTEGER);

        WHEN 'APPROVE_GOAL_REQUEST' THEN
            v_entity_uuid := (p_payload->>'requestId')::UUID;
            IF NOT EXISTS (SELECT 1 FROM goal_requests WHERE id = v_entity_uuid AND status = 'PENDING') THEN
                RAISE EXCEPTION 'Goal request not found or already reviewed' USING ERRCODE = 'P0409';
            END IF;
            IF EXISTS (SELECT 1 FROM goals WHERE customer_id = (SELECT customer_id FROM goal_requests WHERE id = v_entity_uuid) AND status = 'ACTIVE') THEN
                RAISE EXCEPTION 'Customer already has an active goal' USING ERRCODE = 'P0409';
            END IF;
            v_order_uuid := COALESCE((p_payload->>'resultingGoalId')::UUID, gen_random_uuid());
            INSERT INTO goals (id, customer_id, target_quantity, current_progress, bonus_amount_minor, duration_days, status, started_at, expires_at, version, created_at, updated_at)
            SELECT v_order_uuid, customer_id, COALESCE((p_payload->>'targetQuantity')::INTEGER, requested_target, 10), 0,
                   COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, 500), COALESCE((p_payload->>'durationDays')::INTEGER, 7), 'ACTIVE',
                   NOW(), NOW() + make_interval(days => COALESCE((p_payload->>'durationDays')::INTEGER, 7)), 1, NOW(), NOW()
            FROM goal_requests WHERE id = v_entity_uuid;
            UPDATE goal_requests SET status = 'APPROVED', reviewed_by = v_actor_id, reviewed_at = NOW(), resulting_goal_id = v_order_uuid, version = version + 1, updated_at = NOW() WHERE id = v_entity_uuid;
            v_result := jsonb_build_object('requestId', v_entity_uuid, 'resultingGoalId', v_order_uuid);
            PERFORM public.record_canonical_change('goal_requests', v_entity_uuid, 'UPDATE', (SELECT to_jsonb(r) FROM goal_requests r WHERE r.id = v_entity_uuid), (SELECT version FROM goal_requests WHERE id = v_entity_uuid));
            PERFORM public.record_canonical_change('goals', v_order_uuid, 'INSERT', (SELECT to_jsonb(g) FROM goals g WHERE g.id = v_order_uuid), 1);

        WHEN 'REJECT_GOAL_REQUEST' THEN
            v_entity_uuid := (p_payload->>'requestId')::UUID;
            UPDATE goal_requests SET status = 'REJECTED', reviewed_by = v_actor_id, reviewed_at = NOW(), rejection_reason = COALESCE(p_payload->>'rejectionReason', ''), version = version + 1, updated_at = NOW()
            WHERE id = v_entity_uuid AND status = 'PENDING';
            IF NOT FOUND THEN RAISE EXCEPTION 'Goal request not found or already reviewed' USING ERRCODE = 'P0409'; END IF;
            SELECT to_jsonb(r) INTO v_result FROM goal_requests r WHERE r.id = v_entity_uuid;
            PERFORM public.record_canonical_change('goal_requests', v_entity_uuid, 'UPDATE', v_result, (v_result->>'version')::INTEGER);

        WHEN 'OPEN_DAY', 'CREATE_BUSINESS_DAY' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            INSERT INTO public.business_days (id, business_date, status, is_closed, opened_at, version)
            VALUES (v_entity_uuid, (p_payload->>'businessDate')::DATE, 'OPEN', FALSE, NOW(), 1)
            ON CONFLICT (business_date) DO UPDATE
              SET status = 'OPEN', is_closed = FALSE, updated_at = NOW(), version = business_days.version + 1
            RETURNING id INTO v_entity_uuid;

            SELECT to_jsonb(d) INTO v_result FROM public.business_days d WHERE d.id = v_entity_uuid;
            PERFORM public.record_canonical_change('business_days', v_entity_uuid, 'INSERT', v_result, (v_result->>'version')::INTEGER);
            v_result := jsonb_build_object('businessDayId', v_entity_uuid, 'entity', v_result);

        ELSE
            RAISE EXCEPTION 'Unknown command: %', p_command_type;
    END CASE;

    INSERT INTO public.processed_commands (command_id, command_type, actor_admin_id, payload_hash, result_payload, created_at)
    VALUES (p_command_id, p_command_type, v_actor_id, p_payload_hash, v_result, NOW());

    RETURN jsonb_build_object('success', TRUE, 'commandId', p_command_id, 'result', v_result);
END;
$$;

-- Authoritative per-day order numbering. The RPC locks a day while assigning
-- MAX(display_number)+1, and this index is the final database guard.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_day_display_number
ON public.orders(day_id, display_number);

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('00112', 'final_canonical_business_contract')
ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name;
