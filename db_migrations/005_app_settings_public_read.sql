-- Make app_settings readable by ANYONE (anonymous + authenticated).
-- The values stored here (schedule_source, maintenance_mode) are not secrets —
-- they're operational toggles that need to be visible to unauthenticated
-- visitors too (so the maintenance screen can lock them out from the landing
-- page, not just after they've logged in).
-- Write policy is unchanged — only admins can update.
-- Idempotent — safe to re-run.

drop policy if exists "app_settings read for authed" on public.app_settings;
drop policy if exists "app_settings read for all"     on public.app_settings;

create policy "app_settings read for all"
  on public.app_settings for select
  to anon, authenticated
  using (true);
