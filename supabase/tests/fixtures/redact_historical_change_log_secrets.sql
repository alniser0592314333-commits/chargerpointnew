BEGIN;

-- One-time historical sanitization. Preserve every audit row and every
-- non-secret field; remove only credential/verification keys recursively.
UPDATE public.change_log
SET payload=public._cp_redact_sensitive_change_payload(payload)
WHERE payload IS DISTINCT FROM public._cp_redact_sensitive_change_payload(payload);

COMMIT;
