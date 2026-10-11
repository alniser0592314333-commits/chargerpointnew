-- Keep the deployed canonical RPC body intact while adding the missing server-side
-- invariant for stale/offline ADD_ORDER_ITEM commands against cancelled orders.
-- Source was captured from the current deployed execute_canonical_sync_command
-- definition; the only behavior change is the guard in ADD_ORDER_ITEM.
CREATE OR REPLACE FUNCTION public.execute_canonical_sync_command(p_command_id uuid, p_command_type text, p_payload jsonb, p_payload_hash text DEFAULT 'no_hash'::text, p_device_id text DEFAULT 'default_device'::text, p_actor_id uuid DEFAULT NULL::uuid)
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
    v_rec_goal RECORD;
    v_rec_goal_request RECORD;
    v_current_status TEXT;
    v_orig_charge_amount BIGINT;
    v_dev_name VARCHAR(200);
    v_dev_icon VARCHAR(100);
    v_bin TEXT;
    v_goal_target INTEGER;
    v_goal_duration INTEGER;
    v_goal_bonus BIGINT;
    v_goal_started TIMESTAMPTZ;
    v_goal_expires TIMESTAMPTZ;
    v_goal_progress INTEGER;
    v_rec_order RECORD;
    v_change_count BIGINT;
    v_payload_order_count BIGINT;
    v_distinct_number_count BIGINT;
    v_min_new_number INTEGER;
    v_max_new_number INTEGER;
    v_requested_display_number INTEGER;
    v_order_change_payload JSONB;
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
            WHEN 'RENUMBER_DAY_ORDERS' THEN
                v_required_perm := 'orders:renumber-day';
            WHEN 'ADD_ORDER_ITEM' THEN
                v_required_perm := 'orders:edit';
            WHEN 'DELIVER_ORDER_ITEM' THEN
                v_required_perm := 'orders:deliver';
            WHEN 'CANCEL_ORDER', 'CANCEL_ORDER_ITEM' THEN
                v_required_perm := 'orders:cancel';
            WHEN 'POST_PAYMENT', 'CREATE_PAYMENT' THEN
                v_required_perm := 'finance:create-payment';
            WHEN 'CREATE_CUSTOMER_CREDIT', 'CONSUME_CUSTOMER_CREDIT' THEN
                v_required_perm := 'finance:credit-adjustment';
            WHEN 'REFUND_PAYMENT', 'CREATE_REFUND' THEN
                v_required_perm := 'finance:refund';
            WHEN 'CREATE_GOAL', 'UPDATE_GOAL_CONFIG' THEN
                v_required_perm := 'goals:manage';
            -- UPDATE_GOAL_PROGRESS only requests a server-side recalculation;
            -- its client-supplied progress/status/reward fields are ignored.
            WHEN 'UPDATE_GOAL_PROGRESS' THEN
                v_required_perm := NULL;
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
    v_bin := NULLIF(TRIM(p_payload->>'bin'), '');

    IF (
        p_command_type IN ('DELIVER_ORDER_ITEM','CANCEL_ORDER','CANCEL_ORDER_ITEM','CREATE_CUSTOMER_CREDIT','CREATE_PAYMENT','POST_PAYMENT','CREATE_REFUND')
        AND NOT (
            p_command_type = 'DELIVER_ORDER_ITEM'
            AND COALESCE((p_payload->>'autoDelivery')::BOOLEAN, FALSE)
            AND v_admin_role IN ('SUPER_ADMIN', 'Super Admin')
        )
       )
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

            PERFORM public.record_canonical_change('business_days', v_day_uuid, 'UPDATE', jsonb_build_object('id', v_day_uuid, 'status', 'CLOSED'), 1);
            v_result := jsonb_build_object('businessDayId', v_day_uuid, 'status', 'CLOSED');

        -- ----------------------------------------------------
        -- D. ORDERS & ORDER ITEMS
        -- ----------------------------------------------------
        WHEN 'CREATE_ORDER' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (COALESCE(p_payload->>'customerId', p_payload->>'customer_id'))::UUID;
            v_day_uuid := (COALESCE(p_payload->>'dayId', p_payload->>'day_id'))::UUID;
            -- Serialize order creation with renumbering for this business day.
            PERFORM pg_advisory_xact_lock(hashtextextended(v_day_uuid::TEXT, 1));

            SELECT status INTO v_customer_status FROM public.customers WHERE id = v_customer_uuid;
            IF v_customer_status IS NULL THEN
                RAISE EXCEPTION 'Customer Not Found: ID %', v_customer_uuid USING ERRCODE = '23503';
            END IF;
            IF v_customer_status = 'DELETED' THEN
                RAISE EXCEPTION 'Customer Is Deleted/Frozen: Cannot create order for soft-deleted customer %', v_customer_uuid;
            END IF;

            PERFORM id FROM public.business_days WHERE id = v_day_uuid FOR UPDATE;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Business Day Not Found: ID %', v_day_uuid USING ERRCODE = '23503';
            END IF;

            v_requested_display_number := COALESCE(
                (p_payload->>'displayNumber')::INTEGER,
                (p_payload->>'display_number')::INTEGER
            );
            -- Offline devices may submit reserved numbers out of order. Preserve a
            -- requested number when it is valid and free; never reject an otherwise
            -- valid offline order solely because a prior renumber made its reservation stale.
            -- If the number is absent/invalid or now collides, allocate the next free number
            -- while holding the same per-day lock used by renumbering and order creation.
            IF v_requested_display_number IS NULL OR v_requested_display_number < 1 THEN
                SELECT COALESCE(MAX(display_number), 0) + 1
                INTO v_requested_display_number
                FROM public.orders
                WHERE day_id = v_day_uuid;
            END IF;

            IF EXISTS (
                SELECT 1 FROM public.orders
                WHERE day_id = v_day_uuid AND display_number = v_requested_display_number
            ) THEN
                SELECT COALESCE(MAX(display_number), 0) + 1
                INTO v_requested_display_number
                FROM public.orders
                WHERE day_id = v_day_uuid;
            END IF;

            INSERT INTO public.orders (
                id, day_id, customer_id, display_number, status, notes, version, created_at, updated_at
            )
            VALUES (
                v_entity_uuid,
                v_day_uuid,
                v_customer_uuid,
                v_requested_display_number,
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

            -- The change feed must carry the authoritative assigned number, not a
            -- stale offline reservation value that collided after a manual renumber.
            v_order_change_payload := jsonb_set(
                jsonb_set(COALESCE(p_payload, '{}'::JSONB), '{displayNumber}', to_jsonb(v_requested_display_number), TRUE),
                '{display_number}', to_jsonb(v_requested_display_number), TRUE
            );
            PERFORM public.record_canonical_change('orders', v_entity_uuid, 'INSERT', v_order_change_payload, 1);
            v_result := jsonb_build_object('orderId', v_entity_uuid, 'displayNumber', v_requested_display_number);

        WHEN 'RENUMBER_DAY_ORDERS' THEN
            v_day_uuid := COALESCE((p_payload->>'dayId')::UUID, (p_payload->>'id')::UUID);
            IF v_day_uuid IS NULL OR COALESCE(jsonb_typeof(p_payload->'changes'), '') <> 'array' THEN
                RAISE EXCEPTION 'Renumber validation failed: dayId and changes array are required' USING ERRCODE = 'P2201';
            END IF;
            SELECT COUNT(*) INTO v_change_count FROM jsonb_array_elements(p_payload->'changes');
            IF v_change_count < 1 THEN
                RAISE EXCEPTION 'Renumber validation failed: at least one order is required' USING ERRCODE = 'P2201';
            END IF;
            -- Share the exact same per-day lock with CREATE_ORDER.
            PERFORM pg_advisory_xact_lock(hashtextextended(v_day_uuid::TEXT, 1));
            PERFORM id FROM public.business_days WHERE id = v_day_uuid FOR UPDATE;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Business Day Not Found: ID %', v_day_uuid USING ERRCODE = '23503';
            END IF;
            PERFORM id FROM public.orders WHERE day_id = v_day_uuid ORDER BY id FOR UPDATE;

            SELECT COUNT(*) INTO v_payload_order_count FROM public.orders WHERE day_id = v_day_uuid;
            IF v_payload_order_count <> v_change_count THEN
                RAISE EXCEPTION 'Renumber conflict: payload must include every order in the selected day' USING ERRCODE = 'P0409';
            END IF;
            IF EXISTS (
                SELECT 1 FROM jsonb_array_elements(p_payload->'changes') c
                WHERE NULLIF(c->>'id','') IS NULL OR NULLIF(c->>'expectedVersion','') IS NULL
                   OR NULLIF(c->>'oldNumber','') IS NULL OR NULLIF(c->>'newNumber','') IS NULL
            ) OR (
                SELECT COUNT(DISTINCT (c->>'id')::UUID) FROM jsonb_array_elements(p_payload->'changes') c
            ) <> v_change_count THEN
                RAISE EXCEPTION 'Renumber validation failed: duplicate IDs or incomplete change rows' USING ERRCODE = 'P2201';
            END IF;
            IF EXISTS (
                SELECT 1 FROM jsonb_array_elements(p_payload->'changes') c
                WHERE (c->>'newNumber')::INTEGER < 1 OR (c->>'newNumber')::INTEGER > v_change_count
            ) THEN
                RAISE EXCEPTION 'Renumber validation failed: new numbers must be 1..N' USING ERRCODE = 'P2201';
            END IF;
            SELECT COUNT(DISTINCT (c->>'newNumber')::INTEGER),
                   MIN((c->>'newNumber')::INTEGER), MAX((c->>'newNumber')::INTEGER)
            INTO v_distinct_number_count, v_min_new_number, v_max_new_number
            FROM jsonb_array_elements(p_payload->'changes') c;
            IF v_distinct_number_count <> v_change_count OR v_min_new_number <> 1 OR v_max_new_number <> v_change_count THEN
                RAISE EXCEPTION 'Renumber validation failed: new numbers must be unique and contiguous from 1' USING ERRCODE = 'P2201';
            END IF;
            IF EXISTS (
                SELECT 1 FROM public.orders o
                WHERE o.day_id = v_day_uuid
                  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'changes') c WHERE (c->>'id')::UUID = o.id)
            ) OR EXISTS (
                SELECT 1 FROM jsonb_array_elements(p_payload->'changes') c
                WHERE NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = (c->>'id')::UUID AND o.day_id = v_day_uuid)
            ) THEN
                RAISE EXCEPTION 'Renumber conflict: order set changed; reload the day and review again' USING ERRCODE = 'P0409';
            END IF;
            FOR v_rec_order IN
                SELECT o.id, o.display_number, o.version, c.value AS change_row
                FROM public.orders o
                JOIN LATERAL jsonb_array_elements(p_payload->'changes') c(value) ON (c.value->>'id')::UUID = o.id
                WHERE o.day_id = v_day_uuid ORDER BY o.id
            LOOP
                IF v_rec_order.version <> (v_rec_order.change_row->>'expectedVersion')::INTEGER
                   OR v_rec_order.display_number <> (v_rec_order.change_row->>'oldNumber')::INTEGER THEN
                    RAISE EXCEPTION 'Renumber conflict: order % changed on server; reload and review again', v_rec_order.id
                        USING ERRCODE = 'P0409';
                END IF;
            END LOOP;

            -- The live canonical schema has no unique (day_id, display_number) constraint.
            -- One UPDATE per order prevents temporary values from entering change_log.
            UPDATE public.orders o
            SET display_number = (c.value->>'newNumber')::INTEGER,
                updated_at = NOW(),
                version = o.version + 1
            FROM jsonb_array_elements(p_payload->'changes') c(value)
            WHERE o.id = (c.value->>'id')::UUID AND o.day_id = v_day_uuid;

            FOR v_rec_order IN
                SELECT (c.value->>'id')::UUID AS id,
                       (c.value->>'oldNumber')::INTEGER AS old_number,
                       (c.value->>'newNumber')::INTEGER AS new_number,
                       (c.value->>'expectedVersion')::INTEGER AS old_version
                FROM jsonb_array_elements(p_payload->'changes') c(value)
                ORDER BY (c.value->>'id')::UUID
            LOOP
                INSERT INTO public.order_renumber_audit (
                    command_id, day_id, order_id, actor_admin_id, old_number, new_number, old_version, new_version, created_at
                ) VALUES (
                    p_command_id, v_day_uuid, v_rec_order.id, v_actor_id,
                    v_rec_order.old_number, v_rec_order.new_number, v_rec_order.old_version, v_rec_order.old_version + 1, NOW()
                );
            END LOOP;
            v_result := jsonb_build_object('dayId', v_day_uuid, 'count', v_change_count, 'renumbered', TRUE);
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
            -- Reject stale/offline ADD_ORDER_ITEM commands after another device has cancelled the order.
            IF EXISTS (
                SELECT 1 FROM public.orders
                WHERE id = v_order_uuid AND status = 'cancelled'
            ) THEN
                RAISE EXCEPTION 'Validation Error: Cannot add an item to a cancelled order'
                    USING ERRCODE = 'P4005';
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
                v_authoritative_charger_fee := COALESCE((p_payload->>'chargerFeeSnapshotMinor')::BIGINT, (p_payload->>'charger_fee_snapshot_minor')::BIGINT, 50);
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
                COALESCE((p_payload->>'itemSequence')::INTEGER, (p_payload->>'item_sequence')::INTEGER, (SELECT COALESCE(MAX(item_sequence), 0) + 1 FROM public.order_items WHERE order_id = v_order_uuid)),
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

            -- A recognized item is idempotently complete only when its financial
            -- effect actually exists. Do not silently accept a half-committed state
            -- (RECOGNIZED without a charge), because that is exactly how the local
            -- and server financial models drift apart.
            IF v_rec_item.financial_status = 'RECOGNIZED' THEN
                SELECT COUNT(*), MIN(id), MIN(amount_minor)
                INTO v_change_seq, v_ledger_uuid, v_orig_charge_amount
                FROM public.financial_ledger
                WHERE order_item_id = v_item_uuid
                  AND event_type IN ('CHARGE', 'ORDER_ITEM_CHARGE');

                IF v_change_seq = 1 THEN
                    v_result := jsonb_build_object(
                        'orderItemId', v_item_uuid,
                        'status', 'DELIVERED',
                        'financialStatus', 'RECOGNIZED',
                        'alreadyRecognized', TRUE,
                        'ledgerEntryId', v_ledger_uuid,
                        'finalChargeMinor', ABS(COALESCE(v_orig_charge_amount, 0))
                    );
                    -- The command is a replay of an already committed delivery.
                    -- Nothing else must be inserted.
                ELSIF v_change_seq > 1 THEN
                    RAISE EXCEPTION 'FINANCIAL_INVARIANT [409]: Order item % has % charge ledger entries',
                        v_item_uuid, v_change_seq;
                ELSE
                    -- Fall through to the authoritative recognition path below.
                    -- This repairs an inconsistent legacy/server state exactly once.
                    NULL;
                END IF;

            END IF;

            -- Only a missing financial effect enters the recognition path.
            IF COALESCE(v_change_seq, 0) <> 1 THEN
                SELECT base_price_minor, charger_fee_applicable
                INTO v_base_price, v_charger_applicable
                FROM public.device_types
                WHERE id = v_rec_item.device_type_id;

                IF v_base_price IS NULL THEN
                    RAISE EXCEPTION 'Device Type Not Found for Item: ID %', v_rec_item.device_type_id USING ERRCODE = '23503';
                END IF;

                SELECT COALESCE(value_number, 50)
                INTO v_setting_charger_fee
                FROM public.system_settings
                WHERE key = 'default_charger_fee_minor';
                IF v_setting_charger_fee IS NULL THEN v_setting_charger_fee := 50; END IF;

                IF v_charger_applicable AND (NOT v_rec_item.charger_fee_exempt) AND (NOT v_rec_item.has_charger) THEN
                    v_authoritative_charger_fee := v_setting_charger_fee;
                ELSE
                    v_authoritative_charger_fee := 0;
                END IF;

                v_authoritative_discount := COALESCE(v_rec_item.discount_snapshot_minor, 0);
                v_authoritative_final_charge := GREATEST(0, v_base_price + v_authoritative_charger_fee - v_authoritative_discount);

                v_current_balance := public.calculate_customer_authoritative_balance(v_rec_item.customer_id);
                v_projected_balance := v_current_balance - v_authoritative_final_charge;

                IF COALESCE(v_admin_role, '') NOT IN ('SUPER_ADMIN', 'Super Admin') AND (
                    (v_rec_item.debt_limit_minor > 0 AND v_projected_balance < (-v_rec_item.debt_limit_minor))
                    OR
                    (v_rec_item.debt_limit_minor < 0 AND v_projected_balance < v_rec_item.debt_limit_minor)
                    OR
                    (v_rec_item.debt_limit_minor = 0 AND v_projected_balance < 0)
                ) THEN
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
                    'ORDER_ITEM_CHARGE',
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
                ), v_rec_item.version + 1);

                PERFORM public.record_canonical_change('financial_ledger', v_ledger_uuid, 'INSERT', jsonb_build_object(
                    'event_type', 'ORDER_ITEM_CHARGE',
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

            -- Serialize all financial mutations for this customer before reading
            -- outstanding debt. This makes concurrent payments deterministic.
            PERFORM 1
            FROM public.customers
            WHERE id = v_customer_uuid
              AND is_active = TRUE
            FOR UPDATE;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Customer Not Found/Inactive: Cannot record payment for customer %', v_customer_uuid
                    USING ERRCODE = '23503';
            END IF;

            -- Lock the exact eligible items before calculating outstanding amounts.
            PERFORM 1
            FROM public.order_items oi
            JOIN public.orders o ON o.id = oi.order_id
            WHERE o.customer_id = v_customer_uuid
              AND o.status <> 'cancelled'
              AND oi.status <> 'cancelled'
              AND oi.financial_status = 'RECOGNIZED'
              AND oi.payment_status <> 'PAID'
            ORDER BY o.internal_sequence ASC, oi.item_sequence ASC, oi.id ASC
            FOR UPDATE OF oi;

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
                  AND o.status <> 'cancelled'
                  AND oi.status <> 'cancelled'
                  AND oi.financial_status = 'RECOGNIZED'
                  AND oi.payment_status <> 'PAID'
                GROUP BY oi.id, oi.order_id, oi.final_charge_snapshot_minor,
                         o.internal_sequence, oi.item_sequence
                ORDER BY o.internal_sequence ASC, oi.item_sequence ASC, oi.id ASC
            LOOP
                EXIT WHEN v_unallocated_amount <= 0;

                v_item_charge_due := v_rec_item.final_charge_snapshot_minor - v_rec_item.paid_so_far;
                IF v_item_charge_due > 0 THEN
                    IF v_unallocated_amount >= v_item_charge_due THEN
                        v_alloc_amount := v_item_charge_due;
                        v_unallocated_amount := v_unallocated_amount - v_item_charge_due;

                        UPDATE public.order_items SET payment_status = 'PAID', updated_at = NOW(), version = version + 1
                        WHERE id = v_rec_item.id;

                    ELSE
                        v_alloc_amount := v_unallocated_amount;
                        v_unallocated_amount := 0;

                        UPDATE public.order_items SET payment_status = 'PARTIALLY_PAID', updated_at = NOW(), version = version + 1
                        WHERE id = v_rec_item.id;

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

                END IF;
            END LOOP;


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

            v_goal_target := COALESCE((p_payload->>'targetQuantity')::INTEGER, v_rec_goal_request.requested_target, 10);
            v_goal_duration := COALESCE((p_payload->>'durationDays')::INTEGER, (3 + floor(random() * 13))::INTEGER);
            v_goal_bonus := COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, v_goal_target::BIGINT * 10);
            v_goal_started := NOW();
            v_goal_expires := COALESCE((p_payload->>'expiresAt')::TIMESTAMPTZ, v_goal_started + make_interval(days => v_goal_duration));
            IF v_goal_target <= 0 OR v_goal_duration < 3 OR v_goal_duration > 15 OR
               v_goal_bonus < 0 OR v_goal_bonus > v_goal_target::BIGINT * 20 OR
               v_goal_expires <> v_goal_started + make_interval(days => v_goal_duration) THEN
                RAISE EXCEPTION 'Invalid goal request parameters: target, duration, expiry, or reward cap' USING ERRCODE='22023';
            END IF;

            INSERT INTO public.goals (
                id, customer_id, target_quantity, current_progress, bonus_amount_minor,
                duration_days, status, started_at, expires_at, version, created_at, updated_at
            )
            VALUES (
                v_entity_uuid, v_rec_goal_request.customer_id, v_goal_target, 0, v_goal_bonus,
                v_goal_duration, 'ACTIVE', v_goal_started, v_goal_expires, 1, NOW(), NOW()
            );

            UPDATE public.goal_requests
            SET status = 'APPROVED',
                reviewed_by = v_actor_id,
                reviewed_at = NOW(),
                resulting_goal_id = v_entity_uuid,
                updated_at = NOW(),
                version = version + 1
            WHERE id = v_rec_goal_request.id;

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

            v_result := jsonb_build_object('requestId', v_entity_uuid, 'status', 'REJECTED');

        WHEN 'CREATE_GOAL' THEN
            v_entity_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (p_payload->>'customerId')::UUID;
            v_goal_target := COALESCE((p_payload->>'targetQuantity')::INTEGER, 0);
            v_goal_duration := COALESCE((p_payload->>'durationDays')::INTEGER, (3 + floor(random() * 13))::INTEGER);
            v_goal_bonus := COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, v_goal_target::BIGINT * 10);
            v_goal_started := COALESCE((p_payload->>'startedAt')::TIMESTAMPTZ, NOW());
            v_goal_expires := COALESCE((p_payload->>'expiresAt')::TIMESTAMPTZ, v_goal_started + make_interval(days => v_goal_duration));

            IF v_customer_uuid IS NULL OR NOT EXISTS (
                SELECT 1 FROM public.customers
                WHERE id = v_customer_uuid AND status <> 'DELETED' AND is_active = TRUE
            ) THEN
                RAISE EXCEPTION 'Goal customer is missing, deleted, or inactive' USING ERRCODE='23503';
            END IF;
            IF v_goal_target <= 0 THEN
                RAISE EXCEPTION 'Goal target must be a positive integer' USING ERRCODE='22023';
            END IF;
            IF v_goal_duration < 3 OR v_goal_duration > 15 THEN
                RAISE EXCEPTION 'Goal duration must be between 3 and 15 days' USING ERRCODE='22023';
            END IF;
            IF v_goal_bonus < 0 OR v_goal_bonus > v_goal_target::BIGINT * 20 THEN
                RAISE EXCEPTION 'Goal bonus exceeds the hard cap of 20 minor units per target device' USING ERRCODE='22023';
            END IF;
            IF v_goal_expires <> v_goal_started + make_interval(days => v_goal_duration) THEN
                RAISE EXCEPTION 'Goal expiry must equal started_at plus duration_days' USING ERRCODE='22023';
            END IF;
            IF EXISTS (SELECT 1 FROM public.goals WHERE customer_id = v_customer_uuid AND status = 'ACTIVE') THEN
                RAISE EXCEPTION 'Customer already has an active goal' USING ERRCODE='P0001';
            END IF;

            INSERT INTO public.goals (
                id, customer_id, target_quantity, current_progress, bonus_amount_minor,
                duration_days, status, started_at, expires_at, version, created_at, updated_at
            ) VALUES (
                v_entity_uuid, v_customer_uuid, v_goal_target, 0, v_goal_bonus,
                v_goal_duration, 'ACTIVE', v_goal_started, v_goal_expires, 1, NOW(), NOW()
            );

            v_result := jsonb_build_object(
                'goalId', v_entity_uuid, 'customerId', v_customer_uuid, 'targetQuantity', v_goal_target,
                'durationDays', v_goal_duration, 'bonusAmountMinor', v_goal_bonus,
                'startedAt', v_goal_started, 'expiresAt', v_goal_expires, 'status', 'ACTIVE'
            );

        WHEN 'UPDATE_GOAL_CONFIG' THEN
            v_entity_uuid := (p_payload->>'id')::UUID;
            IF v_entity_uuid IS NULL THEN
                RAISE EXCEPTION 'Invalid goal update: id is required' USING ERRCODE='P2201';
            END IF;

            SELECT * INTO v_rec_goal FROM public.goals WHERE id = v_entity_uuid FOR UPDATE;
            IF v_rec_goal.id IS NULL THEN
                RAISE EXCEPTION 'Goal not found: ID %', v_entity_uuid USING ERRCODE='23503';
            END IF;
            IF v_rec_goal.status <> 'ACTIVE' THEN
                RAISE EXCEPTION 'Completed or failed goals are immutable' USING ERRCODE='P0001';
            END IF;

            -- Progress refreshes are idempotent server calculations, so stale local versions do not block them.

            v_goal_target := COALESCE((p_payload->>'targetQuantity')::INTEGER, v_rec_goal.target_quantity);
            v_goal_duration := COALESCE((p_payload->>'durationDays')::INTEGER, v_rec_goal.duration_days);
            v_goal_bonus := COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, v_rec_goal.bonus_amount_minor);
            v_goal_started := v_rec_goal.started_at;
            v_goal_expires := COALESCE((p_payload->>'expiresAt')::TIMESTAMPTZ, v_goal_started + make_interval(days => v_goal_duration));

            IF v_goal_target <= 0 THEN
                RAISE EXCEPTION 'Goal target must be a positive integer' USING ERRCODE='22023';
            END IF;
            IF v_goal_duration < 3 OR v_goal_duration > 15 THEN
                RAISE EXCEPTION 'Goal duration must be between 3 and 15 days' USING ERRCODE='22023';
            END IF;
            IF v_goal_bonus < 0 OR v_goal_bonus > v_goal_target::BIGINT * 20 THEN
                RAISE EXCEPTION 'Goal bonus exceeds the hard cap of 20 minor units per target device' USING ERRCODE='22023';
            END IF;
            IF v_goal_expires <> v_goal_started + make_interval(days => v_goal_duration) THEN
                RAISE EXCEPTION 'Goal expiry must equal started_at plus duration_days' USING ERRCODE='22023';
            END IF;

            UPDATE public.goals
            SET target_quantity = v_goal_target,
                duration_days = v_goal_duration,
                bonus_amount_minor = v_goal_bonus,
                expires_at = v_goal_expires,
                updated_at = NOW(),
                version = version + 1
            WHERE id = v_entity_uuid;


            -- Re-evaluate on the server; ignore client-supplied status/progress/bonus fields.
            PERFORM public.evaluate_customer_active_goal_internal(v_rec_goal.customer_id);
            SELECT * INTO v_rec_goal FROM public.goals WHERE id = v_entity_uuid;
            v_result := jsonb_build_object(
                'goalId', v_entity_uuid, 'version', v_rec_goal.version,
                'status', v_rec_goal.status, 'currentProgress', v_rec_goal.current_progress,
                'bonusLedgerId', v_rec_goal.bonus_ledger_id
            );

        WHEN 'UPDATE_GOAL_PROGRESS' THEN
            v_entity_uuid := COALESCE((p_payload->>'goalId')::UUID, (p_payload->>'id')::UUID);
            IF v_entity_uuid IS NULL THEN
                RAISE EXCEPTION 'Invalid goal progress update: goalId is required' USING ERRCODE='P2201';
            END IF;

            SELECT * INTO v_rec_goal FROM public.goals WHERE id = v_entity_uuid FOR UPDATE;
            IF v_rec_goal.id IS NULL THEN
                RAISE EXCEPTION 'Goal not found: ID %', v_entity_uuid USING ERRCODE='23503';
            END IF;

            v_expected_version := COALESCE((p_payload->>'expectedVersion')::INTEGER,(p_payload->>'expected_version')::INTEGER);
            IF v_expected_version IS NOT NULL AND v_rec_goal.version <> v_expected_version THEN
                RAISE EXCEPTION 'VERSION_CONFLICT [409]: Goal version mismatch. Expected %, current %', v_expected_version, v_rec_goal.version USING ERRCODE='P0409';
            END IF;

            -- Client progress/status/bonus payload fields are deliberately ignored.
            IF v_rec_goal.status = 'ACTIVE' THEN
                PERFORM public.evaluate_customer_active_goal_internal(v_rec_goal.customer_id);
            END IF;
            SELECT * INTO v_rec_goal FROM public.goals WHERE id = v_entity_uuid;
            v_result := jsonb_build_object(
                'goalId', v_entity_uuid, 'version', v_rec_goal.version,
                'status', v_rec_goal.status, 'currentProgress', v_rec_goal.current_progress,
                'bonusLedgerId', v_rec_goal.bonus_ledger_id
            );

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
$function$

