-- Adds Stripe subscription tracking columns to the existing profiles table.
-- Run after 001_app_settings.sql.

alter table public.profiles
  add column if not exists stripe_customer_id              text,
  add column if not exists stripe_subscription_id          text,
  add column if not exists subscription_status             text,        -- active, past_due, canceled, incomplete, etc.
  add column if not exists subscription_plan               text,        -- '1mo' | '12mo' | 'free'
  add column if not exists subscription_current_period_end timestamptz, -- when the current paid period ends
  add column if not exists subscription_cancel_at_period_end boolean default false;

-- Helpful index for webhook lookups.
create index if not exists profiles_stripe_subscription_id_idx
  on public.profiles (stripe_subscription_id);

create index if not exists profiles_stripe_customer_id_idx
  on public.profiles (stripe_customer_id);
