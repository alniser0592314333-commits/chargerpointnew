-- Secure Jawwal Pay submission with a one-time server-verified biometric proof.
alter table public.account_biometric_challenges drop constraint if exists account_biometric_challenges_purpose_check;
alter table public.account_biometric_challenges add constraint account_biometric_challenges_purpose_check
  check (purpose = any (array['enroll'::text,'login'::text,'jawwal-payment'::text]));

create table if not exists public.customer_jawwal_biometric_guard (
  customer_id uuid primary key references public.customers(id) on delete cascade,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 3),
  window_started_at timestamptz,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.customer_jawwal_biometric_guard enable row level security;
revoke all on public.customer_jawwal_biometric_guard from anon, authenticated;
grant all on public.customer_jawwal_biometric_guard to service_role;

create table if not exists public.customer_jawwal_biometric_authorizations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  challenge_id uuid not null unique references public.account_biometric_challenges(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '90 seconds',
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.customer_jawwal_biometric_authorizations enable row level security;
revoke all on public.customer_jawwal_biometric_authorizations from anon, authenticated;
grant all on public.customer_jawwal_biometric_authorizations to service_role;

create or replace function public.submit_customer_jawwal_pay_payment(p_amount_minor bigint, p_biometric_authorization_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $function$
declare
  v_customer_id uuid;
  v_submission_id uuid;
  v_session_id uuid := nullif(auth.jwt()->>'session_id','')::uuid;
  v_authz public.customer_jawwal_biometric_authorizations%rowtype;
  v_guard public.customer_jawwal_biometric_guard%rowtype;
begin
  if auth.uid() is null or v_session_id is null then raise exception 'Customer login required' using errcode='28000'; end if;
  if p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor > 99999999999 then raise exception 'Amount must be greater than zero' using errcode='22023'; end if;
  select l.customer_id into v_customer_id
  from public.customer_account_links l
  join public.customers c on c.id=l.customer_id
  join public.customer_account_sessions s on s.customer_id=l.customer_id and s.auth_user_id=l.auth_user_id
    and s.session_id=v_session_id and s.revoked_at is null and s.expires_at>now()
  where l.auth_user_id=auth.uid() and l.account_status='ACTIVE' and c.is_active is true
    and c.deleted_at is null and c.status<>'DELETED' limit 1;
  if v_customer_id is null then raise exception 'Active customer account session required' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('qr-payment:customer:'||v_customer_id::text,0));
  select * into v_guard from public.customer_jawwal_biometric_guard where customer_id=v_customer_id for update;
  if found and v_guard.locked_until>now() then
    raise exception 'JAWAL_BIOMETRIC_LOCKED:%', floor(extract(epoch from v_guard.locked_until)*1000)::bigint using errcode='P0001';
  end if;
  select * into v_authz from public.customer_jawwal_biometric_authorizations
    where id=p_biometric_authorization_id and customer_id=v_customer_id and auth_user_id=auth.uid()
      and consumed_at is null and expires_at>now() for update;
  if not found then raise exception 'Valid biometric authorization required' using errcode='42501'; end if;
  update public.customer_jawwal_biometric_authorizations set consumed_at=now() where id=v_authz.id;
  insert into public.customer_jawwal_biometric_guard(customer_id,failed_attempts,window_started_at,locked_until,updated_at)
    values(v_customer_id,0,null,null,now())
    on conflict(customer_id) do update set failed_attempts=0,window_started_at=null,locked_until=null,updated_at=now();
  if exists(select 1 from public.qr_payment_submissions s where s.customer_id=v_customer_id and s.status='PENDING'
    and s.submission_source in ('CUSTOMER_QR','CUSTOMER_JAWAL_PAY')) then
    raise exception 'A customer payment is already awaiting review' using errcode='P0001';
  end if;
  if (select count(*) from public.qr_payment_submissions s where s.customer_id=v_customer_id
    and s.submission_source='CUSTOMER_JAWAL_PAY' and s.created_at>now()-interval '1 hour')>=3 then
    raise exception 'Too many Jawwal Pay submissions. Try again later.' using errcode='P0001';
  end if;
  insert into public.qr_payment_submissions(customer_id,amount_minor,receipt_url,note,status,reviewed_by,reviewed_at,
    order_id,payment_method,submission_source,created_at,updated_at,version)
  values(v_customer_id,p_amount_minor,null,'طلب دفع بواسطة جوال باي — بانتظار اعتماد الإدارة',
    'PENDING',null,null,null,'JAWAL_PAY','CUSTOMER_JAWAL_PAY',clock_timestamp(),clock_timestamp(),1)
  returning id into v_submission_id;
  return jsonb_build_object('success',true,'submission_id',v_submission_id,'amount_minor',p_amount_minor,'status','PENDING');
end;$function$;

revoke execute on function public.submit_customer_jawwal_pay_payment(bigint) from public, anon, authenticated;
revoke execute on function public.submit_customer_jawwal_pay_payment(bigint,uuid) from public, anon;
grant execute on function public.submit_customer_jawwal_pay_payment(bigint,uuid) to authenticated;
