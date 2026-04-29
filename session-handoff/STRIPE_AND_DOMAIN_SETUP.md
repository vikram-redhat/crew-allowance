# Stripe Subscriptions + crewallowance.com — go-live checklist

This is the one-shot setup guide for the new tiered subscription model.
Do these in order. Each step says where to do it (Stripe Dashboard, Vercel, DNS registrar, Supabase) and what to copy-paste.

---

## 1. Database migration (Supabase, ~2 min)

In Supabase SQL Editor, run:

```
db_migrations/002_subscription_columns.sql
```

This adds `stripe_customer_id`, `stripe_subscription_id`, `subscription_status`,
`subscription_plan`, `subscription_current_period_end`, and
`subscription_cancel_at_period_end` to the `profiles` table, plus two indexes.
Idempotent — safe to re-run.

---

## 2. Create two Stripe Prices (Stripe Dashboard, ~5 min)

Go to **Stripe Dashboard → Products → + Add product**. Create one product
called **"Crew Allowance"** with two Prices attached:

| Plan | Amount | Currency | Billing period |
|------|--------|----------|----------------|
| Monthly | ₹100   | INR | Recurring · monthly |
| Annual  | ₹1,000 | INR | Recurring · yearly  |

After creating each Price, click into it and copy the Price ID (starts with `price_…`).
You'll need both IDs in step 4.

---

## 3. Add the Stripe webhook (Stripe Dashboard, ~2 min)

**Stripe Dashboard → Developers → Webhooks → + Add endpoint**

- Endpoint URL: `https://crewallowance.com/api/stripe-webhook`
  *(use your Vercel preview URL during testing, then update to .com when DNS is live)*
- Events to send:
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_succeeded`
  - `invoice.payment_failed`

After creating, click **Reveal signing secret** and copy the `whsec_…` value.
You'll need it in step 4.

---

## 4. Set Vercel env vars (Vercel project settings, ~5 min)

**Vercel → crewallowance project → Settings → Environment Variables.**
Add the following for **Production** (and **Preview** if you want test deploys to work):

| Name | Value | Notes |
|------|-------|-------|
| `STRIPE_SECRET_KEY`         | `sk_live_…` (or `sk_test_…` for testing) | Already exists; verify it's the right mode. |
| `STRIPE_WEBHOOK_SECRET`     | `whsec_…` from step 3 | NEW |
| `STRIPE_PRICE_1MO`          | `price_…` for ₹100/month   | NEW |
| `STRIPE_PRICE_12MO`         | `price_…` for ₹1,000/year  | NEW |
| `FREE_ACCESS_CODE`          | A long random string (e.g. `crewfree_xK9p2QmL3aFw`) | NEW · share only with comp users |
| `SUPABASE_URL`              | Your Supabase project URL | NEW (server-side, no `VITE_` prefix) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key from Supabase → Settings → API | NEW · NEVER expose to the browser |
| `VITE_STRIPE_PK`            | `pk_live_…` (or `pk_test_…`) | Already exists; matches the secret key's mode |

Then **redeploy** so the new vars take effect (Vercel doesn't hot-reload env).

---

## 5. Buy & point crewallowance.com (registrar + Vercel, ~15 min)

### 5a. After purchase, in **Vercel → Settings → Domains**:

- Click **Add** → enter `crewallowance.com` and `www.crewallowance.com`.
- Vercel will show one of two records to add at your registrar:

  **Apex (`crewallowance.com`):**
  ```
  Type: A     Name: @     Value: 76.76.21.21
  ```
  **www subdomain:**
  ```
  Type: CNAME  Name: www  Value: cname.vercel-dns.com
  ```

  *(Vercel will display the exact target; copy from there if it differs.)*

### 5b. At your registrar (GoDaddy / Namecheap / etc.):

- Add the two DNS records above. TTL: 1 hour is fine.
- Remove any conflicting A or CNAME records on `@` and `www`.

### 5c. Propagation:

- DNS usually resolves within 10-30 minutes; can take up to 24h.
- Vercel auto-issues SSL once it sees the DNS — no action needed.

### 5d. (Optional) Keep crewallowance.in alive as a redirect:

- In Vercel, add `crewallowance.in` as a domain too.
- Set it to **redirect to crewallowance.com** (Vercel UI has a one-click toggle).
- Point .in's DNS at Vercel the same way.

---

## 6. Smoke test (real card on test mode, ~10 min)

1. Switch Stripe to **Test mode** (toggle in Dashboard top-right).
2. Make sure `STRIPE_SECRET_KEY` and `VITE_STRIPE_PK` in Vercel are the test keys (`sk_test_…` / `pk_test_…`).
3. Sign up a fresh test user on the site.
4. Pick the 1-month plan, pay with Stripe test card `4242 4242 4242 4242`, any future expiry, any CVC.
5. Check:
   - User is activated in Supabase (`is_active = true`, `subscription_plan = '1mo'`, `subscription_status = 'active'`).
   - In Stripe Dashboard → Customers, you see the new customer with an active subscription.
   - In Stripe Dashboard → Webhooks, the event delivery is `200 OK`.
6. Test the free-code path: log out, sign up another user, click "Have a free-access code?", enter your `FREE_ACCESS_CODE`, hit activate. User should activate without a card.
7. Test the failure path: pay with `4000 0000 0000 0002` (Stripe's "card declined" test card). UI should show the decline error.
8. Switch back to Live mode keys when you're ready to take real money.

---

## 7. Free-access code (CREW2026 replacement)

The old hardcoded discount codes (`CREW2026`, `LAUNCH50`, `INDIGO10`) have been removed from the codebase.

Free access is now handled by a single **server-validated** code stored in the `FREE_ACCESS_CODE` env var on Vercel. The checkout screen has a "Have a free-access code?" link at the bottom that reveals a code input. When entered:

- The frontend sends `freeCode` to `/api/create-subscription`
- The server compares it to `FREE_ACCESS_CODE` (no client-side validation)
- On match, the user's profile is set to `is_active = true`, `subscription_plan = 'free'`, with `subscription_current_period_end` set to the chosen plan's duration from today
- No Stripe Customer or Subscription is created

To grant free access: share the `FREE_ACCESS_CODE` string (e.g. `crewfree_xK9p2QmL3aFw`) directly with the person. Change it any time in Vercel env vars — old value stops working immediately after redeploy.

---

## 8. QA audit results

Full sweep performed before go-live. Findings and fixes:

| Check | Status | Notes |
|-------|--------|-------|
| Domain references (.in → .com) | ✅ Clean | All references in JSX, terms.html, privacy.html, CLAUDE.md updated |
| Pricing references (₹299 → ₹100/₹1000) | ✅ Clean | Landing page, checkout, terms.html, API docs, setup guide all updated |
| Old discount codes (CREW2026 etc) | ✅ Removed | No references remain in codebase |
| Dead code (create-payment-intent.js) | ⚠️ Still present | Left in place — no frontend references. Safe to delete. |
| Stale vite.svg in public/ | ⚠️ Still present | Sandbox won't delete. Harmless — nothing references it. |
| Login error message | ✅ Fixed | Changed from "wait for admin approval" to "complete your subscription" |
| CLAUDE.md | ✅ Updated | Reflects new Stripe Subscriptions, env vars, API endpoints |
| DB migration comment (3mo) | ✅ Fixed | Now says '1mo' \| '12mo' \| 'free' |
| JSX comment (three cards) | ✅ Fixed | Now says "two cards" |
| create-subscription.js error msg | ✅ Fixed | Says "1mo or 12mo" |
| Favicon wired in index.html | ✅ | SVG + PNG (16/32/180) + ICO + apple-touch-icon |
| Stripe webhook body parser disabled | ✅ | `export const config = { api: { bodyParser: false } }` |
| Webhook signature verification | ✅ | Uses `constructEvent` with raw body |
| Secret key server-only | ✅ | `STRIPE_SECRET_KEY` only in /api/, no VITE_ prefix |
| Supabase service role key server-only | ✅ | Only in /api/, no VITE_ prefix |
| Free-code validation server-side | ✅ | `FREE_ACCESS_CODE` compared on server, not client |
| Subscription `default_incomplete` | ✅ | First invoice must be paid before activation |
| ESLint on all changed files | ✅ Clean | Zero errors on CrewAllowance.jsx, create-subscription.js, stripe-webhook.js |
| Pre-existing lint errors | ⚠️ 6 errors | In calculate.legacy.js (2) and pcsrParser.js (4) — untouched, pre-existing |

---

## 9. Known gaps to come back to

These were intentionally deferred — listed so they don't get lost.

- **No subscription management UI.** Users can't see their plan, change it, or cancel from the app. Easiest fix: add a "Manage subscription" link that opens the **Stripe Customer Portal** (one Stripe API call, gives you cancel / update card / view invoices for free).
- **No promotion codes.** Discount codes were dropped; only the single `FREE_ACCESS_CODE` env var exists. To bring back % off / launch promos, use **Stripe Coupons + Promotion Codes** (server-validated, Stripe-native).
- **One-off `/api/create-payment-intent.js` is dead code.** Left in place; safe to delete in a future PR.
- **Receipt emails.** Stripe sends them automatically if you turn on *Email customers about successful payments* in **Stripe Dashboard → Settings → Customer emails**. Worth flipping on.
- **Webhook idempotency.** The current handler is idempotent because we do straight UPDATEs keyed on `userId`, but if you ever add INSERTs into a payments-log table, dedupe on `event.id`.
- **Supabase RLS for new columns.** The new subscription columns (`stripe_customer_id`, etc.) are on the `profiles` table which already has RLS. Users can read their own row via the existing policy. Only the webhook (using `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS) can write to these columns. Verify your existing profiles RLS policies don't allow users to UPDATE their own `is_active` or `subscription_status` — if they can, they could activate themselves.
- **Plan upgrade/downgrade.** Currently no flow for switching plans. User would need to cancel and re-subscribe. Stripe Customer Portal handles this natively once wired up.
- **Delete dead code.** `api/create-payment-intent.js` and `public/vite.svg` can be removed.
