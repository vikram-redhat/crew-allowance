-- Backfills email from auth.users into profiles for existing users.
-- Run once after 003_profiles_email.sql.
-- Safe to re-run — only updates rows where email is null.

update public.profiles p
set email = u.email
from auth.users u
where p.id = u.id
  and p.email is null;
