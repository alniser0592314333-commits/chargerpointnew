-- Permit newly introduced customer account event types used by reminders and history access.
-- Keep the existing event contract intact while allowing the new notification events.
ALTER TABLE public.customer_account_events
  DROP CONSTRAINT IF EXISTS customer_account_events_event_type_check;

ALTER TABLE public.customer_account_events
  ADD CONSTRAINT customer_account_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'RESET_REQUESTED',
    'TEMP_PASSWORD_ISSUED',
    'PASSWORD_CHANGED',
    'EMAIL_RESET_SENT',
    'ACCOUNT_FROZEN',
    'ACCOUNT_REACTIVATED',
    'ACCOUNT_CANCELLED',
    'TERMS_ACCEPTED',
    'DEBT_PAYMENT_REMINDER',
    'HISTORY_ACCESS_REQUESTED',
    'HISTORY_ACCESS_APPROVED',
    'HISTORY_ACCESS_REJECTED'
  ]::text[]));
