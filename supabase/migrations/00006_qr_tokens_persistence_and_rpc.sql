/**
 * Supabase Migration: 00006_qr_tokens_persistence_and_rpc.sql
 * Phase 6.5.2: Secure QR Token Persistence & Public Lookup
 *
 * 1. Enables Row Level Security (RLS) on `qr_tokens`.
 * 2. Explicitly restricts direct SELECT/INSERT/UPDATE to authenticated admins and forbids anon access.
 * 3. Adds partial indexes for fast token_hash and active target resolution.
 * 4. Provides `public_resolve_customer_qr(p_token_hash)` SECURITY DEFINER RPC for public /c/:token lookup.
 *    - Validates token active status and non-expiration.
 *    - Resolves customer name and customer code only.
 *    - Zero exposure of internal UUID, phone number, financial ledger, or order history.
 * 5. Provides `create_or_get_customer_qr_token` RPC for authenticated admin QR issuance.
 */

-- ==========================================
-- 1. ENABLE ROW LEVEL SECURITY ON qr_tokens
-- ==========================================
ALTER TABLE qr_tokens ENABLE ROW LEVEL SECURITY;

-- Revoke all direct privileges on qr_tokens from the public anon role
REVOKE ALL ON qr_tokens FROM anon;

-- Grant selective privileges to authenticated role
GRANT SELECT, INSERT, UPDATE ON qr_tokens TO authenticated;

-- ==========================================
-- 2. RLS POLICIES FOR qr_tokens
-- ==========================================

-- Strictly deny all direct table operations by anonymous users
DROP POLICY IF EXISTS "Deny direct public anon access to qr_tokens" ON qr_tokens;
CREATE POLICY "Deny direct public anon access to qr_tokens"
ON qr_tokens
FOR ALL
TO anon
USING (false);

-- Allow authenticated users (Admins / Operators) to view QR tokens
DROP POLICY IF EXISTS "Allow authenticated view of qr_tokens" ON qr_tokens;
CREATE POLICY "Allow authenticated view of qr_tokens"
ON qr_tokens
FOR SELECT
TO authenticated
USING (true);

-- Allow authenticated users to insert new QR tokens
DROP POLICY IF EXISTS "Allow authenticated insert of qr_tokens" ON qr_tokens;
CREATE POLICY "Allow authenticated insert of qr_tokens"
ON qr_tokens
FOR INSERT
TO authenticated
WITH CHECK (true);

-- Allow authenticated users to update QR token status (e.g. deactivate)
DROP POLICY IF EXISTS "Allow authenticated update of qr_tokens" ON qr_tokens;
CREATE POLICY "Allow authenticated update of qr_tokens"
ON qr_tokens
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

-- ==========================================
-- 3. PERFORMANCE INDEXES
-- ==========================================

-- Fast lookup for active tokens by their SHA-256 hash
CREATE INDEX IF NOT EXISTS idx_qr_tokens_hash_active 
ON qr_tokens (token_hash) 
WHERE is_active = TRUE;

-- Fast target resolution for active tokens
CREATE INDEX IF NOT EXISTS idx_qr_tokens_target_active 
ON qr_tokens (target_id, token_type, is_active);

-- ==========================================
-- 4. DETERMINISTIC CUSTOMER CODE DERIVATION
-- ==========================================
CREATE OR REPLACE FUNCTION derive_customer_code(p_customer_id UUID)
RETURNS VARCHAR(10) AS $$
DECLARE
    v_id_str TEXT;
BEGIN
    v_id_str := REPLACE(p_customer_id::TEXT, '-', '');
    RETURN UPPER(SUBSTRING(v_id_str FROM 1 FOR 4));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ==========================================
-- 5. SECURE PUBLIC LOOKUP RPC
-- ==========================================
/**
 * public_resolve_customer_qr
 * Invoked by public read-only page (/c/:token) after computing SHA-256(rawToken).
 * Strictly returns only customer_name and customer_code.
 * Never leaks internal customer UUID, phone, debt, ledger, or orders.
 */
CREATE OR REPLACE FUNCTION public_resolve_customer_qr(p_token_hash TEXT)
RETURNS TABLE (
    customer_name VARCHAR(200),
    customer_code VARCHAR(10)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_target_id UUID;
    v_customer_record RECORD;
BEGIN
    -- 1. Validate that the token hash exists, is active, is for a CUSTOMER, and has not expired
    SELECT target_id INTO v_target_id
    FROM qr_tokens
    WHERE token_hash = p_token_hash
      AND token_type = 'CUSTOMER'
      AND is_active = TRUE
      AND (expires_at IS NULL OR expires_at > NOW())
    LIMIT 1;

    IF v_target_id IS NULL THEN
        RETURN;
    END IF;

    -- 2. Lookup the corresponding customer, verifying the customer is active
    SELECT id, name INTO v_customer_record
    FROM customers
    WHERE id = v_target_id
      AND is_active = TRUE;

    IF v_customer_record.id IS NULL THEN
        RETURN;
    END IF;

    -- 3. Return sanitized, public-safe read model
    RETURN QUERY
    SELECT 
        v_customer_record.name::VARCHAR(200) AS customer_name,
        derive_customer_code(v_customer_record.id) AS customer_code;
END;
$$;

-- Grant EXECUTE to public anon and authenticated users
GRANT EXECUTE ON FUNCTION public_resolve_customer_qr(TEXT) TO anon, authenticated;

-- ==========================================
-- 6. AUTHENTICATED QR TOKEN ISSUANCE RPC
-- ==========================================
/**
 * create_or_get_customer_qr_token
 * Allows authenticated admin/operator to register a newly generated SHA-256 token_hash
 * for a customer, deactivating any previous active tokens for that customer.
 */
CREATE OR REPLACE FUNCTION create_or_get_customer_qr_token(
    p_customer_id UUID,
    p_token_hash TEXT
)
RETURNS TABLE (
    id UUID,
    token_hash VARCHAR(255),
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Verify customer exists and is active
    IF NOT EXISTS (SELECT 1 FROM customers WHERE id = p_customer_id AND is_active = TRUE) THEN
        RAISE EXCEPTION 'Customer not found or inactive';
    END IF;

    -- Deactivate any previously active CUSTOMER tokens for this customer
    UPDATE qr_tokens
    SET is_active = FALSE
    WHERE target_id = p_customer_id
      AND token_type = 'CUSTOMER'
      AND is_active = TRUE
      AND qr_tokens.token_hash != p_token_hash;

    -- Insert new token record (or re-activate if existing hash)
    INSERT INTO qr_tokens (token_hash, token_type, target_id, is_active, created_at)
    VALUES (p_token_hash, 'CUSTOMER', p_customer_id, TRUE, NOW())
    ON CONFLICT (token_hash) DO UPDATE
    SET is_active = TRUE;

    -- Return the registered record
    RETURN QUERY
    SELECT qt.id, qt.token_hash, qt.created_at
    FROM qr_tokens qt
    WHERE qt.token_hash = p_token_hash;
END;
$$;

GRANT EXECUTE ON FUNCTION create_or_get_customer_qr_token(UUID, TEXT) TO authenticated;
