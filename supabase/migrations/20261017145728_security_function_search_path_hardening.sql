-- Pin search_path for the remaining database functions flagged by Supabase.
-- Migration version reconciled with the already-applied live version 20261017145728.
-- Also close the obsolete username-to-email resolver and a public test-only RPC.
-- These changes do not modify business rows or financial data.


REVOKE ALL ON FUNCTION public.get_email_by_username(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.test_fn(text) FROM PUBLIC, anon, authenticated;

ALTER FUNCTION public.update_updated_at_column() SET search_path TO public, pg_temp;
ALTER FUNCTION public.prevent_ledger_modification() SET search_path TO public, pg_temp;
ALTER FUNCTION public.log_table_changes() SET search_path TO public, pg_temp;
ALTER FUNCTION public.derive_customer_code(uuid) SET search_path TO public, pg_temp;
ALTER FUNCTION public.prevent_ledger_tampering() SET search_path TO public, pg_temp;
ALTER FUNCTION public.protect_audit_logs() SET search_path TO public, pg_temp;
ALTER FUNCTION public.enforce_single_super_admin() SET search_path TO public, pg_temp;
ALTER FUNCTION public.test_fn(text) SET search_path TO public, pg_temp;
ALTER FUNCTION public.safe_cast_uuid(text) SET search_path TO public, pg_temp;
ALTER FUNCTION public.protect_super_admin_permissions() SET search_path TO public, pg_temp;
ALTER FUNCTION public.prevent_financial_ledger_tampering() SET search_path TO public, pg_temp;
ALTER FUNCTION public.freeze_recognized_order_item_snapshots() SET search_path TO public, pg_temp;

NOTIFY pgrst, 'reload schema';

