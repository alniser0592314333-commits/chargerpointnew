-- Security hardening: legacy authoritative checkpoint functions are no longer
-- part of the application recovery path. Keep them service_role-only because
-- their historical implementation is not the canonical current backup contract.

REVOKE ALL ON FUNCTION public.create_authoritative_backup_checkpoint(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.restore_authoritative_backup_checkpoint(text, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_authoritative_backup_checkpoint(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.restore_authoritative_backup_checkpoint(text, uuid) TO service_role;
