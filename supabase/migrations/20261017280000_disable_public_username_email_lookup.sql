-- The browser must not resolve usernames to account emails. The replacement
-- Edge Function resolves the identity privately and verifies the password only
-- through Supabase Auth. Apply this migration only after the replacement function
-- and updated client have been deployed and verified.
REVOKE ALL ON FUNCTION public.get_email_by_username(text) FROM PUBLIC, anon, authenticated;
