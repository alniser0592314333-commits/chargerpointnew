-- Customer-owned wallet accounts and an append-only transaction journal.
-- This wallet authorization ledger is separate from the admin/service entitlement tables.
-- Apply only after reviewing this migration; it is not deployed automatically.
begin;

create table public.wallet_service_entitlements (
  customer_id uuid not null references public.customers(id) on delete restrict,
  service_key text not null check (service_key = 'wallet_management'),
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (customer_id, service_key)
);
alter table public.wallet_service_entitlements enable row level security;
alter table public.wallet_service_entitlements force row level security;
revoke all on public.wallet_service_entitlements from anon, authenticated;
grant select, insert, update on public.wallet_service_entitlements to service_role;

create table public.wallet_accounts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  provider text not null check (provider in ('PalPay', 'Jawwal Pay', 'Bank of Palestine')),
  wallet_number text not null check (length(trim(wallet_number)) between 1 and 64),
  display_name text not null check (length(trim(display_name)) between 1 and 120),
  currency text not null default 'ILS' check (currency in ('ILS', 'USD', 'JOD')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, provider, wallet_number),
  unique (id, customer_id)
);

create table public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  transaction_type text not null check (transaction_type in ('INCOME', 'EXPENSE', 'TRANSFER')),
  source_wallet_id uuid null,
  destination_wallet_id uuid null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency in ('ILS', 'USD', 'JOD')),
  idempotency_key uuid not null,
  reference text null check (reference is null or length(reference) <= 160),
  note text null check (note is null or length(note) <= 1000),
  created_by_auth_user_id uuid not null,
  created_at timestamptz not null default now(),
  constraint wallet_tx_source_owner_fk foreign key (source_wallet_id, customer_id)
    references public.wallet_accounts(id, customer_id) on delete restrict,
  constraint wallet_tx_destination_owner_fk foreign key (destination_wallet_id, customer_id)
    references public.wallet_accounts(id, customer_id) on delete restrict,
  constraint wallet_tx_shape check (
    (transaction_type = 'INCOME' and source_wallet_id is null and destination_wallet_id is not null) or
    (transaction_type = 'EXPENSE' and source_wallet_id is not null and destination_wallet_id is null) or
    (transaction_type = 'TRANSFER' and source_wallet_id is not null and destination_wallet_id is not null and source_wallet_id <> destination_wallet_id)
  ),
  unique (customer_id, idempotency_key)
);

create index wallet_accounts_customer_active_idx on public.wallet_accounts(customer_id, is_active, provider);
create index wallet_transactions_customer_created_idx on public.wallet_transactions(customer_id, created_at desc, id desc);
create index wallet_transactions_source_idx on public.wallet_transactions(source_wallet_id, created_at desc);
create index wallet_transactions_destination_idx on public.wallet_transactions(destination_wallet_id, created_at desc);

alter table public.wallet_accounts enable row level security;
alter table public.wallet_accounts force row level security;
alter table public.wallet_transactions enable row level security;
alter table public.wallet_transactions force row level security;

revoke all on public.wallet_accounts from anon, authenticated;
revoke all on public.wallet_transactions from anon, authenticated;
grant select, insert, update on public.wallet_accounts to service_role;
grant select, insert on public.wallet_transactions to service_role;


create or replace function public.wallet_record_transaction(
  p_customer_id uuid,
  p_actor_auth_user_id uuid,
  p_transaction_type text,
  p_source_wallet_id uuid,
  p_destination_wallet_id uuid,
  p_amount_minor bigint,
  p_currency text,
  p_idempotency_key uuid,
  p_reference text default null,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.wallet_transactions%rowtype;
  v_source public.wallet_accounts%rowtype;
  v_destination public.wallet_accounts%rowtype;
  v_balance bigint;
  v_new public.wallet_transactions%rowtype;
begin
  if p_customer_id is null or p_actor_auth_user_id is null or p_idempotency_key is null
    or p_transaction_type is null or p_transaction_type not in ('INCOME', 'EXPENSE', 'TRANSFER')
    or p_amount_minor is null or p_amount_minor <= 0
    or p_currency is null or p_currency not in ('ILS', 'USD', 'JOD')
    or coalesce(length(p_reference), 0) > 160 or coalesce(length(p_note), 0) > 1000 then
    raise exception 'INVALID_WALLET_TRANSACTION' using errcode = '22023';
  end if;

  if (p_transaction_type = 'INCOME' and (p_source_wallet_id is not null or p_destination_wallet_id is null))
    or (p_transaction_type = 'EXPENSE' and (p_source_wallet_id is null or p_destination_wallet_id is not null))
    or (p_transaction_type = 'TRANSFER' and (
      p_source_wallet_id is null or p_destination_wallet_id is null or p_source_wallet_id = p_destination_wallet_id
    )) then
    raise exception 'INVALID_WALLET_TRANSACTION' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.wallet_service_entitlements e
    where e.customer_id = p_customer_id and e.service_key = 'wallet_management' and e.enabled = true
  ) then
    raise exception 'WALLET_SERVICE_NOT_ENABLED' using errcode = '42501';
  end if;

  -- Serialize writes for this customer before checking the idempotency key or balance.
  perform pg_advisory_xact_lock(hashtextextended(p_customer_id::text, 0));

  select * into v_existing from public.wallet_transactions
  where customer_id = p_customer_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.transaction_type is distinct from p_transaction_type
      or v_existing.source_wallet_id is distinct from p_source_wallet_id
      or v_existing.destination_wallet_id is distinct from p_destination_wallet_id
      or v_existing.amount_minor is distinct from p_amount_minor
      or v_existing.currency is distinct from p_currency
      or v_existing.reference is distinct from nullif(trim(p_reference), '')
      or v_existing.note is distinct from nullif(trim(p_note), '')
      or v_existing.created_by_auth_user_id is distinct from p_actor_auth_user_id then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = '22023';
    end if;
    return jsonb_build_object('ok', true, 'duplicate', true, 'transaction_id', v_existing.id);
  end if;

  if p_transaction_type in ('EXPENSE', 'TRANSFER') then
    select * into v_source from public.wallet_accounts
    where id = p_source_wallet_id and customer_id = p_customer_id and is_active = true
    for update;
    if not found or v_source.currency <> p_currency then
      raise exception 'SOURCE_WALLET_UNAVAILABLE' using errcode = '22023';
    end if;

    select coalesce(sum(
      case when destination_wallet_id = v_source.id then amount_minor else 0 end -
      case when source_wallet_id = v_source.id then amount_minor else 0 end
    ), 0)::bigint into v_balance
    from public.wallet_transactions
    where customer_id = p_customer_id
      and (source_wallet_id = v_source.id or destination_wallet_id = v_source.id);

    if v_balance < p_amount_minor then
      raise exception 'INSUFFICIENT_WALLET_BALANCE' using errcode = '22023';
    end if;
  end if;

  if p_transaction_type in ('INCOME', 'TRANSFER') then
    select * into v_destination from public.wallet_accounts
    where id = p_destination_wallet_id and customer_id = p_customer_id and is_active = true
    for update;
    if not found or v_destination.currency <> p_currency then
      raise exception 'DESTINATION_WALLET_UNAVAILABLE' using errcode = '22023';
    end if;
  end if;

  insert into public.wallet_transactions (
    customer_id, transaction_type, source_wallet_id, destination_wallet_id,
    amount_minor, currency, idempotency_key, reference, note, created_by_auth_user_id
  ) values (
    p_customer_id, p_transaction_type, p_source_wallet_id, p_destination_wallet_id,
    p_amount_minor, p_currency, p_idempotency_key, nullif(trim(p_reference), ''),
    nullif(trim(p_note), ''), p_actor_auth_user_id
  ) returning * into v_new;

  return jsonb_build_object('ok', true, 'duplicate', false, 'transaction_id', v_new.id);
end;
$$;

revoke all on function public.wallet_record_transaction(uuid, uuid, text, uuid, uuid, bigint, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.wallet_record_transaction(uuid, uuid, text, uuid, uuid, bigint, text, uuid, text, text) to service_role;

commit;
