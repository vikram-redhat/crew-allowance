-- Tracks per-day API call counts per provider (adb/fr24/aeroapi).
-- Used by the admin dashboard to show usage and estimated cost.
-- Cheap writes (~3 rows/day across all providers).
--
-- Cost is estimated client-side using known per-query rates:
--   AeroAPI:       $0.002/query (Standard tier, varies)
--   FR24 Essential: $90/month flat (count for visibility, not cost)
--   ADB / RapidAPI: depends on plan (count for visibility)
-- Idempotent — safe to re-run.

create table if not exists public.api_usage (
  source     text        not null,                 -- 'adb' | 'fr24' | 'aeroapi'
  date       date        not null,                 -- UTC date of the calls
  call_count integer     not null default 0,
  updated_at timestamptz not null default now(),
  primary key (source, date)
);

-- World-readable so the admin dashboard works without service role.
alter table public.api_usage enable row level security;

drop policy if exists "api_usage read for all"  on public.api_usage;
drop policy if exists "api_usage write for all" on public.api_usage;

-- Reads: anyone (dashboard).
create policy "api_usage read for all"
  on public.api_usage for select
  to anon, authenticated
  using (true);

-- Writes: any authenticated user (so the calculator can increment from the
-- browser without a service-role round-trip). The data is non-sensitive
-- aggregate counts.
create policy "api_usage write for all"
  on public.api_usage for all
  to authenticated
  using (true)
  with check (true);

-- Atomic increment helper: bump today's count by 1 for a source.
-- Falls back to insert on first call of the day.
create or replace function public.bump_api_usage(p_source text)
returns void
language plpgsql
security definer
as $$
begin
  insert into public.api_usage (source, date, call_count, updated_at)
    values (p_source, (now() at time zone 'utc')::date, 1, now())
  on conflict (source, date) do update
    set call_count = public.api_usage.call_count + 1,
        updated_at = now();
end;
$$;

grant execute on function public.bump_api_usage(text) to anon, authenticated;
