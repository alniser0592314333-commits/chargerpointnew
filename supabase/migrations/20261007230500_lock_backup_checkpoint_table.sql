-- Backup checkpoint table is sensitive recovery evidence.
-- It is no longer part of the client-facing backup API.

ALTER TABLE public.backup_checkpoints ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.backup_checkpoints FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.backup_checkpoints TO service_role;
