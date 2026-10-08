-- FINAL DATABASE BASELINE
-- This file is the authoritative application database contract.
-- Historical migrations are retained only as archaeology and must not be used
-- to derive the target schema.
-- Currency is integer minor units (1 ILS = 100 minor units).
-- Default charger fee is 50 minor units (0.50 ILS), matching src/domain/rules.ts.

begin;

create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

create table if not exists public.admins (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  username text not null unique,
  full_name text not null,
  email text,
  role text not null default 'ADMIN' check (role in ('SUPER_ADMIN','ADMIN','MANAGER','OPERATOR','FINANCE','VIEWER')),
  permissions text[] not null default '{}',
  bin_hash text,
  is_active boolean not null default true,
  created_by uuid references public.admins(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(), actor_admin_id uuid references public.admins(id),
  action text not null, target_admin_id uuid references public.admins(id),
  metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table if not exists public.admin_custom_permissions (
  admin_id uuid not null references public.admins(id) on delete cascade,
  permission text not null, is_grant boolean not null, primary key(admin_id,permission)
);

create table if not exists public.system_settings (
  key text primary key,
  value_type text not null check (value_type in ('string','number','boolean','json')),
  value_string text,
  value_number bigint,
  value_boolean boolean,
  value_json jsonb,
  description text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

insert into public.system_settings(key,value_type,value_number,description)
values ('default_charger_fee_minor','number',50,'Default charger fee in minor currency units')
on conflict(key) do update set value_number=50,value_type='number',updated_at=now();

insert into public.system_settings(key,value_type,value_string,description)
values ('currency_code','string','ILS','Application currency')
on conflict(key) do nothing;

insert into public.system_settings(key,value_type,value_string,description)
values ('business_timezone','string','Asia/Jerusalem','Business timezone')
on conflict(key) do nothing;

insert into public.system_settings(key,value_type,value_number,description)
values ('server_reset_generation','number',1,'Authoritative remote dataset generation')
on conflict(key) do nothing;

create table if not exists public.global_app_identity (
  id uuid primary key,
  singleton boolean not null default true unique check (singleton = true),
  app_name text not null default 'نظام إدارة شحن الأجهزة',
  white_logo_url text,
  dark_logo_url text,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.admins(id),
  constraint global_app_identity_canonical_id_chk
    check (id = '00000000-0000-0000-0000-000000000001')
);
insert into public.global_app_identity(id, singleton)
values('00000000-0000-0000-0000-000000000001', true)
on conflict(id) do nothing;

create table if not exists public.app_canonical_state (
  singleton boolean primary key default true check (singleton),
  canonical_version_id uuid not null default gen_random_uuid(),
  reset_generation bigint not null default 1,
  updated_at timestamptz not null default now()
);

insert into public.app_canonical_state(singleton) values(true)
on conflict(singleton) do nothing;

create table if not exists public.business_days (
  id uuid primary key default gen_random_uuid(),
  business_date date not null unique,
  display_number integer not null default 1 check(display_number > 0),
  status text not null default 'OPEN' check(status in ('OPEN','CLOSED')),
  is_closed boolean not null default false,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references public.admins(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name varchar(200) not null,
  phone varchar(50),
  status text not null default 'ACTIVE' check(status in ('ACTIVE','DELETED')),
  is_active boolean not null default true,
  notes text,
  debt_limit_minor bigint not null default 0,
  charger_fee_exempt boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1
);

create table if not exists public.device_types (
  id uuid primary key default gen_random_uuid(),
  name varchar(200) not null,
  name_ar varchar(200),
  name_en varchar(200),
  icon varchar(80) not null default 'smartphone',
  base_price_minor bigint not null default 0 check(base_price_minor >= 0),
  charger_fee_enabled boolean not null default true,
  charger_fee_applicable boolean not null default true,
  status text not null default 'ACTIVE' check(status in ('ACTIVE','RETIRED')),
  is_active boolean not null default true,
  sort_order integer not null default 0 check(sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1
);

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references public.admins(id),
  name text,
  status text not null default 'ACTIVE',
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  day_id uuid not null references public.business_days(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  display_number integer not null default 1,
  internal_sequence bigint generated always as identity unique,
  status text not null default 'pending' check(status in ('pending','charging','delivered','cancelled')),
  customer_balance_snapshot_minor bigint default 0,
  notes text,
  qr_token_id uuid,
  charging_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  check(display_number > 0)
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  device_type_id uuid not null references public.device_types(id) on delete restrict,
  item_sequence integer not null default 1,
  operational_status text not null default 'CHARGING' check(operational_status in ('CHARGING','DELIVERED','CANCELLED')),
  financial_status text not null default 'UNRECOGNIZED' check(financial_status in ('UNRECOGNIZED','RECOGNIZED','REVERSED')),
  payment_status text not null default 'UNPAID' check(payment_status in ('UNPAID','PARTIALLY_PAID','PAID')),
  status text not null default 'charging' check(status in ('charging','delivered','cancelled')),
  device_name_snapshot text not null default '',
  device_icon_snapshot text not null default 'smartphone',
  base_price_snapshot_minor bigint not null default 0,
  charger_fee_enabled_snapshot boolean not null default true,
  customer_charger_fee_exempt_snapshot boolean not null default false,
  charger_fee_snapshot_minor bigint not null default 0,
  discount_snapshot_minor bigint not null default 0,
  final_charge_snapshot_minor bigint not null default 0,
  has_charger boolean not null default false,
  unit_price_minor bigint not null default 0,
  total_price_minor bigint not null default 0,
  replacement_of_item_id uuid references public.order_items(id),
  delivered_at timestamptz,
  financially_recognized_at timestamptz,
  cancelled_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create table if not exists public.financial_ledger (
  id uuid primary key default gen_random_uuid(),
  sequence_number bigint generated always as identity unique,
  event_type text not null check(event_type in ('CHARGE','PAYMENT','CREDIT','DISCOUNT','REVERSAL','REFUND','ADJUSTMENT','ORDER_ITEM_CHARGE','CREDIT_ADJUSTMENT','CREDIT_USED','BONUS','CORRECTION')),
  amount_minor bigint not null,
  order_id uuid references public.orders(id),
  order_item_id uuid references public.order_items(id),
  customer_id uuid not null references public.customers(id) on delete restrict,
  actor_admin_id uuid references public.admins(id),
  reference_id uuid,
  linked_ledger_id uuid references public.financial_ledger(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  amount_minor bigint not null check(amount_minor > 0),
  payment_method text not null,
  reference text,
  actor_admin_id uuid references public.admins(id),
  command_id uuid not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  order_item_id uuid references public.order_items(id) on delete restrict,
  order_id uuid references public.orders(id) on delete restrict,
  allocated_amount_minor bigint not null check(allocated_amount_minor > 0),
  created_at timestamptz not null default now(),
  check(order_item_id is not null or order_id is not null)
);

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  target_quantity integer not null check(target_quantity > 0),
  current_progress integer not null default 0 check(current_progress >= 0),
  bonus_amount_minor bigint not null default 0 check(bonus_amount_minor >= 0),
  duration_days integer not null check(duration_days > 0),
  status text not null default 'ACTIVE' check(status in ('ACTIVE','COMPLETED','FAILED')),
  started_at timestamptz not null,
  expires_at timestamptz not null,
  completed_at timestamptz,
  bonus_ledger_id uuid references public.financial_ledger(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create unique index if not exists uq_goals_one_active_customer on public.goals(customer_id) where status='ACTIVE';

create table if not exists public.goal_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  requested_target integer,
  status text not null default 'PENDING' check(status in ('PENDING','APPROVED','REJECTED')),
  reviewed_by uuid references public.admins(id),
  reviewed_at timestamptz,
  rejection_reason text,
  resulting_goal_id uuid references public.goals(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create table if not exists public.qr_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  public_token text not null unique,
  token_type text not null check(token_type in ('ORDER','CUSTOMER')),
  target_id uuid not null,
  is_active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.order_number_reservations (
  id uuid primary key default gen_random_uuid(),
  business_day_id uuid not null references public.business_days(id) on delete restrict,
  device_id uuid not null references public.devices(id) on delete restrict,
  start_number integer not null,
  end_number integer not null,
  next_number integer not null,
  status text not null default 'ACTIVE' check(status in ('ACTIVE','EXHAUSTED')),
  command_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check(start_number > 0 and end_number >= start_number and next_number between start_number and end_number + 1)
);

create table if not exists public.processed_commands (
  command_id uuid primary key,
  command_type text not null,
  payload_hash text not null,
  aggregate_type text,
  aggregate_id uuid,
  actor_admin_id uuid references public.admins(id),
  device_id uuid,
  result_payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.change_log (
  sequence_id bigint generated always as identity primary key,
  entity_type text not null,
  entity_id uuid not null,
  action text not null check(action in ('INSERT','UPDATE','DELETE','TOMBSTONE')),
  payload jsonb not null default '{}'::jsonb,
  version integer,
  changed_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_admin_id uuid references public.admins(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.qr_payment_submissions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  amount_minor bigint not null check(amount_minor > 0),
  receipt_url text,
  note text,
  status text not null default 'PENDING' check(status in ('PENDING','APPROVED','REJECTED')),
  reviewed_by uuid references public.admins(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references public.admins(id),
  customer_id uuid references public.customers(id),
  type text not null,
  title text,
  message text,
  payload jsonb not null default '{}'::jsonb,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.customer_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id),
  request_type text not null,
  status text not null default 'PENDING',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customer_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customer_delivery_push_logs (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id),
  order_item_id uuid references public.order_items(id),
  status text not null,
  provider_response jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.customer_activity (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  activity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  entity_type text,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  actor_admin_id uuid references public.admins(id),
  created_at timestamptz not null default now()
);

create table if not exists public.personal_financial_transactions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references public.admins(id),
  transaction_type text not null,
  amount_minor bigint not null,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_orders_day on public.orders(day_id, display_number);
create index if not exists idx_orders_customer on public.orders(customer_id, created_at);
create index if not exists idx_order_items_order on public.order_items(order_id, item_sequence);
create index if not exists idx_order_items_customer_lookup on public.order_items(order_id, financial_status, payment_status);
create index if not exists idx_ledger_customer on public.financial_ledger(customer_id, created_at);
create index if not exists idx_ledger_item on public.financial_ledger(order_item_id, event_type);
create unique index if not exists uq_ledger_charge_per_item on public.financial_ledger(order_item_id, event_type) where order_item_id is not null and event_type='ORDER_ITEM_CHARGE';
create index if not exists idx_change_log_sequence on public.change_log(sequence_id);
create index if not exists idx_change_log_entity on public.change_log(entity_type, entity_id, sequence_id);
create index if not exists idx_outbox_commands on public.processed_commands(command_id);

create or replace function public.is_system_bootstrapped()
returns boolean language sql stable security definer set search_path=public
as $$ 
  select exists(
    select 1 from public.admins 
    where role in ('SUPER_ADMIN', 'Super Admin') 
      and is_active = true 
      and auth_user_id is not null 
      and auth_user_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ) 
$$;

create or replace function public.bootstrap_first_super_admin(p_username text,p_full_name text,p_bin text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_email text;
begin
 if exists(
   select 1 from public.admins 
   where role in ('SUPER_ADMIN', 'Super Admin') 
     and is_active = true 
     and auth_user_id is not null 
     and auth_user_id <> '00000000-0000-0000-0000-000000000000'::uuid
 ) then
  return jsonb_build_object('success',false,'code','ALREADY_BOOTSTRAPPED');
 end if;
 if auth.uid() is null then raise exception 'Authentication required' using errcode='P0001'; end if;
 select email into v_email from auth.users where id=auth.uid();
 if v_email is null then
   v_email := auth.jwt()->>'email';
 end if;

 insert into public.admins(auth_user_id,username,full_name,email,role,permissions,bin_hash,is_active)
 values(auth.uid(),trim(p_username),coalesce(nullif(trim(p_full_name),''),trim(p_username)),v_email,'SUPER_ADMIN',
 array['orders:view','orders:create','orders:edit','orders:deliver','orders:cancel','orders:correct',
 'customers:view','customers:create','customers:edit','customers:deactivate','customers:debt-limit',
 'customers:charger-exemption','customers:financial-view','finance:view','finance:create-payment',
 'finance:approve-payment','finance:refund','finance:correction','finance:credit-adjustment',
 'devices:view','devices:manage','devices:pricing','devices:charger-policy','settings:manage',
 'admin:manage','sync:manage','sync:view','goals:view','goals:manage','goals:request','goals:approve']::text[],
 crypt(p_bin,gen_salt('bf')),true)
 on conflict(auth_user_id) do update set
   role = 'SUPER_ADMIN',
   is_active = true,
   username = excluded.username,
   full_name = excluded.full_name,
   bin_hash = excluded.bin_hash,
   permissions = excluded.permissions,
   updated_at = now()
 returning id into v_id;

 return jsonb_build_object('success',true,'admin_id',v_id);
end $$;

create or replace function public.get_email_by_username(p_username text)
returns text language sql stable security definer set search_path=public
as $$ select email from public.admins where lower(username)=lower(p_username) and is_active=true limit 1 $$;

create or replace function public.rpc_fetch_admins()
returns setof jsonb language sql security definer set search_path=public
as $$ select jsonb_build_object('id',a.id,'username',a.username,'full_name',a.full_name,'email',a.email,'role',a.role,'is_active',a.is_active,'version',a.version,'created_at',a.created_at) from public.admins a where public.current_admin_id() is not null order by a.created_at $$;

create or replace function public.get_global_app_identity()
returns jsonb language sql stable security definer set search_path=public
as $
  select jsonb_build_object(
    'id',id,
    'app_name',app_name,
    'white_logo_url',white_logo_url,
    'dark_logo_url',dark_logo_url,
    'version',version,
    'updated_at',updated_at,
    'updated_by',updated_by
  )
  from public.global_app_identity
  where id='00000000-0000-0000-0000-000000000001'
    and singleton=true
  limit 1
$;

create or replace function public.update_global_app_identity(p_app_name text,p_white_logo_url text,p_dark_logo_url text)
returns jsonb language plpgsql security definer set search_path=public
as $
begin
 if not exists(select 1 from public.admins a where a.id=public.current_admin_id() and (a.role='SUPER_ADMIN' or 'settings:manage'=any(a.permissions))) then
  raise exception 'Forbidden' using errcode='P4003';
 end if;
 update public.global_app_identity set
   app_name=coalesce(p_app_name,app_name),
   white_logo_url=p_white_logo_url,
   dark_logo_url=p_dark_logo_url,
   version=version+1,
   updated_at=now(),
   updated_by=public.current_admin_id()
 where id='00000000-0000-0000-0000-000000000001'
   and singleton=true;
 return public.get_global_app_identity();
end $;

create or replace function public.current_admin_id()
returns uuid
language sql stable security definer set search_path=public
as $$
  select id from public.admins where auth_user_id=auth.uid() and is_active=true limit 1
$$;

create or replace function public.get_effective_permissions(p_admin_id uuid)
returns table(permission text)
language sql stable security definer set search_path=public
as $$
  select distinct unnest(coalesce(a.permissions,'{}'::text[]))
  from public.admins a
  where a.id=p_admin_id and a.is_active=true
$$;

create or replace function public.verify_admin_bin(p_bin text)
returns boolean
language sql stable security definer set search_path=public
as $$
  select exists(
    select 1 from public.admins a
    where a.id=public.current_admin_id()
      and a.is_active
      and a.bin_hash is not null
      and crypt(p_bin,a.bin_hash)=a.bin_hash
  )
$$;

create or replace function public.get_current_admin_profile()
returns jsonb
language plpgsql security definer set search_path=public
as $$
declare 
  a public.admins;
  v_email text;
begin
  if auth.uid() is null then
    return jsonb_build_object('authenticated',false,'is_admin',false);
  end if;

  -- 1. Look up admin by auth_user_id directly
  select * into a from public.admins where auth_user_id=auth.uid() limit 1;

  -- 2. If not found, look up by verified email and auto-link auth_user_id
  if a.id is null then
    select email into v_email from auth.users where id=auth.uid();
    if v_email is null then
      v_email := auth.jwt()->>'email';
    end if;

    if v_email is not null then
      select * into a from public.admins where email is not null and lower(email)=lower(v_email) limit 1;
      if a.id is not null then
        update public.admins set auth_user_id=auth.uid(), updated_at=now() where id=a.id;
        a.auth_user_id:=auth.uid();
      end if;
    end if;
  end if;

  if a.id is null then
    return jsonb_build_object('authenticated',true,'is_admin',false,'auth_user_id',auth.uid());
  end if;

  return jsonb_build_object(
    'authenticated',true,
    'is_admin',true,
    'is_active',coalesce(a.is_active,true),
    'admin_id',a.id,
    'auth_user_id',a.auth_user_id,
    'username',a.username,
    'full_name',a.full_name,
    'email',a.email,
    'role',a.role,
    'permissions',coalesce(a.permissions,'{}'::text[])
  );
end;
$$;

create or replace function public.protect_super_admin_account()
returns trigger as $$
begin
    -- Exclude disposable test UUIDs from invariant enforcement
    if coalesce(old.auth_user_id, '00000000-0000-0000-0000-000000000000'::uuid) = '00000000-0000-0000-0000-000000000000'::uuid then
        return case when tg_op = 'DELETE' then old else new end;
    end if;

    if tg_op = 'DELETE' then
        if old.role in ('SUPER_ADMIN', 'Super Admin') then
            raise exception 'Security Invariant Violation: Super Admin account cannot be deleted.';
        end if;
        return old;
    end if;

    if tg_op = 'UPDATE' then
        if old.role in ('SUPER_ADMIN', 'Super Admin') then
            if new.role not in ('SUPER_ADMIN', 'Super Admin') then
                raise exception 'Security Invariant Violation: Super Admin authority cannot be demoted or removed.';
            end if;
            if new.is_active = false then
                raise exception 'Security Invariant Violation: Super Admin account cannot be disabled or suspended.';
            end if;
        end if;
        return new;
    end if;

    return new;
end;
$$ language plpgsql security definer set search_path=public;

drop trigger if exists trg_protect_super_admin_account on public.admins;
create trigger trg_protect_super_admin_account
before update or delete on public.admins
for each row
execute function public.protect_super_admin_account();

create or replace function public.record_canonical_change(
  p_entity_type text,p_entity_id uuid,p_action text,p_payload jsonb,p_version integer
) returns bigint
language plpgsql security definer set search_path=public
as $$
declare v_seq bigint;
begin
  insert into public.change_log(entity_type,entity_id,action,payload,version)
  values(p_entity_type,p_entity_id,p_action,coalesce(p_payload,'{}'::jsonb),p_version)
  returning sequence_id into v_seq;
  return v_seq;
end;
$$;

create or replace function public.trg_change_capture()
returns trigger
language plpgsql security definer set search_path=public
as $$
declare v_payload jsonb; v_id uuid; v_version integer; v_action text;
begin
  if tg_op='DELETE' then
    v_payload:=to_jsonb(old); v_id:=old.id; v_version:=nullif(v_payload->>'version','')::integer; v_action:='DELETE';
  else
    v_payload:=to_jsonb(new); v_id:=new.id; v_version:=nullif(v_payload->>'version','')::integer; v_action:=case when tg_op='INSERT' then 'INSERT' else 'UPDATE' end;
  end if;
  perform public.record_canonical_change(tg_table_name,v_id,v_action,v_payload,v_version);
  return case when tg_op='DELETE' then old else new end;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['business_days','customers','device_types','orders','order_items','financial_ledger','payments','payment_allocations','goals','goal_requests','qr_tokens','order_number_reservations','notifications','customer_requests','customer_push_subscriptions','customer_delivery_push_logs','customer_activity','events','personal_financial_transactions']
  loop
    execute format('drop trigger if exists trg_change_capture on public.%I',t);
    execute format('create trigger trg_change_capture after insert or update or delete on public.%I for each row execute function public.trg_change_capture()',t);
  end loop;
end $$;

create or replace function public.execute_sync_command(
  p_command_id uuid,
  p_command_type text,
  p_aggregate_type text default null,
  p_aggregate_id uuid default null,
  p_payload jsonb default '{}'::jsonb,
  p_expected_version integer default null
) returns jsonb
language plpgsql security definer set search_path=public
as $$
declare
  v_actor uuid:=public.current_admin_id();
  v_role text;
  v_required_permission text;
  v_customer uuid;
  v_order uuid;
  v_item uuid;
  v_device uuid;
  v_goal uuid;
  v_request uuid;
  v_payment uuid;
  v_amount bigint;
  v_fee bigint;
  v_discount bigint;
  v_final bigint;
  v_balance bigint;
  v_limit bigint;
  v_version integer;
  v_result jsonb:='{}'::jsonb;
  v_existing_hash text;
  r record;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode='P0001';
  end if;

  select role into v_role from public.admins where id=v_actor;

  v_required_permission:=case p_command_type
    when 'OPEN_DAY' then 'settings:manage'
    when 'CLOSE_DAY' then 'settings:manage'
    when 'CREATE_CUSTOMER' then 'customers:create'
    when 'UPDATE_CUSTOMER' then 'customers:edit'
    when 'CREATE_DEVICE_TYPE' then 'devices:manage'
    when 'UPDATE_DEVICE_TYPE' then 'devices:manage'
    when 'DELETE_DEVICE_TYPE' then 'devices:manage'
    when 'CREATE_ORDER' then 'orders:create'
    when 'UPDATE_ORDER' then 'orders:edit'
    when 'CANCEL_ORDER' then 'orders:cancel'
    when 'ADD_ORDER_ITEM' then 'orders:edit'
    when 'DELIVER_ORDER_ITEM' then 'orders:deliver'
    when 'CANCEL_ORDER_ITEM' then 'orders:cancel'
    when 'CREATE_PAYMENT' then 'finance:create-payment'
    when 'POST_PAYMENT' then 'finance:create-payment'
    when 'CREATE_CUSTOMER_CREDIT' then 'finance:credit-adjustment'
    when 'CONSUME_CUSTOMER_CREDIT' then 'finance:credit-adjustment'
    when 'CREATE_REFUND' then 'finance:refund'
    when 'CREATE_GOAL' then 'goals:manage'
    when 'UPDATE_GOAL_CONFIG' then 'goals:manage'
    when 'UPDATE_GOAL_PROGRESS' then 'goals:manage'
    when 'RECORD_GOAL_REQUEST' then 'goals:request'
    when 'APPROVE_GOAL_REQUEST' then 'goals:approve'
    when 'REJECT_GOAL_REQUEST' then 'goals:approve'
    else null
  end;

  if coalesce(v_role,'') <> 'SUPER_ADMIN'
     and v_required_permission is not null
     and not exists (
       select 1 from unnest(coalesce((select permissions from public.admins where id=v_actor),'{}'::text[])) p
       where p=v_required_permission
     ) then
    raise exception 'Forbidden: missing permission %',v_required_permission using errcode='P4003';
  end if;

  if p_payload ? 'bin' and nullif(p_payload->>'bin','') is not null then
    if public.verify_admin_bin(p_payload->>'bin') is not true then
      raise exception 'Invalid BIN' using errcode='P0003';
    end if;
  end if;

  if exists(select 1 from public.processed_commands where command_id=p_command_id) then
    select payload_hash,result_payload into v_existing_hash,v_result
    from public.processed_commands where command_id=p_command_id;
    if v_existing_hash <> encode(digest(coalesce(p_payload,'{}'::jsonb)::text,'sha256'),'hex') then
      raise exception 'Idempotency conflict' using errcode='P0009';
    end if;
    return jsonb_build_object('success',true,'commandId',p_command_id,'serverVersion',1,'rpcReached',true,'result',v_result,'idempotent',true);
  end if;

  if p_command_type not in ('OPEN_DAY','CLOSE_DAY','CREATE_CUSTOMER','UPDATE_CUSTOMER','CREATE_DEVICE_TYPE','UPDATE_DEVICE_TYPE','DELETE_DEVICE_TYPE','CREATE_ORDER','UPDATE_ORDER','CANCEL_ORDER','ADD_ORDER_ITEM','DELIVER_ORDER_ITEM','CANCEL_ORDER_ITEM','CREATE_PAYMENT','POST_PAYMENT','CREATE_CUSTOMER_CREDIT','CONSUME_CUSTOMER_CREDIT','CREATE_REFUND','CREATE_GOAL','UPDATE_GOAL_CONFIG','UPDATE_GOAL_PROGRESS','RECORD_GOAL_REQUEST','APPROVE_GOAL_REQUEST','REJECT_GOAL_REQUEST') then
    raise exception 'Unsupported sync command: %',p_command_type using errcode='P0010';
  end if;

  -- All financial and business writes are executed here. The local client never
  -- writes canonical server tables directly.
  case p_command_type
    when 'OPEN_DAY' then
      insert into public.business_days(id,business_date,display_number,status,is_closed,created_at,updated_at)
      values(coalesce((p_payload->>'id')::uuid,p_command_id),coalesce((p_payload->>'businessDate')::date,current_date),
        coalesce((select max(display_number)+1 from public.business_days),1),'OPEN',false,now(),now())
      on conflict(id) do nothing;
      v_result:=jsonb_build_object('businessDayId',coalesce((p_payload->>'id')::uuid,p_command_id));

    when 'CLOSE_DAY' then
      v_order:=(p_payload->>'id')::uuid;
      select version into v_version from public.business_days where id=v_order for update;
      if v_version is null then raise exception 'Business day not found' using errcode='P0006'; end if;
      if p_expected_version is not null and v_version<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='P0002'; end if;
      update public.business_days set status='CLOSED',is_closed=true,closed_at=now(),closed_by=v_actor,updated_at=now(),version=version+1 where id=v_order;
      v_result:=jsonb_build_object('businessDayId',v_order);

    when 'CREATE_CUSTOMER' then
      v_customer:=coalesce((p_payload->>'id')::uuid,p_command_id);
      insert into public.customers(id,name,phone,notes,debt_limit_minor,is_active,charger_fee_exempt,status)
      values(v_customer,coalesce(p_payload->>'name','Customer'),p_payload->>'phone',p_payload->>'notes',
        coalesce((p_payload->>'debtLimitMinor')::bigint,0),
        coalesce((p_payload->>'isActive')::boolean,true),
        coalesce((p_payload->>'chargerFeeExempt')::boolean,false),'ACTIVE')
      on conflict(id) do nothing;
      v_result:=jsonb_build_object('customerId',v_customer);

    when 'UPDATE_CUSTOMER' then
      v_customer:=(p_payload->>'id')::uuid;
      select version into v_version from public.customers where id=v_customer for update;
      if v_version is null then raise exception 'Customer not found' using errcode='P0006'; end if;
      if p_expected_version is not null and v_version<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='P0002'; end if;
      update public.customers set
        name=coalesce(p_payload->>'name',name), phone=coalesce(p_payload->>'phone',phone),
        notes=coalesce(p_payload->>'notes',notes),
        debt_limit_minor=coalesce((p_payload->>'debtLimitMinor')::bigint,debt_limit_minor),
        is_active=coalesce((p_payload->>'isActive')::boolean,is_active),
        charger_fee_exempt=coalesce((p_payload->>'chargerFeeExempt')::boolean,charger_fee_exempt),
        status=case when coalesce((p_payload->>'isActive')::boolean,is_active) then 'ACTIVE' else 'DELETED' end,
        deleted_at=case when coalesce((p_payload->>'isActive')::boolean,is_active) then null else now() end,
        updated_at=now(),version=version+1 where id=v_customer;
      v_result:=jsonb_build_object('customerId',v_customer);

    when 'CREATE_DEVICE_TYPE' then
      v_device:=coalesce((p_payload->>'id')::uuid,p_command_id);
      insert into public.device_types(id,name,name_ar,name_en,icon,base_price_minor,charger_fee_enabled,charger_fee_applicable,status,is_active,sort_order)
      values(v_device,coalesce(p_payload->>'name','Device'),p_payload->>'arabicName',p_payload->>'englishName',
        coalesce(p_payload->>'icon','smartphone'),coalesce((p_payload->>'basePriceMinor')::bigint,0),
        coalesce((p_payload->>'chargerFeeEnabled')::boolean,true),
        coalesce((p_payload->>'chargerFeeApplicable')::boolean,(p_payload->>'chargerFeeEnabled')::boolean,true),
        'ACTIVE',coalesce((p_payload->>'isActive')::boolean,true),coalesce((p_payload->>'sortOrder')::integer,0))
      on conflict(id) do nothing;
      v_result:=jsonb_build_object('deviceTypeId',v_device);

    when 'UPDATE_DEVICE_TYPE' then
      v_device:=(p_payload->>'id')::uuid;
      select version into v_version from public.device_types where id=v_device for update;
      if v_version is null then raise exception 'Device type not found' using errcode='P0006'; end if;
      if p_expected_version is not null and v_version<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='P0002'; end if;
      update public.device_types set
        name=coalesce(p_payload->>'name',name),name_ar=coalesce(p_payload->>'arabicName',name_ar),
        name_en=coalesce(p_payload->>'englishName',name_en),icon=coalesce(p_payload->>'icon',icon),
        base_price_minor=coalesce((p_payload->>'basePriceMinor')::bigint,base_price_minor),
        charger_fee_enabled=coalesce((p_payload->>'chargerFeeEnabled')::boolean,charger_fee_enabled),
        charger_fee_applicable=coalesce((p_payload->>'chargerFeeApplicable')::boolean,charger_fee_applicable),
        is_active=coalesce((p_payload->>'isActive')::boolean,is_active),
        status=case when coalesce((p_payload->>'isActive')::boolean,is_active) then 'ACTIVE' else 'RETIRED' end,
        sort_order=coalesce((p_payload->>'sortOrder')::integer,sort_order),updated_at=now(),version=version+1
      where id=v_device;
      v_result:=jsonb_build_object('deviceTypeId',v_device);

    when 'DELETE_DEVICE_TYPE' then
      v_device:=(p_payload->>'id')::uuid;
      if exists(select 1 from public.order_items where device_type_id=v_device) then
        raise exception 'DEVICE_TYPE_IN_USE' using errcode='P0003';
      end if;
      update public.device_types set is_active=false,status='RETIRED',deleted_at=now(),updated_at=now(),version=version+1 where id=v_device;
      if not found then raise exception 'Device type not found' using errcode='P0006'; end if;
      v_result:=jsonb_build_object('deviceTypeId',v_device);

    when 'CREATE_ORDER' then
      v_order:=coalesce((p_payload->>'id')::uuid,p_command_id);
      v_customer:=(p_payload->>'customerId')::uuid;
      perform 1 from public.business_days where id=(p_payload->>'dayId')::uuid and is_closed=false for update;
      if not found then raise exception 'Business day not found or closed' using errcode='P0007'; end if;
      perform 1 from public.customers where id=v_customer and is_active=true for update;
      if not found then raise exception 'Customer not found or inactive' using errcode='P0006'; end if;
      perform pg_advisory_xact_lock(hashtext((p_payload->>'dayId')::text));
      insert into public.orders(id,day_id,customer_id,display_number,status,customer_balance_snapshot_minor,notes,charging_at)
      values(v_order,(p_payload->>'dayId')::uuid,v_customer,
        (select coalesce(max(display_number),0)+1 from public.orders where day_id=(p_payload->>'dayId')::uuid),
        coalesce(p_payload->>'status','pending'),coalesce((p_payload->>'customerBalanceSnapshotMinor')::bigint,0),
        p_payload->>'notes',now())
      on conflict(id) do nothing;
      v_result:=jsonb_build_object('orderId',v_order);

    when 'UPDATE_ORDER' then
      v_order:=(p_payload->>'id')::uuid;
      select version into v_version from public.orders where id=v_order for update;
      if v_version is null then raise exception 'Order not found' using errcode='P0006'; end if;
      if p_expected_version is not null and v_version<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='P0002'; end if;
      update public.orders set notes=coalesce(p_payload->>'notes',notes),status=coalesce(p_payload->>'status',status),
        updated_at=now(),version=version+1 where id=v_order;
      v_result:=jsonb_build_object('orderId',v_order);

    when 'ADD_ORDER_ITEM' then
      v_item:=(coalesce(p_payload->>'id',p_command_id::text))::uuid;
      v_order:=(p_payload->>'orderId')::uuid;
      perform 1 from public.orders where id=v_order and status<>'cancelled' for update;
      if not found then raise exception 'Order not found or cancelled' using errcode='P0006'; end if;
      select dt.base_price_minor,dt.icon,coalesce(dt.name_ar,dt.name) as name,dt.charger_fee_enabled,dt.charger_fee_applicable,
             c.charger_fee_exempt
      into r
      from public.orders o join public.customers c on c.id=o.customer_id join public.device_types dt on dt.id=(p_payload->>'deviceTypeId')::uuid
      where o.id=v_order;
      if not found then raise exception 'Device type or customer not found' using errcode='P0006'; end if;
      v_fee:=case when r.charger_fee_enabled and r.charger_fee_applicable and not r.charger_fee_exempt and not coalesce((p_payload->>'hasCharger')::boolean,false)
                  then coalesce((select value_number from public.system_settings where key='default_charger_fee_minor'),50) else 0 end;
      v_discount:=greatest(0,coalesce((p_payload->>'discountSnapshotMinor')::bigint,0));
      v_final:=greatest(0,r.base_price_minor+v_fee-v_discount);
      insert into public.order_items(id,order_id,device_type_id,item_sequence,status,operational_status,financial_status,payment_status,
        device_name_snapshot,device_icon_snapshot,base_price_snapshot_minor,charger_fee_enabled_snapshot,customer_charger_fee_exempt_snapshot,
        charger_fee_snapshot_minor,discount_snapshot_minor,final_charge_snapshot_minor,has_charger,unit_price_minor,total_price_minor)
      values(v_item,v_order,(p_payload->>'deviceTypeId')::uuid,coalesce((p_payload->>'itemSequence')::integer,(select coalesce(max(item_sequence),0)+1 from public.order_items where order_id=v_order)),
        'charging','CHARGING','UNRECOGNIZED','UNPAID',r.name,r.icon,r.base_price_minor,r.charger_fee_enabled,r.charger_fee_exempt,v_fee,v_discount,v_final,
        coalesce((p_payload->>'hasCharger')::boolean,false),v_final,v_final);
      v_result:=jsonb_build_object('orderItemId',v_item,'finalChargeMinor',v_final);

    when 'DELIVER_ORDER_ITEM' then
      v_item:=coalesce((p_payload->>'itemId'),(p_payload->>'orderItemId'),(p_payload->>'id'))::uuid;
      select oi.order_id,o.customer_id,c.debt_limit_minor,oi.final_charge_snapshot_minor,oi.financial_status,oi.status,oi.version
      into r from public.order_items oi join public.orders o on o.id=oi.order_id join public.customers c on c.id=o.customer_id
      where oi.id=v_item for update;
      if not found then raise exception 'Item not found' using errcode='P0006'; end if;
      if r.financial_status='RECOGNIZED' then
        v_result:=jsonb_build_object('orderItemId',v_item,'alreadyRecognized',true);
      else
        if r.status='cancelled' then raise exception 'Cancelled item cannot be delivered' using errcode='P0003'; end if;
        if p_expected_version is not null and r.version<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='P0002'; end if;
        select coalesce(sum(amount_minor),0) into v_balance from public.financial_ledger where customer_id=r.customer_id;
        v_limit:=r.debt_limit_minor;
        if v_limit>0 and v_balance-r.final_charge_snapshot_minor < -v_limit then raise exception 'DEBT_LIMIT_EXCEEDED' using errcode='P0007'; end if;
        if v_limit<0 and v_balance-r.final_charge_snapshot_minor < v_limit then raise exception 'DEBT_LIMIT_EXCEEDED' using errcode='P0007'; end if;
        update public.order_items set status='delivered',operational_status='DELIVERED',financial_status='RECOGNIZED',delivered_at=now(),financially_recognized_at=now(),updated_at=now(),version=version+1 where id=v_item;
        insert into public.financial_ledger(event_type,amount_minor,order_id,order_item_id,customer_id,actor_admin_id,metadata)
        values('ORDER_ITEM_CHARGE',-r.final_charge_snapshot_minor,r.order_id,v_item,r.customer_id,v_actor,'{}'::jsonb);
        if not exists(select 1 from public.order_items where order_id=r.order_id and status not in ('cancelled','delivered')) then
          update public.orders set status='delivered',delivered_at=now(),updated_at=now(),version=version+1 where id=r.order_id;
        elsif exists(select 1 from public.order_items where order_id=r.order_id and status='charging') then
          update public.orders set status='charging',updated_at=now(),version=version+1 where id=r.order_id;
        end if;
        v_result:=jsonb_build_object('orderItemId',v_item,'status','DELIVERED');
      end if;

    when 'CANCEL_ORDER_ITEM' then
      v_item:=(p_payload->>'itemId')::uuid;
      select * into r from public.order_items where id=v_item for update;
      if not found then raise exception 'Item not found' using errcode='P0006'; end if;
      if p_expected_version is not null and r.version<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='P0002'; end if;
      if r.status='cancelled' then
        v_result:=jsonb_build_object('orderItemId',v_item,'alreadyCancelled',true);
      else
        if r.financial_status='RECOGNIZED' then
          insert into public.financial_ledger(event_type,amount_minor,order_id,order_item_id,customer_id,actor_admin_id,reference_id)
          select 'REVERSAL',-amount_minor,r.order_id,v_item,o.customer_id,v_actor,null
          from public.financial_ledger fl join public.orders o on o.id=fl.order_id
          where fl.order_item_id=v_item and fl.event_type='ORDER_ITEM_CHARGE'
          order by fl.created_at desc limit 1;
        end if;
        update public.order_items set status='cancelled',operational_status='CANCELLED',financial_status=case when financial_status='RECOGNIZED' then 'REVERSED' else financial_status end,
          cancelled_at=now(),updated_at=now(),version=version+1 where id=v_item;
        v_result:=jsonb_build_object('orderItemId',v_item);
      end if;

    when 'CANCEL_ORDER' then
      v_order:=(p_payload->>'orderId')::uuid;
      select version into v_version from public.orders where id=v_order for update;
      if v_version is null then raise exception 'Order not found' using errcode='P0006'; end if;
      if p_expected_version is not null and v_version<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='P0002'; end if;
      for r in select oi.* from public.order_items oi where oi.order_id=v_order and oi.status<>'cancelled' for update loop
        if r.financial_status='RECOGNIZED' then
          insert into public.financial_ledger(event_type,amount_minor,order_id,order_item_id,customer_id,actor_admin_id)
          select 'REVERSAL',-fl.amount_minor,v_order,r.id,o.customer_id,v_actor
          from public.financial_ledger fl join public.orders o on o.id=v_order
          where fl.order_item_id=r.id and fl.event_type='ORDER_ITEM_CHARGE'
          order by fl.created_at desc limit 1;
        end if;
        update public.order_items set status='cancelled',operational_status='CANCELLED',financial_status=case when financial_status='RECOGNIZED' then 'REVERSED' else financial_status end,
          cancelled_at=now(),updated_at=now(),version=version+1 where id=r.id;
      end loop;
      update public.orders set status='cancelled',cancelled_at=now(),updated_at=now(),version=version+1 where id=v_order;
      v_result:=jsonb_build_object('orderId',v_order);

    when 'CREATE_PAYMENT','POST_PAYMENT' then
      v_payment:=coalesce((p_payload->>'id')::uuid,p_command_id);
      v_customer:=(p_payload->>'customerId')::uuid;
      v_amount:=(p_payload->>'amountMinor')::bigint;
      if v_amount is null or v_amount<=0 then raise exception 'Invalid payment amount' using errcode='P0003'; end if;
      perform 1 from public.customers where id=v_customer and is_active for update;
      if not found then raise exception 'Customer not found or inactive' using errcode='P0006'; end if;
      insert into public.payments(id,customer_id,amount_minor,payment_method,reference,actor_admin_id,command_id)
      values(v_payment,v_customer,v_amount,coalesce(p_payload->>'paymentMethod','CASH'),p_payload->>'reference',v_actor,p_command_id);
      insert into public.financial_ledger(event_type,amount_minor,customer_id,actor_admin_id,reference_id)
      values('PAYMENT',v_amount,v_customer,v_actor,v_payment);
      for r in
        select oi.id,oi.order_id,oi.final_charge_snapshot_minor,
          greatest(0,oi.final_charge_snapshot_minor-coalesce(sum(pa.allocated_amount_minor),0)) due
        from public.order_items oi
        join public.orders o on o.id=oi.order_id
        left join public.payment_allocations pa on pa.order_item_id=oi.id
        where o.customer_id=v_customer and oi.financial_status='RECOGNIZED'
        group by oi.id,oi.order_id,oi.final_charge_snapshot_minor,oi.created_at
        having greatest(0,oi.final_charge_snapshot_minor-coalesce(sum(pa.allocated_amount_minor),0))>0
        order by oi.created_at,oi.id loop
        exit when v_amount<=0;
        v_final:=least(v_amount,r.due);
        insert into public.payment_allocations(payment_id,order_item_id,order_id,allocated_amount_minor)
        values(v_payment,r.id,r.order_id,v_final);
        v_amount:=v_amount-v_final;
        update public.order_items set payment_status=case when v_final>=r.due then 'PAID' else 'PARTIALLY_PAID' end,updated_at=now(),version=version+1 where id=r.id;
      end loop;
      if v_amount>0 then
        insert into public.financial_ledger(event_type,amount_minor,customer_id,actor_admin_id,reference_id)
        values('CREDIT_ADJUSTMENT',v_amount,v_customer,v_actor,v_payment);
      end if;
      v_result:=jsonb_build_object('paymentId',v_payment,'amountMinor',v_amount);

    when 'CREATE_CUSTOMER_CREDIT' then
      v_customer:=(p_payload->>'customerId')::uuid; v_amount:=(p_payload->>'amountMinor')::bigint;
      if v_amount<=0 then raise exception 'Invalid credit amount' using errcode='P0003'; end if;
      insert into public.financial_ledger(id,event_type,amount_minor,customer_id,actor_admin_id,reference_id,metadata)
      values(p_command_id,'CREDIT_ADJUSTMENT',v_amount,v_customer,v_actor,p_command_id,coalesce(p_payload->'metadata','{}'::jsonb));
      insert into public.payments(id,customer_id,amount_minor,payment_method,reference,actor_admin_id,command_id)
      values(p_command_id,v_customer,v_amount,'CASH',coalesce(p_payload->>'note','Customer credit'),v_actor,p_command_id);
      v_result:=jsonb_build_object('ledgerId',p_command_id,'paymentId',p_command_id);

    when 'CONSUME_CUSTOMER_CREDIT' then
      v_customer:=(p_payload->>'customerId')::uuid; v_amount:=(p_payload->>'amountMinor')::bigint;
      insert into public.financial_ledger(id,event_type,amount_minor,customer_id,order_id,actor_admin_id,reference_id)
      values(p_command_id,'CREDIT_USED',-v_amount,(p_payload->>'customerId')::uuid,(p_payload->>'orderId')::uuid,v_actor,p_command_id);
      v_result:=jsonb_build_object('ledgerId',p_command_id);

    when 'CREATE_REFUND' then
      v_customer:=(p_payload->>'customerId')::uuid; v_amount:=(p_payload->>'amountMinor')::bigint;
      if not exists(select 1 from public.financial_ledger where id=(p_payload->>'referenceEventId')::uuid and customer_id=v_customer) then
        raise exception 'Referenced financial event not found' using errcode='P0006';
      end if;
      insert into public.financial_ledger(id,event_type,amount_minor,customer_id,actor_admin_id,reference_id)
      values(p_command_id,'REFUND',-v_amount,v_customer,v_actor,(p_payload->>'referenceEventId')::uuid);
      v_result:=jsonb_build_object('ledgerId',p_command_id);

    when 'CREATE_GOAL' then
      v_goal:=coalesce((p_payload->>'id')::uuid,p_command_id);
      insert into public.goals(id,customer_id,target_quantity,current_progress,bonus_amount_minor,duration_days,status,started_at,expires_at)
      values(v_goal,(p_payload->>'customerId')::uuid,(p_payload->>'targetQuantity')::integer,0,
        (p_payload->>'bonusAmountMinor')::bigint,(p_payload->>'durationDays')::integer,'ACTIVE',
        coalesce((p_payload->>'startedAt')::timestamptz,now()),(p_payload->>'expiresAt')::timestamptz);
      v_result:=jsonb_build_object('goalId',v_goal);

    when 'UPDATE_GOAL_CONFIG' then
      v_goal:=(p_payload->>'id')::uuid;
      update public.goals set target_quantity=coalesce((p_payload->>'targetQuantity')::integer,target_quantity),
        duration_days=coalesce((p_payload->>'durationDays')::integer,duration_days),
        bonus_amount_minor=coalesce((p_payload->>'bonusAmountMinor')::bigint,bonus_amount_minor),
        expires_at=coalesce((p_payload->>'expiresAt')::timestamptz,expires_at),
        status=coalesce(p_payload->>'status',status),completed_at=coalesce((p_payload->>'completedAt')::timestamptz,completed_at),
        bonus_ledger_id=coalesce((p_payload->>'bonusLedgerId')::uuid,bonus_ledger_id),updated_at=now(),version=version+1
      where id=v_goal;
      if not found then raise exception 'Goal not found' using errcode='P0006'; end if;
      if coalesce(p_payload->>'status','')='COMPLETED' and (p_payload->>'bonusLedgerId') is not null then
        insert into public.financial_ledger(id,event_type,amount_minor,customer_id,actor_admin_id,reference_id,metadata)
        select (p_payload->>'bonusLedgerId')::uuid,'BONUS',coalesce((p_payload->>'bonusAmountMinor')::bigint,0),
          customer_id,v_actor,v_goal,jsonb_build_object('reason','GOAL_COMPLETED_VIA_CONFIG_UPDATE','goalId',v_goal)
        from public.goals where id=v_goal
        on conflict(id) do nothing;
      end if;
      v_result:=jsonb_build_object('goalId',v_goal);

    when 'UPDATE_GOAL_PROGRESS' then
      v_goal:=coalesce((p_payload->>'goalId')::uuid,(p_payload->>'id')::uuid);
      update public.goals set current_progress=coalesce((p_payload->>'currentProgress')::integer,current_progress),
        status=coalesce(p_payload->>'status',status),completed_at=coalesce((p_payload->>'completedAt')::timestamptz,completed_at),
        bonus_ledger_id=coalesce((p_payload->>'bonusLedgerId')::uuid,bonus_ledger_id),updated_at=now(),version=version+1
      where id=v_goal;
      if not found then raise exception 'Goal not found' using errcode='P0006'; end if;
      if coalesce((p_payload->>'bonusGranted')::boolean,false) and (p_payload->>'bonusLedgerId') is not null then
        insert into public.financial_ledger(id,event_type,amount_minor,customer_id,actor_admin_id,reference_id,metadata)
        select (p_payload->>'bonusLedgerId')::uuid,'BONUS',coalesce((p_payload->>'bonusAmountMinor')::bigint,0),
          customer_id,v_actor,v_goal,jsonb_build_object('reason','GOAL_COMPLETED','goalId',v_goal)
        from public.goals where id=v_goal
        on conflict(id) do nothing;
      end if;
      v_result:=jsonb_build_object('goalId',v_goal);

    when 'RECORD_GOAL_REQUEST' then
      v_request:=coalesce((p_payload->>'id')::uuid,p_command_id);
      insert into public.goal_requests(id,customer_id,requested_target,status)
      values(v_request,(p_payload->>'customerId')::uuid,(p_payload->>'requestedTarget')::integer,'PENDING');
      v_result:=jsonb_build_object('requestId',v_request);

    when 'APPROVE_GOAL_REQUEST' then
      v_request:=(p_payload->>'requestId')::uuid;
      update public.goal_requests set status='APPROVED',reviewed_by=v_actor,reviewed_at=now(),resulting_goal_id=coalesce((p_payload->>'resultingGoalId')::uuid,resulting_goal_id),updated_at=now(),version=version+1 where id=v_request;
      if not found then raise exception 'Goal request not found' using errcode='P0006'; end if;
      v_goal:=coalesce((p_payload->>'resultingGoalId')::uuid,gen_random_uuid());
      insert into public.goals(id,customer_id,target_quantity,current_progress,bonus_amount_minor,duration_days,status,started_at,expires_at)
      select v_goal,customer_id,coalesce((p_payload->>'targetQuantity')::integer,coalesce(requested_target,10)),0,
        coalesce((p_payload->>'bonusAmountMinor')::bigint,0),
        coalesce((p_payload->>'durationDays')::integer,7),'ACTIVE',now(),
        now() + make_interval(days => coalesce((p_payload->>'durationDays')::integer,7))
      from public.goal_requests where id=v_request
      on conflict(id) do nothing;
      v_result:=jsonb_build_object('requestId',v_request,'goalId',v_goal);

    when 'REJECT_GOAL_REQUEST' then
      v_request:=(p_payload->>'requestId')::uuid;
      update public.goal_requests set status='REJECTED',reviewed_by=v_actor,reviewed_at=now(),rejection_reason=p_payload->>'rejectionReason',updated_at=now(),version=version+1 where id=v_request;
      if not found then raise exception 'Goal request not found' using errcode='P0006'; end if;
      v_result:=jsonb_build_object('requestId',v_request);
  end case;

  insert into public.processed_commands(command_id,command_type,payload_hash,aggregate_type,aggregate_id,actor_admin_id,result_payload)
  values(p_command_id,p_command_type,encode(digest(coalesce(p_payload,'{}'::jsonb)::text,'sha256'),'hex'),p_aggregate_type,p_aggregate_id,v_actor,v_result);

  return jsonb_build_object('success',true,'commandId',p_command_id,'serverVersion',1,'rpcReached',true,'result',v_result);
end;
$$;

create or replace function public.execute_canonical_sync_command(
  p_command_id uuid,p_command_type varchar(100),p_payload jsonb,p_payload_hash text default 'no_hash',
  p_device_id text default 'system',p_actor_id uuid default null
) returns jsonb
language plpgsql security definer set search_path=public
as $$
begin
  return public.execute_sync_command(p_command_id,p_command_type,null,null,p_payload,null);
end;
$$;

create or replace function public.execute_customer_top_up_atomic(
  p_command_id uuid,p_customer_id uuid,p_amount_minor bigint,p_bin text,p_note text default null
) returns jsonb language plpgsql security definer set search_path=public
as $$
declare v_result jsonb; v_balance bigint;
begin
 v_result:=public.execute_sync_command(
   p_command_id,'CREATE_CUSTOMER_CREDIT','financial_ledger',p_customer_id,
   jsonb_build_object('customerId',p_customer_id,'amountMinor',p_amount_minor,'bin',p_bin,'note',p_note),
   null
 );
 select coalesce(sum(amount_minor),0) into v_balance from public.financial_ledger where customer_id=p_customer_id;
 return jsonb_build_object('success',true,'transactionId',p_command_id,'newBalanceMinor',v_balance,'result',v_result);
end $$;

create or replace function public.verify_admin_bin_with_attempt_tracking(p_bin text)
returns jsonb language plpgsql security definer set search_path=public
as $$
begin
  return jsonb_build_object('success',public.verify_admin_bin(p_bin));
end;
$$;

create or replace function public.set_admin_bin(p_new_bin text)
returns jsonb language plpgsql security definer set search_path=public
as $$
begin
  update public.admins set bin_hash=crypt(p_new_bin,gen_salt('bf')),updated_at=now(),version=version+1 where id=public.current_admin_id();
  return jsonb_build_object('success',true);
end;
$$;

create or replace function public.get_or_create_customer_qr(p_customer_id uuid)
returns text language plpgsql security definer set search_path=public as $$
declare v_token text;
begin
 select public_token into v_token from public.qr_tokens where target_id=p_customer_id and token_type='CUSTOMER' and is_active limit 1;
 if v_token is not null then return v_token; end if;
 v_token:=replace(replace(replace(encode(gen_random_bytes(24),'base64'),'+','-'),'/','_'),'=','');
 insert into public.qr_tokens(token_hash,public_token,token_type,target_id) values(encode(digest(v_token,'sha256'),'hex'),v_token,'CUSTOMER',p_customer_id);
 return v_token;
end $$;

create or replace function public.rotate_customer_qr(p_customer_id uuid)
returns text language plpgsql security definer set search_path=public as $$
declare v_token text;
begin
 update public.qr_tokens set is_active=false where target_id=p_customer_id and token_type='CUSTOMER';
 v_token:=replace(replace(replace(encode(gen_random_bytes(24),'base64'),'+','-'),'/','_'),'=','');
 insert into public.qr_tokens(token_hash,public_token,token_type,target_id) values(encode(digest(v_token,'sha256'),'hex'),v_token,'CUSTOMER',p_customer_id);
 return v_token;
end $$;

create or replace function public.get_or_create_order_qr(p_order_id uuid)
returns text language plpgsql security definer set search_path=public as $$
declare v_token text;
begin
 select public_token into v_token from public.qr_tokens where target_id=p_order_id and token_type='ORDER' and is_active limit 1;
 if v_token is not null then return v_token; end if;
 v_token:=replace(replace(replace(encode(gen_random_bytes(24),'base64'),'+','-'),'/','_'),'=','');
 insert into public.qr_tokens(token_hash,public_token,token_type,target_id) values(encode(digest(v_token,'sha256'),'hex'),v_token,'ORDER',p_order_id);
 return v_token;
end $$;

do $$ begin
 if not exists(select 1 from pg_type where typname='public_customer_qr_result') then
  create type public.public_customer_qr_result as (customer_name text, customer_code text);
 end if;
end $$;

-- Public QR functions are intentionally read-only. They return the minimum
-- customer/order projection and never expose admin-only fields.
create or replace function public.public_resolve_order_qr(p_public_token text)
returns setof jsonb language plpgsql security definer set search_path=public as $$
declare v qr_tokens%rowtype;
begin
 select * into v from public.qr_tokens where public_token=p_public_token and token_type='ORDER' and is_active and (expires_at is null or expires_at>now());
 if v.id is null then return; end if;
 return query
 select jsonb_build_object('order_id',o.id,'order_number',o.display_number,'customer_name',c.name,'status',o.status,'created_at',o.created_at,
   'items_count',(select count(*) from public.order_items oi where oi.order_id=o.id),
   'items',(select coalesce(jsonb_agg(jsonb_build_object('name',oi.device_name_snapshot,'status',oi.status,'has_charger',oi.has_charger) order by oi.item_sequence),'[]'::jsonb) from public.order_items oi where oi.order_id=o.id))
 from public.orders o join public.customers c on c.id=o.customer_id where o.id=v.target_id;
end $$;

create or replace function public.public_resolve_customer_qr(p_public_token text)
returns setof public_customer_qr_result language plpgsql security definer set search_path=public as $$
declare v qr_tokens%rowtype;
begin
 select * into v from public.qr_tokens where public_token=p_public_token and token_type='CUSTOMER' and is_active and (expires_at is null or expires_at>now());
 if v.id is null then return; end if;
 return query select c.name, left(replace(c.id::text,'-',''),4) from public.customers c where c.id=v.target_id;
end $$;

-- Security boundary: clients can read through authenticated REST for the
-- read-model tables; canonical mutations must use execute_sync_command/RPCs.
do $$
declare t text;
begin
  foreach t in array array['business_days','customers','device_types','devices','orders','order_items','financial_ledger','payments','payment_allocations','goals','goal_requests','qr_tokens','order_number_reservations','processed_commands','change_log','audit_logs','notifications','customer_requests','customer_push_subscriptions','customer_delivery_push_logs','customer_activity','events','personal_financial_transactions','system_settings','app_canonical_state']
  loop
    execute format('alter table public.%I enable row level security',t);
    execute format('drop policy if exists authenticated_read on public.%I',t);
    execute format('create policy authenticated_read on public.%I for select to authenticated using (true)',t);
  end loop;
end $$;

alter table public.admin_audit_logs enable row level security;
drop policy if exists admin_audit_read on public.admin_audit_logs;
create policy admin_audit_read on public.admin_audit_logs for select to authenticated
using (
  exists (
    select 1 from public.admins a
    where a.id=public.current_admin_id()
      and (a.role='SUPER_ADMIN' or 'admin:manage'=any(a.permissions))
  )
);

alter table public.admin_custom_permissions enable row level security;
drop policy if exists admin_custom_permissions_read on public.admin_custom_permissions;
create policy admin_custom_permissions_read on public.admin_custom_permissions for select to authenticated
using (
  exists (
    select 1 from public.admins a
    where a.id=public.current_admin_id()
      and (a.role='SUPER_ADMIN' or 'admin:manage'=any(a.permissions))
  )
);

-- Direct client INSERT/UPDATE/DELETE policies are deliberately absent.
-- SECURITY DEFINER RPCs own all canonical writes.

commit;


-- ============================================================================
-- Canonical Admin Management Security Contract (2026-10-08)
-- ============================================================================
-- Canonical Admin Management Security + Online-only execution contract
-- Date: 2026-10-08
--
-- Goals:
-- 1. One server-side Super Admin authorization gate for subordinate-admin mutations.
-- 2. Preserve existing mutation semantics and audit actions.
-- 3. Never introduce an offline/outbox path for security-sensitive admin mutations.
-- 4. Return explicit authorization errors so the client cannot look like it silently reset.

CREATE OR REPLACE FUNCTION public.authorize_super_admin_admin_management(
  p_caller_bin TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
  v_caller_bin_hash VARCHAR(255);
  v_caller_role VARCHAR(50);
  v_caller_is_active BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '28000';
  END IF;

  SELECT id, bin_hash, role, is_active
  INTO v_caller_id, v_caller_bin_hash, v_caller_role, v_caller_is_active
  FROM public.admins
  WHERE auth_user_id = auth.uid()
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Caller admin profile not found'
      USING ERRCODE = '42501';
  END IF;

  IF v_caller_is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Caller admin profile is suspended'
      USING ERRCODE = '42501';
  END IF;

  IF upper(replace(trim(coalesce(v_caller_role, '')), ' ', '_')) <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Unauthorized operation: SUPER_ADMIN role required'
      USING ERRCODE = '42501';
  END IF;

  IF p_caller_bin IS NULL OR trim(p_caller_bin) = '' THEN
    RAISE EXCEPTION 'Authorization BIN is required'
      USING ERRCODE = '22023';
  END IF;

  IF v_caller_bin_hash IS NULL
     OR crypt(trim(p_caller_bin), v_caller_bin_hash) <> v_caller_bin_hash THEN
    RAISE EXCEPTION 'Invalid authorization BIN credential'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_caller_id;
END;
$$;

REVOKE ALL ON FUNCTION public.authorize_super_admin_admin_management(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.authorize_super_admin_admin_management(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.rpc_update_admin_password(
  p_target_admin_id UUID,
  p_new_password TEXT,
  p_caller_bin TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
  v_target_auth_user_id UUID;
  v_encrypted_password TEXT;
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_caller_bin);

  SELECT auth_user_id INTO v_target_auth_user_id
  FROM public.admins
  WHERE id = p_target_admin_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target admin account not found'
      USING ERRCODE = '23503';
  END IF;

  IF p_new_password IS NULL OR p_new_password = '' OR length(p_new_password) < 6 THEN
    RAISE EXCEPTION 'Password must be at least 6 characters'
      USING ERRCODE = '22023';
  END IF;

  v_encrypted_password := crypt(p_new_password, gen_salt('bf', 10));

  UPDATE auth.users
  SET encrypted_password = v_encrypted_password,
      updated_at = NOW()
  WHERE id = v_target_auth_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target authentication account not found'
      USING ERRCODE = '23503';
  END IF;

  UPDATE public.admins
  SET version = version + 1,
      updated_at = NOW()
  WHERE id = p_target_admin_id;

  INSERT INTO public.admin_audit_logs (
    actor_admin_id,
    action,
    target_admin_id,
    metadata
  ) VALUES (
    v_caller_id,
    'ADMIN_PASSWORD_RESET',
    p_target_admin_id,
    jsonb_build_object('timestamp', NOW())
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_update_admin_bin(
  p_target_admin_id UUID,
  p_new_bin TEXT,
  p_caller_bin TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
  v_new_bin_hash VARCHAR(255);
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_caller_bin);

  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_target_admin_id) THEN
    RAISE EXCEPTION 'Target admin account not found'
      USING ERRCODE = '23503';
  END IF;

  IF p_new_bin IS NULL OR p_new_bin = '' OR NOT (p_new_bin ~ '^[0-9]{4,}$') THEN
    RAISE EXCEPTION 'BIN must be at least 4 numeric digits'
      USING ERRCODE = '22023';
  END IF;

  v_new_bin_hash := crypt(trim(p_new_bin), gen_salt('bf', 10));

  UPDATE public.admins
  SET bin_hash = v_new_bin_hash,
      version = version + 1,
      updated_at = NOW()
  WHERE id = p_target_admin_id;

  INSERT INTO public.admin_audit_logs (
    actor_admin_id,
    action,
    target_admin_id,
    metadata
  ) VALUES (
    v_caller_id,
    'ADMIN_BIN_RESET',
    p_target_admin_id,
    jsonb_build_object('timestamp', NOW())
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_set_admin_custom_permissions(
  p_target_admin_id UUID,
  p_permissions TEXT[],
  p_bin TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
  v_perm TEXT;
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_bin);

  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_target_admin_id) THEN
    RAISE EXCEPTION 'Target admin not found'
      USING ERRCODE = '23503';
  END IF;

  DELETE FROM public.admin_custom_permissions
  WHERE admin_id = p_target_admin_id;

  IF p_permissions IS NOT NULL AND array_length(p_permissions, 1) > 0 THEN
    FOREACH v_perm IN ARRAY p_permissions LOOP
      IF v_perm IS NOT NULL AND trim(v_perm) <> '' THEN
        INSERT INTO public.admin_custom_permissions (
          admin_id,
          permission,
          is_grant
        ) VALUES (
          p_target_admin_id,
          trim(v_perm),
          TRUE
        )
        ON CONFLICT (admin_id, permission) DO UPDATE SET
          is_grant = TRUE;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.admin_audit_logs (
    actor_admin_id,
    action,
    target_admin_id,
    metadata
  ) VALUES (
    v_caller_id,
    'ADMIN_CUSTOM_PERMISSIONS_UPDATED',
    p_target_admin_id,
    jsonb_build_object(
      'permissions_count', COALESCE(array_length(p_permissions, 1), 0),
      'timestamp', NOW()
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_grant_custom_permission(
  p_target_admin_id UUID,
  p_permission VARCHAR,
  p_is_grant BOOLEAN,
  p_bin TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_bin);

  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_target_admin_id) THEN
    RAISE EXCEPTION 'Target admin not found'
      USING ERRCODE = '23503';
  END IF;

  INSERT INTO public.admin_custom_permissions (
    admin_id,
    permission,
    is_grant
  ) VALUES (
    p_target_admin_id,
    p_permission,
    p_is_grant
  )
  ON CONFLICT (admin_id, permission) DO UPDATE SET
    is_grant = EXCLUDED.is_grant;

  INSERT INTO public.admin_audit_logs (
    actor_admin_id,
    action,
    target_admin_id,
    metadata
  ) VALUES (
    v_caller_id,
    CASE
      WHEN p_is_grant = TRUE THEN 'ADMIN_PERMISSION_GRANTED'::VARCHAR(100)
      ELSE 'ADMIN_PERMISSION_REVOKED'::VARCHAR(100)
    END,
    p_target_admin_id,
    jsonb_build_object('permission', p_permission, 'is_grant', p_is_grant)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_revoke_custom_permission(
  p_target_admin_id UUID,
  p_permission VARCHAR,
  p_bin TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_bin);

  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_target_admin_id) THEN
    RAISE EXCEPTION 'Target admin not found'
      USING ERRCODE = '23503';
  END IF;

  DELETE FROM public.admin_custom_permissions
  WHERE admin_id = p_target_admin_id
    AND permission = p_permission;

  INSERT INTO public.admin_audit_logs (
    actor_admin_id,
    action,
    target_admin_id,
    metadata
  ) VALUES (
    v_caller_id,
    'ADMIN_PERMISSION_REVOKED',
    p_target_admin_id,
    jsonb_build_object('permission', p_permission, 'is_revocation', TRUE)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_suspend_admin(
  p_target_admin_id UUID,
  p_bin TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_bin);

  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_target_admin_id) THEN
    RAISE EXCEPTION 'Target admin not found'
      USING ERRCODE = '23503';
  END IF;

  IF v_caller_id = p_target_admin_id THEN
    RAISE EXCEPTION 'Cannot suspend own administrator account'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.admins
  SET is_active = FALSE,
      disabled_at = NOW(),
      disabled_by = v_caller_id,
      updated_at = NOW(),
      version = version + 1
  WHERE id = p_target_admin_id;

  INSERT INTO public.admin_audit_logs (
    actor_admin_id,
    action,
    target_admin_id,
    metadata
  ) VALUES (
    v_caller_id,
    'ADMIN_SUSPENDED',
    p_target_admin_id,
    jsonb_build_object('timestamp', NOW())
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_activate_admin(
  p_target_admin_id UUID,
  p_bin TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_bin);

  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_target_admin_id) THEN
    RAISE EXCEPTION 'Target admin not found'
      USING ERRCODE = '23503';
  END IF;

  UPDATE public.admins
  SET is_active = TRUE,
      disabled_at = NULL,
      disabled_by = NULL,
      updated_at = NOW(),
      version = version + 1
  WHERE id = p_target_admin_id;

  INSERT INTO public.admin_audit_logs (
    actor_admin_id,
    action,
    target_admin_id,
    metadata
  ) VALUES (
    v_caller_id,
    'ADMIN_ACTIVATED',
    p_target_admin_id,
    jsonb_build_object('timestamp', NOW())
  );
END;
$$;

-- Creation is also an online-only sensitive mutation. It remains a direct RPC;
-- it is never placed in the application's offline Outbox.
CREATE OR REPLACE FUNCTION public.rpc_create_admin(
  p_username TEXT,
  p_email TEXT,
  p_password TEXT,
  p_full_name TEXT,
  p_role TEXT,
  p_bin TEXT,
  p_caller_bin TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
  v_new_user_id UUID;
  v_new_admin_id UUID;
  v_clean_email VARCHAR(255);
  v_clean_username VARCHAR(100);
  v_clean_full_name VARCHAR(200);
  v_clean_role VARCHAR(50);
  v_encrypted_password TEXT;
  v_bin_hash VARCHAR(255);
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_caller_bin);

  v_clean_email := trim(lower(p_email));
  v_clean_username := trim(p_username);
  v_clean_full_name := trim(p_full_name);
  v_clean_role := trim(p_role);

  IF v_clean_role IN ('SUPER_ADMIN', 'Super Admin') THEN
    RAISE EXCEPTION 'Cannot create subordinate accounts with SUPER_ADMIN role'
      USING ERRCODE = '42501';
  END IF;

  IF v_clean_username = '' THEN
    RAISE EXCEPTION 'Username cannot be empty'
      USING ERRCODE = '22023';
  END IF;

  IF v_clean_email = '' THEN
    RAISE EXCEPTION 'Email cannot be empty'
      USING ERRCODE = '22023';
  END IF;

  IF p_password IS NULL OR p_password = '' OR length(p_password) < 6 THEN
    RAISE EXCEPTION 'Password must be at least 6 characters'
      USING ERRCODE = '22023';
  END IF;

  IF p_bin IS NULL OR p_bin = '' OR NOT (p_bin ~ '^[0-9]{4,}$') THEN
    RAISE EXCEPTION 'BIN must be at least 4 numeric digits'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (SELECT 1 FROM auth.users WHERE email = v_clean_email) THEN
    RAISE EXCEPTION 'An account with this email already exists'
      USING ERRCODE = '23505';
  END IF;

  IF EXISTS (SELECT 1 FROM public.admins WHERE username = v_clean_username) THEN
    RAISE EXCEPTION 'An admin account with this username already exists'
      USING ERRCODE = '23505';
  END IF;

  v_encrypted_password := crypt(p_password, gen_salt('bf', 10));
  v_bin_hash := crypt(trim(p_bin), gen_salt('bf', 10));

  INSERT INTO auth.users (
    id,
    instance_id,
    email,
    encrypted_password,
    email_confirmed_at,
    aud,
    role,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
  ) VALUES (
    gen_random_uuid(),
    '00000000-0000-0000-0000-000000000000'::UUID,
    v_clean_email,
    v_encrypted_password,
    NOW(),
    'authenticated',
    'authenticated',
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object(
      'sub', v_clean_email,
      'username', v_clean_username,
      'full_name', v_clean_full_name,
      'email', v_clean_email,
      'email_verified', TRUE,
      'phone_verified', FALSE
    ),
    NOW(),
    NOW()
  )
  RETURNING id INTO v_new_user_id;

  INSERT INTO auth.identities (
    id,
    user_id,
    identity_data,
    provider,
    provider_id,
    last_sign_in_at,
    created_at,
    updated_at,
    email
  ) VALUES (
    gen_random_uuid(),
    v_new_user_id,
    jsonb_build_object(
      'sub', v_new_user_id::text,
      'email', v_clean_email,
      'email_verified', TRUE,
      'phone_verified', FALSE
    ),
    'email',
    v_new_user_id::text,
    NOW(),
    NOW(),
    NOW(),
    v_clean_email
  );

  INSERT INTO public.admins (
    id,
    auth_user_id,
    username,
    full_name,
    email,
    role,
    is_active,
    bin_hash,
    version,
    created_at,
    updated_at
  ) VALUES (
    gen_random_uuid(),
    v_new_user_id,
    v_clean_username,
    v_clean_full_name,
    v_clean_email,
    v_clean_role,
    TRUE,
    v_bin_hash,
    1,
    NOW(),
    NOW()
  )
  RETURNING id INTO v_new_admin_id;

  INSERT INTO public.admin_audit_logs (
    actor_admin_id,
    action,
    target_admin_id,
    metadata
  ) VALUES (
    v_caller_id,
    'ADMIN_CREATED',
    v_new_admin_id,
    jsonb_build_object(
      'username', v_clean_username,
      'role', v_clean_role,
      'timestamp', NOW()
    )
  );

  RETURN v_new_admin_id;
END;
$$;

-- The public Data API must not expose the authorization helper to anonymous callers.
REVOKE ALL ON FUNCTION public.authorize_super_admin_admin_management(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.authorize_super_admin_admin_management(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.authorize_super_admin_admin_management(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';


-- BIN crypt type correction
-- Fix pgcrypto crypt(text,text) calls where admins.bin_hash is varchar.
-- This is a type-contract correction only; no credential/data values are changed.

CREATE OR REPLACE FUNCTION public.authorize_super_admin_admin_management(
  p_caller_bin TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
  v_caller_bin_hash TEXT;
  v_caller_role TEXT;
  v_caller_is_active BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT id, bin_hash::text, role::text, is_active
  INTO v_caller_id, v_caller_bin_hash, v_caller_role, v_caller_is_active
  FROM public.admins
  WHERE auth_user_id = auth.uid()
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Caller admin profile not found' USING ERRCODE = '42501';
  END IF;

  IF v_caller_is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Caller admin profile is suspended' USING ERRCODE = '42501';
  END IF;

  IF upper(replace(trim(coalesce(v_caller_role, '')), ' ', '_')) <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Unauthorized operation: SUPER_ADMIN role required' USING ERRCODE = '42501';
  END IF;

  IF p_caller_bin IS NULL OR trim(p_caller_bin) = '' THEN
    RAISE EXCEPTION 'Authorization BIN is required' USING ERRCODE = '22023';
  END IF;

  IF v_caller_bin_hash IS NULL
     OR crypt(trim(p_caller_bin)::text, v_caller_bin_hash::text) <> v_caller_bin_hash::text THEN
    RAISE EXCEPTION 'Invalid authorization BIN credential' USING ERRCODE = '42501';
  END IF;

  RETURN v_caller_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.verify_admin_bin(p_bin TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admins a
    WHERE a.id = public.current_admin_id()
      AND a.is_active
      AND a.bin_hash IS NOT NULL
      AND crypt(p_bin::text, a.bin_hash::text) = a.bin_hash::text
  );
$$;

CREATE OR REPLACE FUNCTION public.create_authoritative_backup_checkpoint(
  p_entered_bin TEXT,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bin_verified BOOLEAN := FALSE;
    v_chk_id UUID := gen_random_uuid();
    v_seq BIGINT;
    v_manifest JSONB;
    v_snapshot JSONB;
    v_integrity_hash TEXT;
    v_max_seq BIGINT;
    v_count_settings INT;
    v_count_customers INT;
    v_count_days INT;
    v_count_devices INT;
    v_count_orders INT;
    v_count_items INT;
    v_count_payments INT;
    v_count_allocations INT;
    v_count_ledger INT;
    v_count_goals INT;
    v_count_goal_requests INT;
    v_ledger_sum BIGINT;
BEGIN
    IF auth.uid() IS NOT NULL THEN
        SELECT public.verify_admin_bin(p_entered_bin) INTO v_bin_verified;
    ELSE
        SELECT (crypt(trim(p_entered_bin)::text, bin_hash::text) = bin_hash::text)
        INTO v_bin_verified
        FROM public.admins
        WHERE role IN ('SUPER_ADMIN', 'Super Admin') AND is_active = TRUE
        LIMIT 1;
    END IF;

    IF v_bin_verified IS NOT TRUE THEN
        RAISE EXCEPTION 'Security Authorization Failed: Invalid BIN';
    END IF;

    SELECT count(*) INTO v_count_settings FROM public.system_settings;
    SELECT count(*) INTO v_count_customers FROM public.customers;
    SELECT count(*) INTO v_count_days FROM public.business_days;
    SELECT count(*) INTO v_count_devices FROM public.device_types;
    SELECT count(*) INTO v_count_orders FROM public.orders;
    SELECT count(*) INTO v_count_items FROM public.order_items;
    SELECT count(*) INTO v_count_payments FROM public.payments;
    SELECT count(*) INTO v_count_allocations FROM public.payment_allocations;
    SELECT count(*), COALESCE(SUM(amount_minor), 0) INTO v_count_ledger, v_ledger_sum FROM public.financial_ledger;
    SELECT count(*) INTO v_count_goals FROM public.goals;
    SELECT count(*) INTO v_count_goal_requests FROM public.goal_requests;
    SELECT COALESCE(MAX(sequence_id), 0) INTO v_max_seq FROM public.change_log;

    v_snapshot := jsonb_build_object(
        'systemSettings', COALESCE((SELECT jsonb_agg(row_to_json(s)) FROM public.system_settings s), '[]'::jsonb),
        'customers', COALESCE((SELECT jsonb_agg(row_to_json(c)) FROM public.customers c), '[]'::jsonb),
        'deviceTypes', COALESCE((SELECT jsonb_agg(row_to_json(d)) FROM public.device_types d), '[]'::jsonb),
        'businessDays', COALESCE((SELECT jsonb_agg(row_to_json(b)) FROM public.business_days b), '[]'::jsonb),
        'orders', COALESCE((SELECT jsonb_agg(row_to_json(o)) FROM public.orders o), '[]'::jsonb),
        'orderItems', COALESCE((SELECT jsonb_agg(row_to_json(oi)) FROM public.order_items oi), '[]'::jsonb),
        'payments', COALESCE((SELECT jsonb_agg(row_to_json(p)) FROM public.payments p), '[]'::jsonb),
        'paymentAllocations', COALESCE((SELECT jsonb_agg(row_to_json(pa)) FROM public.payment_allocations pa), '[]'::jsonb),
        'financialLedger', COALESCE((SELECT jsonb_agg(row_to_json(fl)) FROM public.financial_ledger fl), '[]'::jsonb),
        'goals', COALESCE((SELECT jsonb_agg(row_to_json(g)) FROM public.goals g), '[]'::jsonb),
        'goalRequests', COALESCE((SELECT jsonb_agg(row_to_json(gr)) FROM public.goal_requests gr), '[]'::jsonb)
    );

    v_integrity_hash := md5(format('%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s:%s',
        v_count_settings, v_count_customers, v_count_days, v_count_devices,
        v_count_orders, v_count_items, v_count_payments, v_count_allocations,
        v_count_ledger, v_ledger_sum, v_count_goals, v_count_goal_requests
    ));

    v_manifest := jsonb_build_object(
        'checkpointId', v_chk_id,
        'schemaVersion', 1,
        'formatVersion', '1.0',
        'authoritativeMaxSequence', v_max_seq,
        'createdAt', NOW(),
        'counts', jsonb_build_object(
            'systemSettings', v_count_settings,
            'customers', v_count_customers,
            'businessDays', v_count_days,
            'deviceTypes', v_count_devices,
            'orders', v_count_orders,
            'orderItems', v_count_items,
            'payments', v_count_payments,
            'paymentAllocations', v_count_allocations,
            'financialLedger', v_count_ledger,
            'goals', v_count_goals,
            'goalRequests', v_count_goal_requests
        ),
        'financialIntegrity', jsonb_build_object('totalLedgerSumMinor', v_ledger_sum)
    );

    INSERT INTO public.backup_checkpoints (checkpoint_id, checkpoint_type, manifest, integrity_hash, snapshot_data, created_at)
    VALUES (v_chk_id, COALESCE(p_notes, 'MANUAL'), v_manifest, v_integrity_hash, v_snapshot, NOW())
    RETURNING checkpoint_sequence INTO v_seq;

    RETURN jsonb_build_object(
        'success', TRUE,
        'checkpointId', v_chk_id,
        'checkpointSequence', v_seq,
        'integrityHash', v_integrity_hash,
        'manifest', v_manifest
    );
END;
$$;

-- restore_authoritative_backup_checkpoint is only a type-contract correction in
-- its authentication branch; keep the existing restore body unchanged by replacing
-- the two affected crypt expressions through a body-level recreation below.
CREATE OR REPLACE FUNCTION public.restore_authoritative_backup_checkpoint(
  p_entered_bin TEXT,
  p_checkpoint_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bin_verified BOOLEAN := FALSE;
    v_chk RECORD;
    v_rec RECORD;
BEGIN
    IF auth.uid() IS NOT NULL THEN
        SELECT public.verify_admin_bin(p_entered_bin) INTO v_bin_verified;
    ELSE
        SELECT (crypt(trim(p_entered_bin)::text, bin_hash::text) = bin_hash::text)
        INTO v_bin_verified
        FROM public.admins
        WHERE role IN ('SUPER_ADMIN', 'Super Admin') AND is_active = TRUE
        LIMIT 1;
    END IF;

    IF v_bin_verified IS NOT TRUE THEN
        RAISE EXCEPTION 'Security Authorization Failed: Invalid BIN';
    END IF;

    SELECT * INTO v_chk
    FROM public.backup_checkpoints
    WHERE checkpoint_id = p_checkpoint_id;

    IF v_chk.checkpoint_id IS NULL THEN
        RAISE EXCEPTION 'Backup Checkpoint Not Found: ID %', p_checkpoint_id;
    END IF;

    ALTER TABLE public.financial_ledger DISABLE TRIGGER trg_immutable_financial_ledger;
    ALTER TABLE public.order_items DISABLE TRIGGER trg_freeze_recognized_order_item;

    DELETE FROM public.goal_requests;
    DELETE FROM public.goals;
    DELETE FROM public.payment_allocations;
    DELETE FROM public.financial_ledger;
    DELETE FROM public.payments;
    DELETE FROM public.order_items;
    DELETE FROM public.orders;
    DELETE FROM public.business_days;
    DELETE FROM public.customers;
    DELETE FROM public.device_types;
    DELETE FROM public.system_settings;

    IF jsonb_typeof(v_chk.snapshot_data->'systemSettings') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'systemSettings') AS x(
            key VARCHAR(100), value_type VARCHAR(20), value_string TEXT, value_number BIGINT, value_boolean BOOLEAN, value_json JSONB, description TEXT, updated_at TIMESTAMPTZ, updated_by UUID
        ) LOOP
            INSERT INTO public.system_settings (key, value_type, value_string, value_number, value_boolean, value_json, description, updated_at, updated_by)
            VALUES (v_rec.key, v_rec.value_type, v_rec.value_string, v_rec.value_number, v_rec.value_boolean, v_rec.value_json, v_rec.description, COALESCE(v_rec.updated_at, NOW()), v_rec.updated_by);
        END LOOP;
    END IF;

    IF jsonb_typeof(v_chk.snapshot_data->'customers') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'customers') AS x(
            id UUID, name VARCHAR(200), phone VARCHAR(50), status VARCHAR(20), is_active BOOLEAN, notes TEXT, debt_limit_minor BIGINT, charger_fee_exempt BOOLEAN, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, version INTEGER
        ) LOOP
            INSERT INTO public.customers (id, name, phone, status, is_active, notes, debt_limit_minor, charger_fee_exempt, created_at, updated_at, deleted_at, version)
            VALUES (v_rec.id, v_rec.name, v_rec.phone, v_rec.status, v_rec.is_active, v_rec.notes, v_rec.debt_limit_minor, v_rec.charger_fee_exempt, v_rec.created_at, v_rec.updated_at, v_rec.deleted_at, v_rec.version);
        END LOOP;
    END IF;

    IF jsonb_typeof(v_chk.snapshot_data->'deviceTypes') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'deviceTypes') AS x(
            id UUID, name VARCHAR(200), name_ar VARCHAR(200), name_en VARCHAR(200), icon VARCHAR(50), base_price_minor BIGINT, charger_fee_enabled BOOLEAN, charger_fee_applicable BOOLEAN, is_active BOOLEAN, status VARCHAR(20), sort_order INTEGER, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, version INTEGER
        ) LOOP
            INSERT INTO public.device_types (id, name, name_ar, name_en, icon, base_price_minor, charger_fee_enabled, charger_fee_applicable, is_active, status, sort_order, created_at, updated_at, deleted_at, version)
            VALUES (v_rec.id, v_rec.name, v_rec.name_ar, v_rec.name_en, v_rec.icon, v_rec.base_price_minor, v_rec.charger_fee_enabled, v_rec.charger_fee_applicable, v_rec.is_active, v_rec.status, v_rec.sort_order, v_rec.created_at, v_rec.updated_at, v_rec.deleted_at, v_rec.version);
        END LOOP;
    END IF;

    IF jsonb_typeof(v_chk.snapshot_data->'businessDays') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'businessDays') AS x(
            id UUID, business_date DATE, display_number INTEGER, status VARCHAR(20), is_closed BOOLEAN, opened_at TIMESTAMPTZ, closed_at TIMESTAMPTZ, closed_by UUID, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, version INTEGER
        ) LOOP
            INSERT INTO public.business_days (id, business_date, display_number, status, is_closed, opened_at, closed_at, closed_by, created_at, updated_at, version)
            VALUES (v_rec.id, v_rec.business_date, v_rec.display_number, v_rec.status, v_rec.is_closed, v_rec.opened_at, v_rec.closed_at, v_rec.closed_by, v_rec.created_at, v_rec.updated_at, v_rec.version);
        END LOOP;
    END IF;

    IF jsonb_typeof(v_chk.snapshot_data->'orders') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'orders') AS x(
            id UUID, day_id UUID, customer_id UUID, display_number INTEGER, status VARCHAR(20), notes TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, version INTEGER
        ) LOOP
            INSERT INTO public.orders (id, day_id, customer_id, display_number, status, notes, created_at, updated_at, deleted_at, version)
            VALUES (v_rec.id, v_rec.day_id, v_rec.customer_id, v_rec.display_number, v_rec.status::order_status, v_rec.notes, v_rec.created_at, v_rec.updated_at, v_rec.deleted_at, v_rec.version);
        END LOOP;
    END IF;

    IF jsonb_typeof(v_chk.snapshot_data->'orderItems') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'orderItems') AS x(
            id UUID, order_id UUID, device_type_id UUID, item_sequence INTEGER, operational_status VARCHAR(20), financial_status VARCHAR(20), payment_status VARCHAR(20), status VARCHAR(20), device_name_snapshot VARCHAR(150), device_icon_snapshot VARCHAR(100), base_price_snapshot_minor BIGINT, charger_fee_snapshot_minor BIGINT, discount_snapshot_minor BIGINT, final_charge_snapshot_minor BIGINT, unit_price_minor BIGINT, total_price_minor BIGINT, has_charger BOOLEAN, charger_fee_enabled_snapshot BOOLEAN, customer_charger_fee_exempt_snapshot BOOLEAN, delivered_at TIMESTAMPTZ, financially_recognized_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ, replacement_of_item_id UUID, notes TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, version INTEGER
        ) LOOP
            INSERT INTO public.order_items (id, order_id, device_type_id, item_sequence, operational_status, financial_status, payment_status, status, device_name_snapshot, device_icon_snapshot, base_price_snapshot_minor, charger_fee_snapshot_minor, discount_snapshot_minor, final_charge_snapshot_minor, unit_price_minor, total_price_minor, has_charger, charger_fee_enabled_snapshot, customer_charger_fee_exempt_snapshot, delivered_at, financially_recognized_at, cancelled_at, replacement_of_item_id, notes, created_at, updated_at, deleted_at, version)
            VALUES (v_rec.id, v_rec.order_id, v_rec.device_type_id, v_rec.item_sequence, v_rec.operational_status, v_rec.financial_status, v_rec.payment_status, v_rec.status::item_status, v_rec.device_name_snapshot, v_rec.device_icon_snapshot, v_rec.base_price_snapshot_minor, v_rec.charger_fee_snapshot_minor, v_rec.discount_snapshot_minor, v_rec.final_charge_snapshot_minor, v_rec.unit_price_minor, v_rec.total_price_minor, v_rec.has_charger, v_rec.charger_fee_enabled_snapshot, v_rec.customer_charger_fee_exempt_snapshot, v_rec.delivered_at, v_rec.financially_recognized_at, v_rec.cancelled_at, v_rec.replacement_of_item_id, v_rec.notes, v_rec.created_at, v_rec.updated_at, v_rec.deleted_at, v_rec.version);
        END LOOP;
    END IF;

    IF jsonb_typeof(v_chk.snapshot_data->'payments') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'payments') AS x(
            id UUID, customer_id UUID, amount_minor BIGINT, payment_method VARCHAR(50), reference TEXT, actor_admin_id UUID, command_id UUID, created_at TIMESTAMPTZ
        ) LOOP
            INSERT INTO public.payments (id, customer_id, amount_minor, payment_method, reference, actor_admin_id, command_id, created_at)
            VALUES (v_rec.id, v_rec.customer_id, v_rec.amount_minor, v_rec.payment_method, v_rec.reference, v_rec.actor_admin_id, v_rec.command_id, v_rec.created_at);
        END LOOP;
    END IF;

    IF jsonb_typeof(v_chk.snapshot_data->'paymentAllocations') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'paymentAllocations') AS x(
            id UUID, payment_id UUID, order_item_id UUID, order_id UUID, allocated_amount_minor BIGINT, created_at TIMESTAMPTZ
        ) LOOP
            INSERT INTO public.payment_allocations (id, payment_id, order_item_id, order_id, allocated_amount_minor, created_at)
            VALUES (v_rec.id, v_rec.payment_id, v_rec.order_item_id, v_rec.order_id, v_rec.allocated_amount_minor, v_rec.created_at);
        END LOOP;
    END IF;

    IF jsonb_typeof(v_chk.snapshot_data->'financialLedger') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'financialLedger') AS x(
            id UUID, sequence_number BIGINT, event_type VARCHAR(30), amount_minor BIGINT, order_id UUID, order_item_id UUID, customer_id UUID, actor_admin_id UUID, reference_id UUID, linked_ledger_id UUID, metadata JSONB, created_at TIMESTAMPTZ
        ) LOOP
            INSERT INTO public.financial_ledger (id, sequence_number, event_type, amount_minor, order_id, order_item_id, customer_id, actor_admin_id, reference_id, linked_ledger_id, metadata, created_at)
            VALUES (v_rec.id, v_rec.sequence_number, v_rec.event_type::ledger_event_type, v_rec.amount_minor, v_rec.order_id, v_rec.order_item_id, v_rec.customer_id, v_rec.actor_admin_id, v_rec.reference_id, v_rec.linked_ledger_id, v_rec.metadata, v_rec.created_at);
        END LOOP;
    END IF;

    IF jsonb_typeof(v_chk.snapshot_data->'goals') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'goals') AS x(
            id UUID, customer_id UUID, target_quantity INTEGER, current_progress INTEGER, bonus_amount_minor BIGINT, duration_days INTEGER, status VARCHAR(20), started_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, bonus_ledger_id UUID, version INTEGER, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
        ) LOOP
            INSERT INTO public.goals (id, customer_id, target_quantity, current_progress, bonus_amount_minor, duration_days, status, started_at, expires_at, completed_at, bonus_ledger_id, version, created_at, updated_at)
            VALUES (v_rec.id, v_rec.customer_id, v_rec.target_quantity, v_rec.current_progress, v_rec.bonus_amount_minor, v_rec.duration_days, v_rec.status, v_rec.started_at, v_rec.expires_at, v_rec.completed_at, v_rec.bonus_ledger_id, v_rec.version, v_rec.created_at, v_rec.updated_at);
        END LOOP;
    END IF;

    IF jsonb_typeof(v_chk.snapshot_data->'goalRequests') = 'array' THEN
        FOR v_rec IN SELECT * FROM jsonb_to_recordset(v_chk.snapshot_data->'goalRequests') AS x(
            id UUID, customer_id UUID, requested_target INTEGER, status VARCHAR(20), reviewed_by UUID, reviewed_at TIMESTAMPTZ, rejection_reason TEXT, resulting_goal_id UUID, version INTEGER, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
        ) LOOP
            INSERT INTO public.goal_requests (id, customer_id, requested_target, status, reviewed_by, reviewed_at, rejection_reason, resulting_goal_id, version, created_at, updated_at)
            VALUES (v_rec.id, v_rec.customer_id, v_rec.requested_target, v_rec.status, v_rec.reviewed_by, v_rec.reviewed_at, v_rec.rejection_reason, v_rec.resulting_goal_id, v_rec.version, v_rec.created_at, v_rec.updated_at);
        END LOOP;
    END IF;

    ALTER TABLE public.financial_ledger ENABLE TRIGGER trg_immutable_financial_ledger;
    ALTER TABLE public.order_items ENABLE TRIGGER trg_freeze_recognized_order_item;

    PERFORM public.record_canonical_change('system', p_checkpoint_id, 'UPDATE', jsonb_build_object('restoredCheckpointId', p_checkpoint_id), 1);

    RETURN jsonb_build_object(
        'success', TRUE,
        'restoredCheckpointId', p_checkpoint_id,
        'message', 'Checkpoint restored successfully in single atomic transaction'
    );
EXCEPTION WHEN OTHERS THEN
    ALTER TABLE public.financial_ledger ENABLE TRIGGER trg_immutable_financial_ledger;
    ALTER TABLE public.order_items ENABLE TRIGGER trg_freeze_recognized_order_item;
    RAISE;
END;
$$;

NOTIFY pgrst, 'reload schema';



-- BIN security/recovery pgcrypto schema correction (2026-10-08)
-- Correct all remaining BIN security/recovery functions to use pgcrypto functions
-- from the actual public schema, preserving existing behavior and defaults.

CREATE OR REPLACE FUNCTION public.issue_bin_recovery_proof(p_current_password TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
    v_admin_id UUID;
    v_is_active BOOLEAN;
    v_bin_status VARCHAR(20);
    v_failed_attempts INT;
    v_encrypted_password TEXT;
    v_token TEXT;
    v_token_hash TEXT;
    v_expires_at TIMESTAMPTZ;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN json_build_object('success', FALSE, 'error', 'Authentication required');
    END IF;

    IF p_current_password IS NULL OR length(p_current_password) < 1 THEN
        RETURN json_build_object('success', FALSE, 'error', 'Current password is required');
    END IF;

    SELECT id, is_active, COALESCE(bin_status, 'ACTIVE'), COALESCE(bin_failed_attempts, 0)
    INTO v_admin_id, v_is_active, v_bin_status, v_failed_attempts
    FROM public.admins
    WHERE auth_user_id = auth.uid();

    IF NOT FOUND OR v_is_active IS NOT TRUE THEN
        RETURN json_build_object('success', FALSE, 'error', 'Active admin profile not found');
    END IF;

    IF v_bin_status != 'LOCKED' AND v_failed_attempts < 3 THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'RECOVERY_NOT_PERMITTED: BIN recovery is only permitted when account is locked after 3 failed attempts'
        );
    END IF;

    SELECT encrypted_password INTO v_encrypted_password
    FROM auth.users
    WHERE id = auth.uid();

    IF NOT FOUND OR v_encrypted_password IS NULL THEN
        RETURN json_build_object('success', FALSE, 'error', 'User credentials not found');
    END IF;

    IF crypt(p_current_password::text, v_encrypted_password::text) <> v_encrypted_password::text THEN
        RETURN json_build_object('success', FALSE, 'error', 'INVALID_PASSWORD');
    END IF;

    UPDATE public.admin_bin_recovery_proofs
    SET is_used = TRUE, used_at = NOW()
    WHERE auth_user_id = auth.uid() AND is_used IS FALSE;

    v_token := encode(gen_random_bytes(32), 'hex');
    v_token_hash := encode(digest(v_token::text, 'sha256'), 'hex');
    v_expires_at := NOW() + INTERVAL '2 minutes';

    INSERT INTO public.admin_bin_recovery_proofs (
        admin_id, auth_user_id, proof_token_hash, purpose, issued_at, expires_at, is_used
    ) VALUES (
        v_admin_id, auth.uid(), v_token_hash, 'BIN_RECOVERY', NOW(), v_expires_at, FALSE
    );

    RETURN json_build_object(
        'success', TRUE,
        'proof_token', v_token,
        'expires_in_seconds', 120,
        'purpose', 'BIN_RECOVERY'
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.recover_and_reset_admin_bin(
    p_new_bin TEXT,
    p_recovery_proof TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
    v_admin_id UUID;
    v_is_active BOOLEAN;
    v_bin_status VARCHAR(20);
    v_failed_attempts INT;
    v_proof_id UUID;
    v_proof_token_hash TEXT;
    v_new_bin_hash VARCHAR(255);
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN json_build_object('success', FALSE, 'error', 'Authentication required');
    END IF;

    IF p_recovery_proof IS NULL OR length(trim(p_recovery_proof)) < 16 THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'PROOF_REQUIRED: Valid recovery authorization proof is required to change BIN'
        );
    END IF;

    IF p_new_bin IS NULL OR length(trim(p_new_bin)) < 4 OR NOT (trim(p_new_bin) ~ '^[0-9]{4,}$') THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'Valid numeric BIN of at least 4 digits is required'
        );
    END IF;

    v_proof_token_hash := encode(digest(trim(p_recovery_proof)::text, 'sha256'), 'hex');

    SELECT id, admin_id
    INTO v_proof_id, v_admin_id
    FROM public.admin_bin_recovery_proofs
    WHERE auth_user_id = auth.uid()
      AND proof_token_hash = v_proof_token_hash
      AND purpose = 'BIN_RECOVERY'
      AND is_used IS FALSE
      AND expires_at > NOW()
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'INVALID_OR_EXPIRED_PROOF: Recovery proof is invalid, expired, or already used'
        );
    END IF;

    UPDATE public.admin_bin_recovery_proofs
    SET is_used = TRUE, used_at = NOW()
    WHERE id = v_proof_id;

    SELECT id, is_active, COALESCE(bin_status, 'ACTIVE'), COALESCE(bin_failed_attempts, 0)
    INTO v_admin_id, v_is_active, v_bin_status, v_failed_attempts
    FROM public.admins
    WHERE id = v_admin_id AND auth_user_id = auth.uid()
    FOR UPDATE;

    IF NOT FOUND OR v_is_active IS NOT TRUE THEN
        RETURN json_build_object('success', FALSE, 'error', 'Active admin profile not found');
    END IF;

    IF v_bin_status != 'LOCKED' AND v_failed_attempts < 3 THEN
        RETURN json_build_object(
            'success', FALSE,
            'error', 'RECOVERY_NOT_PERMITTED: BIN recovery is only allowed when account is in LOCKED state'
        );
    END IF;

    v_new_bin_hash := crypt(trim(p_new_bin)::text, gen_salt('bf', 10));

    UPDATE public.admins
    SET bin_hash = v_new_bin_hash,
        bin_failed_attempts = 0,
        bin_status = 'ACTIVE',
        bin_locked_at = NULL,
        updated_at = NOW(),
        version = version + 1
    WHERE id = v_admin_id;

    RETURN json_build_object('success', TRUE, 'status', 'ACTIVE', 'message', 'BIN_RESET_SUCCESS');
END;
$$;

CREATE OR REPLACE FUNCTION public.set_admin_bin(
    p_bin TEXT,
    p_admin_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_admin_id UUID;
    v_caller_role VARCHAR(50);
    v_caller_active BOOLEAN;
    v_target_id UUID;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF p_bin IS NULL OR length(trim(p_bin)) < 4 OR NOT (trim(p_bin) ~ '^[0-9]{4,}$') THEN
        RAISE EXCEPTION 'BIN must be at least 4 numeric digits';
    END IF;

    SELECT id, role, is_active
    INTO v_caller_admin_id, v_caller_role, v_caller_active
    FROM public.admins
    WHERE auth_user_id = auth.uid()
    LIMIT 1;

    IF NOT FOUND OR v_caller_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Authenticated admin account is inactive or not found';
    END IF;

    IF p_admin_id IS NOT NULL AND p_admin_id != v_caller_admin_id THEN
        IF v_caller_role NOT IN ('SUPER_ADMIN', 'Super Admin') THEN
            RAISE EXCEPTION 'Unauthorized: Only Super Admin can update another admin BIN';
        END IF;

        SELECT id INTO v_target_id FROM public.admins WHERE id = p_admin_id;
        IF v_target_id IS NULL THEN
            RAISE EXCEPTION 'Target admin not found';
        END IF;
    ELSE
        v_target_id := v_caller_admin_id;
    END IF;

    UPDATE public.admins
    SET bin_hash = crypt(trim(p_bin)::text, gen_salt('bf', 10)),
        updated_at = NOW(),
        version = version + 1
    WHERE id = v_target_id;

    RETURN TRUE;
END;
$$;

NOTIFY pgrst, 'reload schema';

