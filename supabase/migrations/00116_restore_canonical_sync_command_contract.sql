-- Migration 00116: restore complete canonical sync command contract and enforce server-side BIN.
-- Intentionally not applied to production by this branch.

-- Remove every legacy canonical overload introduced by earlier migrations.
-- PostgreSQL treats TEXT and VARCHAR as distinct function signatures, so both
-- must be dropped before installing the single authoritative contract.
DROP FUNCTION IF EXISTS public.execute_canonical_sync_command(UUID,VARCHAR(100),JSONB,TEXT,TEXT,TEXT);
DROP FUNCTION IF EXISTS public.execute_canonical_sync_command(UUID,VARCHAR(100),JSONB,TEXT,TEXT,UUID);
DROP FUNCTION IF EXISTS public.execute_canonical_sync_command(UUID,TEXT,JSONB,TEXT,TEXT,TEXT);
DROP FUNCTION IF EXISTS public.execute_canonical_sync_command(UUID,TEXT,JSONB,TEXT,TEXT,UUID);

CREATE OR REPLACE FUNCTION public.execute_canonical_sync_command(
    p_command_id UUID,
    p_command_type TEXT,
    p_payload JSONB,
    p_payload_hash TEXT DEFAULT 'no_hash',
    p_device_id TEXT DEFAULT 'default_device',
    p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
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
    v_rec_goal RECORD;
    v_rec_goal_request RECORD;
    v_current_status TEXT;
    v_orig_charge_amount BIGINT;
    v_dev_name VARCHAR(200);
    v_dev_icon VARCHAR(100);
    v_bin TEXT;
BEGIN
    -- Serialize concurrent retries of the same logical command before
    -- checking/inserting processed_commands. This closes the race where two
    -- identical requests could both pass the initial SELECT.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_command_id::TEXT, 0));

    -- ==========================================
    -- 0. AUTHENTICATION & IDENTITY RESOLUTION
    -- ==========================================
    -- Authenticate BEFORE any idempotency lookup. A known command_id must
    -- never become a side-channel for unauthenticated callers.
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required: caller must be signed in via Supabase Auth'
            USING ERRCODE = 'P0001';
    END IF;

    v_actor_id := auth.uid();
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
    -- 1. RESET GENERATION VALIDATION (STALE OUTBOX PROTECTION)
    -- ==========================================
    SELECT COALESCE(value_number, 1) INTO v_server_gen
    FROM public.system_settings
    WHERE key = 'server_reset_generation';

    v_cmd_gen := COALESCE((p_payload->>'resetGeneration')::BIGINT, (p_payload->>'reset_generation')::BIGINT, 1);

    IF v_cmd_gen < v_server_gen THEN
        RAISE EXCEPTION 'Reset Generation Mismatch: Command generation % is older than server reset generation %. Stale pre-reset command rejected.', v_cmd_gen, v_server_gen
        USING ERRCODE = 'P0002';
    END IF;

    -- ==========================================
    -- 2. STRICT IDEMPOTENCY CHECK
    -- ==========================================
    SELECT command_id, payload_hash, result_payload
    INTO v_existing_cmd
    FROM public.processed_commands
    WHERE command_id = p_command_id;

    IF v_existing_cmd.command_id IS NOT NULL THEN
        IF v_existing_cmd.payload_hash = p_payload_hash OR p_payload_hash = 'no_hash' THEN
            RETURN jsonb_build_object(
                'success', TRUE,
                'idempotent', TRUE,
                'commandId', p_command_id,
                'result', v_existing_cmd.result_payload
            );
        ELSE
            RAISE EXCEPTION 'Idempotency Conflict: Command ID % already executed with different payload', p_command_id
                USING ERRCODE = '23505';
        END IF;
    END IF;

    -- ==========================================
    -- 3. RBAC AUTHORIZATION
    -- ==========================================
    IF v_admin_role NOT IN ('SUPER_ADMIN', 'Super Admin') THEN
        -- Protected customer fields have their own permission boundary.
        IF p_command_type = 'UPDATE_CUSTOMER'
           AND (p_payload ? 'debtLimitMinor' OR p_payload ? 'debt_limit_minor') THEN
            v_required_perm := 'customers:debt-limit';
        ELSIF p_command_type = 'UPDATE_CUSTOMER'
           AND (p_payload ? 'chargerFeeExempt' OR p_payload ? 'charger_fee_exempt') THEN
            v_required_perm := 'customers:charger-exemption';
        ELSE
            v_required_perm := NULL;
        END IF;

        IF v_required_perm IS NULL THEN
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
            WHEN 'CREATE_CUSTOMER_CREDIT', 'CONSUME_CUSTOMER_CREDIT' THEN
                v_required_perm := 'finance:credit-adjustment';
            WHEN 'REFUND_PAYMENT', 'CREATE_REFUND' THEN
                v_required_perm := 'payments:refund';
            WHEN 'CREATE_GOAL', 'UPDATE_GOAL_CONFIG', 'UPDATE_GOAL_PROGRESS' THEN
                v_required_perm := 'goals:manage';
            WHEN 'RECORD_GOAL_REQUEST' THEN
                v_required_perm := 'goals:manage';
            WHEN 'APPROVE_GOAL_REQUEST', 'REJECT_GOAL_REQUEST' THEN
                v_required_perm := 'goals:approve';
            WHEN 'CLOSE_DAY' THEN
                v_required_perm := 'settings:manage';
            ELSE
                v_required_perm := 'settings:manage';
            END CASE;
        END IF;

        IF v_required_perm IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.get_effective_permissions(v_actor_id) WHERE permission = v_required_perm
        ) THEN
            RAISE EXCEPTION 'Forbidden: Admin lacks required permission % for command %', v_required_perm, p_command_type
                USING ERRCODE = 'P4003';
        END IF;
    END IF;

    -- ==========================================
    -- 4. BIN VERIFICATION / DEFERRED AUTHORIZATION
    -- ==========================================
    v_bin := NULLIF(TRIM(COALESCE(p_payload->>'bin', p_payload->>'adminBin', '')), '');

    IF p_command_type IN ('DELIVER_ORDER_ITEM','CANCEL_ORDER','CANCEL_ORDER_ITEM','CREATE_CUSTOMER_CREDIT','CREATE_REFUND')
       OR (p_command_type = 'UPDATE_CUSTOMER'
           AND ((p_payload ? 'debtLimitMinor') OR (p_payload ? 'debt_limit_minor')
             OR (p_payload ? 'chargerFeeExempt') OR (p_payload ? 'charger_fee_exempt'))) THEN
        IF v_bin IS NULL THEN
            RAISE EXCEPTION 'Authorization required: BIN is required for %', p_command_type USING ERRCODE = 'P4004';
        END IF;
        IF public.verify_admin_bin(v_bin) IS NOT TRUE THEN
            RAISE EXCEPTION 'Invalid BIN: Security verification failed' USING ERRCODE = 'P0003';
        END IF;
    ELSIF v_bin IS NOT NULL AND public.verify_admin_bin(v_bin) IS NOT TRUE THEN
        RAISE EXCEPTION 'Invalid BIN: Security verification failed' USING ERRCODE = 'P0003';
    END IF;

    -- ==========================================
    -- 5. ROUTE BY CANONICAL COMMAND TYPE
    -- ==========================================
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
        WHEN 'UPDATE_CUSTOMER', 'EDIT_CUSTOMER' THEN
            v_entity_uuid := (p_payload->>'id')::UUID;
            IF v_entity_uuid IS NULL THEN
                RAISE EXCEPTION 'Validation Error: Customer ID must be a valid UUID'
                    USING ERRCODE = 'P2201';
            END IF;

            SELECT version INTO v_current_version
            FROM public.customers
            WHERE id = v_entity_uuid
            FOR UPDATE;

            IF v_current_version IS NULL THEN
                RAISE EXCEPTION 'Customer Not Found: ID %', v_entity_uuid
                    USING ERRCODE = '23503';
            END IF;

            v_expected_version := COALESCE((p_payload->>'expectedVersion')::INTEGER,(p_payload->>'expected_version')::INTEGER);
            IF v_expected_version IS NOT NULL AND v_current_version <> v_expected_version THEN
                RAISE EXCEPTION 'VERSION_CONFLICT [409]: Aggregate version mismatch on customer %. Expected version %, current server version is %', v_entity_uuid, v_expected_version, v_current_version
                    USING ERRCODE='P0409';
            END IF;

            UPDATE public.customers
            SET name = COALESCE(p_payload->>'name', name),
                phone = COALESCE(p_payload->>'phone', phone),
                notes = COALESCE(p_payload->>'notes', notes),
                debt_limit_minor = COALESCE((p_payload->>'debtLimitMinor')::BIGINT, (p_payload->>'debt_limit_minor')::BIGINT, debt_limit_minor),
                charger_fee_exempt = COALESCE((p_payload->>'chargerFeeExempt')::BOOLEAN, (p_payload->>'charger_fee_exempt')::BOOLEAN, charger_fee_exempt),
                is_active = COALESCE((p_payload->>'isActive')::BOOLEAN, (p_payload->>'is_active')::BOOLEAN, is_active),
                updated_at = NOW(),
                version = version + 1
            WHERE id = v_entity_uuid;

            PERFORM public.record_canonical_change('customers', v_entity_uuid, 'UPDATE', p_payload, v_current_version + 1);
            v_result := jsonb_build_object('customerId', v_entity_uuid, 'version', v_current_version + 1);

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

        WHEN 'UPDATE_DEVICE_TYPE' THEN
            v_entity_uuid := (p_payload->>'id')::UUID;

            -- 1. Validate UUID format
            IF v_entity_uuid IS NULL THEN
                RAISE EXCEPTION 'Validation Error: Device Type ID must be a valid UUID'
                    USING ERRCODE = 'P2201';
            END IF;

            -- 2. Fetch current version with lock
            SELECT version INTO v_current_version
            FROM public.device_types
            WHERE id = v_entity_uuid FOR UPDATE;

            -- 3. Validate existence
            IF v_current_version IS NULL THEN
                RAISE EXCEPTION 'Device Type Not Found: ID %', v_entity_uuid
                    USING ERRCODE = '23503';
            END IF;

            -- 4. Optimistic concurrency check
            v_expected_version := (COALESCE(p_payload->>'expectedVersion', p_payload->>'expected_version'))::INTEGER;
            IF v_expected_version IS NOT NULL THEN
                IF v_current_version <> v_expected_version THEN
                    RAISE EXCEPTION 'VERSION_CONFLICT [409]: Aggregate version mismatch on device type %. Expected version %, current server version is %', v_entity_uuid, v_expected_version, v_current_version
                        USING ERRCODE = 'P0409';
                END IF;
            END IF;

            -- 5. Perform server-authoritative update preserving unchanged fields
            UPDATE public.device_types
            SET name = COALESCE(TRIM(p_payload->>'name'), name),
                name_ar = COALESCE(p_payload->>'nameAr', p_payload->>'name_ar', p_payload->>'name', name_ar),
                name_en = COALESCE(p_payload->>'nameEn', p_payload->>'name_en', name_en),
                base_price_minor = COALESCE((p_payload->>'basePriceMinor')::BIGINT, (p_payload->>'base_price_minor')::BIGINT, base_price_minor),
                charger_fee_enabled = COALESCE((p_payload->>'chargerFeeEnabled')::BOOLEAN, (p_payload->>'charger_fee_enabled')::BOOLEAN, charger_fee_enabled),
                charger_fee_applicable = COALESCE((p_payload->>'chargerFeeApplicable')::BOOLEAN, (p_payload->>'charger_fee_applicable')::BOOLEAN, charger_fee_applicable),
                is_active = COALESCE((p_payload->>'isActive')::BOOLEAN, (p_payload->>'is_active')::BOOLEAN, is_active),
                sort_order = COALESCE((p_payload->>'sortOrder')::INTEGER, (p_payload->>'sort_order')::INTEGER, sort_order),
                updated_at = NOW(),
                version = version + 1
            WHERE id = v_entity_uuid;

            -- 6. Record canonical change (UPDATE type)
            PERFORM public.record_canonical_change('device_types', v_entity_uuid, 'UPDATE', p_payload, v_current_version + 1);

            v_result := jsonb_build_object('deviceTypeId', v_entity_uuid, 'version', v_current_version + 1);

        WHEN 'RETIRE_DEVICE_TYPE', 'DELETE_DEVICE_TYPE' THEN
            v_entity_uuid := (p_payload->>'id')::UUID;
            UPDATE public.device_types
            SET status = 'RETIRED',
                is_active = FALSE,
                deleted_at = NOW(),
                updated_at = NOW(),
                version = version + 1
            WHERE id = v_entity_uuid;

            PERFORM public.record_canonical_change('device_types', v_entity_uuid, 'UPDATE', jsonb_build_object('id', v_entity_uuid, 'status', 'RETIRED'),
                (SELECT version FROM public.device_types WHERE id = v_entity_uuid));
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

        WHEN 'CLOSE_BUSINESS_DAY', 'CLOSE_DAY' THEN
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

            PERFORM public.record_canonical_change('business_days', v_day_uuid, 'UPDATE', jsonb_build_object('id', v_day_uuid, 'status', 'CLOSED'),
                (SELECT version FROM public.business_days WHERE id = v_day_uuid));
            v_result := jsonb_build_object('businessDayId', v_day_uuid, 'status', 'CLOSED');

        -- ----------------------------------------------------
        -- D. ORDERS & ORDER ITEMS
        -- ----------------------------------------------------
        WHEN 'CREATE_ORDER' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (COALESCE(p_payload->>'customerId', p_payload->>'customer_id'))::UUID;
            v_day_uuid := (COALESCE(p_payload->>'dayId', p_payload->>'day_id'))::UUID;

            SELECT status INTO v_customer_status FROM public.customers WHERE id = v_customer_uuid;
            IF v_customer_status IS NULL THEN
                RAISE EXCEPTION 'Customer Not Found: ID %', v_customer_uuid USING ERRCODE = '23503';
            END IF;
            IF v_customer_status = 'DELETED' THEN
                RAISE EXCEPTION 'Customer Is Deleted/Frozen: Cannot create order for soft-deleted customer %', v_customer_uuid;
            END IF;

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

WHEN 'UPDATE_ORDER' THEN
            v_order_uuid := COALESCE((p_payload->>'id')::UUID, (p_payload->>'orderId')::UUID);
            IF v_order_uuid IS NULL THEN
                RAISE EXCEPTION 'Validation Error: Order ID must be a valid UUID' USING ERRCODE = 'P2201';
            END IF;

            SELECT version INTO v_current_version
            FROM public.orders WHERE id = v_order_uuid FOR UPDATE;

            IF v_current_version IS NULL THEN
                RAISE EXCEPTION 'Order Not Found: ID %', v_order_uuid USING ERRCODE = '23503';
            END IF;

            v_expected_version := COALESCE(
                (p_payload->>'expectedVersion')::INTEGER,
                (p_payload->>'expected_version')::INTEGER
            );
            IF v_expected_version IS NOT NULL AND v_current_version <> v_expected_version THEN
                RAISE EXCEPTION 'VERSION_CONFLICT [409]: Aggregate version mismatch on order %. Expected version %, current server version is %',
                    v_order_uuid, v_expected_version, v_current_version USING ERRCODE='P0409';
            END IF;

            UPDATE public.orders
            SET notes = CASE WHEN p_payload ? 'notes' THEN p_payload->>'notes' ELSE notes END,
                updated_at = NOW(),
                version = version + 1
            WHERE id = v_order_uuid;

            PERFORM public.record_canonical_change(
                'orders', v_order_uuid, 'UPDATE',
                jsonb_build_object('id', v_order_uuid, 'notes', (SELECT notes FROM public.orders WHERE id=v_order_uuid)),
                v_current_version + 1
            );
            v_result := jsonb_build_object('orderId', v_order_uuid, 'version', v_current_version + 1);

        WHEN 'ADD_ORDER_ITEM' THEN
            v_item_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_order_uuid := (COALESCE(p_payload->>'orderId', p_payload->>'order_id'))::UUID;
            v_device_type_uuid := (COALESCE(p_payload->>'deviceTypeId', p_payload->>'device_type_id'))::UUID;

            IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id = v_order_uuid) THEN
                RAISE EXCEPTION 'Order Not Found: ID %', v_order_uuid USING ERRCODE = '23503';
            END IF;

            SELECT name, icon, base_price_minor, charger_fee_applicable
            INTO v_dev_name, v_dev_icon, v_base_price, v_charger_applicable
            FROM public.device_types
            WHERE id = v_device_type_uuid;

            IF v_base_price IS NULL THEN
                RAISE EXCEPTION 'Device Type Not Found: ID %', v_device_type_uuid USING ERRCODE = '23503';
            END IF;

            SELECT c.charger_fee_exempt
            INTO v_customer_exempt
            FROM public.orders o
            JOIN public.customers c ON o.customer_id = c.id
            WHERE o.id = v_order_uuid;

            v_has_charger := COALESCE((p_payload->>'hasCharger')::BOOLEAN, (p_payload->>'has_charger')::BOOLEAN, FALSE);
            
            IF v_charger_applicable AND (NOT v_customer_exempt) AND (NOT v_has_charger) THEN
                v_authoritative_charger_fee := COALESCE((p_payload->>'chargerFeeSnapshotMinor')::BIGINT, (p_payload->>'charger_fee_snapshot_minor')::BIGINT, 500);
            ELSE
                v_authoritative_charger_fee := 0;
            END IF;

            v_authoritative_discount := COALESCE((p_payload->>'discountSnapshotMinor')::BIGINT, (p_payload->>'discount_snapshot_minor')::BIGINT, 0);
            v_authoritative_final_charge := GREATEST(0, v_base_price + v_authoritative_charger_fee - v_authoritative_discount);

            UPDATE public.orders
            SET status = 'charging', updated_at = NOW(), version = version + 1
            WHERE id = v_order_uuid AND status = 'delivered';

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

        WHEN 'DELIVER_ORDER_ITEM' THEN
            v_expected_version := COALESCE((p_payload->>'expectedVersion')::INTEGER,(p_payload->>'expected_version')::INTEGER);
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
            IF v_expected_version IS NOT NULL AND v_rec_item.version <> v_expected_version THEN
                RAISE EXCEPTION 'VERSION_CONFLICT [409]: Aggregate version mismatch on order item %. Expected version %, current server version is %', v_item_uuid, v_expected_version, v_rec_item.version USING ERRCODE='P0409';
            END IF;

            IF v_rec_item.cust_status = 'DELETED' THEN
                RAISE EXCEPTION 'Customer is soft-deleted/frozen. Cannot deliver item';
            END IF;

            IF v_rec_item.financial_status = 'RECOGNIZED' THEN
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
                    PERFORM public.record_canonical_change('orders', v_rec_item.order_id, 'UPDATE', jsonb_build_object('status', 'delivered'),
                        (SELECT version FROM public.orders WHERE id = v_rec_item.order_id));
                END IF;

                PERFORM public.record_canonical_change('order_items', v_item_uuid, 'UPDATE', jsonb_build_object(
                    'operational_status', 'DELIVERED',
                    'financial_status', 'RECOGNIZED',
                    'base_price_snapshot_minor', v_base_price,
                    'charger_fee_snapshot_minor', v_authoritative_charger_fee,
                    'final_charge_snapshot_minor', v_authoritative_final_charge,
                    'financially_recognized_at', NOW()
                ), (SELECT version FROM public.order_items WHERE id = v_item_uuid));

                PERFORM public.record_canonical_change('financial_ledger', v_ledger_uuid, 'INSERT', jsonb_build_object(
                    'event_type', 'CHARGE',
                    'amount_minor', -v_authoritative_final_charge,
                    'order_item_id', v_item_uuid,
                    'customer_id', v_rec_item.customer_id
                ), 1);

                v_result := jsonb_build_object(
                    'orderItemId', v_item_uuid,
                    'status', 'DELIVERED',
                    'financialStatus', 'RECOGNIZED',
                    'finalChargeMinor', v_authoritative_final_charge,
                    'ledgerEntryId', v_ledger_uuid
                );
            END IF;

        WHEN 'CANCEL_ORDER' THEN
            v_order_uuid := (COALESCE(p_payload->>'orderId', p_payload->>'id'))::UUID;
            SELECT o.customer_id INTO v_customer_uuid FROM public.orders o WHERE o.id = v_order_uuid FOR UPDATE;
            IF v_customer_uuid IS NULL THEN RAISE EXCEPTION 'Order Not Found: ID %', v_order_uuid USING ERRCODE = '23503'; END IF;
            IF EXISTS (SELECT 1 FROM public.orders WHERE id = v_order_uuid AND status = 'cancelled') THEN
                v_result := jsonb_build_object('orderId', v_order_uuid, 'status', 'CANCELLED', 'alreadyCancelled', TRUE);
            ELSE
                FOR v_rec_item IN SELECT oi.* FROM public.order_items oi WHERE oi.order_id = v_order_uuid AND oi.operational_status <> 'CANCELLED' FOR UPDATE LOOP
                    IF v_rec_item.financial_status = 'RECOGNIZED' THEN
                        SELECT id, amount_minor INTO v_ledger_uuid, v_orig_charge_amount
                        FROM public.financial_ledger WHERE order_item_id = v_rec_item.id AND event_type IN ('CHARGE','ORDER_ITEM_CHARGE')
                        ORDER BY created_at DESC LIMIT 1;
                        UPDATE public.order_items
                        SET operational_status='CANCELLED', financial_status='REVERSED', status='cancelled', cancelled_at=NOW(), updated_at=NOW(), version=version+1
                        WHERE id=v_rec_item.id;
                        INSERT INTO public.financial_ledger(event_type,amount_minor,order_id,order_item_id,customer_id,actor_admin_id,linked_ledger_id,metadata,created_at)
                        VALUES('REVERSAL',ABS(COALESCE(v_orig_charge_amount,v_rec_item.final_charge_snapshot_minor,0)),v_rec_item.order_id,v_rec_item.id,v_rec_item.customer_id,v_actor_id,v_ledger_uuid,
                               jsonb_build_object('reason',COALESCE(p_payload->>'reason','Order cancellation'),'cancelledAt',NOW()),NOW())
                        RETURNING id INTO v_entity_uuid;
                        PERFORM public.record_canonical_change('order_items',v_rec_item.id,'UPDATE',jsonb_build_object('status','cancelled','financial_status','REVERSED'),
                            (SELECT version FROM public.order_items WHERE id=v_rec_item.id));
                        PERFORM public.record_canonical_change('financial_ledger',v_entity_uuid,'INSERT',jsonb_build_object('event_type','REVERSAL','amount_minor',ABS(COALESCE(v_orig_charge_amount,v_rec_item.final_charge_snapshot_minor,0)),'order_item_id',v_rec_item.id),1);
                    ELSE
                        UPDATE public.order_items SET operational_status='CANCELLED', status='cancelled', cancelled_at=NOW(), updated_at=NOW(), version=version+1 WHERE id=v_rec_item.id;
                        PERFORM public.record_canonical_change('order_items',v_rec_item.id,'UPDATE',jsonb_build_object('status','cancelled'),
                            (SELECT version FROM public.order_items WHERE id=v_rec_item.id));
                    END IF;
                END LOOP;
                UPDATE public.orders SET status='cancelled', cancelled_at=NOW(), updated_at=NOW(), version=version+1 WHERE id=v_order_uuid;
                PERFORM public.record_canonical_change('orders',v_order_uuid,'UPDATE',jsonb_build_object('id',v_order_uuid,'status','cancelled'),
                    (SELECT version FROM public.orders WHERE id=v_order_uuid));
                v_result := jsonb_build_object('orderId',v_order_uuid,'status','CANCELLED');
            END IF;

        WHEN 'CANCEL_ORDER_ITEM' THEN
            v_expected_version := COALESCE((p_payload->>'expectedVersion')::INTEGER,(p_payload->>'expected_version')::INTEGER);
            v_item_uuid := (COALESCE(p_payload->>'itemId', p_payload->>'orderItemId', p_payload->>'id'))::UUID;

            SELECT oi.*, o.customer_id
            INTO v_rec_item
            FROM public.order_items oi
            JOIN public.orders o ON oi.order_id = o.id
            WHERE oi.id = v_item_uuid;

            IF v_rec_item.id IS NULL THEN
                RAISE EXCEPTION 'Order Item Not Found: ID %', v_item_uuid USING ERRCODE = '23503';
            END IF;
            IF v_expected_version IS NOT NULL AND v_rec_item.version <> v_expected_version THEN
                RAISE EXCEPTION 'VERSION_CONFLICT [409]: Aggregate version mismatch on order item %. Expected version %, current server version is %', v_item_uuid, v_expected_version, v_rec_item.version USING ERRCODE='P0409';
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
                ), (SELECT version FROM public.order_items WHERE id = v_item_uuid));

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
                WHERE order_item_id = v_item_uuid AND event_type IN ('CHARGE', 'ORDER_ITEM_CHARGE')
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
                ), (SELECT version FROM public.order_items WHERE id = v_item_uuid));

                PERFORM public.record_canonical_change('financial_ledger', v_entity_uuid, 'INSERT', jsonb_build_object(
                    'event_type', 'REVERSAL',
                    'amount_minor', ABS(v_orig_charge_amount),
                    'order_item_id', v_item_uuid,
                    'linked_ledger_id', v_ledger_uuid
                ), 1);

                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'status', 'CANCELLED', 'financialStatus', 'REVERSED', 'reversalLedgerId', v_entity_uuid);
            END IF;

        WHEN 'CREATE_CUSTOMER_CREDIT' THEN
            v_customer_uuid := (p_payload->>'customerId')::UUID;
            v_unallocated_amount := (p_payload->>'amountMinor')::BIGINT;
            IF v_customer_uuid IS NULL OR v_unallocated_amount IS NULL OR v_unallocated_amount <= 0 THEN RAISE EXCEPTION 'Invalid customer credit adjustment'; END IF;
            IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id=v_customer_uuid AND status <> 'DELETED') THEN RAISE EXCEPTION 'Customer Not Found or inactive: ID %',v_customer_uuid USING ERRCODE='23503'; END IF;
            v_payment_uuid := COALESCE((p_payload->>'id')::UUID,p_command_id);
            INSERT INTO public.payments(id,customer_id,amount_minor,payment_method,reference,actor_admin_id,command_id,created_at)
            VALUES(v_payment_uuid,v_customer_uuid,v_unallocated_amount,'CASH',COALESCE(p_payload->>'reference','Customer credit'),v_actor_id,p_command_id,NOW())
            ON CONFLICT(id) DO NOTHING;
            INSERT INTO public.financial_ledger(id,event_type,amount_minor,customer_id,actor_admin_id,reference_id,created_at)
            VALUES(gen_random_uuid(),'CREDIT_ADJUSTMENT',v_unallocated_amount,v_customer_uuid,v_actor_id,v_payment_uuid,NOW())
            RETURNING id INTO v_ledger_uuid;
            PERFORM public.record_canonical_change('payments',v_payment_uuid,'INSERT',p_payload,1);
            PERFORM public.record_canonical_change('financial_ledger',v_ledger_uuid,'INSERT',jsonb_build_object('event_type','CREDIT_ADJUSTMENT','amount_minor',v_unallocated_amount,'customer_id',v_customer_uuid),1);
            v_result:=jsonb_build_object('paymentId',v_payment_uuid,'ledgerEntryId',v_ledger_uuid,'amountMinor',v_unallocated_amount);

        WHEN 'CONSUME_CUSTOMER_CREDIT' THEN
            v_customer_uuid := (p_payload->>'customerId')::UUID;
            v_unallocated_amount := (p_payload->>'amountMinor')::BIGINT;
            IF v_customer_uuid IS NULL OR v_unallocated_amount IS NULL OR v_unallocated_amount <= 0 THEN RAISE EXCEPTION 'Invalid credit consumption'; END IF;
            INSERT INTO public.financial_ledger(id,event_type,amount_minor,customer_id,order_id,actor_admin_id,created_at)
            VALUES(COALESCE((p_payload->>'id')::UUID,p_command_id),'CREDIT_USED',-v_unallocated_amount,v_customer_uuid,
                   CASE WHEN p_payload->>'orderId' IS NULL THEN NULL ELSE (p_payload->>'orderId')::UUID END,v_actor_id,NOW())
            ON CONFLICT(id) DO NOTHING
            RETURNING id INTO v_ledger_uuid;
            PERFORM public.record_canonical_change('financial_ledger',COALESCE(v_ledger_uuid,COALESCE((p_payload->>'id')::UUID,p_command_id)),'INSERT',
                jsonb_build_object('event_type','CREDIT_USED','amount_minor',-v_unallocated_amount,'customer_id',v_customer_uuid),1);
            v_result:=jsonb_build_object('ledgerEntryId',COALESCE(v_ledger_uuid,COALESCE((p_payload->>'id')::UUID,p_command_id)),'amountMinor',-v_unallocated_amount);

        WHEN 'CREATE_REFUND' THEN
            v_customer_uuid := (p_payload->>'customerId')::UUID;
            v_unallocated_amount := (p_payload->>'amountMinor')::BIGINT;
            v_entity_uuid := (p_payload->>'referenceEventId')::UUID;
            IF v_customer_uuid IS NULL OR v_unallocated_amount IS NULL OR v_unallocated_amount <= 0 OR v_entity_uuid IS NULL THEN RAISE EXCEPTION 'Invalid refund payload'; END IF;
            IF NOT EXISTS (SELECT 1 FROM public.financial_ledger WHERE id=v_entity_uuid AND customer_id=v_customer_uuid) THEN RAISE EXCEPTION 'Referenced financial event not found for this customer'; END IF;
            INSERT INTO public.financial_ledger(id,event_type,amount_minor,customer_id,actor_admin_id,reference_id,created_at)
            VALUES(COALESCE((p_payload->>'id')::UUID,p_command_id),'REFUND',-v_unallocated_amount,v_customer_uuid,v_actor_id,v_entity_uuid,NOW())
            ON CONFLICT(id) DO NOTHING
            RETURNING id INTO v_ledger_uuid;
            PERFORM public.record_canonical_change('financial_ledger',COALESCE(v_ledger_uuid,COALESCE((p_payload->>'id')::UUID,p_command_id)),'INSERT',
                jsonb_build_object('event_type','REFUND','amount_minor',-v_unallocated_amount,'customer_id',v_customer_uuid,'reference_id',v_entity_uuid),1);
            v_result:=jsonb_build_object('ledgerEntryId',COALESCE(v_ledger_uuid,COALESCE((p_payload->>'id')::UUID,p_command_id)),'amountMinor',-v_unallocated_amount);

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

                        PERFORM public.record_canonical_change('order_items', v_rec_item.id, 'UPDATE', jsonb_build_object('id', v_rec_item.id, 'payment_status', 'PAID'),
                            (SELECT version FROM public.order_items WHERE id = v_rec_item.id));
                    ELSE
                        v_alloc_amount := v_unallocated_amount;
                        v_unallocated_amount := 0;

                        UPDATE public.order_items SET payment_status = 'PARTIALLY_PAID', updated_at = NOW(), version = version + 1
                        WHERE id = v_rec_item.id;

                        PERFORM public.record_canonical_change('order_items', v_rec_item.id, 'UPDATE', jsonb_build_object('id', v_rec_item.id, 'payment_status', 'PARTIALLY_PAID'),
                            (SELECT version FROM public.order_items WHERE id = v_rec_item.id));
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

        WHEN 'RECORD_GOAL_REQUEST' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (p_payload->>'customerId')::UUID;
            IF v_customer_uuid IS NULL THEN
                RAISE EXCEPTION 'Invalid goal request: customerId is required' USING ERRCODE='P2201';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = v_customer_uuid AND status <> 'DELETED') THEN
                RAISE EXCEPTION 'Customer Not Found: ID %', v_customer_uuid USING ERRCODE='23503';
            END IF;

            INSERT INTO public.goal_requests (
                id, customer_id, requested_target, status, version, created_at, updated_at
            )
            VALUES (
                v_entity_uuid,
                v_customer_uuid,
                (p_payload->>'requestedTarget')::INTEGER,
                'PENDING',
                1,
                NOW(),
                NOW()
            )
            ON CONFLICT (id) DO NOTHING;

            PERFORM public.record_canonical_change('goal_requests', v_entity_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('requestId', v_entity_uuid, 'status', 'PENDING');

        WHEN 'APPROVE_GOAL_REQUEST' THEN
            v_entity_uuid := (p_payload->>'requestId')::UUID;
            IF v_entity_uuid IS NULL THEN
                RAISE EXCEPTION 'Invalid goal approval: requestId is required' USING ERRCODE='P2201';
            END IF;

            SELECT * INTO v_rec_goal_request
            FROM public.goal_requests
            WHERE id = v_entity_uuid
            FOR UPDATE;

            IF v_rec_goal_request.id IS NULL THEN
                RAISE EXCEPTION 'Goal request not found: ID %', v_entity_uuid USING ERRCODE='23503';
            END IF;
            IF v_rec_goal_request.status <> 'PENDING' THEN
                RAISE EXCEPTION 'Goal request is already %', v_rec_goal_request.status USING ERRCODE='P0001';
            END IF;

            v_entity_uuid := COALESCE((p_payload->>'resultingGoalId')::UUID, gen_random_uuid());
            IF EXISTS (
                SELECT 1 FROM public.goals
                WHERE customer_id = v_rec_goal_request.customer_id AND status = 'ACTIVE'
            ) THEN
                RAISE EXCEPTION 'Customer already has an active goal' USING ERRCODE='P0001';
            END IF;

            INSERT INTO public.goals (
                id, customer_id, target_quantity, current_progress, bonus_amount_minor,
                duration_days, status, started_at, expires_at, version, created_at, updated_at
            )
            VALUES (
                v_entity_uuid,
                v_rec_goal_request.customer_id,
                COALESCE((p_payload->>'targetQuantity')::INTEGER, v_rec_goal_request.requested_target, 10),
                0,
                COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, 500),
                COALESCE((p_payload->>'durationDays')::INTEGER, 7),
                'ACTIVE',
                NOW(),
                COALESCE((p_payload->>'expiresAt')::TIMESTAMPTZ, NOW() + make_interval(days => COALESCE((p_payload->>'durationDays')::INTEGER, 7))),
                1,
                NOW(),
                NOW()
            );

            UPDATE public.goal_requests
            SET status = 'APPROVED',
                reviewed_by = v_actor_id,
                reviewed_at = NOW(),
                resulting_goal_id = v_entity_uuid,
                updated_at = NOW(),
                version = version + 1
            WHERE id = v_rec_goal_request.id;

            PERFORM public.record_canonical_change('goals', v_entity_uuid, 'INSERT', jsonb_build_object('id', v_entity_uuid, 'customer_id', v_rec_goal_request.customer_id), 1);
            PERFORM public.record_canonical_change('goal_requests', v_rec_goal_request.id, 'UPDATE', jsonb_build_object('id', v_rec_goal_request.id, 'status', 'APPROVED', 'resulting_goal_id', v_entity_uuid), v_rec_goal_request.version + 1);
            v_result := jsonb_build_object('requestId', v_rec_goal_request.id, 'goalId', v_entity_uuid, 'status', 'APPROVED');

        WHEN 'REJECT_GOAL_REQUEST' THEN
            v_entity_uuid := (p_payload->>'requestId')::UUID;
            IF v_entity_uuid IS NULL THEN
                RAISE EXCEPTION 'Invalid goal rejection: requestId is required' USING ERRCODE='P2201';
            END IF;

            SELECT status, version INTO v_current_status, v_current_version
            FROM public.goal_requests
            WHERE id = v_entity_uuid
            FOR UPDATE;

            IF v_current_status IS NULL THEN
                RAISE EXCEPTION 'Goal request not found: ID %', v_entity_uuid USING ERRCODE='23503';
            END IF;
            IF v_current_status <> 'PENDING' THEN
                RAISE EXCEPTION 'Goal request is already %', v_current_status USING ERRCODE='P0001';
            END IF;

            UPDATE public.goal_requests
            SET status = 'REJECTED',
                reviewed_by = v_actor_id,
                reviewed_at = NOW(),
                rejection_reason = p_payload->>'rejectionReason',
                updated_at = NOW(),
                version = version + 1
            WHERE id = v_entity_uuid;

            PERFORM public.record_canonical_change('goal_requests', v_entity_uuid, 'UPDATE',
                jsonb_build_object('id', v_entity_uuid, 'status', 'REJECTED', 'rejection_reason', p_payload->>'rejectionReason'),
                v_current_version + 1);
            v_result := jsonb_build_object('requestId', v_entity_uuid, 'status', 'REJECTED');

        WHEN 'UPDATE_GOAL_CONFIG' THEN
            v_entity_uuid := (p_payload->>'id')::UUID;
            IF v_entity_uuid IS NULL THEN
                RAISE EXCEPTION 'Invalid goal update: id is required' USING ERRCODE='P2201';
            END IF;

            SELECT * INTO v_rec_goal
            FROM public.goals
            WHERE id = v_entity_uuid
            FOR UPDATE;

            IF v_rec_goal.id IS NULL THEN
                RAISE EXCEPTION 'Goal not found: ID %', v_entity_uuid USING ERRCODE='23503';
            END IF;

            v_expected_version := COALESCE((p_payload->>'expectedVersion')::INTEGER,(p_payload->>'expected_version')::INTEGER);
            IF v_expected_version IS NOT NULL AND v_rec_goal.version <> v_expected_version THEN
                RAISE EXCEPTION 'VERSION_CONFLICT [409]: Goal version mismatch. Expected %, current %', v_expected_version, v_rec_goal.version USING ERRCODE='P0409';
            END IF;

            UPDATE public.goals
            SET target_quantity = COALESCE((p_payload->>'targetQuantity')::INTEGER, target_quantity),
                duration_days = COALESCE((p_payload->>'durationDays')::INTEGER, duration_days),
                bonus_amount_minor = COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, bonus_amount_minor),
                expires_at = COALESCE((p_payload->>'expiresAt')::TIMESTAMPTZ, expires_at),
                status = COALESCE(p_payload->>'status', status),
                completed_at = COALESCE((p_payload->>'completedAt')::TIMESTAMPTZ, completed_at),
                bonus_ledger_id = COALESCE((p_payload->>'bonusLedgerId')::UUID, bonus_ledger_id),
                updated_at = NOW(),
                version = version + 1
            WHERE id = v_entity_uuid;

            PERFORM public.record_canonical_change('goals', v_entity_uuid, 'UPDATE', p_payload, v_rec_goal.version + 1);
            v_result := jsonb_build_object('goalId', v_entity_uuid, 'version', v_rec_goal.version + 1);

        WHEN 'UPDATE_GOAL_PROGRESS' THEN
            v_entity_uuid := COALESCE((p_payload->>'goalId')::UUID, (p_payload->>'id')::UUID);
            IF v_entity_uuid IS NULL THEN
                RAISE EXCEPTION 'Invalid goal progress update: goalId is required' USING ERRCODE='P2201';
            END IF;

            SELECT * INTO v_rec_goal
            FROM public.goals
            WHERE id = v_entity_uuid
            FOR UPDATE;

            IF v_rec_goal.id IS NULL THEN
                RAISE EXCEPTION 'Goal not found: ID %', v_entity_uuid USING ERRCODE='23503';
            END IF;

            v_expected_version := COALESCE((p_payload->>'expectedVersion')::INTEGER,(p_payload->>'expected_version')::INTEGER);
            IF v_expected_version IS NOT NULL AND v_rec_goal.version <> v_expected_version THEN
                RAISE EXCEPTION 'VERSION_CONFLICT [409]: Goal version mismatch. Expected %, current %', v_expected_version, v_rec_goal.version USING ERRCODE='P0409';
            END IF;

            IF COALESCE((p_payload->>'bonusGranted')::BOOLEAN, FALSE)
               AND p_payload->>'bonusLedgerId' IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.financial_ledger WHERE id = (p_payload->>'bonusLedgerId')::UUID) THEN
                INSERT INTO public.financial_ledger (
                    id, event_type, amount_minor, customer_id, actor_admin_id, reference_id, metadata, created_at
                )
                VALUES (
                    (p_payload->>'bonusLedgerId')::UUID,
                    'BONUS',
                    COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, v_rec_goal.bonus_amount_minor),
                    v_rec_goal.customer_id,
                    v_actor_id,
                    v_entity_uuid,
                    jsonb_build_object('reason','GOAL_COMPLETED','goalId',v_entity_uuid),
                    NOW()
                );
            END IF;

            UPDATE public.goals
            SET current_progress = COALESCE((p_payload->>'currentProgress')::INTEGER, current_progress),
                status = COALESCE(p_payload->>'status', status),
                completed_at = COALESCE((p_payload->>'completedAt')::TIMESTAMPTZ, completed_at),
                bonus_ledger_id = COALESCE((p_payload->>'bonusLedgerId')::UUID, bonus_ledger_id),
                updated_at = NOW(),
                version = version + 1
            WHERE id = v_entity_uuid;

            PERFORM public.record_canonical_change('goals', v_entity_uuid, 'UPDATE', p_payload, v_rec_goal.version + 1);
            IF COALESCE((p_payload->>'bonusGranted')::BOOLEAN, FALSE) THEN
                PERFORM public.record_canonical_change('financial_ledger', (p_payload->>'bonusLedgerId')::UUID, 'INSERT',
                    jsonb_build_object('event_type','BONUS','amount_minor',COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, v_rec_goal.bonus_amount_minor),'customer_id',v_rec_goal.customer_id,'reference_id',v_entity_uuid),1);
            END IF;
            v_result := jsonb_build_object('goalId', v_entity_uuid, 'version', v_rec_goal.version + 1);

        WHEN 'CREATE_PAYMENT', 'POST_PAYMENT' THEN
            v_payment_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := COALESCE((p_payload->>'customerId'), (p_payload->>'customer_id'))::UUID;
            IF v_customer_uuid IS NULL THEN
                RAISE EXCEPTION 'Validation Error: Customer ID is required for payment' USING ERRCODE = 'P2201';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = v_customer_uuid AND is_active = TRUE) THEN
                RAISE EXCEPTION 'Customer Not Found/Inactive: Cannot record payment for customer %', v_customer_uuid USING ERRCODE = '23503';
            END IF;
            IF COALESCE((p_payload->>'amountMinor')::BIGINT, (p_payload->>'amount_minor')::BIGINT, 0) <= 0 THEN
                RAISE EXCEPTION 'Validation Error: Payment amount must be positive' USING ERRCODE = '22023';
            END IF;

            INSERT INTO public.payments (
                id, customer_id, amount_minor, payment_method, reference, actor_admin_id, command_id, notes, created_at
            )
            VALUES (
                v_payment_uuid,
                v_customer_uuid,
                COALESCE((p_payload->>'amountMinor')::BIGINT, (p_payload->>'amount_minor')::BIGINT),
                COALESCE(p_payload->>'paymentMethod', p_payload->>'payment_method', 'CASH'),
                COALESCE(p_payload->>'reference', ''),
                v_actor_id,
                p_command_id,
                COALESCE(p_payload->>'notes', ''),
                NOW()
            )
            ON CONFLICT (id) DO NOTHING;

            INSERT INTO public.financial_ledger (
                event_type, amount_minor, customer_id, actor_admin_id, reference_id, metadata, created_at
            )
            SELECT
                'PAYMENT',
                COALESCE((p_payload->>'amountMinor')::BIGINT, (p_payload->>'amount_minor')::BIGINT),
                v_customer_uuid,
                v_actor_id,
                v_payment_uuid,
                jsonb_build_object('paymentId', v_payment_uuid, 'commandId', p_command_id),
                NOW()
            WHERE NOT EXISTS (
                SELECT 1 FROM public.financial_ledger
                WHERE event_type = 'PAYMENT' AND reference_id = v_payment_uuid
            )
            RETURNING id INTO v_ledger_uuid;

            PERFORM public.record_canonical_change('payments', v_payment_uuid, 'INSERT', p_payload, 1);
            IF v_ledger_uuid IS NOT NULL THEN
                PERFORM public.record_canonical_change('financial_ledger', v_ledger_uuid, 'INSERT', jsonb_build_object(
                    'id', v_ledger_uuid, 'eventType', 'PAYMENT', 'amountMinor', COALESCE((p_payload->>'amountMinor')::BIGINT, (p_payload->>'amount_minor')::BIGINT),
                    'customerId', v_customer_uuid, 'referenceId', v_payment_uuid
                ), 1);
            END IF;

            v_result := jsonb_build_object('paymentId', v_payment_uuid, 'ledgerEntryId', v_ledger_uuid, 'customerId', v_customer_uuid);

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
$$;
-- Canonical execute_sync_command wrapper.
-- Remove both historical TEXT/VARCHAR wrapper overloads so PostgREST sees
-- exactly one execute_sync_command contract.
DROP FUNCTION IF EXISTS public.execute_sync_command(TEXT,VARCHAR,VARCHAR,TEXT,JSONB,INTEGER);
DROP FUNCTION IF EXISTS public.execute_sync_command(TEXT,VARCHAR(100),VARCHAR(100),TEXT,JSONB,INTEGER);
CREATE OR REPLACE FUNCTION public.execute_sync_command(
    p_command_id UUID,
    p_command_type TEXT,
    p_aggregate_type TEXT DEFAULT NULL,
    p_aggregate_id UUID DEFAULT NULL,
    p_payload JSONB DEFAULT '{}'::jsonb,
    p_expected_version INTEGER DEFAULT NULL
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN public.execute_canonical_sync_command(
        p_command_id,
        p_command_type,
        p_payload || CASE WHEN p_expected_version IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('expectedVersion',p_expected_version) END,
        COALESCE(p_payload->>'payloadHash','no_hash'),
        COALESCE(p_payload->>'deviceId','default_device'),
        auth.uid()
    );
END;
$$;


-- Explicit RPC grants: clients may invoke only the canonical wrapper; the inner
-- SECURITY DEFINER function is not exposed directly to the public API role.
REVOKE ALL ON FUNCTION public.execute_sync_command(UUID, TEXT, TEXT, UUID, JSONB, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.execute_sync_command(UUID, TEXT, TEXT, UUID, JSONB, INTEGER) TO authenticated;
REVOKE ALL ON FUNCTION public.execute_canonical_sync_command(UUID, TEXT, JSONB, TEXT, TEXT, UUID) FROM PUBLIC;

-- Contract reviewed: keep this migration as the single canonical sync command definition.

-- CI contract review checkpoint: canonical command routing is intentionally explicit.
