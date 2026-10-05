import { query } from "./db.mjs";

const sql = `
CREATE OR REPLACE FUNCTION public.create_authoritative_backup_checkpoint(
    p_entered_bin TEXT,
    p_notes TEXT DEFAULT 'MANUAL'
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
DECLARE
    v_bin_verified BOOLEAN := FALSE;
    v_chk_id UUID := gen_random_uuid();
    v_seq BIGINT;
    v_manifest JSONB;
    v_snapshot JSONB;
    v_integrity_hash TEXT;
    v_max_seq BIGINT;
    v_count_settings INT;
    v_count_customers INT;
    v_count_days INT;
    v_count_devices INT;
    v_count_orders INT;
    v_count_items INT;
    v_count_payments INT;
    v_count_allocations INT;
    v_count_ledger INT;
    v_count_goals INT;
    v_count_goal_requests INT;
    v_ledger_sum BIGINT;
BEGIN
    -- Verify BIN (server authoritative check)
    IF auth.uid() IS NOT NULL THEN
        SELECT public.verify_admin_bin(p_entered_bin) INTO v_bin_verified;
    ELSE
        SELECT (extensions.crypt(trim(p_entered_bin), bin_hash) = bin_hash)
        INTO v_bin_verified
        FROM public.admins
        WHERE role IN ('SUPER_ADMIN', 'Super Admin') AND is_active = true
        LIMIT 1;
    END IF;

    IF v_bin_verified IS NOT TRUE THEN
        RAISE EXCEPTION 'Security Authorization Failed: Invalid BIN';
    END IF;

    -- Count authoritative records
    SELECT count(*) INTO v_count_settings FROM public.system_settings;
    SELECT count(*) INTO v_count_customers FROM public.customers;
    SELECT count(*) INTO v_count_days FROM public.business_days;
    SELECT count(*) INTO v_count_devices FROM public.device_types;
    SELECT count(*) INTO v_count_orders FROM public.orders;
    SELECT count(*) INTO v_count_items FROM public.order_items;
    SELECT count(*) INTO v_count_payments FROM public.payments;
    SELECT count(*) INTO v_count_allocations FROM public.payment_allocations;
    SELECT count(*), COALESCE(SUM(amount_minor), 0) INTO v_count_ledger, v_ledger_sum FROM public.financial_ledger;
    SELECT count(*) INTO v_count_goals FROM public.goals;
    SELECT count(*) INTO v_count_goal_requests FROM public.goal_requests;
    SELECT COALESCE(MAX(sequence_id), 0) INTO v_max_seq FROM public.change_log;

    -- Capture snapshot data with COALESCE to []
    v_snapshot := jsonb_build_object(
        'systemSettings', COALESCE((SELECT jsonb_agg(row_to_json(s)) FROM public.system_settings s), '[]'::jsonb),
        'customers', COALESCE((SELECT jsonb_agg(row_to_json(c)) FROM public.customers c), '[]'::jsonb),
        'deviceTypes', COALESCE((SELECT jsonb_agg(row_to_json(d)) FROM public.device_types d), '[]'::jsonb),
        'businessDays', COALESCE((SELECT jsonb_agg(row_to_json(b)) FROM public.business_days b), '[]'::jsonb),
        'orders', COALESCE((SELECT jsonb_agg(row_to_json(o)) FROM public.orders o), '[]'::jsonb),
        'orderItems', COALESCE((SELECT jsonb_agg(row_to_json(oi)) FROM public.order_items oi), '[]'::jsonb),
        'payments', COALESCE((SELECT jsonb_agg(row_to_json(p)) FROM public.payments p), '[]'::jsonb),
        'paymentAllocations', COALESCE((SELECT jsonb_agg(row_to_json(pa)) FROM public.payment_allocations pa), '[]'::jsonb),
        'financialLedger', COALESCE((SELECT jsonb_agg(row_to_json(fl)) FROM public.financial_ledger fl), '[]'::jsonb),
        'goals', COALESCE((SELECT jsonb_agg(row_to_json(g)) FROM public.goals g), '[]'::jsonb),
        'goalRequests', COALESCE((SELECT jsonb_agg(row_to_json(gr)) FROM public.goal_requests gr), '[]'::jsonb)
    );

    v_integrity_hash := md5(format('%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s',
        v_count_settings, v_count_customers, v_count_days, v_count_devices,
        v_count_orders, v_count_items, v_count_payments, v_count_allocations,
        v_count_ledger, v_ledger_sum, v_count_goals, v_count_goal_requests
    ));

    v_manifest := jsonb_build_object(
        'checkpointId', v_chk_id,
        'schemaVersion', 1,
        'formatVersion', '1.0',
        'authoritativeMaxSequence', v_max_seq,
        'createdAt', NOW(),
        'counts', jsonb_build_object(
            'systemSettings', v_count_settings,
            'customers', v_count_customers,
            'businessDays', v_count_days,
            'deviceTypes', v_count_devices,
            'orders', v_count_orders,
            'orderItems', v_count_items,
            'payments', v_count_payments,
            'paymentAllocations', v_count_allocations,
            'financialLedger', v_count_ledger,
            'goals', v_count_goals,
            'goalRequests', v_count_goal_requests
        ),
        'financialIntegrity', jsonb_build_object(
            'totalLedgerSumMinor', v_ledger_sum
        )
    );

    INSERT INTO public.backup_checkpoints (checkpoint_id, checkpoint_type, manifest, integrity_hash, snapshot_data, created_at)
    VALUES (v_chk_id, COALESCE(p_notes, 'MANUAL'), v_manifest, v_integrity_hash, v_snapshot, NOW())
    RETURNING checkpoint_sequence INTO v_seq;

    RETURN jsonb_build_object(
        'success', TRUE,
        'checkpointId', v_chk_id,
        'checkpointSequence', v_seq,
        'integrityHash', v_integrity_hash,
        'manifest', v_manifest
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_authoritative_backup_checkpoint(
    p_entered_bin TEXT,
    p_checkpoint_id UUID
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
DECLARE
    v_bin_verified BOOLEAN := FALSE;
    v_chk RECORD;
    v_rec RECORD;
BEGIN
    -- 1. Server authoritative BIN verification
    IF auth.uid() IS NOT NULL THEN
        SELECT public.verify_admin_bin(p_entered_bin) INTO v_bin_verified;
    ELSE
        SELECT (extensions.crypt(trim(p_entered_bin), bin_hash) = bin_hash)
        INTO v_bin_verified
        FROM public.admins
        WHERE role IN ('SUPER_ADMIN', 'Super Admin') AND is_active = true
        LIMIT 1;
    END IF;

    IF v_bin_verified IS NOT TRUE THEN
        RAISE EXCEPTION 'Security Authorization Failed: Invalid BIN';
    END IF;

    -- 2. Find checkpoint
    SELECT * INTO v_chk
    FROM public.backup_checkpoints
    WHERE checkpoint_id = p_checkpoint_id;

    IF v_chk.checkpoint_id IS NULL THEN
        RAISE EXCEPTION 'Backup Checkpoint Not Found: ID %', p_checkpoint_id;
    END IF;

    -- 3. Staged Atomic Clean & Restore within this transaction
    ALTER TABLE public.financial_ledger DISABLE TRIGGER trg_immutable_financial_ledger;
    ALTER TABLE public.order_items DISABLE TRIGGER trg_freeze_recognized_order_item;

    -- Clean operational business data
    DELETE FROM public.goal_requests;
    DELETE FROM public.goals;
    DELETE FROM public.payment_allocations;
    DELETE FROM public.financial_ledger;
    DELETE FROM public.payments;
    DELETE FROM public.order_items;
    DELETE FROM public.orders;
    DELETE FROM public.business_days;
    DELETE FROM public.customers;
    DELETE FROM public.device_types;
    DELETE FROM public.system_settings;

    -- Restore System Settings
    IF jsonb_typeof(v_chk.snapshot_data->'systemSettings') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'systemSettings') AS x(
            key VARCHAR(100), value_type VARCHAR(20), value_string TEXT, value_number BIGINT, value_boolean BOOLEAN, value_json JSONB, description TEXT, updated_at TIMESTAMPTZ, updated_by UUID
        ) LOOP
            INSERT INTO public.system_settings (key, value_type, value_string, value_number, value_boolean, value_json, description, updated_at, updated_by)
            VALUES (v_rec.key, v_rec.value_type, v_rec.value_string, v_rec.value_number, v_rec.value_boolean, v_rec.value_json, v_rec.description, COALESCE(v_rec.updated_at, NOW()), v_rec.updated_by);
        END LOOP;
    END IF;

    -- Restore Customers
    IF jsonb_typeof(v_chk.snapshot_data->'customers') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'customers') AS x(
            id UUID, name VARCHAR(200), phone VARCHAR(50), status VARCHAR(20), is_active BOOLEAN, notes TEXT, debt_limit_minor BIGINT, charger_fee_exempt BOOLEAN, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, version INTEGER
        ) LOOP
            INSERT INTO public.customers (id, name, phone, status, is_active, notes, debt_limit_minor, charger_fee_exempt, created_at, updated_at, deleted_at, version)
            VALUES (v_rec.id, v_rec.name, v_rec.phone, v_rec.status, v_rec.is_active, v_rec.notes, v_rec.debt_limit_minor, v_rec.charger_fee_exempt, v_rec.created_at, v_rec.updated_at, v_rec.deleted_at, v_rec.version);
        END LOOP;
    END IF;

    -- Restore Device Types
    IF jsonb_typeof(v_chk.snapshot_data->'deviceTypes') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'deviceTypes') AS x(
            id UUID, name VARCHAR(200), name_ar VARCHAR(200), name_en VARCHAR(200), icon VARCHAR(50), base_price_minor BIGINT, charger_fee_enabled BOOLEAN, charger_fee_applicable BOOLEAN, is_active BOOLEAN, status VARCHAR(20), sort_order INTEGER, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, version INTEGER
        ) LOOP
            INSERT INTO public.device_types (id, name, name_ar, name_en, icon, base_price_minor, charger_fee_enabled, charger_fee_applicable, is_active, status, sort_order, created_at, updated_at, deleted_at, version)
            VALUES (v_rec.id, v_rec.name, v_rec.name_ar, v_rec.name_en, v_rec.icon, v_rec.base_price_minor, v_rec.charger_fee_enabled, v_rec.charger_fee_applicable, v_rec.is_active, v_rec.status, v_rec.sort_order, v_rec.created_at, v_rec.updated_at, v_rec.deleted_at, v_rec.version);
        END LOOP;
    END IF;

    -- Restore Business Days
    IF jsonb_typeof(v_chk.snapshot_data->'businessDays') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'businessDays') AS x(
            id UUID, business_date DATE, display_number INTEGER, status VARCHAR(20), is_closed BOOLEAN, opened_at TIMESTAMPTZ, closed_at TIMESTAMPTZ, closed_by UUID, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, version INTEGER
        ) LOOP
            INSERT INTO public.business_days (id, business_date, display_number, status, is_closed, opened_at, closed_at, closed_by, created_at, updated_at, version)
            VALUES (v_rec.id, v_rec.business_date, v_rec.display_number, v_rec.status, v_rec.is_closed, v_rec.opened_at, v_rec.closed_at, v_rec.closed_by, v_rec.created_at, v_rec.updated_at, v_rec.version);
        END LOOP;
    END IF;

    -- Restore Orders
    IF jsonb_typeof(v_chk.snapshot_data->'orders') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'orders') AS x(
            id UUID, day_id UUID, customer_id UUID, display_number INTEGER, status VARCHAR(20), notes TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, version INTEGER
        ) LOOP
            INSERT INTO public.orders (id, day_id, customer_id, display_number, status, notes, created_at, updated_at, deleted_at, version)
            VALUES (v_rec.id, v_rec.day_id, v_rec.customer_id, v_rec.display_number, v_rec.status::order_status, v_rec.notes, v_rec.created_at, v_rec.updated_at, v_rec.deleted_at, v_rec.version);
        END LOOP;
    END IF;

    -- Restore Order Items
    IF jsonb_typeof(v_chk.snapshot_data->'orderItems') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'orderItems') AS x(
            id UUID, order_id UUID, device_type_id UUID, item_sequence INTEGER, operational_status VARCHAR(20), financial_status VARCHAR(20), payment_status VARCHAR(20), status VARCHAR(20), device_name_snapshot VARCHAR(150), device_icon_snapshot VARCHAR(100), base_price_snapshot_minor BIGINT, charger_fee_snapshot_minor BIGINT, discount_snapshot_minor BIGINT, final_charge_snapshot_minor BIGINT, unit_price_minor BIGINT, total_price_minor BIGINT, has_charger BOOLEAN, charger_fee_enabled_snapshot BOOLEAN, customer_charger_fee_exempt_snapshot BOOLEAN, delivered_at TIMESTAMPTZ, financially_recognized_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ, replacement_of_item_id UUID, notes TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, version INTEGER
        ) LOOP
            INSERT INTO public.order_items (id, order_id, device_type_id, item_sequence, operational_status, financial_status, payment_status, status, device_name_snapshot, device_icon_snapshot, base_price_snapshot_minor, charger_fee_snapshot_minor, discount_snapshot_minor, final_charge_snapshot_minor, unit_price_minor, total_price_minor, has_charger, charger_fee_enabled_snapshot, customer_charger_fee_exempt_snapshot, delivered_at, financially_recognized_at, cancelled_at, replacement_of_item_id, notes, created_at, updated_at, deleted_at, version)
            VALUES (v_rec.id, v_rec.order_id, v_rec.device_type_id, v_rec.item_sequence, v_rec.operational_status, v_rec.financial_status, v_rec.payment_status, v_rec.status::item_status, v_rec.device_name_snapshot, v_rec.device_icon_snapshot, v_rec.base_price_snapshot_minor, v_rec.charger_fee_snapshot_minor, v_rec.discount_snapshot_minor, v_rec.final_charge_snapshot_minor, v_rec.unit_price_minor, v_rec.total_price_minor, v_rec.has_charger, v_rec.charger_fee_enabled_snapshot, v_rec.customer_charger_fee_exempt_snapshot, v_rec.delivered_at, v_rec.financially_recognized_at, v_rec.cancelled_at, v_rec.replacement_of_item_id, v_rec.notes, v_rec.created_at, v_rec.updated_at, v_rec.deleted_at, v_rec.version);
        END LOOP;
    END IF;

    -- Restore Payments
    IF jsonb_typeof(v_chk.snapshot_data->'payments') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'payments') AS x(
            id UUID, customer_id UUID, amount_minor BIGINT, payment_method VARCHAR(50), reference TEXT, actor_admin_id UUID, command_id UUID, created_at TIMESTAMPTZ
        ) LOOP
            INSERT INTO public.payments (id, customer_id, amount_minor, payment_method, reference, actor_admin_id, command_id, created_at)
            VALUES (v_rec.id, v_rec.customer_id, v_rec.amount_minor, v_rec.payment_method, v_rec.reference, v_rec.actor_admin_id, v_rec.command_id, v_rec.created_at);
        END LOOP;
    END IF;

    -- Restore Payment Allocations
    IF jsonb_typeof(v_chk.snapshot_data->'paymentAllocations') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'paymentAllocations') AS x(
            id UUID, payment_id UUID, order_item_id UUID, order_id UUID, allocated_amount_minor BIGINT, created_at TIMESTAMPTZ
        ) LOOP
            INSERT INTO public.payment_allocations (id, payment_id, order_item_id, order_id, allocated_amount_minor, created_at)
            VALUES (v_rec.id, v_rec.payment_id, v_rec.order_item_id, v_rec.order_id, v_rec.allocated_amount_minor, v_rec.created_at);
        END LOOP;
    END IF;

    -- Restore Financial Ledger
    IF jsonb_typeof(v_chk.snapshot_data->'financialLedger') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'financialLedger') AS x(
            id UUID, sequence_number BIGINT, event_type VARCHAR(30), amount_minor BIGINT, order_id UUID, order_item_id UUID, customer_id UUID, actor_admin_id UUID, reference_id UUID, linked_ledger_id UUID, metadata JSONB, created_at TIMESTAMPTZ
        ) LOOP
            INSERT INTO public.financial_ledger (id, sequence_number, event_type, amount_minor, order_id, order_item_id, customer_id, actor_admin_id, reference_id, linked_ledger_id, metadata, created_at)
            VALUES (v_rec.id, v_rec.sequence_number, v_rec.event_type::ledger_event_type, v_rec.amount_minor, v_rec.order_id, v_rec.order_item_id, v_rec.customer_id, v_rec.actor_admin_id, v_rec.reference_id, v_rec.linked_ledger_id, v_rec.metadata, v_rec.created_at);
        END LOOP;
    END IF;

    -- Restore Goals
    IF jsonb_typeof(v_chk.snapshot_data->'goals') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'goals') AS x(
            id UUID, customer_id UUID, target_quantity INTEGER, current_progress INTEGER, bonus_amount_minor BIGINT, duration_days INTEGER, status VARCHAR(20), started_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, bonus_ledger_id UUID, version INTEGER, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
        ) LOOP
            INSERT INTO public.goals (id, customer_id, target_quantity, current_progress, bonus_amount_minor, duration_days, status, started_at, expires_at, completed_at, bonus_ledger_id, version, created_at, updated_at)
            VALUES (v_rec.id, v_rec.customer_id, v_rec.target_quantity, v_rec.current_progress, v_rec.bonus_amount_minor, v_rec.duration_days, v_rec.status, v_rec.started_at, v_rec.expires_at, v_rec.completed_at, v_rec.bonus_ledger_id, v_rec.version, v_rec.created_at, v_rec.updated_at);
        END LOOP;
    END IF;

    -- Restore Goal Requests
    IF jsonb_typeof(v_chk.snapshot_data->'goalRequests') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'goalRequests') AS x(
            id UUID, customer_id UUID, requested_target INTEGER, status VARCHAR(20), reviewed_by UUID, reviewed_at TIMESTAMPTZ, rejection_reason TEXT, resulting_goal_id UUID, version INTEGER, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
        ) LOOP
            INSERT INTO public.goal_requests (id, customer_id, requested_target, status, reviewed_by, reviewed_at, rejection_reason, resulting_goal_id, version, created_at, updated_at)
            VALUES (v_rec.id, v_rec.customer_id, v_rec.requested_target, v_rec.status, v_rec.reviewed_by, v_rec.reviewed_at, v_rec.rejection_reason, v_rec.resulting_goal_id, v_rec.version, v_rec.created_at, v_rec.updated_at);
        END LOOP;
    END IF;

    -- Re-enable immutability triggers
    ALTER TABLE public.financial_ledger ENABLE TRIGGER trg_immutable_financial_ledger;
    ALTER TABLE public.order_items ENABLE TRIGGER trg_freeze_recognized_order_item;

    -- Record authoritative change log restore event
    PERFORM public.record_canonical_change('system', p_checkpoint_id, 'UPDATE', jsonb_build_object('restoredCheckpointId', p_checkpoint_id), 1);

    RETURN jsonb_build_object(
        'success', TRUE,
        'restoredCheckpointId', p_checkpoint_id,
        'message', 'Checkpoint restored successfully in single atomic transaction'
    );
EXCEPTION WHEN OTHERS THEN
    ALTER TABLE public.financial_ledger ENABLE TRIGGER trg_immutable_financial_ledger;
    ALTER TABLE public.order_items ENABLE TRIGGER trg_freeze_recognized_order_item;
    RAISE;
END;
$$;
`;

async function main() {
  console.log("Applying robust backup & restore functions with json array checks...");
  const res = await query(sql);
  console.log("Result:", res);
}
main();
