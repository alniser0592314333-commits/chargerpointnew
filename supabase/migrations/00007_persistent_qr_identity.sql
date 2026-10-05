/**
 * Supabase Migration: 00007_persistent_qr_identity.sql
 * Phase 6.5.2B: Persistent Random Public Capability Handle (Option C)
 *
 * Eliminates the device-bound ephemeral raw token model.
 * Establishes a permanent, central, high-entropy 128-bit public capability identifier
 * (`public_token`) stored directly in PostgreSQL with strict active uniqueness.
 *
 * 1. Adds `public_token` column to `qr_tokens` table.
 * 2. Enforces a PostgreSQL partial unique index guaranteeing exactly ONE active token per target entity.
 * 3. Provides `get_or_create_customer_qr(p_customer_id UUID)`:
 *    - Idempotent: Returns the existing active public_token if one exists.
 *    - Atomic & Concurrency-Safe: Uses INSERT ... ON CONFLICT to prevent race conditions.
 *    - Admin-only (Authenticated).
 * 4. Provides `rotate_customer_qr(p_customer_id UUID)` for explicit administrative rotation.
 * 5. Provides `get_or_create_order_qr(p_order_id UUID)` for future Order QR readiness.
 * 6. Updates `public_resolve_customer_qr(p_public_token TEXT)`:
 *    - SECURITY DEFINER with search_path = public.
 *    - Resolves customer by public_token.
 *    - Enforces customer active check (generic 404 / unavailable on inactive customer).
 *    - Returns only customer_name and customer_code (zero leak of internal UUID, phone, debt, orders).
 */

-- ==========================================
-- 1. ADD public_token COLUMN AND INDEXES
-- ==========================================

ALTER TABLE qr_tokens 
ADD COLUMN IF NOT EXISTS public_token VARCHAR(64) UNIQUE;

-- Backfill public_token from token_hash for existing records if any
UPDATE qr_tokens 
SET public_token = token_hash 
WHERE public_token IS NULL;

-- Enforce NOT NULL on public_token
ALTER TABLE qr_tokens 
ALTER COLUMN public_token SET NOT NULL;

-- Create fast lookup index on public_token
CREATE INDEX IF NOT EXISTS idx_qr_tokens_public_token 
ON qr_tokens(public_token);

-- Enforce exactly ONE active QR token per entity (customer or order) at database level
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_qr_token 
ON qr_tokens (target_id, token_type) 
WHERE is_active = TRUE;

-- ==========================================
-- 2. SECURE PUBLIC RESOLVER RPC
-- ==========================================

DROP FUNCTION IF EXISTS public_resolve_customer_qr(TEXT);
CREATE OR REPLACE FUNCTION public_resolve_customer_qr(p_public_token TEXT)
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
    v_customer RECORD;
BEGIN
    -- 1. Find active, non-expired customer QR token by public_token (or token_hash for backward compatibility)
    SELECT target_id INTO v_target_id
    FROM qr_tokens
    WHERE (public_token = p_public_token OR token_hash = p_public_token)
      AND token_type = 'CUSTOMER'
      AND is_active = TRUE
      AND (expires_at IS NULL OR expires_at > NOW())
    LIMIT 1;

    IF v_target_id IS NULL THEN
        RETURN;
    END IF;

    -- 2. Lookup customer ensuring customer is active and not soft-deleted
    SELECT id, name INTO v_customer
    FROM customers
    WHERE id = v_target_id
      AND is_active = TRUE;

    -- If customer is inactive or not found, return empty set (generic 404 behavior, zero data leakage)
    IF v_customer.id IS NULL THEN
        RETURN;
    END IF;

    -- 3. Return sanitized public read model
    RETURN QUERY
    SELECT 
        v_customer.name::VARCHAR(200) AS customer_name,
        derive_customer_code(v_customer.id) AS customer_code;
END;
$$;

-- Public anon and authenticated users can execute the public resolver
REVOKE ALL ON FUNCTION public_resolve_customer_qr(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_resolve_customer_qr(TEXT) TO anon, authenticated;

-- ==========================================
-- 3. IDEMPOTENT GET-OR-CREATE CUSTOMER QR RPC
-- ==========================================

CREATE OR REPLACE FUNCTION get_or_create_customer_qr(p_customer_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_existing_token TEXT;
    v_new_token TEXT;
BEGIN
    -- 1. Verify customer exists
    IF NOT EXISTS (SELECT 1 FROM customers WHERE id = p_customer_id) THEN
        RAISE EXCEPTION 'Customer not found';
    END IF;

    -- 2. Check for an already active token for this customer (Idempotent / Stable across all devices)
    SELECT public_token INTO v_existing_token
    FROM qr_tokens
    WHERE target_id = p_customer_id
      AND token_type = 'CUSTOMER'
      AND is_active = TRUE
    LIMIT 1;

    IF v_existing_token IS NOT NULL THEN
        RETURN v_existing_token;
    END IF;

    -- 3. Atomically generate a 128-bit cryptographically secure random identifier (32 hex characters)
    v_new_token := encode(gen_random_bytes(16), 'hex');

    -- Insert with concurrency collision protection
    INSERT INTO qr_tokens (
        token_hash,
        public_token,
        token_type,
        target_id,
        is_active,
        created_at
    )
    VALUES (
        v_new_token,
        v_new_token,
        'CUSTOMER',
        p_customer_id,
        TRUE,
        NOW()
    )
    ON CONFLICT (target_id, token_type) WHERE is_active = TRUE
    DO NOTHING;

    -- 4. Return the active token (handles concurrent race condition where another transaction inserted first)
    SELECT public_token INTO v_existing_token
    FROM qr_tokens
    WHERE target_id = p_customer_id
      AND token_type = 'CUSTOMER'
      AND is_active = TRUE
    LIMIT 1;

    RETURN v_existing_token;
END;
$$;

REVOKE ALL ON FUNCTION get_or_create_customer_qr(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_or_create_customer_qr(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION get_or_create_customer_qr(UUID) TO authenticated;

-- ==========================================
-- 4. EXPLICIT CUSTOMER QR ROTATION RPC
-- ==========================================

CREATE OR REPLACE FUNCTION rotate_customer_qr(p_customer_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_new_token TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM customers WHERE id = p_customer_id) THEN
        RAISE EXCEPTION 'Customer not found';
    END IF;

    -- Deactivate current active token
    UPDATE qr_tokens
    SET is_active = FALSE
    WHERE target_id = p_customer_id
      AND token_type = 'CUSTOMER'
      AND is_active = TRUE;

    -- Generate new 128-bit identifier
    v_new_token := encode(gen_random_bytes(16), 'hex');

    INSERT INTO qr_tokens (
        token_hash,
        public_token,
        token_type,
        target_id,
        is_active,
        created_at
    )
    VALUES (
        v_new_token,
        v_new_token,
        'CUSTOMER',
        p_customer_id,
        TRUE,
        NOW()
    );

    RETURN v_new_token;
END;
$$;

REVOKE ALL ON FUNCTION rotate_customer_qr(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rotate_customer_qr(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION rotate_customer_qr(UUID) TO authenticated;

-- ==========================================
-- 5. ORDER QR READINESS RPC
-- ==========================================

CREATE OR REPLACE FUNCTION get_or_create_order_qr(p_order_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_existing_token TEXT;
    v_new_token TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM orders WHERE id = p_order_id) THEN
        RAISE EXCEPTION 'Order not found';
    END IF;

    SELECT public_token INTO v_existing_token
    FROM qr_tokens
    WHERE target_id = p_order_id
      AND token_type = 'ORDER'
      AND is_active = TRUE
    LIMIT 1;

    IF v_existing_token IS NOT NULL THEN
        RETURN v_existing_token;
    END IF;

    v_new_token := encode(gen_random_bytes(16), 'hex');

    INSERT INTO qr_tokens (
        token_hash,
        public_token,
        token_type,
        target_id,
        is_active,
        created_at
    )
    VALUES (
        v_new_token,
        v_new_token,
        'ORDER',
        p_order_id,
        TRUE,
        NOW()
    )
    ON CONFLICT (target_id, token_type) WHERE is_active = TRUE
    DO NOTHING;

    SELECT public_token INTO v_existing_token
    FROM qr_tokens
    WHERE target_id = p_order_id
      AND token_type = 'ORDER'
      AND is_active = TRUE
    LIMIT 1;

    RETURN v_existing_token;
END;
$$;

REVOKE ALL ON FUNCTION get_or_create_order_qr(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_or_create_order_qr(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION get_or_create_order_qr(UUID) TO authenticated;
