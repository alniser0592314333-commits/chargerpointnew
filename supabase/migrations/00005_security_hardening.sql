/**
 * Supabase Migration: 00005_security_hardening.sql
 * Enforces strict DB-level security constraints:
 * - Single Super Admin partial unique index (race condition proof)
 * - Append-only financial ledger trigger (prevent ledger updates/deletes even by Super Admin)
 * - Audit log integrity trigger (server-generated audit records)
 */

-- ==========================================
-- 1. SUPER ADMIN RACE CONDITION PROOF INDEX
-- ==========================================
-- Ensure at the database engine level that only one 'Super Admin' can exist
DROP INDEX IF EXISTS idx_single_super_admin;
CREATE UNIQUE INDEX idx_single_super_admin ON admins ((role = 'Super Admin')) WHERE role = 'Super Admin';

-- ==========================================
-- 2. FINANCIAL LEDGER IMMUTABILITY TRIGGER
-- ==========================================
CREATE OR REPLACE FUNCTION prevent_ledger_tampering()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Financial ledger is append-only. Updates and deletions are strictly prohibited, including for Super Admins.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_ledger_tampering ON financial_ledger;
CREATE TRIGGER trg_prevent_ledger_tampering
    BEFORE UPDATE OR DELETE ON financial_ledger
    FOR EACH ROW
    EXECUTE FUNCTION prevent_ledger_tampering();

-- ==========================================
-- 3. AUDIT LOG INTEGRITY TRIGGER
-- ==========================================
CREATE OR REPLACE FUNCTION protect_audit_logs()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'UPDATE' OR TG_OP = 'DELETE') THEN
        RAISE EXCEPTION 'Audit logs are immutable and cannot be modified or deleted.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_audit_logs ON audit_logs;
CREATE TRIGGER trg_protect_audit_logs
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION protect_audit_logs();
