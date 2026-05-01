-- Versioned rate history. Every time the admin saves a new set of IndiGo
-- allowance rates, a new row is appended with `effective_from` set to the
-- date the new rates take effect.
--
-- The calculator looks up the row whose `effective_from <= <PCSR month start>`
-- and is the most recent such row, so a pilot running their January PCSR in
-- May still gets January's rates even after April rates were saved.
--
-- Idempotent — safe to re-run.

create table if not exists public.rates_history (
  id              bigserial   primary key,
  effective_from  date        not null,             -- "rates apply from this date onwards"
  rates           jsonb       not null,             -- { deadhead: { Captain: 4000, ... }, night: {...}, ... }
  source          text,                              -- e.g. "IndiGo Revised Cockpit Crew Allowances"
  saved_by        uuid        references auth.users(id) on delete set null,
  saved_by_email  text,                              -- denormalised for audit display
  saved_at        timestamptz not null default now(),
  note            text                               -- optional admin note explaining the change
);

create unique index if not exists rates_history_effective_from_unique
  on public.rates_history (effective_from);

create index if not exists rates_history_effective_from_idx
  on public.rates_history (effective_from desc);

alter table public.rates_history enable row level security;

drop policy if exists "rates_history read for all" on public.rates_history;
drop policy if exists "rates_history admin write" on public.rates_history;

-- Reads: anyone (calculator needs to look up rates for the PCSR's month).
create policy "rates_history read for all"
  on public.rates_history for select
  to anon, authenticated
  using (true);

-- Writes: only admins (we check via the bump_calculation_run pattern —
-- check the profiles.is_admin flag for the caller).
create policy "rates_history admin write"
  on public.rates_history for all
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and coalesce(is_admin, false) = true
    )
  )
  with check (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and coalesce(is_admin, false) = true
    )
  );

-- Seed with the current Jan 1 2026 baseline (same shape as DEFAULT_RATES
-- in CrewAllowance.jsx). Idempotent via the unique index on effective_from.
insert into public.rates_history (effective_from, rates, source, saved_by_email, note)
values (
  '2026-01-01',
  jsonb_build_object(
    'deadhead',  jsonb_build_object('Captain', 4000, 'First Officer', 2000, 'Cabin Crew', null),
    'night',     jsonb_build_object('Captain', 2000, 'First Officer', 1000, 'Cabin Crew', null),
    'layover',   jsonb_build_object(
                   'Captain',       jsonb_build_object('base', 3000, 'beyondRate', 150),
                   'First Officer', jsonb_build_object('base', 1500, 'beyondRate',  75),
                   'Cabin Crew',    null),
    'tailSwap',  jsonb_build_object('Captain', 1500, 'First Officer', 750, 'Cabin Crew', null),
    'transit',   jsonb_build_object('Captain', 1000, 'First Officer', 500, 'Cabin Crew', null)
  ),
  'IndiGo Revised Cockpit Crew Allowances',
  'system-seed',
  'Initial seed migrated from DEFAULT_RATES in CrewAllowance.jsx'
)
on conflict (effective_from) do nothing;

-- Helper: return the rates active for a given date (the row whose
-- effective_from is <= the date and is the most recent such row).
create or replace function public.rates_for_date(p_date date)
returns public.rates_history
language sql
stable
as $$
  select * from public.rates_history
  where effective_from <= p_date
  order by effective_from desc
  limit 1;
$$;

grant execute on function public.rates_for_date(date) to anon, authenticated;
