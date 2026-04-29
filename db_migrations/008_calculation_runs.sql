-- Tracks every calculation run, for product diagnostics and marketing metrics.
-- One row per report generation. Admin users are NEVER counted (defense in
-- depth: the RPC checks server-side, not just the client).
--
-- Storage profile: ~1 row per pilot per report run. At hundreds of pilots
-- running monthly, this is well under 10k rows/year. Negligible.
--
-- Idempotent — safe to re-run.

create table if not exists public.calculation_runs (
  id          bigserial   primary key,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  period      text        not null,           -- "2026-01", "2026-02", etc.
  ran_at      timestamptz not null default now()
);

create index if not exists idx_calculation_runs_ran_at      on public.calculation_runs (ran_at desc);
create index if not exists idx_calculation_runs_user_period on public.calculation_runs (user_id, period);
create index if not exists idx_calculation_runs_period      on public.calculation_runs (period);

alter table public.calculation_runs enable row level security;

drop policy if exists "calculation_runs read for all" on public.calculation_runs;

-- Reads: anyone (admin dashboard reads aggregate counts; no PII exposed in
-- aggregates). Individual rows are uninteresting but readable for transparency.
create policy "calculation_runs read for all"
  on public.calculation_runs for select
  to anon, authenticated
  using (true);

-- No insert/update/delete policies → only the SECURITY DEFINER RPC below
-- can write. This stops any client from forging counts.

-- Atomic insert helper. Reads auth.uid() server-side and refuses to insert
-- if the caller is an admin (or unauthenticated). Returns true on success,
-- false on skip.
create or replace function public.bump_calculation_run(p_period text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid;
  v_admin   boolean;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return false;                                  -- unauthenticated → skip
  end if;

  select coalesce(is_admin, false) into v_admin
    from public.profiles
    where id = v_uid;

  if v_admin then
    return false;                                  -- admin → skip silently
  end if;

  insert into public.calculation_runs (user_id, period)
    values (v_uid, p_period);
  return true;
end;
$$;

grant execute on function public.bump_calculation_run(text) to authenticated;
