# Razorpay Subscriptions + crewallowance.com — go-live checklist

Goes through the steps to switch the production Vercel deployment from Stripe to Razorpay. Each step says where to do it (Razorpay Dashboard, Vercel, Supabase) and what to copy-paste.

The Stripe `/api/*` files are left in the repo until the Razorpay path is verified live; this doc covers the Razorpay-side work and assumes those legacy files are still present as a fallback during the cutover.

---

## 1. Run the Supabase migration

Apply [`db_migrations/010_razorpay_columns.sql`](../db_migrations/010_razorpay_columns.sql) on the production database (Supabase SQL editor → paste → run). This adds:

- `razorpay_customer_id`
- `razorpay_subscription_id`
- `razorpay_order_id`           (one-time trial Order)
- `razorpay_payment_id`         (one-time trial Payment)
- `payment_provider`            (`'razorpay'` | `'stripe'` | null)

It also creates indexes on the two id columns for fast webhook lookups. The existing `stripe_*` columns are untouched, so legacy data is preserved and the gating logic in the Profile screen still shows the Subscription card to legacy Stripe users.

The migration is idempotent — safe to re-run.

---

## 2. Create the Razorpay Plans

Razorpay Subscriptions need a `plan_id` per pricing tier. Create the two plans once per environment (Test, then Live):

```bash
cd crew-allowance
RAZORPAY_KEY_ID=rzp_test_xxx \
RAZORPAY_KEY_SECRET=yyy \
node scripts/razorpay-create-plans.mjs
```

The script prints the IDs in the exact `KEY=VALUE` format you paste into Vercel:

```
RAZORPAY_PLAN_1MO=plan_xxxxxxxxxxxx
RAZORPAY_PLAN_12MO=plan_yyyyyyyyyyyy
```

If you re-run the script you'll create duplicates — Razorpay Plans are immutable, so to change pricing you create a new plan and update the env var.

---

## 3. Add the Razorpay webhook

**Razorpay Dashboard → Settings → Webhooks → + Add New Webhook**

- URL: `https://crewallowance.com/api/razorpay-webhook`
- Secret: choose a long random string and save it — you'll add it to Vercel as `RAZORPAY_WEBHOOK_SECRET`.
- Active events:
  - `payment.captured`
  - `payment.failed`
  - `subscription.activated`
  - `subscription.charged`
  - `subscription.updated`
  - `subscription.cancelled`
  - `subscription.completed`
  - `subscription.halted`
  - `subscription.paused`
  - `subscription.resumed`

After saving, hit **Send test webhook** for `payment.captured`. The Razorpay UI should show a `200`. If it shows `400`, the secret is wrong; `500` means the env vars on Vercel aren't set yet (do step 4 first).

---

## 4. Configure Vercel environment variables

**Vercel → Project → Settings → Environment Variables**, scope each to **Production** (and **Preview** if you want test-mode deploys).

| Variable | Value | Notes |
|----------|-------|-------|
| `VITE_RAZORPAY_KEY_ID`  | `rzp_live_…` (or `rzp_test_…`) | Public — exposed to browser. Must match `RAZORPAY_KEY_ID`. |
| `RAZORPAY_KEY_ID`       | same as above | Server-only copy |
| `RAZORPAY_KEY_SECRET`   | server-only secret paired with KEY_ID | Server-only |
| `RAZORPAY_WEBHOOK_SECRET` | the secret you set in step 3 | NEW |
| `RAZORPAY_PLAN_1MO`     | `plan_…` from step 2 | NEW |
| `RAZORPAY_PLAN_12MO`    | `plan_…` from step 2 | NEW |
| `FREE_ACCESS_CODE`      | (unchanged) | Comp accounts |
| `SUPABASE_URL`          | (unchanged) | |
| `SUPABASE_SERVICE_ROLE_KEY` | (unchanged) | |

You can leave the existing `STRIPE_*` and `VITE_STRIPE_PK` vars in place during the cutover — nothing reads them after the deploy. Remove them once you've completed the cleanup step at the end of this doc.

---

## 5. Auto-capture payments

**Razorpay Dashboard → Settings → Payment Capture** → set to **Automatically** (default for new accounts). Without this, payments stay in `authorized` state and Razorpay auto-refunds them after a few days.

This is also necessary for the `payment.captured` webhook to fire — the webhook listens for captured payments, not authorized ones.

---

## 6. Deploy

Push the branch, let Vercel build and deploy, then verify:

- `https://crewallowance.com/api/razorpay-create-order` returns `405 Method not allowed` on a GET (proves the endpoint is live).
- Privacy page lists Razorpay as the payment processor.
- The Choose-your-plan screen no longer says "Stripe" anywhere.

---

## 7. End-to-end test in Test Mode

1. Switch the env vars to your **test-mode** keys / plan ids if you haven't already.
2. Sign up with a fresh email.
3. **Trial path** — pick "Try once", click Pay → Razorpay modal opens → use UPI ID `success@razorpay`.
   - Expected: success screen renders, `profiles.trial_paid_at` is set, `profiles.is_active=true`, `profiles.razorpay_payment_id` populated.
   - Razorpay Dashboard → Transactions → Payments shows the payment as `captured`.
   - Razorpay Dashboard → Webhooks → most recent delivery is `200 OK`.
4. **Trial failure** — repeat with `failure@razorpay`. The modal shows the decline; no DB change.
5. **Subscription path** — sign up another fresh user, pick Monthly. Use any Razorpay test card (e.g. Visa `4111 1111 1111 1111`, future expiry, any CVV) and complete the mandate / authorisation step.
   - Expected: `subscription_status` flips to `active` (or `authenticated` while the first charge processes), `subscription_current_period_end` is populated by the webhook.
6. **Cancel** — open Profile → click **Cancel subscription** → confirm.
   - Expected: optimistic UI change ("Cancellation scheduled"), webhook then writes `subscription_cancel_at_period_end=true` and `subscription_status='cancelled'` once the cycle ends.
7. **Free code** — sign up, click "Have a free-access code?", enter the value of `FREE_ACCESS_CODE`. Should activate instantly with no Razorpay involvement.

---

## 8. Switch to Live Mode

1. Generate Live mode keys in the Razorpay Dashboard. Toggle Test ↔ Live in the top bar.
2. Re-run `scripts/razorpay-create-plans.mjs` with the **Live** keys to create live plans.
3. Re-create the webhook in Live mode (URL is identical, secret is new).
4. Update Vercel env vars to Live values.
5. Redeploy.
6. Run one real ₹100 trial purchase end-to-end, then refund it from the Razorpay Dashboard.

---

## 9. Cleanup (after live verification)

Delete the legacy Stripe surface area:

- `api/stripe-webhook.js`
- `api/create-subscription.js`
- `api/create-trial-payment.js`
- `api/customer-portal.js`
- `api/create-payment-intent.js`
- `npm uninstall stripe`
- Vercel env vars: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_1MO`, `STRIPE_PRICE_12MO`, `VITE_STRIPE_PK`
- Optional: drop the `stripe_*` columns from `profiles` if you no longer need historical lookup. Keep them if you want to be able to refund older Stripe payments via the Stripe Dashboard later.

---

## Limitations vs the old Stripe setup

- **No hosted Customer Portal.** Razorpay does not have a Stripe-style portal. The in-app **Cancel subscription** button covers cancel-at-period-end; updating saved cards / mandates relies on Razorpay's automated retry email/SMS sent on the next failed charge.
- **Plan changes (upgrade / downgrade)** require cancelling and resubscribing — Razorpay subscriptions are tied to a single plan id.
- **Subscriptions are bounded by `total_count`.** This implementation uses 120 monthly cycles (~10 years) and 10 yearly cycles (10 years) so the user effectively has open-ended access until they cancel. Bump `PLAN_TOTAL_COUNT` in [`api/razorpay-create-subscription.js`](../api/razorpay-create-subscription.js) if you need a longer horizon.
- **UPI Autopay / e-mandate flows** vary by bank; some users may need to authorise the recurring debit twice (initial setup + first charge). The webhook handles both paths idempotently.
