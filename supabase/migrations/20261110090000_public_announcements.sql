
begin;

create table if not exists public.public_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null default '',
  body text not null default '',
  image_url text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  constraint public_announcements_valid_window check (ends_at > starts_at),
  constraint public_announcements_content check (length(trim(body)) > 0 or image_url is not null),
  constraint public_announcements_body_length check (length(body) <= 3000),
  constraint public_announcements_title_length check (length(title) <= 160)
);

create index if not exists public_announcements_schedule_idx
  on public.public_announcements (is_enabled, starts_at, ends_at);

alter table public.public_announcements enable row level security;
revoke all on public.public_announcements from anon, authenticated;
grant all on public.public_announcements to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('public-announcements', 'public-announcements', true, 5242880,
        array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'];

commit;
