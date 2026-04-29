# Session handoff — most recent first

> **Pick this up next time:** read `SESSION_2026-04-28_HANDOFF.md` first.
> It captures the post-launch work — switch to FlightAware AeroAPI, parser
> improvements, admin tools (maintenance mode, API usage panel, users
> search/stats), Stripe deferred Payment Element, and a Layover bug fix.
>
> Then `SESSION_2026-04-23_HANDOFF.md` for the launch state.
>
> The notes below are from the older 21–22 April session and remain valid for
> FR24 architecture context only (now superseded by FlightAware).

---

# Session handoff — 21–22 Apr 2026

Quick-start notes for the next session. Full context is in
`../CREWALLOWANCE_HANDOFF.md` section 11.

## Where things stand

**Code:** unchanged during this session. Parser/calc are working on all three test PDFs
(Jan, Feb, March for Vineet; Anshu EOM for Jan).

**March PDF test (Vineet):** ran cleanly through GRID parser — 23 sectors, 4 hotels,
no regressions. Layover came out to ₹12,600; other allowances need live ADB/FR24
data that the local harness can't produce. Realistic prod estimate ₹15–20k.

**xlsx input evaluation:** xlsx exports lack the calendar grid (no ATD/ATA/routes),
so stick with PDF input.

## Open question — FR24 architecture

Vikram is thinking about how to deal with FR24 Explorer plan's 30-day history
limit. Three options identified, no decision yet:

- **A. Upgrade to Essential ($90/mo):** 2-year history, skip sweep entirely (Claude's rec).
- **B. Stay on Explorer, fetch per-PCSR-upload only:** warn users about >30d history.
- **C. Hybrid delta-aware sweep:** cheapest if drift is low, most complex.

**Blocking question to ask Vikram first:** were the manual DB fixes he made to ADB
data because (a) ADB was consistently wrong for certain flights, or (b) ADB went
stale when IndiGo shifted a schedule? That answer determines whether delta-detection
is even meaningful.

## Operational cleanup needed before any sweeper work

1. Add `source` column to `schedule_times` cache ('manual' | 'adb' | 'fr24') so
   Vikram's hand-corrected rows don't get overwritten.
2. Confirm FR24 `flight-summary` returns BOTH scheduled and actual times in one call
   (likely but unconfirmed — one probe call to verify before architecting).

## Harnesses saved here

- `harnesses/mar_calc.mjs` — full end-to-end calc on any PDF + SV xlsx.
- `harnesses/regression.mjs` — Jan + Feb regression test.
- `harnesses/probe_mar.mjs` — parser-only inspection.
- `harnesses/anshu_calc.mjs` — EOM-format equivalent.
- `harnesses/probe_assignments.mjs` — EOM date-assignment debug logger.

These paths are hardcoded to `mnt/crewallowance/crew-allowance` and `mnt/crewallowance/assets`,
so just `cd` to the crew-allowance repo and run them with `node`.
