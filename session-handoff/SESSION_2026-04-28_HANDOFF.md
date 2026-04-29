# Session handoff — 28 April 2026

Continuation of post-launch work. **Read this first** when picking up.
For earlier context see `SESSION_2026-04-23_HANDOFF.md`.

---

## Headline state

CrewAllowance.com is **live with paying users**. About 5 comp users have tested.
This session covered:

- A pilot's PCSR that wouldn't parse → **EOM parser fixed** (header-driven column detection)
- A user reporting wrong totals → **traced to ADB data quality**, switched to FR24
- FR24 has no scheduled times → **switched to FlightAware AeroAPI** (the win)
- New admin tools: **maintenance mode**, **API usage/cost panel**, **users search/stats**
- Payment-flow cleanup: **deferred Stripe Payment Element** (no more abandoned-checkout clutter)
- Form fixes: **comp code case-insensitive + prominent banner**, **two real bugs in calculator** (PNQ layover split, EOM parser column detection)

---

## What was wrong with ADB and why we left it

The pilot AFAN's PCSR failed because the EOM parser was using hardcoded x-coordinate
bands tuned to one PDF layout. Fixed with header-driven column detection (find
"Date | Duties | Details | Report | Actual | Debrief | Indicators" labels in the
PDF, snapshot their x-positions, assign every cell to the nearest column).
That's a permanent fix for layout drift — it'll absorb future eCrew template variants.

The bigger story was data-quality. A user reported their app totals were wrong.
We traced it: ADB was returning STA = 00:20 for 6E6658 PNQ-DEL on Feb 12, but the
actual scheduled arrival was 23:30. A 50-minute schedule error inflated their
Deadhead by ₹3,333. Vikram had been manually patching ADB rows for previous users —
not a sustainable model.

**Decision:** abandon ADB for the trust it can't deliver, switch providers.

---

## Provider migration: ADB → FR24 → FlightAware

We tried FR24 Essential ($90/mo, 2-year history). Worked for actuals + tail registrations
but **FR24's API has no scheduled times** — only what aircraft actually did. We confirmed
by checking the response shapes of all FR24 endpoints (Flight Summary Light/Full,
Historic Flight Positions, Historic Flight Events Full, Flight Tracks). None expose STD/STA.
The FR24 web UI shows STD/STA from a separate licensed source (probably OAG/SITA) that
isn't part of their API products.

We then tried **FlightAware AeroAPI**. Their `/history/flights/{ident}` endpoint returns
both `scheduled_out`/`scheduled_in` AND `actual_out`/`actual_in` AND `registration` AND
distinguishes gate vs runway times. History back to Jan 2011. Pay-per-query (~$0.002/call,
$10 first month, ~$100/mo at scale).

**Verdict:** FlightAware is the right provider. Vineet's Jan and Feb totals reconciled
to known-good values. Vineet Jan came in at ₹91,617 with no manual fixes.

### Files added/modified this session

```
api/aeroapi.js              ← NEW. FlightAware proxy.
api/fr24.js                 ← MODIFIED. Removed 30-day window guard (Essential
                              has 2 yrs). Updated field-name mapping (datetime_takeoff,
                              datetime_landed). Added UTC→IST conversion.
                              Added ?debug=1 for raw response.

src/calculate.js            ← MODIFIED. Layover post-process: coalesce same-station
                              consecutive events when intervening duty doesn't visit
                              home base. Same logic that previously double-counted
                              PNQ when pilot did a brief round-trip mid-layover.

src/pdf/pcsrParser.js       ← MODIFIED. EOM parser switched from hardcoded x-bands
                              to header-driven column detection (line 320 area).
                              Anshu Jan and AFAN Apr both parse cleanly now.

src/CrewAllowance.jsx       ← MODIFIED in many places:
                              - fetchScheduleSource accepts "aeroapi"
                              - fetchMaintenanceMode (new) + maintenance gate
                              - bumpApiUsage RPC call on every live API call
                              - SOURCE_THROTTLE_MS includes aeroapi
                              - Per-source endpoint routing in fetchWithCache
                              - Admin: 3-radio source toggle (adb/fr24/aeroapi)
                              - Admin: ApiUsagePanel component
                              - Admin: Maintenance tab
                              - Admin: Users tab — search box + stats summary
                              - Admin: per-user plan badge (Comp/Monthly/Annual/Trial used)
                              - Checkout: deferred PaymentIntent (no more "incomplete"
                                rows in Stripe Dashboard from plan toggling)
                              - Checkout: prominent gold "Have a free-access code?"
                                banner (was buried as a tiny link)
                              - Signup: case-insensitive comp code
                              - Calc: current/future month rejection at upload
                              - Drop zone: copy update — "Upload your performed roster
                                (PERSONAL CREW SCHEDULE REPORT) for any previous
                                month here"

api/signup.js               ← UNCHANGED this session — wired correctly already

db_migrations/
  005_app_settings_public_read.sql  ← NEW. Allow anon to read app_settings (so
                                     maintenance flag works for unauthenticated
                                     visitors on the landing page).
  006_api_usage.sql                 ← NEW. api_usage table + bump_api_usage() RPC.
                                     World-readable, world-writable for authenticated
                                     users (counts are non-sensitive aggregates).

session-handoff/harnesses/compare_providers.mjs
                            ← MODIFIED. Three-way diff: ADB / FR24 / FA columns.
                              CSV output expanded.
```

### Migrations to run on prod (in order)

1. `004_trial_columns.sql` (already done in last session)
2. `005_app_settings_public_read.sql` ← **needed for maintenance mode to gate unauthenticated visitors**
3. `006_api_usage.sql` ← **needed before flipping to AeroAPI** (else usage counter writes silently fail)

---

## Critical env-var checklist on Vercel (Production)

| Var | Purpose | Status |
|---|---|---|
| `STRIPE_SECRET_KEY` | sk_live_... | live |
| `STRIPE_WEBHOOK_SECRET` | whsec_... | live |
| `STRIPE_PRICE_1MO` | price_... ₹100/mo | live |
| `STRIPE_PRICE_12MO` | price_... ₹1000/yr | live |
| `FREE_ACCESS_CODE` | "CREW2026" | live |
| `SUPABASE_URL` | server-side copy | live |
| `SUPABASE_SERVICE_ROLE_KEY` | server-side | live |
| `RAPIDAPI_KEY` | AeroDataBox | live (kept as fallback) |
| `FR24_API_TOKEN` | Flightradar24 | live (Essential, $90/mo, can drop after AeroAPI proves out) |
| **`AEROAPI_KEY`** | **FlightAware AeroAPI** | **NEW, must be set for /api/aeroapi to work** |
| `VITE_STRIPE_PK` | pk_live_... | live |
| `VITE_SUPABASE_URL` | client-side | live |
| `VITE_SUPABASE_ANON_KEY` | client-side | live |

---

## Known-good calculations (regression baseline)

Run `node session-handoff/harnesses/compare_providers.mjs <pdf> https://crewallowance.com`
to validate after any future provider switch.

| PCSR | Sectors | Expected total (FA) |
|---|---|---|
| Anshu Jan 2026 (EOM) | 34 | ₹16,917 (limited cache locally — prod will be higher) |
| Vineet Jan 2026 (GRID) | 42 | **₹91,617** ← golden — matches payslip closely |
| Vineet Feb 2026 (GRID) | 32 | ₹37,050 |
| Vineet Mar 2026 (GRID) | 23 | parser-only validated, no payslip yet |
| AFAN Apr 2026 (EOM) | 42 | parser-only — current month, blocked by completeness gate |

---

## Layover coalescing — what we shipped

**Bug:** When a pilot lays over at station X, briefly flies a round-trip elsewhere
and back to X (without going home), the original code emitted two separate layover
events. New user's PCSR had this for PNQ Feb 10-12: 27h + 17h = ₹3,450 + ₹3,000 = ₹6,450,
when it should have been one continuous ₹6,600 stay.

**Fix in `src/calculate.js` `calculateLayover`:** post-process events list. When two
consecutive events are at the **same station**, AND no duty between them visits the
home base, merge into one continuous event spanning prev's chocks-on to cur's chocks-off.
Re-compute base + extra against the merged duration.

**Verified no regression** against Anshu Jan, Vineet Jan, Vineet Feb (no spurious merges
because none of those have the same-station-twice pattern).

---

## Tail-swap rule confirmation

IndiGo PAH says:

- Tail swap pays for **operating + operating** OR **operating + DHF** combinations
- **Within same duty period only**
- Excluded: any DHT involvement, or DHF→DHF

Our existing `calculateTailSwap` code matches all four rules exactly. **No code change
needed.** Investigated for the new user's Feb report (where payslip paid 1 swap but app
showed 2). The discrepancy is data-quality (FlightAware aircraft reg vs actual reg flown),
not rule logic.

---

## Open / parked items

In rough priority order:

1. **AeroAPI cost validation at scale** — currently $10 till month-end. Before paying
   $100+/mo, check how many calls per pilot per report we burn. The new admin
   "API Usage" panel shows live count + estimated cost.

2. **JAI tail-swap confirmation** — for the new user's Feb report, ask the pilot whether
   they actually swapped aircraft at JAI Feb 25. If FA's `VT-ICX → VT-ICQ` is wrong,
   we have a data-quality concern with FA too. If correct, payslip might have under-paid.

3. **Hotel-section parser robustness** — the new user's PCSR returned 0 hotels. Without
   hotel data, the layover gate is permissive (counts everything). With hotels, gate
   filters out non-hotelled long sits. Worth checking if their PCSR has a Hotel
   Information section the parser missed (they're using a slightly different layout
   than Vineet).

4. **BOM "is this a layover?" question** — IndiGo's PAH definition of TLPD eligibility
   for short ground stops between sectors. Some looked legit on duration but weren't
   on the payslip. Probably needs a definitive read of the rule book.

5. **Compare-providers harness** — works for ADB/FR24/AeroAPI three-way diff. Useful
   if FA quality concerns ever arise. Run it on the same sectors against all three to
   spot disagreement patterns.

6. **DEAD code cleanup** — `api/create-payment-intent.js` (replaced by `create-subscription.js`),
   `api/aerodatabox.js` if you're sure ADB is permanently retired. ADB still useful as
   a fallback for forward rosters (current month sectors that haven't operated yet,
   though we now block those at upload).

7. **Cache `source` column** — discussed earlier, never built. Would let us tell which
   provider produced each cached row, useful for forensics. Add when next touching
   `flight_schedule_cache` schema.

---

## What you do at session start next time

1. **Open this file first.** Then `SESSION_2026-04-23_HANDOFF.md` for prior context.
2. **Check if AeroAPI cost is reasonable** — Admin → Data Source tab → API Usage panel.
3. **Check if any new layout-variant PCSRs failed** — look for support emails to
   help@crewallowance.com.
4. **For any "wrong number" complaints**: first ask the user to verify their actuals
   in eCrew (we can't fix data quality from outside). Then check the breakdown CSV
   for which allowance type is off. The Layover/Tail-swap coalescing/duty rules are
   the most likely areas for genuine bugs vs data-quality issues.

---

## File map at end of this session

```
crew-allowance/
├── api/
│   ├── aerodatabox.js               (kept as fallback)
│   ├── aeroapi.js                   ★ NEW — FlightAware proxy
│   ├── calculate.legacy.js          (dead)
│   ├── create-payment-intent.js     (dead, safe to delete)
│   ├── create-subscription.js       (active)
│   ├── create-trial-payment.js      (active)
│   ├── customer-portal.js           (active)
│   ├── fr24.js                      (active, modified field names + UTC→IST)
│   ├── signup.js                    (active)
│   └── stripe-webhook.js            (active)
├── db_migrations/
│   ├── 001_app_settings.sql
│   ├── 002_subscription_columns.sql
│   ├── 003_profiles_email.sql
│   ├── 003b_backfill_emails.sql
│   ├── 004_trial_columns.sql
│   ├── 005_app_settings_public_read.sql      ★ NEW
│   └── 006_api_usage.sql                     ★ NEW
├── src/
│   ├── CrewAllowance.jsx            (the monolith — many additions this session)
│   ├── calculate.js                 (Layover coalescing added)
│   └── pdf/
│       ├── pcsrParser.js            (EOM header-driven column detection)
│       └── pdfToText.js
└── session-handoff/
    ├── README.md
    ├── SESSION_2026-04-23_HANDOFF.md
    ├── SESSION_2026-04-28_HANDOFF.md         ★ THIS FILE
    ├── STRIPE_AND_DOMAIN_SETUP.md
    └── harnesses/
        ├── anshu_calc.mjs
        ├── compare_providers.mjs              (now 3-way: ADB/FR24/FA)
        ├── mar_calc.mjs
        ├── probe_assignments.mjs
        ├── probe_mar.mjs
        └── regression.mjs
```

---

End of session 28 April 2026.
