-- Adds email column to profiles so the admin user list can display it
-- without needing to join auth.users (which requires service role).
-- Idempotent — safe to re-run.

alter table public.profiles
  add column if not exists email text;
