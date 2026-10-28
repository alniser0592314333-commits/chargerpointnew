-- Wallet-management service entitlements. New subscribers have no access unless
-- an administrator explicitly enables the service for that customer.
begin;

create table if not exists public.wallet_service_entitlements (
  customer_id uuid not null references public.customers(id) on delete cascade,
  service_key text not null check (service_key in ('wallet_management')),
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid null,
  primary key (customer_id, service_key)
);

alter table public.wallet_service_entitlements enable row level security;
alter table public.wallet_service_entitlements force row level security;

revoke all on table public.wallet_service_entitlements from anon, authenticated;
grant select, insert, update, delete on table public.wallet_service_entitlements to service_role;

comment on table public.wallet_service_entitlements is
  'Server-enforced entitlements for optional customer-facing services. No direct client access.';
comment on column public.wallet_service_entitlements.enabled is
  'Access is granted only when true and checked server-side on each service entry.';

commit;
