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

- **`/src/CrewAllowance.jsx`** — The entire app (~1,500 lines): all screens, components, business logic, and inline styles live here. There is no component splitting across files.
- **`/src/main.jsx`** — Entry point; mounts `<App />` from CrewAllowance.jsx.
- **`/api/create-subscription.js`** — Vercel serverless function: creates Stripe Customer + Subscription for tiered plans (₹100/mo, ₹1000/yr) or handles free-access code activation.
- **`/api/stripe-webhook.js`** — Stripe webhook handler: syncs subscription lifecycle events (created, updated, deleted, invoice paid/failed) to the `profiles` table.
- **`/api/create-payment-intent.js`** — **DEAD CODE** (legacy one-off PaymentIntent). Superseded by create-subscription.js. Safe to delete.

### Screen Navigation

Navigation is state-driven (no React Router). A `screen` state variable in the root `App` component determines which screen renders. Screens: `landing`, `login`, `signup`, `checkout`, `forgot`, `calc`, `admin`, `reset-password`.

### Backend Services

- **Supabase** — Auth (email/password), `profiles` table (user records with `is_active`, `is_admin` flags).
- **Stripe** — Subscription billing via Stripe.js (client) + `/api/create-subscription` + `/api/stripe-webhook` (server). Two plans: ₹100/month, ₹1,000/year. Free-access code path for comp accounts.

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
VITE_STRIPE_PK          # Stripe publishable key (pk_live_... or pk_test_...)
VITE_SUPABASE_URL       # Supabase project URL
VITE_SUPABASE_ANON_KEY  # Supabase anon key

# Server-side only (Vercel env — never exposed)
STRIPE_SECRET_KEY         # sk_live_... or sk_test_...
STRIPE_WEBHOOK_SECRET     # whsec_... from Stripe Webhooks
STRIPE_PRICE_1MO          # price_... for ₹100/month plan
STRIPE_PRICE_12MO         # price_... for ₹1,000/year plan
FREE_ACCESS_CODE          # Shared secret for comp accounts
SUPABASE_URL              # Same URL, but without VITE_ prefix for server
SUPABASE_SERVICE_ROLE_KEY # Service role key (never the anon key)
RAPIDAPI_KEY              # For AeroDataBox proxy
FR24_API_TOKEN            # For FR24 proxy
```

### Styling

All styles are inline CSS-in-JS using a `C` color token object defined at the top of CrewAllowance.jsx. There is no external CSS framework.
