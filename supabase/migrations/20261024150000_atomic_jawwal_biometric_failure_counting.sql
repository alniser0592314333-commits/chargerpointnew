-- Atomic server-side counting for every Jawwal biometric prompt failure/cancellation.
-- Only the service role can invoke this function; clients cannot reset or manipulate the lock.
create or replace function public.record_customer_jawwal_biometric_failure(p_customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_guard public.customer_jawwal_biometric_guard%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_customer_id is null then
    raise exception 'Customer is required' using errcode = '22023';
  end if;

  insert into public.customer_jawwal_biometric_guard
    (customer_id, failed_attempts, window_started_at, locked_until, updated_at)
  values (p_customer_id, 1, v_now, null, v_now)
  on conflict (customer_id) do update
  set
    failed_attempts = case
      when public.customer_jawwal_biometric_guard.locked_until > v_now
        then public.customer_jawwal_biometric_guard.failed_attempts
      when public.customer_jawwal_biometric_guard.window_started_at is null
        or public.customer_jawwal_biometric_guard.window_started_at <= v_now - interval '1 hour'
        then 1
      else least(public.customer_jawwal_biometric_guard.failed_attempts + 1, 3)
    end,
    window_started_at = case
      when public.customer_jawwal_biometric_guard.locked_until > v_now
        then public.customer_jawwal_biometric_guard.window_started_at
      when public.customer_jawwal_biometric_guard.window_started_at is null
        or public.customer_jawwal_biometric_guard.window_started_at <= v_now - interval '1 hour'
        then v_now
      else public.customer_jawwal_biometric_guard.window_started_at
    end,
    locked_until = case
      when public.customer_jawwal_biometric_guard.locked_until > v_now
        then public.customer_jawwal_biometric_guard.locked_until
      when public.customer_jawwal_biometric_guard.window_started_at is null
        or public.customer_jawwal_biometric_guard.window_started_at <= v_now - interval '1 hour'
        then null
      when public.customer_jawwal_biometric_guard.failed_attempts + 1 >= 3
        then v_now + interval '1 hour'
      else null
    end,
    updated_at = v_now
  returning * into v_guard;

  return jsonb_build_object(
    'failedAttempts', v_guard.failed_attempts,
    'attemptsRemaining', greatest(0, 3 - v_guard.failed_attempts),
    'lockedUntil', v_guard.locked_until
  );
end;
$function$;

revoke all on function public.record_customer_jawwal_biometric_failure(uuid) from public, anon, authenticated;
grant execute on function public.record_customer_jawwal_biometric_failure(uuid) to service_role;
