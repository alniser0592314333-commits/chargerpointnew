-- Scoped business-day restore RPC.
-- Replaces only explicitly selected business dates. Financially recognized
-- history is append-only: a restore that would alter/delete recognized
-- financial records is rejected instead of silently rewriting accounting.
begin;

create or replace function public.restore_selected_business_days(
  p_bin text,
  p_snapshot jsonb,
  p_business_dates date[]
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin_id uuid;
  v_bin_hash text;
  v_admin_role text;
  v_dates date[];
  v_day_count integer := 0;
  v_order_count integer := 0;
  v_item_count integer := 0;
  v_old_day_ids uuid[];
  v_new_day_ids uuid[];
  v_payload_days jsonb;
  v_payload_orders jsonb;
  v_payload_items jsonb;
  v_date date;
  v_restored_order record;
  v_order_qr_token text;
  v_order_qr_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_bin is null or length(trim(p_bin)) < 4 or trim(p_bin) !~ '^\d{4,}$' then
    raise exception 'Valid numeric BIN is required';
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'Invalid backup snapshot';
  end if;
  if p_business_dates is null or cardinality(p_business_dates) = 0 then
    raise exception 'Select at least one business date';
  end if;
  select array_agg(distinct d order by d) into v_dates
  from unnest(p_business_dates) d where d is not null;
  if coalesce(cardinality(v_dates),0) = 0 then
    raise exception 'No valid business dates selected';
  end if;

  select a.id, a.bin_hash, a.role into v_admin_id, v_bin_hash, v_admin_role
  from public.admins a
  where a.auth_user_id = auth.uid() and a.is_active = true
  limit 1;
  if v_admin_id is null then raise exception 'Active admin session required'; end if;
  if coalesce(v_admin_role,'') not in ('SUPER_ADMIN', 'Super Admin')
     and not exists (
       select 1 from public.get_effective_permissions(v_admin_id)
       where permission in ('settings:manage', 'admin:manage', 'SUPER_ADMIN')
     ) then
    raise exception 'Permission denied: settings:manage required';
  end if;
  if v_bin_hash is null or crypt(trim(p_bin), v_bin_hash) <> v_bin_hash then
    raise exception 'Invalid BIN credential';
  end if;

  v_payload_days := coalesce(p_snapshot->'businessDays','[]'::jsonb);
  v_payload_orders := coalesce(p_snapshot->'orders','[]'::jsonb);
  v_payload_items := coalesce(p_snapshot->'orderItems','[]'::jsonb);
  if jsonb_typeof(v_payload_days) <> 'array'
     or jsonb_typeof(v_payload_orders) <> 'array'
     or jsonb_typeof(v_payload_items) <> 'array' then
    raise exception 'Backup must contain businessDays, orders and orderItems arrays';
  end if;

  -- Ensure every selected date exists in the backup exactly once.
  foreach v_date in array v_dates loop
    if (select count(*) from jsonb_to_recordset(v_payload_days)
        as x(id uuid, business_date date) where x.business_date = v_date) <> 1 then
      raise exception 'Backup must contain exactly one business day for date %', v_date;
    end if;
  end loop;

  -- Never let an incomplete/empty backup silently erase an existing day's orders.
  if exists (
    select 1 from public.business_days d
    where d.business_date = any(v_dates)
      and exists (select 1 from public.orders o where o.day_id = d.id)
      and not exists (
        select 1
        from jsonb_to_recordset(v_payload_orders) as x(id uuid,day_id uuid)
        join jsonb_to_recordset(v_payload_days) as bd(id uuid,business_date date)
          on bd.id = x.day_id
        where bd.business_date = d.business_date
      )
  ) then
    raise exception 'Backup has no orders for a selected date that currently has orders; restore refused to prevent accidental data loss';
  end if;

  -- Lock affected live days and protect accounting history from destructive edits.
  if exists (
    select 1 from public.financial_ledger fl
    join public.orders o on o.id = fl.order_id
    join public.business_days d on d.id = o.day_id
    where d.business_date = any(v_dates)
  ) then
    raise exception 'Selected live days have financial ledger history; restore refused to protect accounting';
  end if;

  -- A backup containing already-recognized charges cannot be replayed as
  -- operational rows without its matching immutable ledger history.
  if exists (
    select 1
    from jsonb_to_recordset(v_payload_items) as x(
      id uuid,order_id uuid,financial_status text,payment_status text)
    join jsonb_to_recordset(v_payload_orders) as o(id uuid,day_id uuid)
      on o.id = x.order_id
    join jsonb_to_recordset(v_payload_days) as bd(id uuid,business_date date)
      on bd.id = o.day_id
    where bd.business_date = any(v_dates)
      and (coalesce(upper(x.financial_status),'UNRECOGNIZED') = 'RECOGNIZED'
           or coalesce(upper(x.payment_status),'UNPAID') in ('PAID','PARTIALLY_PAID'))
  ) then
    raise exception 'Backup contains recognized financial items; restore refused to avoid creating charges without ledger history';
  end if;

  perform id from public.business_days where business_date = any(v_dates) for update;
  select array_agg(id) into v_old_day_ids from public.business_days where business_date = any(v_dates);
  if exists (
    select 1 from public.orders o
    join public.business_days d on d.id = o.day_id
    join public.order_items oi on oi.order_id = o.id
    where d.business_date = any(v_dates)
      and (oi.financial_status = 'RECOGNIZED'
           or exists (select 1 from public.financial_ledger fl where fl.order_item_id = oi.id)
           or exists (select 1 from public.financial_ledger fl where fl.order_id = o.id))
  ) then
    raise exception 'Selected live days contain recognized financial history; restore refused to protect the ledger';
  end if;
  if exists (
    select 1 from public.payment_allocations pa
    join public.orders o on o.id = pa.order_id
    join public.business_days d on d.id = o.day_id
    where d.business_date = any(v_dates)
  ) then
    raise exception 'Selected live days contain order-level payment allocations; restore refused to protect payments';
  end if;
  if exists (
    select 1 from public.payment_allocations pa
    join public.order_items oi on oi.id = pa.order_item_id
    join public.orders o on o.id = oi.order_id
    join public.business_days d on d.id = o.day_id
    where d.business_date = any(v_dates)
  ) then
    raise exception 'Selected live days contain payment allocations; restore refused to protect payments';
  end if;

  -- Protect ancillary records that refer to orders/items outside the rows
  -- being replaced. They are audit/idempotency history, not disposable backup data.
  if exists (
    select 1 from public.customer_delivery_push_logs l
    join public.order_items oi on oi.id = l.order_item_id
    join public.orders o on o.id = oi.order_id
    join public.business_days d on d.id = o.day_id
    where d.business_date = any(v_dates)
  ) then
    raise exception 'Selected days have delivery push history; restore refused to preserve notification idempotency';
  end if;
  if exists (
    select 1 from public.qr_payment_submissions s
    join public.orders o on o.id = s.order_id
    join public.business_days d on d.id = o.day_id
    where d.business_date = any(v_dates)
  ) then
    raise exception 'Selected days have QR payment submissions; restore refused to preserve payment review history';
  end if;
  if exists (
    select 1 from public.order_items replacement
    join public.order_items original on original.id = replacement.replacement_of_item_id
    join public.orders o on o.id = original.order_id
    join public.business_days d on d.id = o.day_id
    where d.business_date = any(v_dates)
      and not exists (
        select 1 from public.orders ro
        join public.business_days rd on rd.id = ro.day_id
        where ro.id = replacement.order_id and rd.business_date = any(v_dates)
      )
  ) then
    raise exception 'Selected days have replacement items referenced by other days; restore refused';
  end if;

  if exists (
    select 1 from jsonb_to_recordset(v_payload_orders) as x(id uuid,day_id uuid)
    join jsonb_to_recordset(v_payload_days) as bd(id uuid,business_date date)
      on bd.id = x.day_id
    where bd.business_date = any(v_dates)
      and not exists (
        select 1 from jsonb_to_recordset(v_payload_items) as i(id uuid,order_id uuid)
        where i.order_id = x.id
      )
  ) then
    raise exception 'Backup contains an order without any order items; restore refused to prevent incomplete records';
  end if;

  -- Validate all references before mutating anything.
  if exists (
    select 1 from jsonb_to_recordset(v_payload_orders)
      as x(id uuid, day_id uuid, customer_id uuid)
    join jsonb_to_recordset(v_payload_days) as bd(id uuid, business_date date)
      on bd.id = x.day_id
    where bd.business_date = any(v_dates)
      and not exists(select 1 from public.customers c where c.id = x.customer_id)
  ) then
    raise exception 'Backup orders reference missing live customers';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(v_payload_items)
      as x(id uuid, order_id uuid, device_type_id uuid)
    join jsonb_to_recordset(v_payload_orders) as o(id uuid, day_id uuid)
      on o.id = x.order_id
    join jsonb_to_recordset(v_payload_days) as bd(id uuid, business_date date)
      on bd.id = o.day_id
    where bd.business_date = any(v_dates)
      and not exists(select 1 from public.device_types dt where dt.id = x.device_type_id)
  ) then
    raise exception 'Backup order items reference missing device types';
  end if;

  -- Expire previously issued offline number blocks for these dates. Keeping
  -- stale blocks active could assign numbers that collide with restored orders.
  update public.order_number_reservations r
  set next_number = r.end_number + 1,
      status = 'EXHAUSTED',
      updated_at = now(),
      version = r.version + 1
  from public.business_days d
  where r.business_day_id = d.id and d.business_date = any(v_dates);

  -- Remove dependent, non-financial records only for the selected dates.
  delete from public.qr_tokens qt using public.orders o, public.business_days d
    where qt.target_id = o.id and o.day_id = d.id and d.business_date = any(v_dates)
      and qt.token_type = 'ORDER';
  delete from public.order_items oi using public.orders o, public.business_days d
    where oi.order_id = o.id and o.day_id = d.id and d.business_date = any(v_dates);
  delete from public.orders o using public.business_days d
    where o.day_id = d.id and d.business_date = any(v_dates);

  -- Upsert day metadata by business date while preserving existing live IDs.
  -- Keeping the live ID preserves order-number reservations and offline references.
  insert into public.business_days
    (id,business_date,display_number,status,is_closed,opened_at,closed_at,closed_by,created_at,updated_at,version)
  select x.id,x.business_date,x.display_number,x.status,x.is_closed,x.opened_at,x.closed_at,x.closed_by,x.created_at,x.updated_at,coalesce(x.version,1)
  from jsonb_to_recordset(v_payload_days) as x(
    id uuid,business_date date,display_number integer,status text,is_closed boolean,
    opened_at timestamptz,closed_at timestamptz,closed_by uuid,created_at timestamptz,updated_at timestamptz,version integer)
  where x.business_date = any(v_dates)
  on conflict (business_date) do update set
    display_number = excluded.display_number,
    status = excluded.status,
    is_closed = excluded.is_closed,
    opened_at = excluded.opened_at,
    closed_at = excluded.closed_at,
    closed_by = excluded.closed_by,
    updated_at = excluded.updated_at,
    version = greatest(public.business_days.version, excluded.version) + 1;

  insert into public.orders
    (id,day_id,customer_id,display_number,status,customer_balance_snapshot_minor,notes,qr_token_id,charging_at,delivered_at,cancelled_at,created_at,updated_at,deleted_at,version)
  select x.id,target_day.id,x.customer_id,x.display_number,lower(coalesce(x.status,'pending')),x.customer_balance_snapshot_minor,x.notes,null::uuid,x.charging_at,x.delivered_at,x.cancelled_at,x.created_at,x.updated_at,x.deleted_at,coalesce(x.version,1)
  from jsonb_to_recordset(v_payload_orders) as x(
    id uuid,day_id uuid,customer_id uuid,display_number integer,status text,customer_balance_snapshot_minor bigint,
    notes text,qr_token_id uuid,charging_at timestamptz,delivered_at timestamptz,cancelled_at timestamptz,
    created_at timestamptz,updated_at timestamptz,deleted_at timestamptz,version integer)
  join jsonb_to_recordset(v_payload_days) as backup_day(id uuid,business_date date)
    on backup_day.id = x.day_id
  join public.business_days target_day on target_day.business_date = backup_day.business_date
  where backup_day.business_date = any(v_dates);

  -- Issue fresh QR capabilities for restored orders; never reactivate a
  -- stale token that may have been scanned or copied before the restore.
  for v_restored_order in
    select o.id from public.orders o
    join public.business_days d on d.id = o.day_id
    where d.business_date = any(v_dates)
      and o.cancelled_at is null and o.deleted_at is null
  loop
    v_order_qr_token := public.get_or_create_order_qr__session_guarded_impl(v_restored_order.id);
    select qt.id into v_order_qr_id
    from public.qr_tokens qt
    where qt.public_token = v_order_qr_token and qt.token_type = 'ORDER'
    limit 1;
    update public.orders set qr_token_id = v_order_qr_id where id = v_restored_order.id;
  end loop;

  insert into public.order_items
    (id,order_id,device_type_id,item_sequence,operational_status,financial_status,payment_status,status,device_name_snapshot,device_icon_snapshot,base_price_snapshot_minor,charger_fee_enabled_snapshot,customer_charger_fee_exempt_snapshot,charger_fee_snapshot_minor,discount_snapshot_minor,final_charge_snapshot_minor,has_charger,unit_price_minor,total_price_minor,replacement_of_item_id,delivered_at,financially_recognized_at,cancelled_at,deleted_at,created_at,updated_at,version)
  select x.id,x.order_id,x.device_type_id,coalesce(x.item_sequence,1),upper(coalesce(x.operational_status,'CHARGING')),upper(coalesce(x.financial_status,'UNRECOGNIZED')),upper(coalesce(x.payment_status,'UNPAID')),lower(coalesce(x.status,'charging')),
    coalesce(x.device_name_snapshot,''),coalesce(x.device_icon_snapshot,'smartphone'),coalesce(x.base_price_snapshot_minor,0),
    coalesce(x.charger_fee_enabled_snapshot,true),coalesce(x.customer_charger_fee_exempt_snapshot,false),
    coalesce(x.charger_fee_snapshot_minor,0),coalesce(x.discount_snapshot_minor,0),coalesce(x.final_charge_snapshot_minor,0),
    coalesce(x.has_charger,false),coalesce(x.unit_price_minor,0),coalesce(x.total_price_minor,0),x.replacement_of_item_id,
    x.delivered_at,x.financially_recognized_at,x.cancelled_at,x.deleted_at,x.created_at,x.updated_at,coalesce(x.version,1)
  from jsonb_to_recordset(v_payload_items) as x(
    id uuid,order_id uuid,device_type_id uuid,item_sequence integer,operational_status text,financial_status text,payment_status text,status text,
    device_name_snapshot text,device_icon_snapshot text,base_price_snapshot_minor bigint,charger_fee_enabled_snapshot boolean,
    customer_charger_fee_exempt_snapshot boolean,charger_fee_snapshot_minor bigint,discount_snapshot_minor bigint,final_charge_snapshot_minor bigint,
    has_charger boolean,unit_price_minor bigint,total_price_minor bigint,replacement_of_item_id uuid,delivered_at timestamptz,
    financially_recognized_at timestamptz,cancelled_at timestamptz,deleted_at timestamptz,created_at timestamptz,updated_at timestamptz,version integer)
  where x.order_id in (select o.id from public.orders o join public.business_days d on d.id=o.day_id where d.business_date = any(v_dates));

  get diagnostics v_item_count = row_count;
  select count(*) into v_day_count from public.business_days where business_date = any(v_dates);
  select count(*) into v_order_count from public.orders o join public.business_days d on d.id=o.day_id where d.business_date = any(v_dates);

  insert into public.admin_audit_logs(actor_admin_id,action,metadata)
  values(v_admin_id,'RESTORE_SELECTED_BUSINESS_DAYS',jsonb_build_object(
    'business_dates',v_dates,'days',v_day_count,'orders',v_order_count,'order_items',v_item_count));

  return jsonb_build_object('success',true,'business_dates',v_dates,'days',v_day_count,'orders',v_order_count,'order_items',v_item_count);
end;
$$;

revoke all on function public.restore_selected_business_days(text,jsonb,date[]) from public, anon;
grant execute on function public.restore_selected_business_days(text,jsonb,date[]) to authenticated;

commit;
