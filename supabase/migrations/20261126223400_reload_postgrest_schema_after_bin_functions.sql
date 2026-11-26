/**
 * Supabase Migration: 00027_reload_postgrest_schema_after_bin_functions.sql
 * Forces PostgREST to reload its schema cache to ensure verify_admin_bin_with_attempt_tracking
 * and related BIN functions are fully visible upon cold starts.
 */
NOTIFY pgrst, 'reload schema';
