-- Customer requests to enable wallet management. The wallet request lifecycle is
-- isolated from admin financial records and references the canonical customer UUID
-- without a foreign key so customer cleanup cannot cascade into this service.
begin;

create table if not exists public.wallet_activation_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz null,
  decided_by uuid null,
  rejection_reason text null check (rejection_reason is null or length(rejection_reason) <= 1000),
  updated_at timestamptz not null default now(),
  check (
    (status = 'PENDING' and decided_at is null and decided_by is null)
    or (status in ('APPROVED', 'REJECTED') and decided_at is not null and decided_by is not null)
  )
);

create index if not exists wallet_activation_requests_customer_history_idx
  on public.wallet_activation_requests (customer_id, requested_at desc);
create index if not exists wallet_activation_requests_admin_queue_idx
  on public.wallet_activation_requests (requested_at asc) where status = 'PENDING';
create unique index if not exists wallet_activation_requests_one_pending_per_customer
  on public.wallet_activation_requests (customer_id) where status = 'PENDING';

alter table public.wallet_activation_requests enable row level security;
alter table public.wallet_activation_requests force row level security;
revoke all on table public.wallet_activation_requests from anon, authenticated;
grant select, insert, update on table public.wallet_activation_requests to service_role;

comment on table public.wallet_activation_requests is
  'Isolated customer requests for wallet-management access; all state changes are server-authorized.';

commit;
