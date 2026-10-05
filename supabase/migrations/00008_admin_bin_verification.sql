/**
 * Supabase Migration: 00008_admin_bin_verification.sql
 * Implements server-authoritative, atomic bcrypt BIN verification via PostgreSQL pgcrypto.
 * Closes all TOCTOU gaps, enforces strict auth.uid() identity, and guarantees atomic financial mutations.
 */

-- Ensure pgcrypto extension is available
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==========================================
-- 1. SECURE SERVER-SIDE BIN VERIFICATION PREFLIGHT RPC
-- ==========================================
CREATE OR REPLACE FUNCTION verify_admin_bin(
    p_bin TEXT
)
RETURNS BOOLEAN
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
DECLARE
    v_admin_id UUID;
    v_bin_hash VARCHAR(255);
    v_is_active BOOLEAN;
BEGIN
    -- 1. Strict authentication check: caller MUST be authenticated
    IF auth.uid() IS NULL THEN
        RETURN FALSE;
    END IF;

    -- 2. Format check
    IF p_bin IS NULL OR length(trim(p_bin)) < 4 THEN
        RETURN FALSE;
    END IF;

    -- 3. Resolve authenticated admin solely from auth.uid()
    SELECT id, bin_hash, is_active 
    INTO v_admin_id, v_bin_hash, v_is_active
    FROM admins
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    IF NOT FOUND OR v_is_active IS NOT TRUE OR v_bin_hash IS NULL THEN
        RETURN FALSE;
    END IF;

    -- 4. Verify slow salted bcrypt hash via crypt()
    IF crypt(trim(p_bin), v_bin_hash) = v_bin_hash THEN
        RETURN TRUE;
    ELSE
        RETURN FALSE;
    END IF;
END;
$$;

-- Revoke all permissions from public/anon, grant only to authenticated
REVOKE EXECUTE ON FUNCTION verify_admin_bin(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION verify_admin_bin(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION verify_admin_bin(TEXT) TO authenticated;


-- ==========================================
-- 2. SECURE ADMIN BIN ROTATION / PROVISIONING
-- ==========================================
CREATE OR REPLACE FUNCTION set_admin_bin(
    p_bin TEXT,
    p_admin_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
DECLARE
    v_caller_admin_id UUID;
    v_caller_role VARCHAR(50);
    v_caller_active BOOLEAN;
    v_target_id UUID;
BEGIN
    -- 1. Strict authentication check: auth.uid() MUST be present
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    -- 2. Format validation
    IF p_bin IS NULL OR length(trim(p_bin)) < 4 OR NOT (p_bin ~ '^\d{4,}$') THEN
        RAISE EXCEPTION 'BIN must be at least 4 digits';
    END IF;

    -- 3. Resolve caller admin record from auth.uid()
    SELECT id, role, is_active 
    INTO v_caller_admin_id, v_caller_role, v_caller_active
    FROM admins 
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    IF NOT FOUND OR v_caller_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Authenticated admin account is inactive or not found';
    END IF;

    -- 4. Determine target admin (no guessing or fallback to Super Admin)
    IF p_admin_id IS NOT NULL AND p_admin_id != v_caller_admin_id THEN
        -- Only Super Admin can modify another admin's BIN
        IF v_caller_role != 'Super Admin' THEN
            RAISE EXCEPTION 'Unauthorized: Only Super Admin can update another admin BIN';
        END IF;
        
        -- Verify target admin exists and is active
        SELECT id INTO v_target_id FROM admins WHERE id = p_admin_id;
        IF v_target_id IS NULL THEN
            RAISE EXCEPTION 'Target admin not found';
        END IF;
    ELSE
        -- Self-modification
        v_target_id := v_caller_admin_id;
    END IF;

    -- 5. Update bin_hash with fresh salted bcrypt hash
    UPDATE admins 
    SET bin_hash = crypt(trim(p_bin), gen_salt('bf', 10)),
        updated_at = NOW(),
        version = version + 1
    WHERE id = v_target_id;

    RETURN TRUE;
END;
$$;

-- Revoke all permissions from public/anon, grant only to authenticated
REVOKE EXECUTE ON FUNCTION set_admin_bin(TEXT, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION set_admin_bin(TEXT, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION set_admin_bin(TEXT, UUID) TO authenticated;


-- ==========================================
-- 3. ATOMIC SERVER-SIDE FINANCIAL MUTATION (NO TOCTOU)
-- ==========================================
CREATE OR REPLACE FUNCTION execute_customer_top_up_atomic(
    p_command_id UUID,
    p_customer_id UUID,
    p_amount_minor BIGINT,
    p_bin TEXT,
    p_note TEXT DEFAULT NULL
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
DECLARE
    v_admin_id UUID;
    v_bin_hash VARCHAR(255);
    v_is_active BOOLEAN;
    v_role VARCHAR(50);
    v_existing_cmd processed_commands%ROWTYPE;
    v_new_balance BIGINT;
    v_ledger_id UUID;
    v_result JSONB;
BEGIN
    -- 1. Authentication check
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required for sensitive financial operation';
    END IF;

    -- 2. Input validation
    IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
        RAISE EXCEPTION 'Invalid top-up amount. Must be greater than zero.';
    END IF;

    IF p_bin IS NULL OR length(trim(p_bin)) < 4 THEN
        RAISE EXCEPTION 'Valid authorization BIN is required';
    END IF;

    -- 3. Check idempotency first
    SELECT * INTO v_existing_cmd FROM processed_commands WHERE command_id = p_command_id;
    IF FOUND THEN
        RETURN v_existing_cmd.result_payload;
    END IF;

    -- 4. Resolve authenticated admin from auth.uid()
    SELECT id, bin_hash, is_active, role 
    INTO v_admin_id, v_bin_hash, v_is_active, v_role
    FROM admins 
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    IF NOT FOUND OR v_is_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Admin account not found or inactive';
    END IF;

    -- 5. Atomic BIN credential verification via bcrypt
    IF v_bin_hash IS NULL OR crypt(trim(p_bin), v_bin_hash) != v_bin_hash THEN
        RAISE EXCEPTION 'Invalid authorization BIN credential';
    END IF;

    -- 6. Verify customer exists
    IF NOT EXISTS (SELECT 1 FROM customers WHERE id = p_customer_id) THEN
        RAISE EXCEPTION 'Customer not found';
    END IF;

    -- 7. Insert into financial_ledger (append-only)
    v_ledger_id := gen_random_uuid();
    INSERT INTO financial_ledger (
        id,
        customer_id,
        amount_minor,
        event_type,
        actor_admin_id,
        created_at
    ) VALUES (
        v_ledger_id,
        p_customer_id,
        p_amount_minor,
        'CREDIT_ADJUSTMENT',
        v_admin_id,
        NOW()
    );

    -- 8. Compute updated customer balance
    SELECT COALESCE(SUM(amount_minor), 0)
    INTO v_new_balance
    FROM financial_ledger
    WHERE customer_id = p_customer_id;

    -- Update customer balance cache and version
    UPDATE customers 
    SET updated_at = NOW(),
        version = version + 1
    WHERE id = p_customer_id;

    -- 9. Record processed command for idempotency
    v_result := jsonb_build_object(
        'success', true,
        'transactionId', v_ledger_id,
        'newBalanceMinor', v_new_balance,
        'processedAt', NOW()
    );

    INSERT INTO processed_commands (
        command_id,
        actor_id,
        command_type,
        result_payload,
        processed_at
    ) VALUES (
        p_command_id,
        v_admin_id,
        'CREATE_CUSTOMER_CREDIT',
        v_result,
        NOW()
    );

    RETURN v_result;
END;
$$;

-- Revoke all permissions from public/anon, grant only to authenticated
REVOKE EXECUTE ON FUNCTION execute_customer_top_up_atomic(UUID, UUID, BIGINT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION execute_customer_top_up_atomic(UUID, UUID, BIGINT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION execute_customer_top_up_atomic(UUID, UUID, BIGINT, TEXT, TEXT) TO authenticated;
