-- Remove administrator authorization secrets from sync change payloads.
-- The command payload still reaches the guarded RPC for verification, but the
-- change log must never persist or distribute the BIN to other sync clients.

CREATE OR REPLACE FUNCTION public.redact_sensitive_change_log_payload()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.payload IS NOT NULL THEN
    NEW.payload := NEW.payload - ARRAY[
      'bin',
      'adminBin',
      'admin_bin',
      'BIN',
      'ADMIN_BIN',
      'AdminBin',
      'deferBinVerification',
      'offlinePendingApproval'
    ];
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.redact_sensitive_change_log_payload() IS
  'Redacts administrator BIN credentials and local-only authorization markers from sync change-log payloads.';

DROP TRIGGER IF EXISTS trg_redact_sensitive_change_log_payload ON public.change_log;

CREATE TRIGGER trg_redact_sensitive_change_log_payload
BEFORE INSERT OR UPDATE OF payload ON public.change_log
FOR EACH ROW
EXECUTE FUNCTION public.redact_sensitive_change_log_payload();

-- Scrub previously persisted credentials without changing payment or ledger rows.
UPDATE public.change_log
SET payload = payload - ARRAY[
  'bin',
  'adminBin',
  'admin_bin',
  'BIN',
  'ADMIN_BIN',
  'AdminBin',
  'deferBinVerification',
  'offlinePendingApproval'
]
WHERE payload ?| ARRAY[
  'bin',
  'adminBin',
  'admin_bin',
  'BIN',
  'ADMIN_BIN',
  'AdminBin',
  'deferBinVerification',
  'offlinePendingApproval'
];
