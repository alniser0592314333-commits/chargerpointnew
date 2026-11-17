-- Customer portal event publishing and secure push delivery.
-- Event content is private to authenticated customer accounts; media is served via short-lived signed URLs.
create table if not exists public.customer_portal_events (
  id uuid primary key default gen_random_uuid(),
  title_ar text,
  title_en text,
  content_blocks jsonb not null default '[]'::jsonb,
  sort_order integer not null default 0,
  is_published boolean not null default false,
  published_at timestamptz,
  notifications_sent_at timestamptz,
  web_push_sent_at timestamptz,
  created_by uuid references public.admins(id) on delete set null,
  updated_by uuid references public.admins(id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_portal_events_blocks_array check (jsonb_typeof(content_blocks) = 'array'),
  constraint customer_portal_events_blocks_size check (pg_column_size(content_blocks) <= 262144)
);

create index if not exists customer_portal_events_visible_order_idx
  on public.customer_portal_events (sort_order, published_at desc)
  where is_published is true and archived_at is null;

alter table public.customer_portal_events enable row level security;
revoke all on public.customer_portal_events from public, anon, authenticated;
grant all on public.customer_portal_events to service_role;

-- The existing subscription table is deliberately service-role-only; no browser table access.
revoke all on public.customer_push_subscriptions from public, anon, authenticated;
grant all on public.customer_push_subscriptions to service_role;

-- Prevent duplicate in-app/native-push fanout for the same event/customer pair.
create unique index if not exists customer_account_event_portal_event_once_idx
  on public.customer_account_events (customer_id, (payload ->> 'event_id'))
  where event_type = 'CUSTOMER_PORTAL_EVENT_PUBLISHED';

-- Private event media; the Edge Function issues one-time upload tokens and short-lived read URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'customer-portal-events',
  'customer-portal-events',
  false,
  8388608,
  array['image/jpeg','image/png','image/webp']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.publish_customer_portal_event(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_event public.customer_portal_events;
  v_inserted integer := 0;
  v_role text;
begin
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  );
  if v_role is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select * into v_event
  from public.customer_portal_events
  where id = p_event_id and archived_at is null
  for update;

  if not found or v_event.is_published is not true then
    raise exception 'published event not found' using errcode = 'P0002';
  end if;

  if v_event.notifications_sent_at is not null then
    return jsonb_build_object('success', true, 'already_sent', true, 'inserted_count', 0);
  end if;

  insert into public.customer_account_events (customer_id, event_type, payload)
  select
    link.customer_id,
    'CUSTOMER_PORTAL_EVENT_PUBLISHED',
    jsonb_build_object(
      'event_id', v_event.id,
      'title_ar', coalesce(nullif(v_event.title_ar, ''), 'حدث جديد'),
      'title_en', coalesce(nullif(v_event.title_en, ''), 'New event'),
      'preview_ar', 'تمت إضافة حدث جديد إلى صفحة الأحداث.',
      'preview_en', 'A new event has been added to the events page.'
    )
  from public.customer_account_links link
  join public.customers customer on customer.id = link.customer_id
  where link.account_status = 'ACTIVE'
    and customer.is_active is true
    and customer.deleted_at is null
    and customer.status <> 'DELETED'
  on conflict (customer_id, (payload ->> 'event_id'))
    where event_type = 'CUSTOMER_PORTAL_EVENT_PUBLISHED'
    do nothing;

  get diagnostics v_inserted = row_count;

  update public.customer_portal_events
  set notifications_sent_at = now(), updated_at = now()
  where id = p_event_id;

  return jsonb_build_object('success', true, 'already_sent', false, 'inserted_count', v_inserted);
end;
$function$;

revoke all on function public.publish_customer_portal_event(uuid) from public, anon, authenticated;
grant execute on function public.publish_customer_portal_event(uuid) to service_role;

create or replace function public.get_customer_web_push_vapid_keys()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, vault
as $function$
declare
  v_role text;
  v_public text;
  v_private text;
begin
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  );
  if v_role is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select decrypted_secret into v_public
  from vault.decrypted_secrets where name = 'customer_web_push_vapid_public' limit 1;
  select decrypted_secret into v_private
  from vault.decrypted_secrets where name = 'customer_web_push_vapid_private' limit 1;

  return jsonb_build_object('public_key', v_public, 'private_key', v_private);
end;
$function$;

revoke all on function public.get_customer_web_push_vapid_keys() from public, anon, authenticated;
grant execute on function public.get_customer_web_push_vapid_keys() to service_role;
