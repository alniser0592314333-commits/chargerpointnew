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
as $ select exists(select 1 from public.admins where role='SUPER_ADMIN' and is_active=true) $;

create or replace function public.bootstrap_first_super_admin(p_username text,p_full_name text,p_bin text)
returns jsonb language plpgsql security definer set search_path=public as $
declare v_id uuid; v_email text;
begin
 if exists(select 1 from public.admins where role='SUPER_ADMIN' and is_active=true) then
  return jsonb_build_object('success',false,'code','ALREADY_BOOTSTRAPPED');
 end if;
 if auth.uid() is null then raise exception 'Authentication required' using errcode='P0001'; end if;
 select email into v_email from auth.users where id=auth.uid();
 insert into public.admins(auth_user_id,username,full_name,email,role,permissions,bin_hash)
 values(auth.uid(),p_username,p_full_name,v_email,'SUPER_ADMIN',
 array['orders:view','orders:create','orders:edit','orders:deliver','orders:cancel','orders:correct',
 'customers:view','customers:create','customers:edit','customers:deactivate','customers:debt-limit',
 'customers:charger-exemption','customers:financial-view','finance:view','finance:create-payment',
 'finance:approve-payment','finance:refund','finance:correction','finance:credit-adjustment',
 'devices:view','devices:manage','devices:pricing','devices:charger-policy','settings:manage',
 'admin:manage','sync:manage','sync:view','goals:view','goals:manage','goals:request','goals:approve']::text[],
 crypt(p_bin,gen_salt('bf'))) returning id into v_id;
 return jsonb_build_object('success',true,'admin_id',v_id);
end $;

create or replace function public.get_email_by_username(p_username text)
returns text language sql stable security definer set search_path=public
as $ select email from public.admins where lower(username)=lower(p_username) and is_active=true limit 1 $;

create or replace function public.rpc_fetch_admins()
returns setof jsonb language sql security definer set search_path=public
as $ select jsonb_build_object('id',a.id,'username',a.username,'full_name',a.full_name,'email',a.email,'role',a.role,'is_active',a.is_active,'version',a.version,'created_at',a.created_at) from public.admins a where public.current_admin_id() is not null order by a.created_at $;

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
declare a public.admins;
begin
  select * into a from public.admins where auth_user_id=auth.uid() limit 1;
  if a.id is null then
    return jsonb_build_object('authenticated',true,'is_admin',false);
  end if;
  return jsonb_build_object(
    'authenticated',true,'is_admin',a.is_active,'is_active',a.is_active,
    'admin_id',a.id,'auth_user_id',a.auth_user_id,'username',a.username,
    'full_name',a.full_name,'email',a.email,'role',a.role,
    'permissions',coalesce(a.permissions,'{}'::text[])
  );
end;
$$;

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
    when 'CREATE_PAYMENT','POST_PAYMENT' then 'finance:create-payment'
    when 'CREATE_CUSTOMER_CREDIT','CONSUME_CUSTOMER_CREDIT' then 'finance:credit-adjustment'
    when 'CREATE_REFUND' then 'finance:refund'
    when 'CREATE_GOAL','UPDATE_GOAL_CONFIG','UPDATE_GOAL_PROGRESS' then 'goals:manage'
    when 'RECORD_GOAL_REQUEST' then 'goals:request'
    when 'APPROVE_GOAL_REQUEST','REJECT_GOAL_REQUEST' then 'goals:approve'
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
      update public.business_days set status='CLOSED',is_closed=true,closed_at=now(),closed_by=v_actor,updated_at=now(),version=version+1 where id=v_order;
      if not found then raise exception 'Business day not found' using errcode='P0006'; end if;
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
        greatest(1,coalesce((p_payload->>'displayNumber')::integer,(select coalesce(max(display_number),0)+1 from public.orders where day_id=(p_payload->>'dayId')::uuid))),
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
      select dt.base_price_minor,dt.icon,coalesce(dt.name_ar,dt.name),coalesce(dt.name_en,dt.name),dt.charger_fee_enabled,dt.charger_fee_applicable,
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
      perform 1 from public.orders where id=v_order for update;
      if not found then raise exception 'Order not found' using errcode='P0006'; end if;
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
        order by oi.created_at,oi.id for update loop
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
      v_result:=jsonb_build_object('goalId',v_goal);

    when 'UPDATE_GOAL_PROGRESS' then
      v_goal:=coalesce((p_payload->>'goalId')::uuid,(p_payload->>'id')::uuid);
      update public.goals set current_progress=coalesce((p_payload->>'currentProgress')::integer,current_progress),
        status=coalesce(p_payload->>'status',status),completed_at=coalesce((p_payload->>'completedAt')::timestamptz,completed_at),
        bonus_ledger_id=coalesce((p_payload->>'bonusLedgerId')::uuid,bonus_ledger_id),updated_at=now(),version=version+1
      where id=v_goal;
      if not found then raise exception 'Goal not found' using errcode='P0006'; end if;
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
      v_result:=jsonb_build_object('requestId',v_request);

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
returns text language plpgsql security definer set search_path=public as $
declare v_token text;
begin
 select public_token into v_token from public.qr_tokens where target_id=p_customer_id and token_type='CUSTOMER' and is_active limit 1;
 if v_token is not null then return v_token; end if;
 v_token:=replace(replace(replace(encode(gen_random_bytes(24),'base64'),'+','-'),'/','_'),'=','');
 insert into public.qr_tokens(token_hash,public_token,token_type,target_id) values(encode(digest(v_token,'sha256'),'hex'),v_token,'CUSTOMER',p_customer_id);
 return v_token;
end $;

create or replace function public.rotate_customer_qr(p_customer_id uuid)
returns text language plpgsql security definer set search_path=public as $
declare v_token text;
begin
 update public.qr_tokens set is_active=false where target_id=p_customer_id and token_type='CUSTOMER';
 v_token:=replace(replace(replace(encode(gen_random_bytes(24),'base64'),'+','-'),'/','_'),'=','');
 insert into public.qr_tokens(token_hash,public_token,token_type,target_id) values(encode(digest(v_token,'sha256'),'hex'),v_token,'CUSTOMER',p_customer_id);
 return v_token;
end $;

create or replace function public.get_or_create_order_qr(p_order_id uuid)
returns text language plpgsql security definer set search_path=public as $
declare v_token text;
begin
 select public_token into v_token from public.qr_tokens where target_id=p_order_id and token_type='ORDER' and is_active limit 1;
 if v_token is not null then return v_token; end if;
 v_token:=replace(replace(replace(encode(gen_random_bytes(24),'base64'),'+','-'),'/','_'),'=','');
 insert into public.qr_tokens(token_hash,public_token,token_type,target_id) values(encode(digest(v_token,'sha256'),'hex'),v_token,'ORDER',p_order_id);
 return v_token;
end $;

do $ begin
 if not exists(select 1 from pg_type where typname='public_customer_qr_result') then
  create type public.public_customer_qr_result as (customer_name text, customer_code text);
 end if;
end $;

-- Public QR functions are intentionally read-only. They return the minimum
-- customer/order projection and never expose admin-only fields.
create or replace function public.public_resolve_order_qr(p_public_token text)
returns setof jsonb language plpgsql security definer set search_path=public as $
declare v qr_tokens%rowtype;
begin
 select * into v from public.qr_tokens where public_token=p_public_token and token_type='ORDER' and is_active and (expires_at is null or expires_at>now());
 if v.id is null then return; end if;
 return query
 select jsonb_build_object('order_id',o.id,'order_number',o.display_number,'customer_name',c.name,'status',o.status,'created_at',o.created_at,
   'items_count',(select count(*) from public.order_items oi where oi.order_id=o.id),
   'items',(select coalesce(jsonb_agg(jsonb_build_object('name',oi.device_name_snapshot,'status',oi.status,'has_charger',oi.has_charger) order by oi.item_sequence),'[]'::jsonb) from public.order_items oi where oi.order_id=o.id))
 from public.orders o join public.customers c on c.id=o.customer_id where o.id=v.target_id;
end $;

create or replace function public.public_resolve_customer_qr(p_public_token text)
returns setof public_customer_qr_result language plpgsql security definer set search_path=public as $
declare v qr_tokens%rowtype;
begin
 select * into v from public.qr_tokens where public_token=p_public_token and token_type='CUSTOMER' and is_active and (expires_at is null or expires_at>now());
 if v.id is null then return; end if;
 return query select c.name, left(replace(c.id::text,'-',''),4) from public.customers c where c.id=v.target_id;
end $;

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
