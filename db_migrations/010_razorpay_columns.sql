-- Adds Razorpay subscription / payment tracking columns to the profiles table.
-- Lives alongside the existing stripe_* columns (002_subscription_columns.sql,
-- 004_trial_columns.sql) so legacy Stripe data is preserved during the
-- migration and rollback stays cheap.
--
-- Provider-agnostic columns that already exist and are reused as-is:
--   subscription_status, subscription_plan, subscription_current_period_end,
--   subscription_cancel_at_period_end, is_active, trial_paid_at, trial_used.
--
-- Idempotent — safe to re-run.

alter table public.profiles
  add column if not exists razorpay_customer_id     text,
  add column if not exists razorpay_subscription_id text,
  add column if not exists razorpay_order_id        text,  -- one-time trial Order
  add column if not exists razorpay_payment_id      text,  -- one-time trial Payment
  add column if not exists payment_provider         text;  -- 'razorpay' | 'stripe' | null

create index if not exists profiles_razorpay_subscription_id_idx
  on public.profiles (razorpay_subscription_id);

create index if not exists profiles_razorpay_customer_id_idx
  on public.profiles (razorpay_customer_id);

create index if not exists profiles_razorpay_order_id_idx
  on public.profiles (razorpay_order_id);
