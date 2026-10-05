-- Migration 00041: Public Resolve Order QR RPC & Safe Token Generation
-- Strictly read-only, publicly accessible capability lookup for order tokens

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

    -- Standard core 128-bit hex token without external pgcrypto dependency
    v_new_token := replace(gen_random_uuid()::text, '-', '');

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

GRANT EXECUTE ON FUNCTION get_or_create_order_qr(UUID) TO anon, authenticated;

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
    IF NOT EXISTS (SELECT 1 FROM customers WHERE id = p_customer_id) THEN
        RAISE EXCEPTION 'Customer not found';
    END IF;

    SELECT public_token INTO v_existing_token
    FROM qr_tokens
    WHERE target_id = p_customer_id
      AND token_type = 'CUSTOMER'
      AND is_active = TRUE
    LIMIT 1;

    IF v_existing_token IS NOT NULL THEN
        RETURN v_existing_token;
    END IF;

    v_new_token := replace(gen_random_uuid()::text, '-', '');

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

    SELECT public_token INTO v_existing_token
    FROM qr_tokens
    WHERE target_id = p_customer_id
      AND token_type = 'CUSTOMER'
      AND is_active = TRUE
    LIMIT 1;

    RETURN v_existing_token;
END;
$$;

GRANT EXECUTE ON FUNCTION get_or_create_customer_qr(UUID) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public_resolve_order_qr(p_public_token TEXT)
RETURNS TABLE (
    order_id UUID,
    order_number INTEGER,
    customer_name VARCHAR(200),
    status TEXT,
    created_at TIMESTAMPTZ,
    items_count INTEGER,
    items JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_order_id UUID;
    v_order RECORD;
    v_customer RECORD;
    v_items JSONB;
    v_items_count INTEGER;
BEGIN
    -- 1. Find active, non-expired order QR token by public_token (or token_hash)
    SELECT qt.target_id INTO v_order_id
    FROM qr_tokens qt
    WHERE (qt.public_token = p_public_token OR qt.token_hash = p_public_token)
      AND qt.token_type = 'ORDER'
      AND qt.is_active = TRUE
      AND (qt.expires_at IS NULL OR qt.expires_at > NOW())
    LIMIT 1;

    IF v_order_id IS NULL THEN
        RETURN;
    END IF;

    -- 2. Lookup order ensuring order is not soft-deleted
    SELECT o.id, o.display_number, o.status, o.customer_id, o.created_at
    INTO v_order
    FROM orders o
    WHERE o.id = v_order_id
      AND o.deleted_at IS NULL;

    IF v_order.id IS NULL THEN
        RETURN;
    END IF;

    -- 3. Lookup customer name
    SELECT c.id, c.name INTO v_customer
    FROM customers c
    WHERE c.id = v_order.customer_id;

    -- 4. Aggregate items safely (read-only, sanitized)
    SELECT 
        COUNT(*)::INTEGER,
        COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'name', oi.device_name_snapshot,
                    'status', oi.status,
                    'has_charger', oi.has_charger
                ) ORDER BY oi.item_sequence
            ),
            '[]'::jsonb
        )
    INTO v_items_count, v_items
    FROM order_items oi
    WHERE oi.order_id = v_order.id;

    -- 5. Return sanitized public read model
    RETURN QUERY
    SELECT 
        v_order.id AS order_id,
        v_order.display_number AS order_number,
        COALESCE(v_customer.name, 'عميل')::VARCHAR(200) AS customer_name,
        v_order.status::TEXT AS status,
        v_order.created_at AS created_at,
        v_items_count AS items_count,
        v_items AS items;
END;
$$;

REVOKE ALL ON FUNCTION public_resolve_order_qr(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_resolve_order_qr(TEXT) TO anon, authenticated;
