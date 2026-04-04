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
- **`/api/create-payment-intent.js`** — Vercel serverless function for Stripe PaymentIntent creation.

### Screen Navigation

Navigation is state-driven (no React Router). A `screen` state variable in the root `App` component determines which screen renders. Screens: `landing`, `login`, `signup`, `checkout`, `forgot`, `calc`, `admin`, `reset-password`.

### Backend Services

- **Supabase** — Auth (email/password), `profiles` table (user records with `is_active`, `is_admin` flags).
- **Stripe** — Payment processing via client-side Stripe.js + the `/api/create-payment-intent` serverless function.

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
- Discount codes with percentages
- App branding, contact emails, legal URLs

### Environment Variables

```
VITE_STRIPE_PK          # Stripe publishable key
VITE_SUPABASE_URL       # Supabase project URL
VITE_SUPABASE_ANON_KEY  # Supabase anon key
STRIPE_SECRET_KEY       # Server-side only (Vercel env), used in /api/create-payment-intent.js
```

### Styling

All styles are inline CSS-in-JS using a `C` color token object defined at the top of CrewAllowance.jsx. There is no external CSS framework.
