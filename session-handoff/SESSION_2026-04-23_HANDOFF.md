# Session handoff — 23 April 2026

This is a snapshot of where CrewAllowance.in (now `.com`) stands at end of session. Read this first when picking up the work.

---

## TL;DR — current launch state

**Production is LIVE on `crewallowance.com` (Vercel).** Stripe is live, Supabase is live, Resend SMTP is wired, the new Cowork-built tiered subscription model is shipped. The app went from a one-off PaymentIntent labeled "Monthly Subscription" to a real Stripe Subscription product with a one-time trial, a comp-access path, and an admin-bypass for unlimited use.

User has zero paying customers yet. He's about to start onboarding pilots.

---

## Pricing model (final, post-this-session)

Three options at signup, in this order:
1. **Try once** — ₹100 one-time payment via Stripe PaymentIntent, gives one calculator run, no auto-renewal. **Default selection** with "Recommended for first-time users" badge.
2. **Monthly** — ₹100/month recurring Stripe Subscription, unlimited reports.
3. **Annual** — ₹1,000/year recurring Stripe Subscription, unlimited reports, "Best value" badge (saves 17%).

Plus the **comp/free path**: a "Have a free-access code?" link below the payment form. Server-validated against `FREE_ACCESS_CODE` env var (currently `crewfree_xK9p2QmL3aFw` — a placeholder, user can rotate). Comp users get `is_active = true` immediately (auto-approved — manual approval was built but reverted at user's request).

After a paid trial is used, the calculator gates with an `UpgradeScreen` showing only Monthly/Annual cards.

---

## Architecture changes shipped this session

### Files added
- `api/signup.js` — server-side signup with rollback. Uses `auth.admin.createUser({ email_confirm: true })` so no verification email needed. If profile insert fails (duplicate emp_id, etc.), the auth user is deleted so email/password are freed for retry. **Replaces the old client-side `supabase.auth.signUp` call** to fix orphaned-auth-record bug when emp_id was duplicate.
- `api/create-trial-payment.js` — one-off ₹100 PaymentIntent. Webhook stamps `trial_paid_at` on success.
- `api/customer-portal.js` — Stripe Customer Portal session for managing subscriptions (cancel, update card, view invoices). Hosted by Stripe.
- `db_migrations/004_trial_columns.sql` — adds `trial_paid_at`, `trial_used`, `trial_payment_intent_id`, plus `unique(emp_id) where emp_id is not null` constraint.

### Files modified
- `api/create-subscription.js` — comp path now accepts trial/1mo/12mo plans (not just 1mo/12mo). Comp users get `is_active = true` and `subscription_status = "active"` (auto-approved).
- `api/stripe-webhook.js` — handles `payment_intent.succeeded` for trial purchases (ignores subscription invoices via `!pi.invoice` check).
- `src/CrewAllowance.jsx` — massive set of UI/UX changes (see below).

### Files NOT removed but deprecated
- `api/create-payment-intent.js` — dead code, no frontend references. Safe to delete.
- `public/vite.svg` — sandbox can't delete it, harmless.

---

## Database migrations (run in order)

```
001_app_settings.sql            — schedule_source key/value
002_subscription_columns.sql    — Stripe customer/sub tracking
003_profiles_email.sql          — email column on profiles
003b_backfill_emails.sql        — copy emails from auth.users → profiles
004_trial_columns.sql           — trial tracking + unique emp_id
```

User has run all of these in production. Note: 004's unique-emp_id constraint **will fail if duplicates exist** — user hit this once with emp_id 16612, resolved manually before re-running.

---

## Env vars (in Vercel — Production)

Client-side (VITE_ prefix, exposed to browser):
- `VITE_STRIPE_PK` — `pk_live_...`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Server-side (no prefix, never exposed):
- `STRIPE_SECRET_KEY` — `sk_live_...`
- `STRIPE_WEBHOOK_SECRET` — `whsec_...`
- `STRIPE_PRICE_1MO` — `price_...` for ₹100/month
- `STRIPE_PRICE_12MO` — `price_...` for ₹1,000/year
- `FREE_ACCESS_CODE` — comp code shared with trusted users
- `SUPABASE_URL` — same URL as VITE_SUPABASE_URL
- `SUPABASE_SERVICE_ROLE_KEY` — service role from Supabase Settings → API
- `RAPIDAPI_KEY` — for AeroDataBox proxy
- `FR24_API_TOKEN` — for FR24 proxy

**Note:** No `STRIPE_PRICE_TRIAL` — trial uses a hardcoded ₹100 amount in `create-trial-payment.js`.

---

## Stripe Dashboard config

- 2 Prices on the "Crew Allowance" product: ₹100/month recurring INR, ₹1,000/year recurring INR.
- Webhook endpoint: `https://crewallowance.com/api/stripe-webhook` subscribed to:
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_succeeded`
  - `invoice.payment_failed`
  - `payment_intent.succeeded` ← needed for trial
- Customer Portal: enabled in Settings → Billing → Customer Portal.
- UPI: enabled in Settings → Payment Methods. Auto-surfaces for India-based users via the Payment Element (replaced the old Card Element this session).

---

## Auth & access model

A user can run a calculation if **any** of these is true:
- `is_admin = true` — unlimited, bypasses everything
- `subscription_status` is `active` or `trialing` — paid subscriber
- `trial_paid_at` is set AND `trial_used = false` — paid trial, hasn't used run yet
- `subscription_plan = "free"` — comp account

After a successful trial calculation, `trial_used` is set to `true` (server-side via `supabase.update`, plus local React state). Subsequent attempts route to `UpgradeScreen`.

Login screen blocks `!is_active` UNLESS the user is an admin (special bypass — admins can log in regardless of `is_active`). Same logic on auto-login (session restore).

---

## Major UX changes this session

1. **Favicon**: A1 design (paper plane with ₹$€£ in 2x2 grid) shipped as SVG + 16/32/180 PNG + ICO. Wired in `index.html`.

2. **Landing page**:
   - Hero CTA: "Get started — ₹100/month →"
   - PCSR before/after toggle moved up high, dark-section background, animated 5s auto-toggle. Real PCSR calendar grid format on left tab, allowance breakdown on right tab.
   - Payslip vs Crew Allowance comparison: single-card animated toggle showing payslip totals → sector-by-sector breakdown.
   - Pricing card: "₹100/month or ₹1,000/year (save 17%)"

3. **Signup**:
   - Email field renamed from "IndiGo email" to just "Email address"
   - Employee ID **required** and **unique** (DB constraint)
   - Format validation, duplicate-email and duplicate-emp-id detection with clickable Sign In / Reset Password links
   - Server-side endpoint with rollback (no orphaned auth records)
   - Auto-login after signup so checkout can proceed without re-auth

4. **Checkout**:
   - 3-card plan picker (Trial / Monthly / Annual)
   - Stripe Payment Element (replaced Card Element) — supports card + UPI auto-detected per region
   - Free-access code path validates server-side
   - Plan validation differs for paid vs comp paths (comp accepts trial; paid doesn't)

5. **Profile screen**:
   - Subscription card hidden for admins and comp users
   - Comp users see a read-only "Account · Comp · Free" card instead
   - Manage Subscription opens Stripe Customer Portal

6. **Calculator**:
   - PCSR ownership check: non-admin can only upload their own PCSR (matches `pcsrData.pilot.employee_id` against user's `emp_id`). Admins bypass.
   - Trial banner shown for trial-active users
   - Access gate redirects to UpgradeScreen if user has no valid access

7. **Admin Users tab**:
   - Email column visible (after backfill migration)
   - Admins always show as "Active" regardless of `is_active`
   - Pending-approval comp users get a gold badge (currently dormant since auto-approval is on)

8. **Forms**: All `<button>` elements explicitly `type="button"`, primary `Btn`s have `submit` prop. Pressing Enter triggers the right action on every form screen.

9. **Domain**: All `.in` references → `.com`. Vercel handles domain + DNS + SSL automatically.

10. **Email**: Resend SMTP wired into Supabase. (User did this in their Supabase dashboard, not in code.)

11. **Contact**: All references → `help@crewallowance.com`.

12. **Terminology**: "PCSR" expanded to "Personal Crew Schedule Report" on first mention (landing page, upload page). "AIMS" → "eCrew" (the actual IndiGo system name). "EOM/grid format" reference removed from upload page.

---

## Known good behavior (don't break these)

- Multi-admin supported — just `update profiles set is_admin = true where email = '...';`
- Comp code rotation only blocks NEW signups; existing comp users keep working (their `is_active` is already true)
- Trial doesn't expire — once paid, the unused run sits in their account forever
- Admin can upload anyone's PCSR (no ownership check for admins)
- Login Enter key submits Sign In, not Forgot Password (regression bug fixed mid-session)
- Discount codes (CREW2026, LAUNCH50, INDIGO10) intentionally REMOVED. Free access is now the single `FREE_ACCESS_CODE` env var path.

---

## Open / parked items

These came up during the session but were not actioned:

1. **Admin user deletion** — planned but not built. Plan was: `/api/admin-delete-user.js` that verifies caller is admin, cancels Stripe Subscription if any, deletes Stripe Customer, deletes profile row, deletes auth.users row. Frontend would add a red Delete button next to non-admin users with a confirmation modal.

2. **FR24 monthly sweep architecture** — discussed in earlier sessions, parked. See `CREWALLOWANCE_HANDOFF.md` Section 11 for the full strategy options. Decision blocked on user clarifying whether their manual DB schedule fixes were for time-varying issues or persistent flight problems.

3. **`source` column on `schedule_times` cache** — should be added before any FR24 sweeper work begins.

4. **Dead code cleanup** — `api/create-payment-intent.js` and `public/vite.svg` are both unused. Safe to delete.

5. **Receipt emails from Stripe** — can be enabled in Stripe Dashboard → Settings → Customer Emails. User hasn't done this yet.

6. **Comp account expiry enforcement** — currently `subscription_current_period_end` is informational only for comp users. If user ever wants comp accounts to actually expire, the place to gate it is in `calculate()` alongside the other access checks.

7. **Admin tools wishlist (from user)** — multi-admin already works. No other admin tooling requested yet.

---

## Things to watch for

- **SV data lost?** User noted Jan/Feb sector_values appeared missing after a deploy. Did NOT investigate this session — may need to look at the `sector_values` table next time. (No assistant response was given when raised.)
- **"Tail-swap shows ?"** — explained: that's the unverifiable marker (line 372-384 in `calculate.js`) when aircraft registration is missing for one of the consecutive sectors. Not a bug, working as designed.

---

## File map for next session

```
/sessions/determined-adoring-fermat/mnt/crewallowance/
├── crew-allowance/                    ← the actual app
│   ├── api/                           ← Vercel serverless functions
│   │   ├── aerodatabox.js             (existing)
│   │   ├── calculate.legacy.js        (dead, but still there)
│   │   ├── create-payment-intent.js   (DEAD — safe to delete)
│   │   ├── create-subscription.js     (recurring sub + comp path)
│   │   ├── create-trial-payment.js    (one-off ₹100 trial)
│   │   ├── customer-portal.js         (Stripe portal session)
│   │   ├── fr24.js                    (existing)
│   │   ├── signup.js                  (server-side signup w/ rollback)
│   │   └── stripe-webhook.js          (sub events + trial PI events)
│   ├── db_migrations/                 ← run in order in Supabase SQL Editor
│   ├── public/                        ← favicon, terms, privacy
│   ├── src/
│   │   ├── CrewAllowance.jsx          ← THE MONOLITH (everything UI lives here)
│   │   ├── calculate.js               ← allowance calculation engine
│   │   └── pdf/pcsrParser.js          ← PCSR PDF parsing
│   ├── CLAUDE.md                      ← architecture notes (updated this session)
│   └── package.json
├── session-handoff/                   ← THIS folder
│   ├── README.md                      (older quick-start notes)
│   ├── STRIPE_AND_DOMAIN_SETUP.md     (still useful — go-live checklist)
│   ├── SESSION_2026-04-23_HANDOFF.md  (this file)
│   └── harnesses/                     (test harnesses from earlier sessions)
└── CREWALLOWANCE_HANDOFF.md           ← Section 11 has FR24 architecture research
```

---

## How to resume next session

1. Read this file first.
2. If picking up admin-delete-user: re-read the plan in section "Open / parked items #1" above.
3. If investigating SV data loss: query `sector_values` table in Supabase, check what's there for Jan/Feb 2026.
4. If working on UI: `crew-allowance/src/CrewAllowance.jsx` is the only React file. ~2500 lines, organised by section dividers (`/* ═══...══ */`).
5. ESLint passes clean on all session-modified files. Pre-existing 6 errors in `calculate.legacy.js` (2) and `pcsrParser.js` (4) — leave alone.
6. To run lint: `cd crew-allowance && npx eslint src/CrewAllowance.jsx api/<file>.js`
7. Local build (`npm run build`) is BLOCKED in this sandbox by a Rollup arm64 binary issue — that's a sandbox-only problem, Vercel builds fine.

---

End of session 23 April 2026.
