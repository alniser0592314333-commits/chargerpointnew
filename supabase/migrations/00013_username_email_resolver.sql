-- Migration 00013: Secure Username to Email Resolver for Username + Password Login
-- Enforces password verification before returning mapped email to prevent enumeration and harvesting

CREATE OR REPLACE FUNCTION public.get_email_by_username(
    p_username TEXT,
    p_password TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_email TEXT;
    v_encrypted_password TEXT;
BEGIN
    IF p_username IS NULL OR length(trim(p_username)) = 0 THEN
        RETURN NULL;
    END IF;

    -- Strict protection against enumeration & harvesting:
    -- If p_password is omitted or empty, do NOT reveal email
    IF p_password IS NULL OR length(trim(p_password)) = 0 THEN
        RETURN NULL;
    END IF;

    SELECT a.email, u.encrypted_password
    INTO v_email, v_encrypted_password
    FROM admins a
    JOIN auth.users u ON a.auth_user_id = u.id
    WHERE LOWER(a.username) = LOWER(TRIM(p_username))
    LIMIT 1;

    IF NOT FOUND OR v_encrypted_password IS NULL THEN
        RETURN NULL;
    END IF;

    -- Validate password against bcrypt hash in auth.users
    IF extensions.crypt(trim(p_password), v_encrypted_password) = v_encrypted_password THEN
        RETURN v_email;
    ELSE
        RETURN NULL;
    END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.get_email_by_username(TEXT);
REVOKE EXECUTE ON FUNCTION public.get_email_by_username(TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_email_by_username(TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_email_by_username(TEXT, TEXT) TO anon, authenticated, service_role;

