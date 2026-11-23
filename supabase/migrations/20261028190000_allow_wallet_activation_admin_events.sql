-- Allow wallet activation lifecycle events in the existing customer-account admin event stream.
-- Keep all previously supported event types unchanged.
begin;

alter table public.customer_account_events
  drop constraint if exists customer_account_events_event_type_check;

alter table public.customer_account_events
  add constraint customer_account_events_event_type_check
  check (event_type = any (array[
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
    'HISTORY_ACCESS_REJECTED',
    'WALLET_ACTIVATION_REQUESTED',
    'WALLET_ACTIVATION_APPROVED',
    'WALLET_ACTIVATION_REJECTED'
  ]::text[]));

commit;
