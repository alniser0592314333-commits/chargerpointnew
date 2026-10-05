-- Migration 00018: Fix Username to Email Resolver for Username + Password Login
-- Restores single-parameter resolver that maps username to email for active admins.
-- Delegates password authentication strictly to Supabase Auth (GoTrue).

-- 1. Drop 2-parameter overload explicitly to resolve ambiguity
DROP FUNCTION IF EXISTS public.get_email_by_username(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.get_email_by_username(TEXT);

-- 2. Create authoritative single-parameter username-to-email resolver
CREATE OR REPLACE FUNCTION public.get_email_by_username(
    p_username TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_email TEXT;
BEGIN
    IF p_username IS NULL OR length(trim(p_username)) = 0 THEN
        RETURN NULL;
    END IF;

    SELECT a.email
    INTO v_email
    FROM public.admins a
    WHERE LOWER(a.username) = LOWER(TRIM(p_username))
      AND a.is_active = TRUE
    LIMIT 1;

    RETURN v_email;
END;
$$;

-- 3. Explicit permissions
REVOKE EXECUTE ON FUNCTION public.get_email_by_username(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_email_by_username(TEXT) TO anon, authenticated, service_role;
