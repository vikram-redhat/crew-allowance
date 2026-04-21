-- Global application settings (single-row key/value store).
-- Used to toggle between AeroDataBox and FR24 as the live schedule data provider.

create table if not exists public.app_settings (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

-- Seed the schedule source (default to AeroDataBox).
insert into public.app_settings (key, value)
  values ('schedule_source', 'adb')
  on conflict (key) do nothing;

-- Row-level security: every authenticated user can read settings; only admins
-- can write them. We reuse the existing `is_admin` flag on `profiles`.
alter table public.app_settings enable row level security;

drop policy if exists "app_settings read for authed" on public.app_settings;
create policy "app_settings read for authed"
  on public.app_settings for select
  to authenticated
  using (true);

drop policy if exists "app_settings write admin" on public.app_settings;
create policy "app_settings write admin"
  on public.app_settings for all
  to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );
