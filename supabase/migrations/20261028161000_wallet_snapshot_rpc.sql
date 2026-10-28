-- Server-only snapshot read for the customer's own wallet accounts.
begin;
create or replace function public.wallet_get_snapshot(
  p_customer_id uuid,
  p_limit integer default 50,
  p_before timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_accounts jsonb;
  v_transactions jsonb;
begin
  if p_customer_id is null or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'INVALID_WALLET_QUERY' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.wallet_service_entitlements e
    where e.customer_id = p_customer_id and e.service_key = 'wallet_management' and e.enabled = true
  ) then
    raise exception 'WALLET_SERVICE_NOT_ENABLED' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'provider', a.provider, 'wallet_number', a.wallet_number,
    'display_name', a.display_name, 'currency', a.currency, 'is_active', a.is_active,
    'created_at', a.created_at, 'balance_minor', coalesce(b.balance_minor, 0)
  ) order by case a.provider when 'PalPay' then 1 when 'Jawwal Pay' then 2 when 'Bank of Palestine' then 3 else 4 end, a.created_at), '[]'::jsonb)
  into v_accounts
  from public.wallet_accounts a
  left join lateral (
    select sum((case when t.destination_wallet_id = a.id then t.amount_minor else 0 end) -
      (case when t.source_wallet_id = a.id then t.amount_minor else 0 end))::bigint as balance_minor
    from public.wallet_transactions t
    where t.customer_id = p_customer_id and (t.source_wallet_id = a.id or t.destination_wallet_id = a.id)
  ) b on true
  where a.customer_id = p_customer_id;
  select coalesce(jsonb_agg(to_jsonb(page) order by page.created_at desc, page.id desc), '[]'::jsonb)
  into v_transactions
  from (
    select t.id, t.transaction_type, t.source_wallet_id, t.destination_wallet_id,
      t.amount_minor, t.currency, t.reference, t.note, t.created_at,
      sw.display_name as source_wallet_name, dw.display_name as destination_wallet_name
    from public.wallet_transactions t
    left join public.wallet_accounts sw on sw.id = t.source_wallet_id and sw.customer_id = t.customer_id
    left join public.wallet_accounts dw on dw.id = t.destination_wallet_id and dw.customer_id = t.customer_id
    where t.customer_id = p_customer_id and (p_before is null or t.created_at < p_before)
    order by t.created_at desc, t.id desc limit p_limit
  ) page;
  return jsonb_build_object('ok', true, 'accounts', v_accounts, 'transactions', v_transactions);
end;
$$;
revoke all on function public.wallet_get_snapshot(uuid, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.wallet_get_snapshot(uuid, integer, timestamptz) to service_role;
commit;
