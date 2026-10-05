/**
 * Supabase Migration: 00100_canonical_architecture_baseline.sql
 * =========================================================================
 * Phase 1 Canonical Database Foundation for Order & Customer Management System
 * =========================================================================
 * Authoritative Canonical Relational Foundation:
 * 1. UUID identifiers, integer minor currency units, monotonic versioning.
 * 2. Soft-delete + operational freeze for Customers.
 * 3. Canonical Business Days with semantic close support.
 * 4. Retired status for Device Types (no hard deletes referencing historical records).
 * 5. Typed key/value System Settings table.
 * 6. Orders with NO duplicate restrictions per day/customer and server-authoritative sequencing.
 * 7. Order Items with 3 independent dimensions:
 *    - operational_status: CHARGING, DELIVERED, CANCELLED
 *    - financial_status:   UNRECOGNIZED, RECOGNIZED, REVERSED
 *    - payment_status:     UNPAID, PARTIALLY_PAID, PAID
 *    - Price Snapshot Rule: Authoritative financial price calculated and frozen at DELIVERY/RECOGNITION.
 * 8. Append-only immutable Financial Ledger (strictly rejects UPDATE and DELETE).
 * 9. Payments and Item-Level Payment Allocations (authoritative FIFO allocation).
 * 10. Canonical processed_commands table with payload_hash idempotency.
 * 11. Monotonic change_log sequence for delta synchronization.
 * 12. Super Admin immutable authority & RBAC enforcement (protected by DB triggers; dynamic permissions).
 * 13. Reversal semantics for cancelled recognized order items.
 * 14. Server-authoritative debt limit enforcement.
 * 15. Authoritative backup checkpoints & staged atomic restore.
 */

-- Ensure extensions exist
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Extend ledger_event_type enum if it exists as enum
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ledger_event_type') THEN
        ALTER TYPE public.ledger_event_type ADD VALUE IF NOT EXISTS 'CHARGE';
        ALTER TYPE public.ledger_event_type ADD VALUE IF NOT EXISTS 'ADJUSTMENT';
        ALTER TYPE public.ledger_event_type ADD VALUE IF NOT EXISTS 'CREDIT';
        ALTER TYPE public.ledger_event_type ADD VALUE IF NOT EXISTS 'DISCOUNT';
    END IF;
END $$;

-- Set default for icon on device_types
ALTER TABLE public.device_types ALTER COLUMN icon SET DEFAULT 'smartphone';

-- Set defaults for snapshots on order_items
ALTER TABLE public.order_items ALTER COLUMN device_name_snapshot SET DEFAULT '';
ALTER TABLE public.order_items ALTER COLUMN device_icon_snapshot SET DEFAULT 'smartphone';
ALTER TABLE public.order_items ALTER COLUMN charger_fee_enabled_snapshot SET DEFAULT TRUE;
ALTER TABLE public.order_items ALTER COLUMN customer_charger_fee_exempt_snapshot SET DEFAULT FALSE;
ALTER TABLE public.order_items ALTER COLUMN charger_fee_snapshot_minor SET DEFAULT 0;
ALTER TABLE public.order_items ALTER COLUMN has_charger SET DEFAULT FALSE;
ALTER TABLE public.order_items ALTER COLUMN unit_price_minor SET DEFAULT 0;
ALTER TABLE public.order_items ALTER COLUMN total_price_minor SET DEFAULT 0;

-- Ensure created_at on processed_commands
ALTER TABLE public.processed_commands ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- =========================================================================
-- 0. DROP OBSOLETE & CONFLICTING RPC OVERLOADS & LEGACY TRIGGERS
-- =========================================================================

DROP FUNCTION IF EXISTS public.execute_command(text, character varying, character varying, text, jsonb, integer);
DROP FUNCTION IF EXISTS public.execute_command(text, text, text, text, jsonb, integer);

-- Drop duplicate conflicting legacy triggers on financial_ledger
DROP TRIGGER IF EXISTS trg_prevent_ledger_delete ON public.financial_ledger;
DROP TRIGGER IF EXISTS trg_prevent_ledger_tampering ON public.financial_ledger;
DROP TRIGGER IF EXISTS trg_prevent_ledger_update ON public.financial_ledger;

-- =========================================================================
-- 1. TYPED SYSTEM SETTINGS
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.system_settings (
    key VARCHAR(100) PRIMARY KEY,
    value_type VARCHAR(20) NOT NULL CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
    value_string TEXT,
    value_number BIGINT,
    value_boolean BOOLEAN,
    value_json JSONB,
    description TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID
);

-- Seed default canonical settings
INSERT INTO public.system_settings (key, value_type, value_number, description)
VALUES ('default_charger_fee_minor', 'number', 500, 'Standard charger service fee in minor currency units (5.00 ILS)')
ON CONFLICT (key) DO UPDATE SET
    value_number = EXCLUDED.value_number,
    description = EXCLUDED.description;

INSERT INTO public.system_settings (key, value_type, value_string, description)
VALUES ('currency_code', 'string', 'ILS', 'System standard currency ISO code')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.system_settings (key, value_type, value_string, description)
VALUES ('business_timezone', 'string', 'Asia/Jerusalem', 'Authoritative business timezone')
ON CONFLICT (key) DO NOTHING;

-- =========================================================================
-- 2. CANONICAL CUSTOMERS
-- =========================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'customers') THEN
        CREATE TABLE public.customers (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name VARCHAR(200) NOT NULL,
            phone VARCHAR(50),
            status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DELETED')),
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            notes TEXT,
            debt_limit_minor BIGINT NOT NULL DEFAULT 0 CHECK (debt_limit_minor >= 0),
            charger_fee_exempt BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at TIMESTAMPTZ,
            version INTEGER NOT NULL DEFAULT 1
        );
    ELSE
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'status') THEN
            ALTER TABLE public.customers ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DELETED'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'deleted_at') THEN
            ALTER TABLE public.customers ADD COLUMN deleted_at TIMESTAMPTZ;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'debt_limit_minor') THEN
            ALTER TABLE public.customers ADD COLUMN debt_limit_minor BIGINT NOT NULL DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'charger_fee_exempt') THEN
            ALTER TABLE public.customers ADD COLUMN charger_fee_exempt BOOLEAN NOT NULL DEFAULT FALSE;
        END IF;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_customers_status ON public.customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON public.customers(phone);

-- =========================================================================
-- 3. CANONICAL BUSINESS DAYS
-- =========================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'business_days') THEN
        CREATE TABLE public.business_days (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            business_date DATE NOT NULL UNIQUE,
            display_number INTEGER NOT NULL DEFAULT 1,
            status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
            is_closed BOOLEAN NOT NULL DEFAULT FALSE,
            opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            closed_at TIMESTAMPTZ,
            closed_by UUID,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            version INTEGER NOT NULL DEFAULT 1,
            CONSTRAINT positive_display_number CHECK (display_number > 0)
        );
    ELSE
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'business_days' AND column_name = 'status') THEN
            ALTER TABLE public.business_days ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'business_days' AND column_name = 'display_number') THEN
            ALTER TABLE public.business_days ADD COLUMN display_number INTEGER NOT NULL DEFAULT 1;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'business_days' AND column_name = 'opened_at') THEN
            ALTER TABLE public.business_days ADD COLUMN opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
        END IF;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_business_days_status ON public.business_days(status);

-- =========================================================================
-- 4. CANONICAL DEVICE TYPES
-- =========================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'device_types') THEN
        CREATE TABLE public.device_types (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name VARCHAR(200) NOT NULL,
            name_ar VARCHAR(200) NOT NULL,
            name_en VARCHAR(200) NOT NULL,
            icon VARCHAR(50) NOT NULL DEFAULT 'smartphone',
            base_price_minor BIGINT NOT NULL DEFAULT 0 CHECK (base_price_minor >= 0),
            charger_fee_enabled BOOLEAN NOT NULL DEFAULT TRUE,
            charger_fee_applicable BOOLEAN NOT NULL DEFAULT TRUE,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at TIMESTAMPTZ,
            version INTEGER NOT NULL DEFAULT 1
        );
    ELSE
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'device_types' AND column_name = 'status') THEN
            ALTER TABLE public.device_types ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'device_types' AND column_name = 'charger_fee_applicable') THEN
            ALTER TABLE public.device_types ADD COLUMN charger_fee_applicable BOOLEAN NOT NULL DEFAULT TRUE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'device_types' AND column_name = 'name_ar') THEN
            ALTER TABLE public.device_types ADD COLUMN name_ar VARCHAR(200);
            UPDATE public.device_types SET name_ar = name WHERE name_ar IS NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'device_types' AND column_name = 'name_en') THEN
            ALTER TABLE public.device_types ADD COLUMN name_en VARCHAR(200);
            UPDATE public.device_types SET name_en = name WHERE name_en IS NULL;
        END IF;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_device_types_status ON public.device_types(status);

-- =========================================================================
-- 5. CANONICAL ORDERS
-- =========================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'orders') THEN
        CREATE TABLE public.orders (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            day_id UUID NOT NULL REFERENCES public.business_days(id) ON DELETE RESTRICT,
            customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
            display_number INTEGER NOT NULL DEFAULT 1,
            internal_sequence BIGSERIAL UNIQUE NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'charging',
            notes TEXT DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at TIMESTAMPTZ,
            version INTEGER NOT NULL DEFAULT 1,
            CONSTRAINT positive_order_display_number CHECK (display_number > 0)
        );
    END IF;
END $$;

-- Drop obsolete day+customer unique constraint if present
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'public.orders'::regclass
          AND contype = 'u'
          AND conname LIKE '%day%customer%'
    ) LOOP
        EXECUTE 'ALTER TABLE public.orders DROP CONSTRAINT ' || quote_ident(r.conname);
    END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_day_sequence ON public.orders(day_id, internal_sequence);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON public.orders(customer_id);

-- =========================================================================
-- 6. CANONICAL ORDER ITEMS
-- =========================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'order_items') THEN
        CREATE TABLE public.order_items (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
            device_type_id UUID NOT NULL REFERENCES public.device_types(id) ON DELETE RESTRICT,
            item_sequence INTEGER NOT NULL DEFAULT 1,
            
            operational_status VARCHAR(20) NOT NULL DEFAULT 'CHARGING',
            financial_status VARCHAR(20) NOT NULL DEFAULT 'UNRECOGNIZED',
            payment_status VARCHAR(20) NOT NULL DEFAULT 'UNPAID',
            status VARCHAR(20) NOT NULL DEFAULT 'charging',
            
            device_name_snapshot VARCHAR(150) NOT NULL DEFAULT '',
            device_icon_snapshot VARCHAR(100) NOT NULL DEFAULT 'smartphone',
            base_price_snapshot_minor BIGINT NOT NULL DEFAULT 0,
            charger_fee_snapshot_minor BIGINT NOT NULL DEFAULT 0,
            discount_snapshot_minor BIGINT NOT NULL DEFAULT 0,
            final_charge_snapshot_minor BIGINT NOT NULL DEFAULT 0,
            unit_price_minor BIGINT NOT NULL DEFAULT 0,
            total_price_minor BIGINT NOT NULL DEFAULT 0,
            
            has_charger BOOLEAN NOT NULL DEFAULT FALSE,
            charger_fee_enabled_snapshot BOOLEAN NOT NULL DEFAULT TRUE,
            customer_charger_fee_exempt_snapshot BOOLEAN NOT NULL DEFAULT FALSE,
            
            delivered_at TIMESTAMPTZ,
            financially_recognized_at TIMESTAMPTZ,
            cancelled_at TIMESTAMPTZ,
            replacement_of_item_id UUID REFERENCES public.order_items(id),
            notes TEXT,
            
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at TIMESTAMPTZ,
            version INTEGER NOT NULL DEFAULT 1
        );
    ELSE
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'operational_status') THEN
            ALTER TABLE public.order_items ADD COLUMN operational_status VARCHAR(20) NOT NULL DEFAULT 'CHARGING';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'financial_status') THEN
            ALTER TABLE public.order_items ADD COLUMN financial_status VARCHAR(20) NOT NULL DEFAULT 'UNRECOGNIZED';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'payment_status') THEN
            ALTER TABLE public.order_items ADD COLUMN payment_status VARCHAR(20) NOT NULL DEFAULT 'UNPAID';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'discount_snapshot_minor') THEN
            ALTER TABLE public.order_items ADD COLUMN discount_snapshot_minor BIGINT NOT NULL DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'final_charge_snapshot_minor') THEN
            ALTER TABLE public.order_items ADD COLUMN final_charge_snapshot_minor BIGINT NOT NULL DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'financially_recognized_at') THEN
            ALTER TABLE public.order_items ADD COLUMN financially_recognized_at TIMESTAMPTZ;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'cancelled_at') THEN
            ALTER TABLE public.order_items ADD COLUMN cancelled_at TIMESTAMPTZ;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'notes') THEN
            ALTER TABLE public.order_items ADD COLUMN notes TEXT;
        END IF;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_order_items_order ON public.order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_device_type ON public.order_items(device_type_id);
CREATE INDEX IF NOT EXISTS idx_order_items_operational ON public.order_items(operational_status);
CREATE INDEX IF NOT EXISTS idx_order_items_financial ON public.order_items(financial_status);

-- =========================================================================
-- 7. CANONICAL FINANCIAL LEDGER (STRICTLY IMMUTABLE)
-- =========================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'financial_ledger') THEN
        CREATE TABLE public.financial_ledger (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            sequence_number BIGSERIAL NOT NULL UNIQUE,
            event_type VARCHAR(30) NOT NULL,
            amount_minor BIGINT NOT NULL,
            order_id UUID REFERENCES public.orders(id),
            order_item_id UUID REFERENCES public.order_items(id),
            customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
            actor_admin_id UUID,
            reference_id UUID,
            linked_ledger_id UUID REFERENCES public.financial_ledger(id),
            metadata JSONB DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    ELSE
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'financial_ledger' AND column_name = 'linked_ledger_id') THEN
            ALTER TABLE public.financial_ledger ADD COLUMN linked_ledger_id UUID REFERENCES public.financial_ledger(id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'financial_ledger' AND column_name = 'sequence_number') THEN
            ALTER TABLE public.financial_ledger ADD COLUMN sequence_number BIGSERIAL UNIQUE;
        END IF;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ledger_customer ON public.financial_ledger(customer_id);
CREATE INDEX IF NOT EXISTS idx_ledger_order_item ON public.financial_ledger(order_item_id);

-- Enforce Strict Immutability on Financial Ledger (No UPDATE, No DELETE)
CREATE OR REPLACE FUNCTION public.prevent_financial_ledger_tampering()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Financial Invariant Violation: financial_ledger is strictly append-only. UPDATE and DELETE operations are forbidden.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_immutable_financial_ledger ON public.financial_ledger;
CREATE TRIGGER trg_immutable_financial_ledger
BEFORE UPDATE OR DELETE ON public.financial_ledger
FOR EACH ROW
EXECUTE FUNCTION public.prevent_financial_ledger_tampering();

-- Enforce Permanent Immutability on Recognized Order Item Snapshots
CREATE OR REPLACE FUNCTION public.freeze_recognized_order_item_snapshots()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.financial_status = 'RECOGNIZED' THEN
        -- If already recognized, pricing snapshots and recognition status cannot be altered or reverted
        IF NEW.base_price_snapshot_minor != OLD.base_price_snapshot_minor
           OR NEW.charger_fee_snapshot_minor != OLD.charger_fee_snapshot_minor
           OR NEW.discount_snapshot_minor != OLD.discount_snapshot_minor
           OR NEW.final_charge_snapshot_minor != OLD.final_charge_snapshot_minor
           OR NEW.financial_status = 'UNRECOGNIZED'
        THEN
            RAISE EXCEPTION 'Financial Invariant Violation: Authoritative pricing snapshots for recognized order items are permanently frozen and cannot be changed or reverted.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_freeze_recognized_order_item ON public.order_items;
CREATE TRIGGER trg_freeze_recognized_order_item
BEFORE UPDATE ON public.order_items
FOR EACH ROW
EXECUTE FUNCTION public.freeze_recognized_order_item_snapshots();

-- =========================================================================
-- 8. CANONICAL PAYMENTS & ITEM-LEVEL PAYMENT ALLOCATIONS (FIFO)
-- =========================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payments') THEN
        CREATE TABLE public.payments (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
            amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
            payment_method VARCHAR(50) NOT NULL DEFAULT 'CASH',
            reference TEXT DEFAULT '',
            actor_admin_id UUID,
            command_id UUID,
            notes TEXT DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payment_allocations') THEN
        CREATE TABLE public.payment_allocations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
            order_item_id UUID NOT NULL REFERENCES public.order_items(id) ON DELETE RESTRICT,
            order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
            allocated_amount_minor BIGINT NOT NULL CHECK (allocated_amount_minor > 0),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    ELSE
        -- Ensure order_item_id column exists
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_allocations' AND column_name = 'order_item_id') THEN
            ALTER TABLE public.payment_allocations ADD COLUMN order_item_id UUID REFERENCES public.order_items(id) ON DELETE RESTRICT;
        END IF;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_allocations_payment ON public.payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_allocations_order_item ON public.payment_allocations(order_item_id);

-- =========================================================================
-- 9. CANONICAL PROCESSED COMMANDS (IDEMPOTENCY)
-- =========================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'processed_commands') THEN
        CREATE TABLE public.processed_commands (
            command_id UUID PRIMARY KEY,
            command_type VARCHAR(100) NOT NULL,
            actor_admin_id UUID,
            payload_hash VARCHAR(64) NOT NULL DEFAULT 'no_hash',
            result_payload JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    ELSE
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'processed_commands' AND column_name = 'payload_hash') THEN
            ALTER TABLE public.processed_commands ADD COLUMN payload_hash VARCHAR(64) NOT NULL DEFAULT 'no_hash';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'processed_commands' AND column_name = 'actor_admin_id') THEN
            ALTER TABLE public.processed_commands ADD COLUMN actor_admin_id UUID;
        END IF;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_processed_commands_hash ON public.processed_commands(command_id, payload_hash);

-- =========================================================================
-- 10. CANONICAL CHANGE LOG & DELTA SEQUENCE
-- =========================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'change_log') THEN
        CREATE TABLE public.change_log (
            sequence_id BIGSERIAL PRIMARY KEY,
            entity_type VARCHAR(50) NOT NULL,
            entity_id UUID NOT NULL,
            action VARCHAR(20) NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE', 'TOMBSTONE')),
            payload JSONB NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    ELSE
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'change_log' AND column_name = 'version') THEN
            ALTER TABLE public.change_log ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        END IF;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_change_log_sequence ON public.change_log(sequence_id);

-- Helper to record canonical change
CREATE OR REPLACE FUNCTION public.record_canonical_change(
    p_entity_type VARCHAR(50),
    p_entity_id UUID,
    p_action VARCHAR(20),
    p_payload JSONB,
    p_version INTEGER DEFAULT 1
)
RETURNS BIGINT AS $$
DECLARE
    v_seq BIGINT;
BEGIN
    INSERT INTO public.change_log (entity_type, entity_id, action, payload, version, changed_at)
    VALUES (p_entity_type, p_entity_id, p_action, p_payload, COALESCE(p_version, 1), NOW())
    RETURNING sequence_id INTO v_seq;
    RETURN v_seq;
END;
$$ LANGUAGE plpgsql;

-- =========================================================================
-- 11. CANONICAL GOALS & GOAL REQUESTS
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.goals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
    target_quantity INTEGER NOT NULL CHECK (target_quantity > 0),
    current_progress INTEGER NOT NULL DEFAULT 0 CHECK (current_progress >= 0),
    bonus_amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (bonus_amount_minor >= 0),
    duration_days INTEGER NOT NULL DEFAULT 7 CHECK (duration_days > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'COMPLETED', 'FAILED')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    bonus_ledger_id UUID REFERENCES public.financial_ledger(id),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_single_active_goal 
ON public.goals(customer_id) 
WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_goals_customer ON public.goals(customer_id);
CREATE INDEX IF NOT EXISTS idx_goals_status ON public.goals(status);

CREATE TABLE IF NOT EXISTS public.goal_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
    requested_target INTEGER CHECK (requested_target > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    reviewed_by UUID REFERENCES public.admins(id),
    reviewed_at TIMESTAMPTZ,
    rejection_reason TEXT,
    resulting_goal_id UUID REFERENCES public.goals(id),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goal_requests_customer ON public.goal_requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_goal_requests_status ON public.goal_requests(status);

DROP TRIGGER IF EXISTS trg_log_goals ON public.goals;
CREATE TRIGGER trg_log_goals
AFTER INSERT OR UPDATE OR DELETE ON public.goals
FOR EACH ROW EXECUTE FUNCTION log_table_changes();

DROP TRIGGER IF EXISTS trg_log_goal_requests ON public.goal_requests;
CREATE TRIGGER trg_log_goal_requests
AFTER INSERT OR UPDATE OR DELETE ON public.goal_requests
FOR EACH ROW EXECUTE FUNCTION log_table_changes();

-- =========================================================================
-- 12. CANONICAL BACKUP CHECKPOINTS TABLE
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.backup_checkpoints (
    checkpoint_sequence BIGSERIAL PRIMARY KEY,
    checkpoint_id UUID UNIQUE NOT NULL,
    checkpoint_type TEXT NOT NULL DEFAULT 'MANUAL',
    manifest JSONB NOT NULL,
    integrity_hash TEXT NOT NULL,
    snapshot_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- 12. AUTHORITATIVE SUPER ADMIN & RBAC SECURITY
-- =========================================================================

-- Trigger to protect Super Admin account from deletion, demotion, or deactivation
CREATE OR REPLACE FUNCTION public.protect_super_admin_account()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.role IN ('SUPER_ADMIN', 'Super Admin') THEN
            RAISE EXCEPTION 'Security Invariant Violation: Super Admin account cannot be deleted.';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.role IN ('SUPER_ADMIN', 'Super Admin') THEN
            IF NEW.role NOT IN ('SUPER_ADMIN', 'Super Admin') THEN
                RAISE EXCEPTION 'Security Invariant Violation: Super Admin authority cannot be demoted or removed.';
            END IF;
            IF NEW.is_active = FALSE THEN
                RAISE EXCEPTION 'Security Invariant Violation: Super Admin account cannot be disabled or suspended.';
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_super_admin_account ON public.admins;
CREATE TRIGGER trg_protect_super_admin_account
BEFORE UPDATE OR DELETE ON public.admins
FOR EACH ROW
EXECUTE FUNCTION public.protect_super_admin_account();

-- Trigger to protect Super Admin custom permissions from mutation/override
CREATE OR REPLACE FUNCTION public.protect_super_admin_permissions()
RETURNS TRIGGER AS $$
DECLARE
    v_target_role VARCHAR(50);
BEGIN
    SELECT role INTO v_target_role FROM public.admins WHERE id = COALESCE(NEW.admin_id, OLD.admin_id);
    IF v_target_role IN ('SUPER_ADMIN', 'Super Admin') THEN
        RAISE EXCEPTION 'Security Invariant Violation: Super Admin permissions are absolute and cannot be restricted or altered.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_super_admin_permissions ON public.admin_custom_permissions;
CREATE TRIGGER trg_protect_super_admin_permissions
BEFORE INSERT OR UPDATE OR DELETE ON public.admin_custom_permissions
FOR EACH ROW
EXECUTE FUNCTION public.protect_super_admin_permissions();

-- Authoritative get_effective_permissions function: Super Admin dynamically inherits ALL permissions
CREATE OR REPLACE FUNCTION public.get_effective_permissions(p_admin_id UUID)
RETURNS TABLE (permission VARCHAR(100)) AS $$
DECLARE
    v_role VARCHAR(50);
BEGIN
    SELECT role INTO v_role FROM public.admins WHERE id = p_admin_id;
    
    -- Super Admin has ALL system permissions dynamically from permissions table + wildcards
    IF v_role IN ('SUPER_ADMIN', 'Super Admin') THEN
        RETURN QUERY
        SELECT code::VARCHAR(100) FROM public.permissions
        UNION
        SELECT rp.permission::VARCHAR(100) FROM public.role_permissions rp
        UNION
        VALUES ('SUPER_ADMIN'::VARCHAR(100)), ('*'::VARCHAR(100));
        RETURN;
    END IF;

    -- Subordinate Admins: Role permissions + custom grants
    RETURN QUERY
    SELECT rp.permission::VARCHAR(100)
    FROM public.admins a
    JOIN public.role_permissions rp ON a.role = rp.role
    WHERE a.id = p_admin_id
    UNION
    SELECT acp.permission::VARCHAR(100)
    FROM public.admin_custom_permissions acp
    WHERE acp.admin_id = p_admin_id AND acp.is_grant = TRUE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Authoritative Customer Balance Calculation
CREATE OR REPLACE FUNCTION public.calculate_customer_authoritative_balance(p_customer_id UUID)
RETURNS BIGINT AS $$
DECLARE
    v_balance BIGINT;
BEGIN
    SELECT COALESCE(SUM(amount_minor), 0)
    INTO v_balance
    FROM public.financial_ledger
    WHERE customer_id = p_customer_id;
    RETURN v_balance;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- =========================================================================
-- 13. SEMANTIC CANONICAL SYNC COMMAND PROCESSOR (authoritative transaction)
-- =========================================================================

CREATE OR REPLACE FUNCTION public.execute_canonical_sync_command(
    p_command_id UUID,
    p_command_type TEXT,
    p_payload JSONB,
    p_payload_hash TEXT DEFAULT 'no_hash',
    p_device_id TEXT DEFAULT 'default_device',
    p_bin TEXT DEFAULT NULL
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

                -- Insert append-only linked REVERSAL entry
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
$$;

-- Unified semantic execute_sync_command wrapper
CREATE OR REPLACE FUNCTION public.execute_sync_command(
    p_command_id TEXT,
    p_command_type VARCHAR(100),
    p_aggregate_type VARCHAR(100) DEFAULT NULL,
    p_aggregate_id TEXT DEFAULT NULL,
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
        p_command_id::UUID,
        p_command_type,
        p_payload,
        COALESCE(p_payload->>'payloadHash', 'no_hash'),
        COALESCE(p_payload->>'deviceId', 'default_device'),
        p_payload->>'bin'
    );
END;
$$;

-- Overload taking UUID directly
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
        p_payload,
        COALESCE(p_payload->>'payloadHash', 'no_hash'),
        COALESCE(p_payload->>'deviceId', 'default_device'),
        p_payload->>'bin'
    );
END;
$$;

-- =========================================================================
-- 14. DELTA SYNC PULL RPC
-- =========================================================================

CREATE OR REPLACE FUNCTION public.pull_canonical_delta_changes(
    p_since_sequence BIGINT DEFAULT 0,
    p_limit INTEGER DEFAULT 500
)
RETURNS TABLE (
    sequence_id BIGINT,
    entity_type VARCHAR(50),
    entity_id UUID,
    action VARCHAR(20),
    payload JSONB,
    version INTEGER,
    changed_at TIMESTAMPTZ
)
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE sql
AS $$
    SELECT sequence_id, entity_type, entity_id, action, payload, version, changed_at
    FROM public.change_log
    WHERE sequence_id > p_since_sequence
    ORDER BY sequence_id ASC
    LIMIT LEAST(COALESCE(p_limit, 500), 1000);
$$;

-- =========================================================================
-- 15. AUTHORITATIVE BACKUP CHECKPOINT & RESTORE RPC
-- =========================================================================

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

    -- Capture snapshot data
    v_snapshot := jsonb_build_object(
        'systemSettings', (SELECT jsonb_agg(row_to_json(s)) FROM public.system_settings s),
        'customers', (SELECT jsonb_agg(row_to_json(c)) FROM public.customers c),
        'deviceTypes', (SELECT jsonb_agg(row_to_json(d)) FROM public.device_types d),
        'businessDays', (SELECT jsonb_agg(row_to_json(b)) FROM public.business_days b),
        'orders', (SELECT jsonb_agg(row_to_json(o)) FROM public.orders o),
        'orderItems', (SELECT jsonb_agg(row_to_json(oi)) FROM public.order_items oi),
        'payments', (SELECT jsonb_agg(row_to_json(p)) FROM public.payments p),
        'paymentAllocations', (SELECT jsonb_agg(row_to_json(pa)) FROM public.payment_allocations pa),
        'financialLedger', (SELECT jsonb_agg(row_to_json(fl)) FROM public.financial_ledger fl),
        'goals', (SELECT jsonb_agg(row_to_json(g)) FROM public.goals g),
        'goalRequests', (SELECT jsonb_agg(row_to_json(gr)) FROM public.goal_requests gr)
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

-- Authoritative Staged Restore RPC
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
    FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'systemSettings') AS x(
        key VARCHAR(100), value_type VARCHAR(20), value_string TEXT, value_number BIGINT, value_boolean BOOLEAN, value_json JSONB, description TEXT, updated_at TIMESTAMPTZ, updated_by UUID
    ) LOOP
        INSERT INTO public.system_settings (key, value_type, value_string, value_number, value_boolean, value_json, description, updated_at, updated_by)
        VALUES (v_rec.key, v_rec.value_type, v_rec.value_string, v_rec.value_number, v_rec.value_boolean, v_rec.value_json, v_rec.description, COALESCE(v_rec.updated_at, NOW()), v_rec.updated_by);
    END LOOP;

    -- Restore Customers
    FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'customers') AS x(
        id UUID, name VARCHAR(200), phone VARCHAR(50), status VARCHAR(20), is_active BOOLEAN, notes TEXT, debt_limit_minor BIGINT, charger_fee_exempt BOOLEAN, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, version INTEGER
    ) LOOP
        INSERT INTO public.customers (id, name, phone, status, is_active, notes, debt_limit_minor, charger_fee_exempt, created_at, updated_at, deleted_at, version)
        VALUES (v_rec.id, v_rec.name, v_rec.phone, v_rec.status, v_rec.is_active, v_rec.notes, v_rec.debt_limit_minor, v_rec.charger_fee_exempt, v_rec.created_at, v_rec.updated_at, v_rec.deleted_at, v_rec.version);
    END LOOP;

    -- Restore Device Types
    FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'deviceTypes') AS x(
        id UUID, name VARCHAR(200), name_ar VARCHAR(200), name_en VARCHAR(200), icon VARCHAR(50), base_price_minor BIGINT, charger_fee_enabled BOOLEAN, charger_fee_applicable BOOLEAN, is_active BOOLEAN, status VARCHAR(20), sort_order INTEGER, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, version INTEGER
    ) LOOP
        INSERT INTO public.device_types (id, name, name_ar, name_en, icon, base_price_minor, charger_fee_enabled, charger_fee_applicable, is_active, status, sort_order, created_at, updated_at, deleted_at, version)
        VALUES (v_rec.id, v_rec.name, v_rec.name_ar, v_rec.name_en, v_rec.icon, v_rec.base_price_minor, v_rec.charger_fee_enabled, v_rec.charger_fee_applicable, v_rec.is_active, v_rec.status, v_rec.sort_order, v_rec.created_at, v_rec.updated_at, v_rec.deleted_at, v_rec.version);
    END LOOP;

    -- Restore Business Days
    FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'businessDays') AS x(
        id UUID, business_date DATE, display_number INTEGER, status VARCHAR(20), is_closed BOOLEAN, opened_at TIMESTAMPTZ, closed_at TIMESTAMPTZ, closed_by UUID, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, version INTEGER
    ) LOOP
        INSERT INTO public.business_days (id, business_date, display_number, status, is_closed, opened_at, closed_at, closed_by, created_at, updated_at, version)
        VALUES (v_rec.id, v_rec.business_date, v_rec.display_number, v_rec.status, v_rec.is_closed, v_rec.opened_at, v_rec.closed_at, v_rec.closed_by, v_rec.created_at, v_rec.updated_at, v_rec.version);
    END LOOP;

    -- Restore Orders
    FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'orders') AS x(
        id UUID, day_id UUID, customer_id UUID, display_number INTEGER, status VARCHAR(20), notes TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, version INTEGER
    ) LOOP
        INSERT INTO public.orders (id, day_id, customer_id, display_number, status, notes, created_at, updated_at, deleted_at, version)
        VALUES (v_rec.id, v_rec.day_id, v_rec.customer_id, v_rec.display_number, v_rec.status::order_status, v_rec.notes, v_rec.created_at, v_rec.updated_at, v_rec.deleted_at, v_rec.version);
    END LOOP;

    -- Restore Order Items
    FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'orderItems') AS x(
        id UUID, order_id UUID, device_type_id UUID, item_sequence INTEGER, operational_status VARCHAR(20), financial_status VARCHAR(20), payment_status VARCHAR(20), status VARCHAR(20), device_name_snapshot VARCHAR(150), device_icon_snapshot VARCHAR(100), base_price_snapshot_minor BIGINT, charger_fee_snapshot_minor BIGINT, discount_snapshot_minor BIGINT, final_charge_snapshot_minor BIGINT, unit_price_minor BIGINT, total_price_minor BIGINT, has_charger BOOLEAN, charger_fee_enabled_snapshot BOOLEAN, customer_charger_fee_exempt_snapshot BOOLEAN, delivered_at TIMESTAMPTZ, financially_recognized_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ, replacement_of_item_id UUID, notes TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, version INTEGER
    ) LOOP
        INSERT INTO public.order_items (id, order_id, device_type_id, item_sequence, operational_status, financial_status, payment_status, status, device_name_snapshot, device_icon_snapshot, base_price_snapshot_minor, charger_fee_snapshot_minor, discount_snapshot_minor, final_charge_snapshot_minor, unit_price_minor, total_price_minor, has_charger, charger_fee_enabled_snapshot, customer_charger_fee_exempt_snapshot, delivered_at, financially_recognized_at, cancelled_at, replacement_of_item_id, notes, created_at, updated_at, deleted_at, version)
        VALUES (v_rec.id, v_rec.order_id, v_rec.device_type_id, v_rec.item_sequence, v_rec.operational_status, v_rec.financial_status, v_rec.payment_status, v_rec.status::item_status, v_rec.device_name_snapshot, v_rec.device_icon_snapshot, v_rec.base_price_snapshot_minor, v_rec.charger_fee_snapshot_minor, v_rec.discount_snapshot_minor, v_rec.final_charge_snapshot_minor, v_rec.unit_price_minor, v_rec.total_price_minor, v_rec.has_charger, v_rec.charger_fee_enabled_snapshot, v_rec.customer_charger_fee_exempt_snapshot, v_rec.delivered_at, v_rec.financially_recognized_at, v_rec.cancelled_at, v_rec.replacement_of_item_id, v_rec.notes, v_rec.created_at, v_rec.updated_at, v_rec.deleted_at, v_rec.version);
    END LOOP;

    -- Restore Payments
    FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'payments') AS x(
        id UUID, customer_id UUID, amount_minor BIGINT, payment_method VARCHAR(50), reference TEXT, actor_admin_id UUID, command_id UUID, created_at TIMESTAMPTZ
    ) LOOP
        INSERT INTO public.payments (id, customer_id, amount_minor, payment_method, reference, actor_admin_id, command_id, created_at)
        VALUES (v_rec.id, v_rec.customer_id, v_rec.amount_minor, v_rec.payment_method, v_rec.reference, v_rec.actor_admin_id, v_rec.command_id, v_rec.created_at);
    END LOOP;

    -- Restore Payment Allocations
    FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'paymentAllocations') AS x(
        id UUID, payment_id UUID, order_item_id UUID, order_id UUID, allocated_amount_minor BIGINT, created_at TIMESTAMPTZ
    ) LOOP
        INSERT INTO public.payment_allocations (id, payment_id, order_item_id, order_id, allocated_amount_minor, created_at)
        VALUES (v_rec.id, v_rec.payment_id, v_rec.order_item_id, v_rec.order_id, v_rec.allocated_amount_minor, v_rec.created_at);
    END LOOP;

    -- Restore Financial Ledger
    FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'financialLedger') AS x(
        id UUID, sequence_number BIGINT, event_type VARCHAR(30), amount_minor BIGINT, order_id UUID, order_item_id UUID, customer_id UUID, actor_admin_id UUID, reference_id UUID, linked_ledger_id UUID, metadata JSONB, created_at TIMESTAMPTZ
    ) LOOP
        INSERT INTO public.financial_ledger (id, sequence_number, event_type, amount_minor, order_id, order_item_id, customer_id, actor_admin_id, reference_id, linked_ledger_id, metadata, created_at)
        VALUES (v_rec.id, v_rec.sequence_number, v_rec.event_type::ledger_event_type, v_rec.amount_minor, v_rec.order_id, v_rec.order_item_id, v_rec.customer_id, v_rec.actor_admin_id, v_rec.reference_id, v_rec.linked_ledger_id, v_rec.metadata, v_rec.created_at);
    END LOOP;

    -- Restore Goals (if present in snapshot)
    IF v_chk.snapshot_data ? 'goals' AND v_chk.snapshot_data->'goals' IS NOT NULL THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'goals') AS x(
            id UUID, customer_id UUID, target_quantity INTEGER, current_progress INTEGER, bonus_amount_minor BIGINT, duration_days INTEGER, status VARCHAR(20), started_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, bonus_ledger_id UUID, version INTEGER, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
        ) LOOP
            INSERT INTO public.goals (id, customer_id, target_quantity, current_progress, bonus_amount_minor, duration_days, status, started_at, expires_at, completed_at, bonus_ledger_id, version, created_at, updated_at)
            VALUES (v_rec.id, v_rec.customer_id, v_rec.target_quantity, v_rec.current_progress, v_rec.bonus_amount_minor, v_rec.duration_days, v_rec.status, v_rec.started_at, v_rec.expires_at, v_rec.completed_at, v_rec.bonus_ledger_id, v_rec.version, v_rec.created_at, v_rec.updated_at);
        END LOOP;
    END IF;

    -- Restore Goal Requests (if present in snapshot)
    IF v_chk.snapshot_data ? 'goalRequests' AND v_chk.snapshot_data->'goalRequests' IS NOT NULL THEN
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

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
