-- Adds one-time trial tracking + uniqueness constraint on employee ID.
-- Run after 003_profiles_email.sql.
-- Idempotent — safe to re-run.

-- Trial tracking
alter table public.profiles
  add column if not exists trial_paid_at timestamptz,
  add column if not exists trial_used    boolean default false;

-- Stripe payment intent id for the trial purchase (used by webhook to mark paid)
alter table public.profiles
  add column if not exists trial_payment_intent_id text;

-- Unique constraint on emp_id, excluding nulls (existing users without an
-- emp_id are unaffected). New signups will be required to provide one.
create unique index if not exists profiles_emp_id_unique
  on public.profiles (emp_id)
  where emp_id is not null;
