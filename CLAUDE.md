# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start dev server with HMR
npm run build     # Production build (outputs to dist/)
npm run lint      # ESLint check
npm run preview   # Preview production build
```

No test framework is configured.

## Architecture

**Crew Allowance** is a React SPA for IndiGo airline crew to calculate monthly flight allowances.

### Structure

- **`/src/CrewAllowance.jsx`** — The entire UI app (~3,000+ lines): all screens, components, business logic, and inline styles live here. There is no component splitting across files.
- **`/src/calculate.js`** — Pure-function calculation engine. Imported by CrewAllowance.jsx and by the test harnesses in `/tmp`. All five allowance rules live here, plus `INDIAN_AIRPORTS` / `isDomestic()` helpers and `runCalculations()` orchestrator.
- **`/src/pdf/pcsrParser.js`** — PCSR PDF parser. Two paths: GRID (most pilots) and EOM (header-driven column detection — see Section 12.8 of HANDOFF). Rejects current/future-month PCSRs.
- **`/src/main.jsx`** — Entry point; mounts `<App />` from CrewAllowance.jsx.
- **`/api/aeroapi.js`** — FlightAware AeroAPI proxy (primary schedule data source). Returns scheduled + actual gate times + aircraft reg. Supports `?debug=1`.
- **`/api/fr24.js`** — Flightradar24 proxy (fallback only — used when FA returns null aircraft reg, gated by `fr24_fallback_enabled` admin setting).
- **`/api/aerodatabox.js`** — AeroDataBox proxy (legacy, kept as toggleable break-glass; not called in normal operation).
- **`/api/razorpay-create-order.js`** — Vercel serverless function: creates a one-time Razorpay Order for the ₹100 trial. Browser opens Standard Checkout with the returned `order_id`.
- **`/api/razorpay-create-subscription.js`** — Creates a Razorpay Subscription against `RAZORPAY_PLAN_1MO` / `RAZORPAY_PLAN_12MO` (₹100/mo, ₹1000/yr) OR handles free-access code activation. Browser opens Checkout with the returned `subscription_id`.
- **`/api/razorpay-verify-payment.js`** — HMAC-SHA256 verification of the Checkout `handler` callback (both `order_id|payment_id` for trial and `payment_id|subscription_id` for subscriptions). Performs an optimistic `profiles` update so the success UI renders without waiting for the webhook.
- **`/api/razorpay-webhook.js`** — Source-of-truth for trial + subscription lifecycle. Verifies `X-Razorpay-Signature` against `RAZORPAY_WEBHOOK_SECRET`, then maps `payment.captured` and `subscription.*` events to the same `profiles` columns the legacy Stripe webhook used.
- **`/api/razorpay-cancel-subscription.js`** — In-app "Cancel at end of period" replacement for the Stripe Customer Portal. Calls `POST /v1/subscriptions/:id/cancel` with `cancel_at_cycle_end=1`.
- **`/api/create-subscription.js`**, **`/api/stripe-webhook.js`**, **`/api/create-trial-payment.js`**, **`/api/customer-portal.js`**, **`/api/create-payment-intent.js`** — **LEGACY STRIPE** code, kept temporarily for fallback. Will be deleted once Razorpay path is verified live.
- **`/scripts/razorpay-create-plans.mjs`** — One-off helper: creates the two recurring Plans on Razorpay and prints the `plan_id`s for the env vars.

The three schedule proxies share an interchangeable response shape:
`{ std_local, sta_local, atd_local, ata_local, aircraft_reg, _source?, _meta? }` — so the
client can swap providers via the admin Data Source toggle without code changes.

### Screen Navigation

Navigation is state-driven (no React Router). A `screen` state variable in the root `App` component determines which screen renders. Screens: `landing`, `login`, `signup`, `checkout`, `forgot`, `calc`, `admin`, `reset-password`.

### Backend Services

- **Supabase** — Auth (email/password) + tables: `profiles` (users with `is_active`, `is_admin`, subscription state, trial state), `flight_schedule_cache` (per flight/dep/arr/date), `app_settings` (`schedule_source`, `maintenance_mode`, `fr24_fallback_enabled`), `sector_values` (monthly SV uploads), `api_usage` (per-source per-day call counts).
- **Razorpay** — Subscription billing via Razorpay Standard Checkout (client) + `/api/razorpay-create-subscription` (recurring) / `/api/razorpay-create-order` (trial) + `/api/razorpay-verify-payment` + `/api/razorpay-webhook` (server). Two plans: ₹100/month, ₹1,000/year, plus a one-time ₹100 trial. Free-access code path for comp accounts is unchanged.

### Allowance Calculation Engine

The core logic parses two CSVs (logbook + schedule) and computes 5 allowance types:

| Allowance | Rule |
|-----------|------|
| Deadhead | Per scheduled block hour for non-operating crew |
| Night Flying | Flights departing 0000–0600 IST |
| Layover | Away from home base >10h 01m |
| Tail Swap | Aircraft registration changes on same day |
| Transit | Domestic halts between 90 min and 4 hours |

All time math uses UTC→IST conversion (UTC+5:30). Results are exportable as CSV.

### Configuration

A hardcoded `CONFIG` object in CrewAllowance.jsx holds:
- Allowance rates per rank (Captain, First Officer, Cabin Crew) — based on IndiGo's January 2026 rates
- Subscription plan definitions (1mo / 12mo)
- App branding, contact emails, legal URLs

### Environment Variables

```
# Client-side (VITE_ prefix — exposed to browser)
VITE_RAZORPAY_KEY_ID    # Razorpay publishable key (rzp_live_... or rzp_test_...)
VITE_SUPABASE_URL       # Supabase project URL
VITE_SUPABASE_ANON_KEY  # Supabase anon key

# Server-side only (Vercel env — never exposed)
RAZORPAY_KEY_ID           # rzp_live_... or rzp_test_... (paired with KEY_SECRET)
RAZORPAY_KEY_SECRET       # Server-only secret
RAZORPAY_WEBHOOK_SECRET   # Secret configured on the Razorpay webhook endpoint
RAZORPAY_PLAN_1MO         # plan_... for ₹100/month  (created via scripts/razorpay-create-plans.mjs)
RAZORPAY_PLAN_12MO        # plan_... for ₹1,000/year
FREE_ACCESS_CODE          # Shared secret for comp accounts
SUPABASE_URL              # Same URL, but without VITE_ prefix for server
SUPABASE_SERVICE_ROLE_KEY # Service role key (never the anon key)
AEROAPI_KEY               # For FlightAware AeroAPI proxy (PRIMARY)
FR24_API_TOKEN            # For FR24 proxy (FALLBACK for missing aircraft reg)
RAPIDAPI_KEY              # For AeroDataBox proxy (LEGACY, not called in normal use)

# Legacy Stripe vars (kept for the cutover; safe to remove after the
# Razorpay path is verified live and the legacy /api/* files are deleted):
#   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_1MO, STRIPE_PRICE_12MO, VITE_STRIPE_PK
```

### Schedule Data Architecture

Three providers, one response shape, admin-toggleable. See HANDOFF Section 12.1–12.4 for
the migration history (ADB → FR24 → FlightAware) and the IST/UTC bug fix that affected
all three. Phase 2 (FR24 fallback for missing FA reg) and Phase 3 (midnight-delay sector
detection) are documented in HANDOFF 12.2 and 12.3.

The `fetchWithCache` function in CrewAllowance.jsx is the single entry point. It handles:
cache lookups (PCSR date and day-1 for midnight-delay sectors), primary proxy call, FR24
fallback for null reg, midnight-delay retry with `date - 1`, cache writes under the *true*
operation date, and `_date_shifted` flag propagation.

### Styling

All styles are inline CSS-in-JS using a `C` color token object defined at the top of CrewAllowance.jsx. There is no external CSS framework.
