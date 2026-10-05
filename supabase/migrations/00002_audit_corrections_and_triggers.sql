/**
 * Supabase Corrective Migration: 00002_audit_corrections_and_triggers.sql
 * Implements strict database-level immutability for financial_ledger,
 * corrects foreign key constraints (removing ON DELETE CASCADE for historical items),
 * and adds audit safety mechanisms.
 */

-- ==========================================
-- 1. FINANCIAL LEDGER IMMUTABILITY (TRIGGER & FUNCTION)
-- ==========================================

CREATE OR REPLACE FUNCTION prevent_ledger_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Financial ledger records are strictly immutable. UPDATE and DELETE operations are prohibited.';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_ledger_update ON financial_ledger;
CREATE TRIGGER trg_prevent_ledger_update
    BEFORE UPDATE ON financial_ledger
    FOR EACH ROW
    EXECUTE FUNCTION prevent_ledger_modification();

DROP TRIGGER IF EXISTS trg_prevent_ledger_delete ON financial_ledger;
CREATE TRIGGER trg_prevent_ledger_delete
    BEFORE DELETE ON financial_ledger
    FOR EACH ROW
    EXECUTE FUNCTION prevent_ledger_modification();

-- ==========================================
-- 2. CORRECT ORDER_ITEMS FOREIGN KEY (REMOVE CASCADE)
-- ==========================================

-- Drop existing foreign key constraint if it exists with cascade
ALTER TABLE order_items 
    DROP CONSTRAINT IF EXISTS order_items_order_id_fkey;

-- Re-add foreign key with RESTRICT to prevent destructive deletion of historical financial items
ALTER TABLE order_items 
    ADD CONSTRAINT order_items_order_id_fkey 
    FOREIGN KEY (order_id) 
    REFERENCES orders(id) 
    ON DELETE RESTRICT;

-- Ensure customer and order foreign keys are also non-destructive
ALTER TABLE orders 
    DROP CONSTRAINT IF EXISTS orders_customer_id_fkey;

ALTER TABLE orders 
    ADD CONSTRAINT orders_customer_id_fkey 
    FOREIGN KEY (customer_id) 
    REFERENCES customers(id) 
    ON DELETE RESTRICT;

ALTER TABLE orders 
    DROP CONSTRAINT IF EXISTS orders_day_id_fkey;

ALTER TABLE orders 
    ADD CONSTRAINT orders_day_id_fkey 
    FOREIGN KEY (day_id) 
    REFERENCES business_days(id) 
    ON DELETE RESTRICT;

-- ==========================================
-- 3. ENABLE ROW LEVEL SECURITY (RLS) STUB FOUNDATION
-- ==========================================

ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_conflicts ENABLE ROW LEVEL SECURITY;

-- Note: RLS policies in production should restrict client access directly to sensitive ledger/admin tables,
-- forcing mutations through secure server-side RPC / API handlers or authenticated role policies.
