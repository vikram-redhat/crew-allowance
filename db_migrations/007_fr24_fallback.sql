-- Phase 2 (Apr 2026): FR24 fallback for missing FlightAware aircraft regs.
--
-- FlightAware AeroAPI is the primary schedule provider, but it returns null
-- for aircraft_reg on a small but meaningful subset of IndiGo flights
-- (e.g. 6E2230 DEL-KNU on 2026-01-01, 6E2052 DEL-HYD on 2026-01-11).
-- FR24 carries valid regs for the same flights.
--
-- This setting toggles the secondary FR24 call. Default: TRUE.
-- The cost is zero — FR24 Essential is flat $90/month.
--
-- Idempotent — safe to re-run.

insert into public.app_settings (key, value, updated_at)
  values ('fr24_fallback_enabled', 'true', now())
on conflict (key) do nothing;

-- Note: no schema changes needed for api_usage. The fallback writes count
-- under source = 'fr24_fallback' which the table already accepts (source is
-- a free-text column with no enum constraint).
