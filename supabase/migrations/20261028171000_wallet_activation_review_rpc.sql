-- Atomically decide an activation request and apply the entitlement.
begin;

create or replace function public.wallet_review_activation_request(
  p_request_id uuid,
  p_decision text,
  p_rejection_reason text,
  p_admin_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.wallet_activation_requests%rowtype;
  v_now timestamptz := now();
  v_reason text := nullif(left(trim(coalesce(p_rejection_reason, '')), 1000), '');
begin
  if p_decision not in ('APPROVE', 'REJECT') or p_admin_id is null then
    return jsonb_build_object('ok', false, 'error', 'INVALID_DECISION');
  end if;
  if p_decision = 'APPROVE' and v_reason is not null then
    v_reason := null;
  end if;

  select * into v_request
  from public.wallet_activation_requests
  where id = p_request_id
  for update;

  if not found or v_request.status <> 'PENDING' then
    return jsonb_build_object('ok', false, 'error', 'REQUEST_NO_LONGER_PENDING');
  end if;

  if p_decision = 'APPROVE' then
    insert into public.wallet_service_entitlements
      (customer_id, service_key, enabled, created_at, updated_at, updated_by)
    values
      (v_request.customer_id, 'wallet_management', true, v_now, v_now, p_admin_id)
    on conflict (customer_id, service_key) do update
      set enabled = true, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  end if;

  update public.wallet_activation_requests
  set status = case when p_decision = 'APPROVE' then 'APPROVED' else 'REJECTED' end,
      decided_at = v_now,
      decided_by = p_admin_id,
      rejection_reason = case when p_decision = 'REJECT' then v_reason else null end,
      updated_at = v_now
  where id = p_request_id and status = 'PENDING';

  insert into public.customer_account_events (customer_id, event_type, payload)
  values (
    v_request.customer_id,
    case when p_decision = 'APPROVE' then 'WALLET_ACTIVATION_APPROVED' else 'WALLET_ACTIVATION_REJECTED' end,
    jsonb_build_object(
      'wallet_activation_request_id', p_request_id,
      'rejection_reason', case when p_decision = 'REJECT' then v_reason else null end
    )
  );

  return jsonb_build_object(
    'ok', true,
    'status', case when p_decision = 'APPROVE' then 'APPROVED' else 'REJECTED' end
  );
end;
$$;

revoke all on function public.wallet_review_activation_request(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.wallet_review_activation_request(uuid, text, text, uuid) to service_role;

commit;
