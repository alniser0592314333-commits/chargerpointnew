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

