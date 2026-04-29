import { useState, useRef, useCallback, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";
import { runCalculations } from "./calculate.js";
import "./App.css";

/* ═══════════════════════════════════════════════════════════════════
   SUPABASE CLIENT
═══════════════════════════════════════════════════════════════════ */
const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL      || "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const supabase = SUPABASE_URL
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

const sbWarn = () => console.warn("Supabase not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY");

/* ═══════════════════════════════════════════════════════════════════
   APP CONFIGURATION
═══════════════════════════════════════════════════════════════════ */
const CONFIG = {
  appName:       "Crew Allowance",
  airline:       "IndiGo",
  tagline:       "Eff. Jan 2026",
  copyrightYear: "2026",
  siteUrl:       "https://crewallowance.com",
  emailSupport:  "help@crewallowance.com",
  emailPrivacy:  "help@crewallowance.com",
  currency:      "₹",
  // Subscription tiers. Server validates plan key against STRIPE_PRICE_* env vars.
  plans: {
    "trial": { kind: "trial",        total: 100,  label: "Try once",  sub: "₹100 · One report · No auto-renewal", badge: "Recommended for first-time users" },
    "1mo":   { kind: "subscription", total: 100,  label: "Monthly",   sub: "₹100/month · unlimited reports",      badge: "" },
    "12mo":  { kind: "subscription", total: 1000, label: "Annual",    sub: "₹1,000/year (save 17%) · unlimited",  badge: "Best value" },
  },
  defaultPlan: "trial",
  ranks: ["Captain", "Senior Captain", "First Officer", "Senior First Officer", "Cabin Crew"],
  layoverMinHours: 10.0167,
  governingLaw:    "New Delhi, India",
  effectiveDate:   "1 January 2026",
};

const APP_NAME       = CONFIG.appName;
const RANKS          = CONFIG.ranks;
const PLANS          = CONFIG.plans;
const DEFAULT_PLAN   = CONFIG.defaultPlan;

// Map display ranks → rate bucket
const rankBucket = r => {
  const v = (r || "").toLowerCase();
  if (v.includes("cabin")) return "Cabin Crew";
  if (v.includes("first") || v.includes("fo")) return "First Officer";
  return "Captain";
};

const DEFAULT_RATES = {
  lastUpdated: "1 January 2026",
  source: "IndiGo Revised Cockpit Crew Allowances",
  deadhead:  { Captain: 4000, "First Officer": 2000, "Cabin Crew": null },
  night:     { Captain: 2000, "First Officer": 1000, "Cabin Crew": null },
  layover:   { Captain: { base: 3000, beyondRate: 150 }, "First Officer": { base: 1500, beyondRate: 75 }, "Cabin Crew": null },
  tailSwap:  { Captain: 1500, "First Officer": 750,  "Cabin Crew": null },
  transit:   { Captain: 1000, "First Officer": 500,  "Cabin Crew": null },
  layoverMinHours: CONFIG.layoverMinHours,
};

const fmtHM  = m => { const h = Math.floor(Math.abs(m)/60), mn = Math.round(Math.abs(m)%60); return h+"h "+mn.toString().padStart(2,"0")+"m"; };
const fmtINR = n => "₹"+(Math.round(n||0)).toLocaleString("en-IN");


/* Calculation is server-side via /api/calculate — see api/calculate.js */
/* ═══════════════════════════════════════════════════════════════════
   SCHEDULE DATA API  (AeroDataBox or FR24, via serverless proxy + Supabase cache)
═══════════════════════════════════════════════════════════════════ */
// Read the global schedule_source admin setting from app_settings.
// Returns "adb" (default), "fr24", or "aeroapi". Fails open to "adb" on any
// error so a missing settings table or permissions hiccup never breaks the
// calculator.
async function fetchScheduleSource() {
  if (!supabase) return "aeroapi";
  try {
    const { data } = await supabase.from("app_settings")
      .select("value").eq("key", "schedule_source").maybeSingle();
    const v = (data?.value || "").toLowerCase();
    if (v === "fr24") return "fr24";
    if (v === "adb")  return "adb";
    return "aeroapi"; // default: AeroAPI (FA) is the trusted primary as of Apr 2026.
  } catch {
    return "aeroapi";
  }
}

// Phase 2 (Apr 2026): when the primary provider is AeroAPI but its response
// has a null aircraft_reg (a known FA gap for some IndiGo flights — e.g.
// 6E2230 DEL-KNU 2026-01-01 and 6E2052 DEL-HYD 2026-01-11 returned null),
// we make a secondary call to FR24 just to fill in the reg. FR24 is on a
// flat $90/month plan, so the marginal cost is zero — we only pay for the
// duplicate latency.
//
// This is gated by an admin toggle (`fr24_fallback_enabled`) so it can be
// flipped off the moment FlightAware fixes their data on their side.
//
// Defaults to TRUE — the use case is real today and the cost is zero.
async function fetchFallbackEnabled() {
  if (!supabase) return true;
  try {
    const { data } = await supabase.from("app_settings")
      .select("value").eq("key", "fr24_fallback_enabled").maybeSingle();
    if (!data?.value) return true; // default ON
    const v = String(data.value).toLowerCase();
    return v !== "false" && v !== "0";
  } catch {
    return true;
  }
}

// Returns { enabled: boolean, message: string } for the maintenance flag.
// Fails open (enabled=false) on any error so a misconfig never locks users out.
async function fetchMaintenanceMode() {
  if (!supabase) return { enabled: false, message: "" };
  try {
    const { data, error } = await supabase.from("app_settings")
      .select("value").eq("key", "maintenance_mode").maybeSingle();
    if (error) {
      console.warn("[maintenance] read error:", error.message);
      return { enabled: false, message: "" };
    }
    if (!data?.value) {
      console.log("[maintenance] no row yet (returning false)");
      return { enabled: false, message: "" };
    }
    // Stored as JSON: {"enabled": true, "message": "..."}
    let parsed;
    try { parsed = JSON.parse(data.value); }
    catch { parsed = { enabled: data.value === "true", message: "" }; }
    console.log("[maintenance] flag =", parsed);
    return {
      enabled: !!parsed.enabled,
      message: String(parsed.message || ""),
    };
  } catch (e) {
    console.warn("[maintenance] fetch threw:", e.message);
    return { enabled: false, message: "" };
  }
}

// Per-source throttle between live API calls.
//   ADB:     600ms  (~1.6 req/sec)
//   FR24:    2100ms (~28 req/min — just under FR24's typical 30/min ceiling)
//   AeroAPI: 600ms  (FA Standard handles bursts well)
const SOURCE_THROTTLE_MS = { adb: 600, fr24: 2100, aeroapi: 600 };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Bump the api_usage counter for a source. Fire-and-forget — never throws.
async function bumpApiUsage(source) {
  if (!supabase) return;
  try {
    const { error } = await supabase.rpc("bump_api_usage", { p_source: source });
    if (error) console.warn("[usage] bump error:", error.message);
  } catch (e) { console.warn("[usage] bump threw:", e.message); }
}

// Compute the absolute clock-difference in minutes between two HH:MM strings,
// allowing for midnight wrap-around (so 23:50 vs 00:10 = 20 min, not 23h40m).
// Returns null if either input is unparseable.
function hhmmGapMins(a, b) {
  const parse = (s) => {
    if (!s || typeof s !== "string") return null;
    const m = s.match(/^(\d{2}):(\d{2})$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  };
  const am = parse(a), bm = parse(b);
  if (am == null || bm == null) return null;
  const raw = Math.abs(am - bm);
  return Math.min(raw, 1440 - raw); // wrap around midnight
}

// Subtract 1 day from a YYYY-MM-DD string (UTC-safe).
function shiftDateMinusOne(yyyymmdd) {
  const d = new Date(yyyymmdd + "T00:00:00Z");
  if (isNaN(d)) return null;
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// One-shot call to a single provider proxy. No cache reads, no merging.
// Used both as the primary lookup and as the FR24 fallback for missing FA reg.
// Returns { data, status: "ok" } | { rateLimited, retryAfter } | { status: code } | null.
async function callProxyOnce(flight, dep, arr, date, source) {
  const endpoint = source === "fr24"    ? "/api/fr24"
                 : source === "aeroapi" ? "/api/aeroapi"
                 :                        "/api/aerodatabox";
  const providerName = source === "fr24"    ? "FR24"
                     : source === "aeroapi" ? "AeroAPI"
                     :                        "AeroDataBox";
  const url = `${endpoint}?flight=${encodeURIComponent(flight)}&dep=${encodeURIComponent(dep)}&arr=${encodeURIComponent(arr)}&date=${encodeURIComponent(date)}`;
  let resp;
  try {
    resp = await fetch(url);
  } catch (fetchErr) {
    console.warn(`${providerName} fetch error for ${flight} ${dep}→${arr} ${date}:`, fetchErr.message);
    return null;
  }
  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get("retry-after") || "0", 10);
    console.warn(`${providerName} 429 rate-limited; retry-after=${retryAfter}s`);
    return { rateLimited: true, retryAfter };
  }
  if (!resp.ok) {
    let body = "";
    try { body = await resp.text(); } catch { /* ignore */ }
    console.warn(`${providerName} ${resp.status} for ${flight} ${dep}→${arr} ${date}:`, body.slice(0, 200));
    return { status: resp.status };
  }
  const data = await resp.json();
  return { data, status: "ok" };
}

// Returns { data, fromCache } or { rateLimited: true } or null.
//
// `pcsrAtd` (optional): the actual takeoff time the pilot recorded on the
// PCSR for this leg (HH:MM IST). Used to detect "midnight-delay" sectors —
// flights whose scheduled departure was the previous day but actual takeoff
// slipped past midnight, so the PCSR dates them to the next day. When the
// schedule API's returned ATD differs from the PCSR ATD by >6h, we retry
// with date-1 and use that operation if its ATD matches. See Phase 3 notes.
async function fetchWithCache(flight, dep, arr, date, source = "adb", pcsrAtd = null) {
  // Diagnostic log: helps debug why Phase 3 may or may not have triggered
  // for a given sector. Only logs when pcsrAtd is in the early-AM window
  // (the only case where Phase 3 actually does anything) to avoid noise.
  if (pcsrAtd && /^0[0-5]:/.test(pcsrAtd)) {
    console.log(`[fetchWithCache:earlyAM] ${flight} ${dep}→${arr} ${date} pcsrAtd=${pcsrAtd}`);
  }
  // ── Cache check: try the PCSR date first, then (if pcsrAtd suggests a
  //    midnight-delay shift) try day-1. This means re-runs of an
  //    already-shifted sector hit cache without paying for a primary call.
  if (supabase) {
    const { data, error: cacheReadErr } = await supabase.from("flight_schedule_cache")
      .select("*").eq("flight_no", flight).eq("dep", dep).eq("arr", arr).eq("date", date).limit(1).maybeSingle();
    if (cacheReadErr) {
      console.warn(`[cache] read error for ${flight} ${dep}→${arr} ${date}:`, cacheReadErr.message);
    } else if (data) {
      return { data, fromCache: true };
    }
    // If the PCSR ATD is early-morning (00:00–06:00 IST), this might be a
    // midnight-delay sector. Check the day-1 cache row too — if its ATD is
    // close to the PCSR's, that's the operation we want.
    if (pcsrAtd) {
      const m = pcsrAtd.match(/^(\d{2}):(\d{2})$/);
      const mins = m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : -1;
      if (mins >= 0 && mins <= 360) {
        const prevDate = shiftDateMinusOne(date);
        if (prevDate) {
          const { data: prev } = await supabase.from("flight_schedule_cache")
            .select("*").eq("flight_no", flight).eq("dep", dep).eq("arr", arr).eq("date", prevDate).limit(1).maybeSingle();
          if (prev?.atd_local) {
            const gap = hhmmGapMins(pcsrAtd, prev.atd_local);
            if (gap != null && gap <= 60) {
              return { data: { ...prev, _date_shifted: true, _shifted_to: prevDate }, fromCache: true };
            }
          }
        }
      }
    }
  }

  // ── Primary call ────────────────────────────────────────────────────────
  const primary = await callProxyOnce(flight, dep, arr, date, source);
  if (!primary) return null;
  if (primary.rateLimited) return primary;
  if (primary.status !== "ok") return null;

  let json = primary.data;
  let cacheDate = date;            // where to write the cache row
  let dateShifted = false;         // tag for the UI
  bumpApiUsage(source);

  // ── Phase 3: midnight-delay detection ───────────────────────────────────
  // The PCSR dates each sector by its ACTUAL takeoff date. A flight scheduled
  // for late evening on day N that gets delayed past midnight takes off on
  // day N+1, so the PCSR records it as N+1. But the schedule API buckets it
  // under day N (its scheduled date). Querying day N+1 returns the wrong
  // operation — usually a different aircraft — which then poisons tail-swap
  // detection.
  //
  // The reliable signal: PCSR ATD in the early-morning window (00:00–06:00 IST)
  // is highly suspicious for a midnight-delay sector. If the API's ATD for
  // that day is NOT in the same early-morning window, the API gave us the
  // wrong day's operation. Retry with date-1; if its ATD lands close to the
  // PCSR's ATD AND the primary's ATD doesn't, use the day-1 result.
  //
  // Skipped for sectors with no PCSR ATD (DHF/DHT) since they can't drive
  // tail-swap detection anyway.
  const inEarlyMorning = (hhmm) => {
    const m = hhmm?.match(/^(\d{2}):(\d{2})$/);
    if (!m) return false;
    const mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    return mins >= 0 && mins <= 360; // 00:00–06:00 IST
  };

  if (pcsrAtd && json.atd_local && inEarlyMorning(pcsrAtd) && !inEarlyMorning(json.atd_local)) {
    const prevDate = shiftDateMinusOne(date);
    if (prevDate) {
      const primaryGap = hhmmGapMins(pcsrAtd, json.atd_local);
      console.log(`[date-shift] ${flight} ${dep}→${arr} ${date}: PCSR ATD ${pcsrAtd} (early-AM) vs API ATD ${json.atd_local} (not early-AM) — retrying with ${prevDate}`);
      const retry = await callProxyOnce(flight, dep, arr, prevDate, source);
      if (retry?.status === "ok" && retry.data?.atd_local) {
        const retryGap = hhmmGapMins(pcsrAtd, retry.data.atd_local);
        // Use the day-1 result if it's much closer (≤60m) to the PCSR ATD
        // and meaningfully closer than the primary.
        if (retryGap != null && retryGap <= 60 && (primaryGap == null || retryGap + 60 < primaryGap)) {
          console.log(`[date-shift] ${flight} ${dep}→${arr}: ${prevDate} ATD ${retry.data.atd_local} matches PCSR (${retryGap}m gap vs ${primaryGap}m) — using day-shifted result.`);
          json = { ...retry.data, _date_shifted: true, _shifted_to: prevDate };
          cacheDate = prevDate;
          dateShifted = true;
          bumpApiUsage(source);
        } else {
          console.log(`[date-shift] ${flight} ${dep}→${arr}: ${prevDate} ATD ${retry.data?.atd_local} not a clear match (${retryGap}m gap) — keeping original.`);
        }
      }
    }
  }

  // ── Phase 2: FR24 fallback for missing FA aircraft_reg ───────────────────
  // Only fires when:
  //   1. Primary source is AeroAPI (FR24 fallback only makes sense for FA).
  //   2. Admin toggle `fr24_fallback_enabled` is true (default true).
  //   3. FA returned a successful response BUT aircraft_reg is null/empty.
  // Cost: zero — FR24 is flat $90/mo on Essential.
  // We track these calls under source "fr24_fallback" so the admin can see
  // the hit rate (= how often FA is letting us down).
  if (source === "aeroapi" && (!json.aircraft_reg || json.aircraft_reg === "")) {
    try {
      const fallbackOn = await fetchFallbackEnabled();
      if (fallbackOn) {
        // Use cacheDate (post-shift) so we look up the same operation FA returned.
        const fb = await callProxyOnce(flight, dep, arr, cacheDate, "fr24");
        if (fb?.status === "ok" && fb.data?.aircraft_reg) {
          json = { ...json, aircraft_reg: fb.data.aircraft_reg, _reg_source: "fr24_fallback" };
          bumpApiUsage("fr24_fallback");
          console.log(`[fr24_fallback] filled reg for ${flight} ${dep}→${arr} ${cacheDate}: ${fb.data.aircraft_reg}`);
        }
      }
    } catch (e) {
      // Fallback is best-effort; never let it break the main call.
      console.warn("[fr24_fallback] failed (non-fatal):", e.message);
    }
  }

  if (supabase) {
    // Cache key is the *true* operation date — same as `date` for normal
    // sectors, or date-1 when we day-shifted. Other pilots querying the
    // same true-date sector will hit cache cleanly.
    const { error: cacheErr } = await supabase.from("flight_schedule_cache").upsert({
      flight_no: flight, dep, arr, date: cacheDate,
      std_local: json.std_local ?? null, sta_local: json.sta_local ?? null,
      atd_local: json.atd_local ?? null, ata_local: json.ata_local ?? null,
      aircraft_reg: json.aircraft_reg ?? null,
      fetched_at: new Date().toISOString(),
    }, { onConflict: "flight_no,dep,arr,date" });
    if (cacheErr) console.warn("Cache write failed:", cacheErr.message);
  }
  // Re-flag the returned data so the calculator/UI can see this was shifted.
  if (dateShifted) json = { ...json, _date_shifted: true, _shifted_to: cacheDate };
  return { data: json, fromCache: false };
}

// Returns { map, fetched, cached, failed }
async function buildSchedMap(sectors, onProgress, source = "adb") {
  const map = {};
  const unique = [];
  const seen = new Set();
  for (const s of sectors) {
    const flight = s.flight || s.flight_no;
    const key = `${flight}|${s.dep}|${s.arr}|${s.date}`;
    if (!seen.has(key)) { seen.add(key); unique.push({ ...s, _flight: flight }); }
  }
  const baseThrottle = SOURCE_THROTTLE_MS[source] ?? 600;
  let fetched = 0, cached = 0, failed = 0;
  let lastWasLive = false;
  for (let i = 0; i < unique.length; i++) {
    const s = unique[i];
    onProgress?.(i + 1, unique.length, s._flight);
    if (!s.dep || !s.arr) {
      console.warn(`Skipping ${s._flight} on ${s.date}: dep/arr missing`);
      failed++;
      continue;
    }
    if (lastWasLive) await sleep(baseThrottle);
    lastWasLive = false;
    const key = `${s._flight}|${s.dep}|${s.arr}|${s.date}`;
    try {
      // Up to 3 attempts on rate-limit, with exponential backoff.
      let result = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        // Pass the PCSR's actual takeoff time so fetchWithCache can detect
        // midnight-delay sectors (Phase 3). The remapping in `recompute`
        // renames `atd_local` to `atd` before sectors get here, so check both.
        // Skipped (passed as null) for DHF/DHT sectors which have no ATD.
        const pcsrAtd = s.atd || s.atd_local || null;
        result = await fetchWithCache(s._flight, s.dep, s.arr, s.date, source, pcsrAtd);
        if (!result?.rateLimited) break;
        const waitMs = (result.retryAfter > 0 ? result.retryAfter * 1000 : (10000 * (attempt + 1)));
        console.warn(`Rate-limited; backing off ${waitMs}ms before retry ${attempt + 1}/3`);
        await sleep(waitMs);
      }
      if (result && !result.rateLimited) {
        map[key] = result.data;
        if (result.fromCache) { cached++; } else { fetched++; lastWasLive = true; }
      } else {
        failed++;
      }
    } catch (e) {
      console.warn("buildSchedMap error:", e.message);
      failed++;
    }
  }
  return { map, fetched, cached, failed };
}

/* ═══════════════════════════════════════════════════════════════════
   CSV DOWNLOAD
═══════════════════════════════════════════════════════════════════ */
function dlCSV(res, pilot) {
  const rows = [], add = (...r) => rows.push(r.join(","));
  add("Crew Allowance Statement - " + res.period);
  add("Pilot: " + pilot.name, "ID: " + pilot.emp_id, "Rank: " + pilot.rank);
  add(); add("DEADHEAD"); add("Date","Flight","From","To","Sched Block (mins)","Amount (INR)");
  res.deadhead.sectors.forEach(s => add(s.date, s.flight, s.from, s.to, s.scheduled_block_mins, Math.round(s.amount)));
  add("TOTAL","","","","", Math.round(res.deadhead.amount)); add();
  add("NIGHT FLYING (00:00–06:00 IST, PAH §9.0)"); add("Date","Flight","From","To","STD IST","STA IST","Night Mins","SV","Amount (INR)");
  res.night.sectors.forEach(s => add(s.date, s.flight, s.from, s.to, s.std_ist, s.sta_ist, s.night_mins, s.sv_used ?? "—", Math.round(s.amount)));
  add("TOTAL","","","","","","", Math.round(res.night.amount)); add();
  add("LAYOVER"); add("Station","Date In","Date Out","Check-In","Check-Out","Hrs","Base","Extra","Total (INR)","Note");
  res.layover.events.forEach(e => add(
    e.station, e.date_in, e.date_out, e.check_in_ist, e.check_out_ist, e.duration_hrs,
    Math.round(e.base_amount), Math.round(e.extra_amount), Math.round(e.total),
    e.international ? "International — calculated separately" : ""
  ));
  add("TOTAL","","","","","","","", Math.round(res.layover.amount)); add();
  add("TAIL-SWAP"); add("Date","Sectors","Station","Reg Out","Reg In","Amount (INR)","Note");
  res.tailSwap.swaps.forEach(s => add(s.date, s.sector_pair, s.station, s.reg_out, s.reg_in,
    s.unverifiable ? "unverifiable" : Math.round(s.amount),
    s.date_shifted ? "Midnight-delay sector — reg verified against previous day's schedule" : ""));
  add("TOTAL","","","","", Math.round(res.tailSwap.amount)); add();
  add("TRANSIT"); add("Date","Station","Arrived","Departed","Halt (mins)","Billable (mins)","Basis","Amount (INR)");
  res.transit.halts.forEach(h => add(h.date, h.station, h.arrived_ist, h.departed_ist, h.halt_mins, h.billable_mins, h.basis, Math.round(h.amount)));
  add("TOTAL","","","","","","", Math.round(res.transit.amount)); add();
  add("GRAND TOTAL INR", Math.round(res.total));
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `CrewAllowance_${pilot.emp_id}_${res.period?.replace(/\s/g, "_")}.csv`;
  a.click();
}

/* ═══════════════════════════════════════════════════════════════════
   DESIGN TOKENS
═══════════════════════════════════════════════════════════════════ */
const C = {
  sky:"#f0f7ff", skyMid:"#daeeff", white:"#ffffff",
  blue:"#1a6fd4", blueMid:"#3d8ef0", blueLight:"#e8f2fd", blueXLight:"#f4f9ff",
  navy:"#0f3460",
  gold:"#b87000", goldBg:"#fff8e6", goldBorder:"#f0d080", goldText:"#c47f00",
  green:"#0e7a5a", greenBg:"#edfaf5",
  red:"#c0132a", redBg:"#fff1f3",
  text:"#1e293b", textMid:"#475569", textLo:"#94a3b8",
  border:"#e2eaf4", borderMid:"#c8d8ee",
  shadow:"0 2px 12px rgba(26,111,212,0.08)",
  shadowMd:"0 4px 24px rgba(26,111,212,0.12)",
};

/* ═══════════════════════════════════════════════════════════════════
   SHARED UI COMPONENTS
═══════════════════════════════════════════════════════════════════ */
function FInput({ label, type="text", value, onChange, placeholder, autoComplete, hint, readOnly }) {
  const [f, setF] = useState(false);
  return (
    <div style={{ marginBottom: 16 }}>
      {label && <label style={{ display:"block", fontSize:12, fontWeight:700, color:C.navy, marginBottom:5 }}>{label}</label>}
      <input type={type} value={value}
        onChange={e => onChange && onChange(e.target.value)}
        placeholder={placeholder} autoComplete={autoComplete} readOnly={readOnly}
        onFocus={() => setF(true)} onBlur={() => setF(false)}
        style={{ width:"100%", background: readOnly ? "#f8fafc" : C.white,
          border:"1.5px solid "+(f ? C.blue : C.border), borderRadius:10,
          padding:"12px 14px", color:C.text, fontFamily:"inherit", fontSize:15,
          outline:"none", transition:"all 0.15s", boxSizing:"border-box",
          boxShadow: f ? "0 0 0 3px "+C.blueLight : "none" }} />
      {hint && <div style={{ fontSize:11, color:C.textLo, marginTop:4 }}>{hint}</div>}
    </div>
  );
}

function FSelect({ label, value, onChange, options }) {
  return (
    <div style={{ marginBottom: 16 }}>
      {label && <label style={{ display:"block", fontSize:12, fontWeight:700, color:C.navy, marginBottom:5 }}>{label}</label>}
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ width:"100%", background:C.white, border:"1.5px solid "+C.border, borderRadius:10,
          padding:"12px 14px", color:C.text, fontFamily:"inherit", fontSize:15,
          outline:"none", appearance:"none", cursor:"pointer", boxSizing:"border-box" }}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

const BtnS = {
  primary:  { background:"linear-gradient(135deg,"+C.blue+","+C.blueMid+")", color:C.white, border:"none", boxShadow:"0 2px 8px rgba(26,111,212,0.28)" },
  ghost:    { background:C.white, color:C.blue, border:"1.5px solid "+C.borderMid, boxShadow:C.shadow },
  danger:   { background:C.white, color:C.red, border:"1.5px solid #fca5a5", boxShadow:"none" },
  gold:     { background:"linear-gradient(135deg,"+C.goldText+",#8a5500)", color:C.white, border:"none", boxShadow:"0 2px 8px rgba(180,112,0,0.28)" },
  disabled: { background:"#e9eef5", color:C.textLo, border:"none", boxShadow:"none", cursor:"not-allowed" },
};

function Btn({ children, onClick, variant="primary", small, disabled, full=true, icon, submit }) {
  const s = disabled ? BtnS.disabled : (BtnS[variant] || BtnS.primary);
  // When submit=true, the click is handled by the parent <form>'s onSubmit —
  // don't also fire onClick here, that would double-trigger the action.
  return (
    <button type={submit ? "submit" : "button"} onClick={disabled || submit ? undefined : onClick}
      style={{ ...s, width:full?"100%":"auto", padding:small?"8px 14px":"13px 20px",
        borderRadius:10, fontFamily:"inherit", fontSize:small?12:14, fontWeight:700,
        letterSpacing:"0.02em", cursor:disabled?"not-allowed":"pointer",
        transition:"all 0.15s", display:"inline-flex", alignItems:"center",
        justifyContent:"center", gap:6, boxSizing:"border-box" }}>
      {icon && <span>{icon}</span>}{children}
    </button>
  );
}

function Card({ children, style, color }) {
  const b  = color==="gold" ? C.goldBorder : color==="blue" ? C.blue : color==="green" ? C.green : C.border;
  const bg = color==="gold" ? C.goldBg : color==="blue" ? C.blueXLight : color==="green" ? C.greenBg : C.white;
  return <div style={{ background:bg, border:"1.5px solid "+b, borderRadius:14, padding:"16px", boxShadow:C.shadow, ...style }}>{children}</div>;
}

function Badge({ children, color="blue" }) {
  const m = { blue:{bg:C.blueLight,c:C.blue}, green:{bg:C.greenBg,c:C.green}, red:{bg:C.redBg,c:C.red}, gold:{bg:C.goldBg,c:C.goldText} };
  const t = m[color] || m.blue;
  return <span style={{ display:"inline-block", padding:"2px 9px", borderRadius:20, fontSize:11, fontWeight:700, background:t.bg, color:t.c }}>{children}</span>;
}

function CollapsibleTable({ title, total, note, headers, rows, renderRow }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom:14, borderRadius:14, border:"1.5px solid "+C.border, overflow:"hidden", boxShadow:C.shadow }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
          padding:"12px 16px", background:C.sky, cursor:"pointer", userSelect:"none" }}>
        <span style={{ fontSize:13, fontWeight:700, color:C.navy }}>{title}</span>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:15, fontWeight:800, color:C.goldText }}>{fmtINR(total)}</span>
          <span style={{ color:C.textLo, transition:"transform 0.2s", display:"inline-block", transform:open?"rotate(180deg)":"none" }}>▾</span>
        </div>
      </div>
      {open && (
        <div style={{ overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
            <thead>
              <tr>{headers.map((h, i) => (
                <th key={i} style={{ background:"#f8fbff", color:C.textMid, padding:"8px 10px", textAlign:"left",
                  fontWeight:700, fontSize:10, letterSpacing:"0.05em", textTransform:"uppercase",
                  borderBottom:"1.5px solid "+C.border, whiteSpace:"nowrap" }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>{rows.map((row, i) => renderRow(row, i))}</tbody>
            {note && (
              <tfoot><tr><td colSpan={99} style={{ padding:"8px 12px", background:C.blueXLight,
                color:C.textMid, fontSize:11, fontStyle:"italic", borderTop:"1px solid "+C.border }}>
                ⓘ {note}
              </td></tr></tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

function TC({ children, i, right, gold }) {
  return (
    <td style={{ padding:"9px 10px", background:i%2===0 ? C.white : "#f8fbff",
      borderBottom:"1px solid "+C.border, color:gold ? C.goldText : C.text,
      fontWeight:gold ? 700 : 400, textAlign:right ? "right" : "left", whiteSpace:"nowrap" }}>
      {children}
    </td>
  );
}

function AuthShell({ children, title, sub, wide, onSubmit }) {
  const handleSubmit = onSubmit ? (e => { e.preventDefault(); onSubmit(); }) : undefined;
  return (
    <div style={{ minHeight:"100vh",
      background:"linear-gradient(160deg,"+C.skyMid+" 0%,"+C.sky+" 50%,"+C.white+" 100%)",
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"24px 16px" }}>
      <div style={{ textAlign:"center", marginBottom:24 }}>
        <div style={{ width:54, height:54, borderRadius:16,
          background:"linear-gradient(135deg,"+C.blue+","+C.navy+")",
          display:"flex", alignItems:"center", justifyContent:"center",
          fontSize:26, margin:"0 auto 12px", boxShadow:"0 6px 20px rgba(26,111,212,0.3)" }}>✈</div>
        <div style={{ fontSize:22, fontWeight:900, color:C.navy, letterSpacing:"-0.01em" }}>{APP_NAME}</div>
        <div style={{ fontSize:11, color:C.blue, letterSpacing:"0.12em", textTransform:"uppercase", marginTop:2, opacity:0.75 }}>{CONFIG.airline} · {CONFIG.tagline}</div>
      </div>
      <form onSubmit={handleSubmit} style={{ width:"100%", maxWidth:wide ? 520 : 420, background:C.white, borderRadius:22,
        boxShadow:"0 12px 48px rgba(26,111,212,0.14)", padding:"28px 24px", border:"1px solid "+C.border }}>
        <h2 style={{ margin:"0 0 4px", fontSize:20, color:C.navy, fontWeight:900, letterSpacing:"-0.01em" }}>{title}</h2>
        {sub && <p style={{ margin:"0 0 20px", fontSize:13, color:C.textMid }}>{sub}</p>}
        {children}
      </form>
      <div style={{ marginTop:24, display:"flex", gap:6, alignItems:"center", opacity:0.3 }}>
        {Array.from({ length:9 }).map((_, i) => (
          <div key={i} style={{ width:i%3===1?28:16, height:4, borderRadius:2, background:C.blue }} />
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   MAINTENANCE SCREEN  (shown to all non-admins when admin flips the flag)
═══════════════════════════════════════════════════════════════════ */
function MaintenanceScreen({ message, onAdminLogin }) {
  return (
    <div style={{ minHeight:"100vh",
      background:"linear-gradient(160deg,"+C.skyMid+" 0%,"+C.sky+" 50%,"+C.white+" 100%)",
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"24px 16px" }}>
      <div style={{ textAlign:"center", marginBottom:28 }}>
        <div style={{ width:64, height:64, borderRadius:18,
          background:"linear-gradient(135deg,"+C.gold+","+C.goldText+")",
          display:"flex", alignItems:"center", justifyContent:"center",
          fontSize:32, margin:"0 auto 14px", boxShadow:"0 6px 20px rgba(184,112,0,0.3)" }}>🔧</div>
        <div style={{ fontSize:24, fontWeight:900, color:C.navy, letterSpacing:"-0.01em" }}>{APP_NAME}</div>
        <div style={{ fontSize:11, color:C.gold, letterSpacing:"0.12em", textTransform:"uppercase", marginTop:2, fontWeight:700 }}>Down for Maintenance</div>
      </div>
      <div style={{ width:"100%", maxWidth:440, background:C.white, borderRadius:22,
        boxShadow:"0 12px 48px rgba(184,112,0,0.14)", padding:"28px 24px", border:"1px solid "+C.goldBorder, textAlign:"center" }}>
        <h2 style={{ margin:"0 0 12px", fontSize:18, color:C.navy, fontWeight:900 }}>We'll be back soon</h2>
        <p style={{ margin:"0 0 18px", fontSize:14, color:C.textMid, lineHeight:1.6 }}>
          {message
            ? message
            : "Crew Allowance is temporarily down while we ship some improvements. Please check back in a little while — we won't be long."}
        </p>
        <p style={{ margin:"0 0 20px", fontSize:12, color:C.textLo, lineHeight:1.6 }}>
          Questions? Email <a href="mailto:help@crewallowance.com" style={{ color:C.blue, textDecoration:"underline" }}>help@crewallowance.com</a>
        </p>
        <button type="button" onClick={onAdminLogin}
          style={{ background:"none", border:"1px solid "+C.border, borderRadius:8,
            padding:"8px 16px", fontSize:11, color:C.textLo, cursor:"pointer",
            fontFamily:"inherit", fontWeight:600 }}>
          Admin sign-in
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   PDF DROP ZONE  (PCSR)
═══════════════════════════════════════════════════════════════════ */
function PcsrDropZone({ file, onParsed, onFail }) {
  const [drag, setDrag]       = useState(false);
  const [parsing, setParsing] = useState(false);
  const ref = useRef();

  const ingest = useCallback(async f => {
    if (!f) return;
    if (!String(f.name || "").toLowerCase().endsWith(".pdf")) {
      onFail("Please choose a PDF file."); return;
    }
    setParsing(true);
    try {
      const { parsePcsrPdf } = await import("./pdf/pcsrParser.js");
      const result = await parsePcsrPdf(await f.arrayBuffer());
      console.log("[pcsrParser _rawSample]\n", result._rawSample);
      onParsed(f, result);
    } catch (e) {
      onFail(e?.message || String(e));
    } finally {
      setParsing(false);
    }
  }, [onParsed, onFail]);

  const onDrop = useCallback(e => { e.preventDefault(); setDrag(false); if (!parsing) ingest(e.dataTransfer.files[0]); }, [ingest, parsing]);

  return (
    <div onClick={() => !parsing && ref.current?.click()}
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)} onDrop={onDrop}
      style={{ background:file ? C.blueXLight : drag ? C.blueLight : C.sky,
        border:"2px dashed "+(file ? C.blueMid : drag ? C.blue : C.borderMid),
        borderRadius:16, padding:"28px 20px", cursor:parsing?"wait":"pointer",
        transition:"all 0.2s", textAlign:"center", opacity:parsing?0.75:1 }}>
      <div style={{ fontSize:40, marginBottom:10 }}>📄</div>
      <div style={{ fontSize:15, fontWeight:800, color:C.navy, marginBottom:8 }}>
        {file ? "PCSR loaded ✓" : "Upload your performed roster (PERSONAL CREW SCHEDULE REPORT) for any previous month here"}
      </div>
      {parsing
        ? <div style={{ fontSize:12, color:C.blue, fontWeight:700 }}>Reading PDF...</div>
        : file
          ? <div style={{ fontSize:12, color:C.blue, fontWeight:600 }}>✓ {file.name}</div>
          : <div style={{ fontSize:12, color:C.textLo }}>Click or drag PDF here</div>}
      <input ref={ref} type="file" accept=".pdf,application/pdf" style={{ display:"none" }} disabled={parsing}
        onChange={e => { if (e.target.files[0]) ingest(e.target.files[0]); }} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   PCSR → RESULTS — animated before/after toggle
═══════════════════════════════════════════════════════════════════ */
function PcsrBeforeAfter() {
  const [showResult, setShowResult] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setShowResult(v => !v), 5000);
    return () => clearInterval(id);
  }, []);

  const fade = "all 0.5s ease";

  // Dummy PCSR grid data — 7 visible days with stacked flight cells (mimics the real calendar grid)
  const gridDays = [
    { day:"01", dow:"Wed", flights:[
      {flt:"6327",dep:"DEL",arr:"BOM",t1:"A08:25",t2:"A09:12",ac:"[320]"},
    ]},
    { day:"02", dow:"Thu", flights:[
      {flt:"2312",dep:"BOM",arr:"DEL",t1:"A09:55",t2:"A09:46",ac:"[320]",hl:true},
    ]},
    { day:"03", dow:"Fri", flights:[
      {flt:"6836",dep:"DEL",arr:"CCU",t1:"A06:54",t2:"A08:57",ac:"[321]"},
    ]},
    { day:"04", dow:"Sat", flights:[]},
    { day:"05", dow:"Sun", flights:[
      {flt:"2052",dep:"DEL",arr:"HYD",t1:"A12:06",t2:"A14:15",ac:"[321]"},
      {flt:"2073",dep:"HYD",arr:"DEL",t1:"A15:53",t2:"A17:30",ac:"[320]"},
    ]},
    { day:"06", dow:"Mon", flights:[
      {flt:"770",dep:"TRZ",arr:"DEL",t1:"A05:27",t2:"A08:19",ac:"[320]"},
    ]},
    { day:"07", dow:"Tue", flights:[]},
  ];

  const cellBorder = "1px solid #d4dce8";
  const gridFont = "'Arial Narrow', Arial, sans-serif";

  return (
    <div style={{ maxWidth:520, margin:"0 auto" }}>
      {/* Toggle */}
      <div style={{ display:"flex", justifyContent:"center", gap:0, marginBottom:16 }}>
        <button type="button" onClick={() => setShowResult(false)} style={{
          background: !showResult ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.06)",
          border:"1.5px solid " + (!showResult ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.12)"),
          borderRadius:"10px 0 0 10px", padding:"10px 20px", cursor:"pointer",
          fontSize:13, fontWeight:700, color: C.white,
          fontFamily:"inherit", transition:fade,
        }}>📄 Your PCSR</button>
        <button type="button" onClick={() => setShowResult(true)} style={{
          background: showResult ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.06)",
          border:"1.5px solid " + (showResult ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.12)"),
          borderRadius:"0 10px 10px 0", padding:"10px 20px", cursor:"pointer",
          fontSize:13, fontWeight:700, color: showResult ? "#b87000" : C.white,
          fontFamily:"inherit", transition:fade,
        }}>📊 Your breakdown</button>
      </div>

      <div style={{ background:C.white, borderRadius:14, border:"1.5px solid rgba(255,255,255,0.2)",
        boxShadow:"0 8px 40px rgba(0,0,0,0.3)", overflow:"hidden", position:"relative", minHeight:340 }}>

        {/* ── PCSR view — calendar grid format ── */}
        <div style={{ opacity: showResult ? 0 : 1, transform: showResult ? "translateX(-20px)" : "translateX(0)",
          transition:fade, position: showResult ? "absolute" : "relative", top:0, left:0, right:0 }}>
          {/* Header mimicking real PCSR */}
          <div style={{ padding:"12px 16px 8px", borderBottom:"2px solid #1a1a1a" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontSize:11, color:C.textMid }}>InterGlobe Aviation</span>
              <span style={{ fontSize:13, fontWeight:800, color:"#1a1a1a" }}>Personal Crew Schedule Report</span>
            </div>
            <div style={{ fontSize:10, color:C.textMid, textAlign:"center", marginTop:3 }}>
              01/03/2026 - 31/03/2026 (All times in Local Station)
            </div>
          </div>
          {/* Crew info bar */}
          <div style={{ background:"#e8f0e8", padding:"5px 12px", fontSize:10, fontWeight:700, color:"#2a5a2a",
            fontFamily:gridFont }}>
            28XXX SHARMA, A. DEL,CP,320
          </div>
          {/* Calendar grid */}
          <div style={{ overflowX:"auto", padding:"0 4px 10px" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontFamily:gridFont, fontSize:8.5, minWidth:340 }}>
              <thead>
                <tr>
                  {gridDays.map(d => (
                    <th key={d.day} style={{ border:cellBorder, padding:"3px 2px", textAlign:"center",
                      background:"#f5f7fa", fontWeight:700, color:C.navy, width:`${100/7}%` }}>
                      <div>{d.day}/03</div>
                      <div style={{ fontWeight:400, color:C.textLo }}>{d.dow}</div>
                    </th>
                  ))}
                  <th style={{ border:cellBorder, padding:"3px 2px", textAlign:"center", background:"#f5f7fa",
                    color:C.textLo, fontSize:8 }}>...</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  {gridDays.map(d => (
                    <td key={d.day} style={{ border:cellBorder, padding:"3px 2px", verticalAlign:"top",
                      background: d.flights.length ? C.white : "#fafbfc", minHeight:80 }}>
                      {d.flights.length === 0 && (
                        <div style={{ textAlign:"center", color:C.textLo, padding:"16px 0", fontSize:9 }}></div>
                      )}
                      {d.flights.map((f,i) => (
                        <div key={i} style={{ marginBottom: i < d.flights.length-1 ? 6 : 0, lineHeight:1.4 }}>
                          <div style={{ color: f.hl ? "#c04000" : "#1a6fd4", fontWeight:700, fontSize:9 }}>{f.flt}</div>
                          <div style={{ color:C.textMid }}>{f.dep}</div>
                          <div style={{ color:C.textMid }}>{f.arr}</div>
                          <div style={{ color:C.textLo }}>{f.t1}</div>
                          <div style={{ color:C.textLo }}>{f.t2}</div>
                          <div style={{ color:C.textLo }}>{f.ac}</div>
                        </div>
                      ))}
                    </td>
                  ))}
                  <td style={{ border:cellBorder, verticalAlign:"middle", textAlign:"center" }}>
                    <div style={{ color:C.textLo, fontSize:9, lineHeight:1.5 }}>24<br/>more<br/>days</div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {/* Stats bar like real PCSR */}
          <div style={{ background:"#e8eef6", padding:"6px 12px", fontSize:9, color:C.navy, fontFamily:gridFont,
            display:"flex", justifyContent:"space-between", flexWrap:"wrap", gap:4, borderTop:"1.5px solid "+C.border }}>
            <span><b>Block Hours</b> 69:59</span>
            <span><b>Duty Hours</b> 137:24</span>
            <span><b>Dead Head</b> 12:51</span>
            <span><b>Flights</b> 15</span>
            <span><b>Landings</b> 37</span>
          </div>
        </div>

        {/* ── Results view ── */}
        <div style={{ opacity: showResult ? 1 : 0, transform: showResult ? "translateX(0)" : "translateX(20px)",
          transition:fade, position: showResult ? "relative" : "absolute", top:0, left:0, right:0 }}>
          <div style={{ background:"linear-gradient(135deg,"+C.blue+","+C.navy+")", padding:"10px 16px",
            display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontSize:18 }}>📊</span>
              <div>
                <div style={{ fontSize:12, fontWeight:800, color:C.white }}>Allowance Breakdown</div>
                <div style={{ fontSize:10, color:"rgba(255,255,255,0.5)" }}>A. Sharma · March 2026</div>
              </div>
            </div>
            <div style={{ fontSize:18, fontWeight:900, color:C.white }}>₹24,350</div>
          </div>
          <div style={{ padding:"14px 16px" }}>
            {/* Deadhead */}
            <div style={{ marginBottom:12 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <span style={{ fontSize:14 }}>🛫</span>
                  <span style={{ fontSize:14, fontWeight:800, color:C.navy }}>Deadhead</span>
                </div>
                <span style={{ fontSize:14, fontWeight:900, color:C.navy }}>₹8,000</span>
              </div>
              {[["6E204","DEL → BOM","DHF","2h 10m","₹4,000"],["6E892","DEL → CCU","DHF","2h 05m","₹4,000"]].map(([flt,route,typ,dur,amt]) => (
                <div key={flt} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:C.textMid,
                  background:C.blueXLight, borderRadius:6, padding:"4px 8px", marginBottom:3 }}>
                  <span style={{ fontWeight:700, color:C.navy }}>{flt}</span>
                  <span>{route}</span>
                  <span style={{ color:C.blue, fontWeight:600 }}>{typ}</span>
                  <span>{dur}</span>
                  <span style={{ fontWeight:700 }}>{amt}</span>
                </div>
              ))}
            </div>
            {/* Layover */}
            <div style={{ marginBottom:12 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <span style={{ fontSize:14 }}>🏨</span>
                  <span style={{ fontSize:14, fontWeight:800, color:C.navy }}>Layover</span>
                </div>
                <span style={{ fontSize:14, fontWeight:900, color:C.navy }}>₹6,600</span>
              </div>
              {[["CCU","3–4 Mar","18h 42m","₹3,000"],["BLR","7–8 Mar","22h 15m","₹3,600"]].map(([loc,dates,dur,amt]) => (
                <div key={loc} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:C.textMid,
                  background:C.blueXLight, borderRadius:6, padding:"4px 8px", marginBottom:3 }}>
                  <span style={{ fontWeight:700, color:C.navy }}>{loc}</span>
                  <span>{dates}</span>
                  <span>{dur}</span>
                  <span style={{ fontWeight:700 }}>{amt}</span>
                </div>
              ))}
            </div>
            {/* Remaining allowances compact */}
            <div style={{ display:"grid", gap:6 }}>
              {[["🌙","Night Flying","3 sectors","₹6,000"],["✈️","Tail-Swap","2 swaps","₹3,000"],["⏱","Transit","1 halt","₹750"]].map(([icon,name,detail,amt]) => (
                <div key={name} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                  background:C.sky, borderRadius:8, padding:"6px 10px" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ fontSize:13 }}>{icon}</span>
                    <span style={{ fontSize:12, fontWeight:700, color:C.navy }}>{name}</span>
                  </div>
                  <span style={{ fontSize:10, color:C.textLo }}>{detail}</span>
                  <span style={{ fontSize:12, fontWeight:800, color:C.navy }}>{amt}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div style={{ textAlign:"center", marginTop:12, fontSize:11, color:"rgba(255,255,255,0.35)" }}>
        Tap to switch · Auto-toggles every 5s
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   PAYSLIP vs CREW ALLOWANCE — animated before/after toggle
═══════════════════════════════════════════════════════════════════ */
function PayslipCompare() {
  const [showDetail, setShowDetail] = useState(false);

  // Auto-toggle every 4 seconds
  useEffect(() => {
    const id = setInterval(() => setShowDetail(v => !v), 4000);
    return () => clearInterval(id);
  }, []);

  const fade = "all 0.5s ease";

  return (
    <div style={{ background:"linear-gradient(135deg,#0f3460,#1a6fd4)", padding:"50px 20px" }}>
      <div style={{ textAlign:"center", marginBottom:20 }}>
        <div style={{ fontSize:12, fontWeight:700, color:"rgba(255,255,255,0.5)", letterSpacing:"0.12em",
          textTransform:"uppercase", marginBottom:8 }}>The difference</div>
        <h2 style={{ fontSize:"clamp(20px,4vw,28px)", fontWeight:900, color:C.white, margin:0 }}>
          Your payslip shows the total. We show the proof.
        </h2>
      </div>

      {/* Toggle buttons */}
      <div style={{ display:"flex", justifyContent:"center", gap:0, marginBottom:20 }}>
        <button type="button" onClick={() => setShowDetail(false)} style={{
          background: !showDetail ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.06)",
          border:"1.5px solid " + (!showDetail ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.1)"),
          borderRadius:"10px 0 0 10px", padding:"10px 20px", cursor:"pointer",
          fontSize:13, fontWeight:700, color:C.white, fontFamily:"inherit", transition:fade,
        }}>Payslip view</button>
        <button type="button" onClick={() => setShowDetail(true)} style={{
          background: showDetail ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.06)",
          border:"1.5px solid " + (showDetail ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.1)"),
          borderRadius:"0 10px 10px 0", padding:"10px 20px", cursor:"pointer",
          fontSize:13, fontWeight:700, color: showDetail ? "#b87000" : C.white, fontFamily:"inherit", transition:fade,
        }}>Crew Allowance view</button>
      </div>

      {/* Single card — content crossfades */}
      <div style={{ maxWidth:380, margin:"0 auto", background:"rgba(255,255,255,0.08)",
        border:"1.5px solid rgba(255,255,255,0.15)", borderRadius:16, padding:"24px 20px",
        minHeight:260, position:"relative", overflow:"hidden" }}>

        {/* Payslip view — totals only */}
        <div style={{ opacity: showDetail ? 0 : 1, transform: showDetail ? "translateY(-12px)" : "translateY(0)",
          transition:fade, position: showDetail ? "absolute" : "relative", top:0, left:0, right:0, padding: showDetail ? "24px 20px" : 0 }}>
          <div style={{ display:"grid", gap:8 }}>
            {[["Deadhead","₹8,000"],["Night Flying","₹6,000"],["Layover","₹6,600"],["Tail-Swap","₹3,000"],["Transit","₹750"]].map(([name, amt]) => (
              <div key={name} style={{ display:"flex", justifyContent:"space-between", fontSize:14, color:C.white }}>
                <span style={{ opacity:0.7 }}>{name}</span>
                <span style={{ fontWeight:800 }}>{amt}</span>
              </div>
            ))}
          </div>
          <div style={{ borderTop:"1px solid rgba(255,255,255,0.2)", marginTop:12, paddingTop:10,
            display:"flex", justifyContent:"space-between", fontSize:15, fontWeight:900, color:C.white }}>
            <span>Total</span><span>₹24,350</span>
          </div>
          <div style={{ fontSize:12, color:"rgba(255,255,255,0.35)", marginTop:14, textAlign:"center", lineHeight:1.6 }}>
            Which flights make up ₹8,000 in Deadhead?<br/>Which layovers add to ₹6,600? No way to tell.
          </div>
        </div>

        {/* Crew Allowance view — sector-level detail */}
        <div style={{ opacity: showDetail ? 1 : 0, transform: showDetail ? "translateY(0)" : "translateY(12px)",
          transition:fade, position: showDetail ? "relative" : "absolute", top:0, left:0, right:0, padding: showDetail ? 0 : "24px 20px" }}>
          {/* Deadhead breakdown */}
          <div style={{ marginBottom:12 }}>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:14, fontWeight:800, color:C.white, marginBottom:6 }}>
              <span>Deadhead</span><span>₹8,000</span>
            </div>
            {[["6E204","DEL → BOM","2h 10m","₹4,000"],["6E892","DEL → CCU","2h 05m","₹4,000"]].map(([flt, route, dur, amt]) => (
              <div key={flt} style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"rgba(255,255,255,0.6)", padding:"3px 4px",
                background:"rgba(255,255,255,0.04)", borderRadius:6, marginBottom:3 }}>
                <span style={{ fontWeight:700 }}>{flt}</span>
                <span>{route}</span>
                <span>{dur}</span>
                <span style={{ fontWeight:700 }}>{amt}</span>
              </div>
            ))}
          </div>
          {/* Layover breakdown */}
          <div style={{ marginBottom:12 }}>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:14, fontWeight:800, color:C.white, marginBottom:6 }}>
              <span>Layover</span><span>₹6,600</span>
            </div>
            {[["CCU","3–4 Mar","18h 42m","₹3,000"],["BLR","7–8 Mar","22h 15m","₹3,600"]].map(([loc, dates, dur, amt]) => (
              <div key={loc} style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"rgba(255,255,255,0.6)", padding:"3px 4px",
                background:"rgba(255,255,255,0.04)", borderRadius:6, marginBottom:3 }}>
                <span style={{ fontWeight:700 }}>{loc}</span>
                <span>{dates}</span>
                <span>{dur}</span>
                <span style={{ fontWeight:700 }}>{amt}</span>
              </div>
            ))}
          </div>
          {/* Others collapsed */}
          <div style={{ display:"grid", gap:4 }}>
            {[["Night Flying","₹6,000","3 sectors"],["Tail-Swap","₹3,000","2 swaps"],["Transit","₹750","1 halt"]].map(([name, amt, detail]) => (
              <div key={name} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:13, color:C.white }}>
                <span style={{ opacity:0.7 }}>{name}</span>
                <span style={{ fontSize:11, color:"rgba(255,255,255,0.4)" }}>{detail}</span>
                <span style={{ fontWeight:800 }}>{amt}</span>
              </div>
            ))}
          </div>
          <div style={{ borderTop:"1px solid rgba(255,255,255,0.2)", marginTop:10, paddingTop:8,
            display:"flex", justifyContent:"space-between", fontSize:15, fontWeight:900, color:C.white }}>
            <span>Total</span><span>₹24,350</span>
          </div>
        </div>
      </div>

      <div style={{ textAlign:"center", marginTop:18, fontSize:12, color:"rgba(255,255,255,0.45)" }}>
        Tap to switch · Auto-toggles every 4s
      </div>
      <div style={{ textAlign:"center", marginTop:8, fontSize:13, color:"rgba(255,255,255,0.6)", maxWidth:420, margin:"8px auto 0", lineHeight:1.6 }}>
        Your payslip shows totals per allowance type. We show you the sector-by-sector breakdown behind each one — so you can verify every rupee.
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   LANDING PAGE
═══════════════════════════════════════════════════════════════════ */
function LandingPage({ goLogin, goSignup }) {
  const steps = [
    { icon:"📄", title:"Export your PCSR from eCrew", body:"Download your final Personal Crew Schedule Report (PCSR) for the month as a PDF from eCrew." },
    { icon:"⬆", title:"Upload your PCSR", body:"Drop your PCSR PDF into the app. That's the only file you need. Sector Values are uploaded once per month by your admin — shared across all crew." },
    { icon:"⚡", title:"Instant enrichment & calculation", body:"The app fetches scheduled times and aircraft registrations automatically from AeroDataBox, then applies all IndiGo allowance rules instantly." },
    { icon:"📊", title:"Download your breakdown", body:"Get a complete itemised CSV breakdown of every allowance for the month — ready to verify against your payslip." },
  ];
  const allowances = [
    { name:"Deadhead",    icon:"🛫", desc:"Per scheduled block hour when positioned as non-operating crew",       captain:"₹4,000/hr",  fo:"₹2,000/hr"  },
    { name:"Night Flying",icon:"🌙", desc:"For each hour flown between 0000–0600 IST per PAH §9.0",              captain:"₹2,000/hr",  fo:"₹1,000/hr"  },
    { name:"Layover",     icon:"🏨", desc:"For stays away from home base exceeding 10 hours 01 minute",          captain:"₹3,000 base",fo:"₹1,500 base" },
    { name:"Tail-Swap",   icon:"✈️", desc:"When aircraft registration changes between consecutive sectors",       captain:"₹1,500/swap",fo:"₹750/swap"  },
    { name:"Transit",     icon:"⏱",  desc:"Pro-rata for domestic halts between 90 mins and 4 hrs (PAH §7.0)",   captain:"₹1,000/hr",  fo:"₹500/hr"    },
  ];
  return (
    <div style={{ background:C.white, fontFamily:"'Nunito','Segoe UI',sans-serif", color:C.text }}>
      <div style={{ position:"sticky", top:0, zIndex:20, background:"rgba(255,255,255,0.95)",
        backdropFilter:"blur(10px)", borderBottom:"1px solid "+C.border,
        padding:"12px 20px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:34, height:34, borderRadius:10,
            background:"linear-gradient(135deg,"+C.blue+","+C.navy+")",
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:18, boxShadow:"0 2px 8px rgba(26,111,212,0.28)" }}>✈</div>
          <div style={{ fontSize:16, fontWeight:900, color:C.navy, letterSpacing:"-0.01em" }}>{APP_NAME}</div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button type="button" onClick={goLogin} style={{ background:"transparent", border:"1.5px solid "+C.borderMid,
            borderRadius:9, color:C.textMid, fontSize:13, padding:"7px 14px", cursor:"pointer", fontWeight:700, fontFamily:"inherit" }}>Sign in</button>
          <button type="button" onClick={goSignup} style={{ background:"linear-gradient(135deg,"+C.blue+","+C.blueMid+")",
            border:"none", borderRadius:9, color:C.white, fontSize:13, padding:"7px 16px",
            cursor:"pointer", fontWeight:700, fontFamily:"inherit", boxShadow:"0 2px 8px rgba(26,111,212,0.28)" }}>Get started →</button>
        </div>
      </div>
      <div style={{ background:"linear-gradient(160deg,"+C.navy+" 0%,"+C.blue+" 60%,"+C.blueMid+" 100%)",
        padding:"60px 20px 80px", textAlign:"center", position:"relative", overflow:"hidden" }}>
        <div style={{ position:"relative", maxWidth:640, margin:"0 auto" }}>
          <div style={{ display:"inline-block", background:"rgba(255,255,255,0.12)", borderRadius:20,
            padding:"4px 14px", fontSize:12, color:"rgba(255,255,255,0.9)", fontWeight:700,
            letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:20 }}>For IndiGo Cockpit Crew</div>
          <h1 style={{ fontSize:"clamp(28px,6vw,48px)", fontWeight:900, color:C.white,
            lineHeight:1.1, letterSpacing:"-0.02em", margin:"0 0 18px" }}>
            Know exactly what<br />allowances you're owed
          </h1>
          <p style={{ fontSize:"clamp(14px,2.5vw,18px)", color:"rgba(255,255,255,0.75)",
            maxWidth:480, margin:"0 auto 32px", lineHeight:1.6 }}>
            Upload your Personal Crew Schedule Report (PCSR) and get an instant, itemised breakdown of every allowance — Deadhead, Night Flying, Layover, Tail-Swap, and Transit.
          </p>
          <div style={{ display:"flex", gap:12, justifyContent:"center", flexWrap:"wrap" }}>
            <button type="button" onClick={goSignup} style={{ background:C.white, border:"none", borderRadius:12,
              color:C.blue, fontSize:15, padding:"14px 28px", cursor:"pointer", fontWeight:800,
              fontFamily:"inherit", boxShadow:"0 4px 20px rgba(0,0,0,0.2)" }}>
              Get started — ₹100/month →
            </button>
            <button type="button" onClick={goLogin} style={{ background:"rgba(255,255,255,0.15)",
              border:"1.5px solid rgba(255,255,255,0.3)", borderRadius:12, color:C.white,
              fontSize:15, padding:"14px 28px", cursor:"pointer", fontWeight:700, fontFamily:"inherit" }}>Sign in</button>
          </div>
          <div style={{ marginTop:20, fontSize:12, color:"rgba(255,255,255,0.5)" }}>No credit card required to try · Cancel anytime</div>
        </div>
      </div>
      <div style={{ background:C.sky, borderTop:"1px solid "+C.border, borderBottom:"1px solid "+C.border,
        padding:"20px", display:"flex", justifyContent:"center", gap:"clamp(20px,4vw,60px)", flexWrap:"wrap" }}>
        {[["1","File to upload"],["5","Allowance types"],["Jan 2026","Rules in effect"],["Auto","Schedule data"]].map(([n,l]) => (
          <div key={l} style={{ textAlign:"center" }}>
            <div style={{ fontSize:22, fontWeight:900, color:C.blue }}>{n}</div>
            <div style={{ fontSize:12, color:C.textMid, marginTop:2 }}>{l}</div>
          </div>
        ))}
      </div>
      {/* ── PCSR → Results showcase — prominent, right after hero ── */}
      <div style={{ background:"linear-gradient(180deg,"+C.navy+" 0%,#1a3a6a 100%)", padding:"50px 20px 40px" }}>
        <div style={{ maxWidth:520, margin:"0 auto", textAlign:"center" }}>
          <div style={{ fontSize:12, fontWeight:700, color:"rgba(255,255,255,0.5)", letterSpacing:"0.12em",
            textTransform:"uppercase", marginBottom:10 }}>From your PCSR</div>
          <h2 style={{ fontSize:"clamp(22px,4.5vw,32px)", fontWeight:900, color:C.white, margin:"0 0 6px", letterSpacing:"-0.01em" }}>
            One PDF. Every allowance. Broken down.
          </h2>
          <p style={{ fontSize:13, color:"rgba(255,255,255,0.55)", lineHeight:1.6, margin:"0 auto 24px", maxWidth:420 }}>
            Upload your final PCSR from eCrew and instantly see which sectors and layovers make up each number on your payslip.
          </p>
          <PcsrBeforeAfter />
        </div>
      </div>

      <div style={{ maxWidth:700, margin:"0 auto", padding:"60px 20px" }}>
        <div style={{ textAlign:"center", marginBottom:40 }}>
          <div style={{ fontSize:12, fontWeight:700, color:C.blue, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:8 }}>How it works</div>
          <h2 style={{ fontSize:"clamp(22px,4vw,32px)", fontWeight:900, color:C.navy, letterSpacing:"-0.01em" }}>
            Four steps. That's it.
          </h2>
        </div>
        <div style={{ display:"grid", gap:16 }}>
          {steps.map((s, i) => (
            <div key={i} style={{ display:"flex", gap:16, alignItems:"flex-start", background:C.white,
              borderRadius:16, padding:"20px", border:"1.5px solid "+C.border, boxShadow:C.shadow }}>
              <div style={{ width:48, height:48, borderRadius:14, background:C.blueXLight,
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:24, flexShrink:0 }}>{s.icon}</div>
              <div>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                  <span style={{ width:22, height:22, borderRadius:"50%",
                    background:"linear-gradient(135deg,"+C.blue+","+C.navy+")",
                    display:"inline-flex", alignItems:"center", justifyContent:"center",
                    fontSize:11, fontWeight:900, color:C.white, flexShrink:0 }}>{i+1}</span>
                  <span style={{ fontSize:15, fontWeight:800, color:C.navy }}>{s.title}</span>
                </div>
                <p style={{ fontSize:13, color:C.textMid, lineHeight:1.6, margin:0 }}>{s.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
      {/* ── Payslip vs Crew Allowance — animated toggle callout ── */}
      <PayslipCompare />

      <div style={{ background:C.sky, padding:"60px 20px" }}>
        <div style={{ maxWidth:700, margin:"0 auto" }}>
          <div style={{ textAlign:"center", marginBottom:32 }}>
            <h2 style={{ fontSize:"clamp(22px,4vw,30px)", fontWeight:900, color:C.navy, letterSpacing:"-0.01em" }}>All five IndiGo allowances covered</h2>
            <p style={{ fontSize:13, color:C.textMid, marginTop:8 }}>Rates effective 1 January 2026</p>
          </div>
          <div style={{ display:"grid", gap:10 }}>
            {allowances.map((a, i) => (
              <div key={i} style={{ background:C.white, borderRadius:14, padding:"16px 18px",
                border:"1.5px solid "+C.border, boxShadow:C.shadow,
                display:"flex", alignItems:"center", gap:16, flexWrap:"wrap" }}>
                <div style={{ width:40, height:40, borderRadius:12, background:C.blueXLight,
                  display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>{a.icon}</div>
                <div style={{ flex:1, minWidth:160 }}>
                  <div style={{ fontSize:14, fontWeight:800, color:C.navy, marginBottom:3 }}>{a.name}</div>
                  <div style={{ fontSize:12, color:C.textMid }}>{a.desc}</div>
                </div>
                <div style={{ display:"flex", gap:12, flexShrink:0 }}>
                  <div style={{ textAlign:"center" }}>
                    <div style={{ fontSize:10, color:C.textLo, marginBottom:2 }}>Captain</div>
                    <div style={{ fontSize:13, fontWeight:800, color:C.goldText }}>{a.captain}</div>
                  </div>
                  <div style={{ textAlign:"center" }}>
                    <div style={{ fontSize:10, color:C.textLo, marginBottom:2 }}>F/O</div>
                    <div style={{ fontSize:13, fontWeight:800, color:C.blue }}>{a.fo}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div style={{ maxWidth:480, margin:"0 auto", padding:"60px 20px", textAlign:"center" }}>
        <h2 style={{ fontSize:"clamp(22px,4vw,30px)", fontWeight:900, color:C.navy, letterSpacing:"-0.01em", marginBottom:24 }}>Simple, affordable pricing</h2>
        <div style={{ background:C.white, borderRadius:20, padding:"32px 28px",
          border:"2px solid "+C.blue, boxShadow:C.shadowMd, marginBottom:20 }}>
          <div style={{ fontSize:48, fontWeight:900, color:C.navy, letterSpacing:"-0.02em" }}>
            ₹100<span style={{ fontSize:16, fontWeight:600, color:C.textMid }}>/month</span>
          </div>
          <div style={{ fontSize:13, color:C.textMid, margin:"4px 0 0" }}>or ₹1,000/year (save 17%)</div>
          <div style={{ fontSize:13, color:C.textMid, margin:"8px 0 24px" }}>Per crew member · Cancel anytime</div>
          <div style={{ display:"grid", gap:8, marginBottom:24, textAlign:"left" }}>
            {["Upload only your PCSR","All 5 allowance types broken down","Auto schedule data via AeroDataBox","CSV breakdown download","Rates kept up-to-date"].map(f => (
              <div key={f} style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, color:C.text }}>
                <span style={{ color:C.green, fontWeight:800, fontSize:15 }}>✓</span>{f}
              </div>
            ))}
          </div>
          <button type="button" onClick={goSignup} style={{ width:"100%", background:"linear-gradient(135deg,"+C.blue+","+C.blueMid+")",
            border:"none", borderRadius:11, color:C.white, fontSize:15, padding:"14px",
            cursor:"pointer", fontWeight:800, fontFamily:"inherit", boxShadow:"0 3px 12px rgba(26,111,212,0.3)" }}>
            Get started →
          </button>
        </div>
      </div>
      <div style={{ background:"linear-gradient(135deg,"+C.navy+","+C.blue+")", padding:"50px 20px", textAlign:"center" }}>
        <h2 style={{ fontSize:"clamp(20px,4vw,28px)", fontWeight:900, color:C.white, letterSpacing:"-0.01em", marginBottom:12 }}>
          Ready to know what you're owed?
        </h2>
        <button type="button" onClick={goSignup} style={{ background:C.white, border:"none", borderRadius:12,
          color:C.blue, fontSize:15, padding:"14px 32px", cursor:"pointer", fontWeight:800,
          fontFamily:"inherit", boxShadow:"0 4px 20px rgba(0,0,0,0.2)", marginTop:16 }}>
          Create your account →
        </button>
        <div style={{ marginTop:28, fontSize:11, color:"rgba(255,255,255,0.4)", letterSpacing:"0.06em" }}>
          © {CONFIG.copyrightYear} {CONFIG.appName} · For {CONFIG.airline} crew members
        </div>
        <div style={{ marginTop:12, display:"flex", gap:20, justifyContent:"center" }}>
          <a href="/privacy.html" style={{ fontSize:12, color:"rgba(255,255,255,0.45)", textDecoration:"none" }}>Privacy Policy</a>
          <a href="/terms.html"   style={{ fontSize:12, color:"rgba(255,255,255,0.45)", textDecoration:"none" }}>Terms of Service</a>
          <a href={"mailto:"+CONFIG.emailSupport} style={{ fontSize:12, color:"rgba(255,255,255,0.45)", textDecoration:"none" }}>Contact</a>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   AUTH SCREENS (Login, Signup, Checkout, Forgot, ResetPassword)
═══════════════════════════════════════════════════════════════════ */
function LoginScreen({ onLogin, goSignup, goForgot, goLanding }) {
  const [email, setEmail] = useState("");
  const [pass,  setPass]  = useState("");
  const [err,   setErr]   = useState("");
  const [busy,  setBusy]  = useState(false);

  const submit = async () => {
    setErr(""); setBusy(true);
    if (!supabase) { sbWarn(); setErr("Database not configured."); setBusy(false); return; }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password: pass });
    if (error) { setErr("Invalid email or password."); setBusy(false); return; }
    const { data: profile } = await supabase.from("profiles").select("*").eq("id", data.user.id).single();
    if (!profile) { setErr("Account not found. Please contact admin."); setBusy(false); return; }
    if (!profile.is_active && !profile.is_admin) {
      if (profile.subscription_status === "pending_approval") {
        setErr("Your comp-access request is awaiting admin approval. We'll activate your account shortly. Questions? help@crewallowance.com");
      } else {
        setErr("Your account is not yet active. Please complete your subscription or contact help@crewallowance.com.");
      }
      setBusy(false); return;
    }
    onLogin({ ...profile, email: data.user.email });
    setBusy(false);
  };

  return (
    <AuthShell title="Welcome back" sub="Sign in to your Crew Allowance account" onSubmit={submit}>
      <FInput label="Email address" type="email" value={email} onChange={setEmail} placeholder="Your registered email address" autoComplete="email" />
      <FInput label="Password" type="password" value={pass} onChange={setPass} placeholder="Your password" autoComplete="current-password" />
      {err && <div style={{ padding:"10px 14px", background:C.redBg, border:"1px solid #fca5a5", borderRadius:8, color:C.red, fontSize:12, marginBottom:14 }}>{err}</div>}
      <Btn onClick={submit} disabled={busy} submit>{busy ? "Signing in..." : "Sign In →"}</Btn>
      <div style={{ marginTop:14, textAlign:"center" }}>
        <button type="button" onClick={goForgot} style={{ background:"none", border:"none", color:C.blue, fontSize:13, cursor:"pointer", fontFamily:"inherit", textDecoration:"underline" }}>Forgot password?</button>
      </div>
      <div style={{ marginTop:10, textAlign:"center", fontSize:13, color:C.textMid }}>
        New user?{" "}
        <button type="button" onClick={goSignup} style={{ background:"none", border:"none", color:C.blue, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:700 }}>Create an account</button>
      </div>
      <div style={{ marginTop:10, textAlign:"center" }}>
        <button type="button" onClick={goLanding} style={{ background:"none", border:"none", color:C.textLo, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>← Back to home</button>
      </div>
    </AuthShell>
  );
}

function SignupScreen({ goLogin, goLanding, goCheckout, goForgot }) {
  const [name,    setName]    = useState("");
  const [email,   setEmail]   = useState("");
  const [empId,   setEmpId]   = useState("");
  const [rank,    setRank]    = useState("Captain");
  const [base,    setBase]    = useState("DEL");
  const [pass,    setPass]    = useState("");
  const [confirm, setConfirm] = useState("");
  const [err,     setErr]     = useState("");
  const [busy,    setBusy]    = useState(false);

  const submit = async () => {
    if (!name || !email || !empId || !pass) { setErr("Name, email, employee ID, and password are required."); return; }
    if (!/\S+@\S+\.\S+/.test(email)) { setErr("Please enter a valid email address."); return; }
    if (pass !== confirm) { setErr("Passwords do not match."); return; }
    if (pass.length < 8)  { setErr("Password must be at least 8 characters."); return; }
    setErr(""); setBusy(true);

    // Server-side signup: does auth.createUser + profiles.insert atomically.
    // If profile insert fails (e.g. duplicate emp_id), the auth user is rolled
    // back so the email/password are freed for a clean retry.
    try {
      const resp = await fetch("/api/signup", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          name, email, password: pass, emp_id: empId,
          rank, home_base: base,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) {
        // Server returns either "duplicate_email" / "duplicate_emp_id" tokens
        // (which the UI renders as friendly clickable messages) or a plain
        // string for unexpected errors.
        setErr(data.error || "Signup failed.");
        setBusy(false);
        return;
      }
      // Auto sign-in so the browser has a live Supabase session for the
      // checkout/trial endpoints and any subsequent calls.
      if (supabase) {
        const { error: signinErr } = await supabase.auth.signInWithPassword({ email, password: pass });
        if (signinErr) {
          // Edge case: account exists but sign-in failed. Send to login.
          setErr("Account created. Please sign in to continue.");
          setBusy(false);
          return;
        }
      }
      setBusy(false);
      goCheckout(data.user);
    } catch (e) {
      setErr(e?.message || "Network error during signup.");
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Create account" sub="IndiGo crew only · Takes 60 seconds" onSubmit={submit}>
      <FInput label="Full name" value={name} onChange={setName} placeholder="Your full name as it appears on your ID" />
      <FInput label="Email address" type="email" value={email} onChange={setEmail} placeholder="Your email address" />
      <FInput label="Employee ID" value={empId} onChange={setEmpId} placeholder="Your IndiGo employee number" hint="Required — keeps your account secure and unique" />
      <FSelect label="Rank" value={rank} onChange={setRank} options={RANKS} />
      <FInput label="Home Base (IATA)" value={base} onChange={setBase} placeholder="e.g. DEL" hint="3-letter IATA code of your home airport" />
      <FInput label="Password" type="password" value={pass} onChange={setPass} placeholder="Choose a strong password (min 8 characters)" />
      <FInput label="Confirm password" type="password" value={confirm} onChange={setConfirm} placeholder="Repeat your password" />
      {err && !["duplicate_email","duplicate_emp_id"].includes(err) && <div style={{ padding:"10px 14px", background:C.redBg, borderRadius:8, color:C.red, fontSize:12, marginBottom:14 }}>{err}</div>}
      {err === "duplicate_email" && (
        <div style={{ padding:"12px 14px", background:C.redBg, borderRadius:8, color:C.red, fontSize:12, marginBottom:14, lineHeight:1.7 }}>
          An account with this email already exists.{" "}
          <button type="button" onClick={goLogin} style={{ background:"none", border:"none", color:C.blue, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:700, textDecoration:"underline", padding:0 }}>Sign in</button>
          {" or "}
          <button type="button" onClick={goForgot} style={{ background:"none", border:"none", color:C.blue, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:700, textDecoration:"underline", padding:0 }}>reset your password</button>.
        </div>
      )}
      {err === "duplicate_emp_id" && (
        <div style={{ padding:"12px 14px", background:C.redBg, borderRadius:8, color:C.red, fontSize:12, marginBottom:14, lineHeight:1.7 }}>
          An account with this employee ID already exists.{" "}
          <button type="button" onClick={goLogin} style={{ background:"none", border:"none", color:C.blue, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:700, textDecoration:"underline", padding:0 }}>Sign in</button>
          {" or "}
          <button type="button" onClick={goForgot} style={{ background:"none", border:"none", color:C.blue, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:700, textDecoration:"underline", padding:0 }}>reset your password</button> if it's yours.
          If this isn't you, please email <a href="mailto:help@crewallowance.com" style={{ color:C.blue }}>help@crewallowance.com</a>.
        </div>
      )}
      <Btn onClick={submit} disabled={busy} submit>{busy ? "Creating account..." : "Continue to payment →"}</Btn>
      <div style={{ marginTop:12, textAlign:"center", fontSize:13, color:C.textMid }}>
        Already registered?{" "}
        <button type="button" onClick={goLogin} style={{ background:"none", border:"none", color:C.blue, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:700 }}>Sign in</button>
      </div>
      <div style={{ marginTop:8, textAlign:"center" }}>
        <button type="button" onClick={goLanding} style={{ background:"none", border:"none", color:C.textLo, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>← Back to home</button>
      </div>
    </AuthShell>
  );
}

function CheckoutScreen({ pendingUser, goLogin, onActivate }) {
  const [planKey,    setPlanKey]    = useState(DEFAULT_PLAN);
  const [freeCode,   setFreeCode]   = useState("");
  const [showFree,   setShowFree]   = useState(false);
  const [loading,    setLoading]    = useState(false);
  const [done,       setDone]       = useState(false);
  const [payErr,     setPayErr]     = useState("");
  const [stripeReady, setStripeReady] = useState(false);

  const stripeRef          = useRef(null);
  const elementsRef        = useRef(null);
  const paymentElementRef  = useRef(null);
  const paymentDivRef      = useRef(null);

  const plan = PLANS[planKey];

  // ── Load Stripe.js ─────────────────────────────────────────────────────
  useEffect(() => {
    const STRIPE_PK = import.meta.env.VITE_STRIPE_PK || "";
    if (!STRIPE_PK) return;
    if (!window.Stripe) {
      const script = document.createElement("script");
      script.src = "https://js.stripe.com/v3/";
      script.onload = () => { stripeRef.current = window.Stripe(STRIPE_PK); };
      document.head.appendChild(script);
    } else {
      stripeRef.current = window.Stripe(STRIPE_PK);
    }
  }, []);

  // ── Mount Payment Element in DEFERRED mode ─────────────────────────────
  // No clientSecret upfront. We supply mode/amount/currency so the Element
  // can render and validate input, but no PaymentIntent or Subscription is
  // created on the server until the user clicks Pay. This keeps the Stripe
  // Dashboard clean of abandoned-checkout intents.
  //
  // Mounted ONCE per session and re-used across plan changes — we just call
  // elements.update({ amount }) when the user picks a different plan.
  useEffect(() => {
    if (showFree || !stripeRef.current || !paymentDivRef.current) return;
    if (paymentElementRef.current) return;   // already mounted

    const elements = stripeRef.current.elements({
      mode: "payment",
      amount: plan.total * 100,    // paise
      currency: "inr",
      paymentMethodCreation: "manual",
      appearance: {
        theme: "stripe",
        variables: { fontFamily:"'Nunito','Segoe UI',sans-serif", colorPrimary:"#1a6fd4", borderRadius:"10px" },
      },
    });
    const paymentEl = elements.create("payment", { layout: "tabs" });
    paymentEl.mount(paymentDivRef.current);
    paymentEl.on("ready", () => setStripeReady(true));
    elementsRef.current = elements;
    paymentElementRef.current = paymentEl;

    return () => {
      if (paymentElementRef.current) {
        paymentElementRef.current.unmount();
        paymentElementRef.current = null;
        elementsRef.current = null;
      }
    };
    // Only depend on stripeRef/showFree — plan changes are handled separately
    // by elements.update() below to avoid remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFree, stripeReady]);

  // When the plan changes, just tell the existing Element about the new amount.
  useEffect(() => {
    if (elementsRef.current && !showFree) {
      elementsRef.current.update({ amount: plan.total * 100 });
    }
  }, [plan.total, showFree]);

  const finishActivation = () => { onActivate(pendingUser); setDone(true); };

  // ── Pay handler — creates the PaymentIntent / Subscription on click ────
  const handlePay = async () => {
    setPayErr(""); setLoading(true);

    // Free-access path: server verifies the code and activates the user.
    if (showFree) {
      try {
        const resp = await fetch("/api/create-subscription", {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ plan:planKey, userId:pendingUser?.id||"", email:pendingUser?.email||"", freeCode:freeCode.trim() }),
        });
        const data = await resp.json();
        if (!resp.ok || data.error) throw new Error(data.error || "Activation failed.");
        finishActivation();
      } catch (err) { setPayErr(err.message); }
      setLoading(false);
      return;
    }

    // Paid path
    if (!stripeRef.current || !elementsRef.current) {
      setPayErr("Payment form not ready. Please wait a moment."); setLoading(false); return;
    }
    try {
      // Step 1: validate the user's input client-side.
      const { error: submitErr } = await elementsRef.current.submit();
      if (submitErr) throw new Error(submitErr.message);

      // Step 2: NOW create the PaymentIntent (trial) or Subscription (1mo/12mo).
      const isTrial  = plan?.kind === "trial";
      const endpoint = isTrial ? "/api/create-trial-payment" : "/api/create-subscription";
      const body     = isTrial
        ? { userId: pendingUser?.id || "", email: pendingUser?.email || "" }
        : { plan: planKey, userId: pendingUser?.id || "", email: pendingUser?.email || "" };
      const resp = await fetch(endpoint, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify(body),
      });
      const { clientSecret, error: serverErr } = await resp.json();
      if (serverErr) throw new Error(serverErr);
      if (!clientSecret) throw new Error("Payment session could not be created.");

      // Step 3: confirm payment with the freshly created clientSecret.
      const { error: confirmErr, paymentIntent } = await stripeRef.current.confirmPayment({
        elements: elementsRef.current,
        clientSecret,
        confirmParams: {
          return_url: window.location.origin + "?payment_status=success",
        },
        redirect: "if_required",
      });
      if (confirmErr) throw new Error(confirmErr.message);
      if (paymentIntent && paymentIntent.status === "succeeded") {
        finishActivation();
      } else if (paymentIntent && paymentIntent.status === "requires_action") {
        setPayErr("Payment requires additional action. Please complete the authentication.");
      } else {
        finishActivation(); // processing — webhook will reconcile
      }
    } catch (err) { setPayErr(err.message); }
    setLoading(false);
  };

  if (done) return (
    <AuthShell title="You're all set! 🎉" sub="">
      <div style={{ textAlign:"center", padding:"8px 0 18px" }}>
        <div style={{ width:60, height:60, borderRadius:"50%", background:C.greenBg, border:"2px solid "+C.green,
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:28, margin:"0 auto 16px" }}>✓</div>
        <p style={{ color:C.textMid, fontSize:14, lineHeight:1.6, marginBottom:20 }}>
          {showFree ? "Your free account is activated." : "Payment confirmed. Your subscription is active."}
          <br />Welcome to Crew Allowance, {pendingUser?.name?.split(" ")[0]}!
        </p>
      </div>
      <Btn onClick={goLogin}>Sign in to your account →</Btn>
    </AuthShell>
  );

  return (
    <AuthShell title="Choose your plan" sub="Cancel anytime · Auto-renews until cancelled" wide>
      {/* Plan picker — two cards */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr", gap:10, marginBottom:20 }}>
        {Object.entries(PLANS).map(([key, p]) => {
          const selected = key === planKey;
          return (
            <button key={key} onClick={() => setPlanKey(key)} type="button"
              style={{
                textAlign:"left", cursor:"pointer", fontFamily:"inherit",
                background: selected ? C.blueXLight : C.white,
                border: "2px solid " + (selected ? C.blue : C.border),
                borderRadius:12, padding:"14px 16px",
                display:"flex", justifyContent:"space-between", alignItems:"center", gap:12,
              }}>
              <div>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ fontSize:15, fontWeight:800, color:C.navy }}>{p.label}</span>
                  {p.badge && (
                    <span style={{ fontSize:10, fontWeight:800, background:C.green, color:C.white,
                      padding:"2px 7px", borderRadius:99, letterSpacing:"0.04em" }}>{p.badge}</span>
                  )}
                </div>
                <div style={{ fontSize:12, color:C.textMid, marginTop:3 }}>{p.sub}</div>
              </div>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontSize:18, fontWeight:900, color:C.navy }}>{fmtINR(p.total)}</div>
                <div style={{ fontSize:11, color:C.textLo }}>billed today</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Order summary */}
      <div style={{ background:C.blueXLight, border:"1.5px solid "+C.border, borderRadius:12, padding:"14px 16px", marginBottom:18 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <span style={{ fontSize:13, color:C.textMid }}>Crew Allowance — {plan.label}</span>
          <span style={{ fontSize:14, fontWeight:700, color:C.navy }}>{fmtINR(plan.total)}</span>
        </div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
          paddingTop:8, borderTop:"1px solid "+C.borderMid, marginTop:8 }}>
          <span style={{ fontSize:14, fontWeight:800, color:C.navy }}>Total today</span>
          <span style={{ fontSize:18, fontWeight:900, color:showFree?C.green:C.navy }}>
            {showFree ? "Free" : fmtINR(plan.total)}
          </span>
        </div>
      </div>

      {/* Payment form (card, UPI, etc.) OR free-access code input */}
      {!showFree ? (
        <div style={{ marginBottom:16 }}>
          {/* Prominent comp-code prompt — moved up from the bottom because users
              were missing the small underlined link and bailing without entering
              their code. */}
          <button type="button" onClick={() => { setShowFree(true); setPayErr(""); }}
            style={{
              width:"100%", textAlign:"left", cursor:"pointer", fontFamily:"inherit",
              background:C.goldBg, border:"1.5px solid "+C.goldBorder, borderRadius:10,
              padding:"12px 14px", marginBottom:14,
              display:"flex", alignItems:"center", justifyContent:"space-between", gap:10,
            }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontSize:18 }}>🎟️</span>
              <div>
                <div style={{ fontSize:13, fontWeight:800, color:C.goldText }}>Have a free-access code?</div>
                <div style={{ fontSize:11, color:C.goldText, opacity:0.8, marginTop:1 }}>Tap here to skip payment</div>
              </div>
            </div>
            <span style={{ fontSize:13, color:C.goldText, fontWeight:700 }}>→</span>
          </button>

          <div style={{ background:C.blueXLight, border:"1.5px solid "+C.border, borderRadius:10, padding:"10px 14px", marginBottom:14, fontSize:11, color:C.textMid }}>
            🔒 Payment handled securely by <strong>Stripe</strong>. We never see or store your payment details.
          </div>
          <label style={{ display:"block", fontSize:12, fontWeight:700, color:C.navy, marginBottom:6 }}>Payment method</label>
          <div ref={paymentDivRef} style={{ minHeight:46 }} />
          {!stripeReady && <div style={{ fontSize:11, color:C.textLo, marginTop:4 }}>Loading secure payment form...</div>}
        </div>
      ) : (
        <div style={{ marginBottom:16 }}>
          <label style={{ display:"block", fontSize:12, fontWeight:700, color:C.navy, marginBottom:6 }}>Free-access code</label>
          <input value={freeCode} onChange={e => setFreeCode(e.target.value)} placeholder="e.g. CREW2026"
            autoCapitalize="characters" autoCorrect="off" spellCheck="false"
            style={{ width:"100%", boxSizing:"border-box", background:C.white, border:"1.5px solid "+C.border,
              borderRadius:10, padding:"11px 14px", color:C.text, fontFamily:"inherit", fontSize:14, outline:"none", letterSpacing:"0.08em", textTransform:"uppercase" }} />
          <div style={{ fontSize:11, color:C.textLo, marginTop:4 }}>Code is not case-sensitive. Activates free access if valid.</div>
        </div>
      )}

      {payErr && <div style={{ padding:"10px 14px", background:C.redBg, border:"1px solid #fca5a5", borderRadius:8, color:C.red, fontSize:12, marginBottom:14 }}>{payErr}</div>}

      <Btn onClick={handlePay} variant={showFree?"gold":"primary"} disabled={loading||(!showFree&&!stripeReady)||(showFree&&!freeCode.trim())} icon={loading?"⟳":showFree?"✨":"🔒"}>
        {loading
          ? (showFree?"Activating...":"Processing...")
          : (showFree
              ? `Activate ${plan.label.toLowerCase()} →`
              : `Pay ${fmtINR(plan.total)} & subscribe →`)}
      </Btn>

      <div style={{ marginTop:14, textAlign:"center", display:"flex", flexDirection:"column", gap:6 }}>
        {showFree && (
          <button type="button" onClick={() => { setShowFree(false); setPayErr(""); }} style={{ background:"none", border:"none", color:C.textMid, fontSize:12, cursor:"pointer", fontFamily:"inherit", textDecoration:"underline" }}>
            ← Back to card payment
          </button>
        )}
        <button type="button" onClick={goLogin} style={{ background:"none", border:"none", color:C.textLo, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>Already have an account? Sign in</button>
      </div>
    </AuthShell>
  );
}

function ForgotScreen({ goLogin }) {
  const [email, setEmail] = useState("");
  const [sent,  setSent]  = useState(false);
  const [busy,  setBusy]  = useState(false);
  const [err,   setErr]   = useState("");

  const send = async () => {
    if (!email) { setErr("Please enter your email address."); return; }
    setBusy(true); setErr("");
    if (supabase) await supabase.auth.resetPasswordForEmail(email, { redirectTo: CONFIG.siteUrl });
    setBusy(false); setSent(true);
  };

  return (
    <AuthShell title="Reset password" sub="We'll send a link to your inbox" onSubmit={send}>
      {!sent ? (
        <>
          <FInput label="Your registered email address" type="email" value={email} onChange={setEmail} placeholder="The email address on your account" />
          {err && <div style={{ padding:"10px 14px", background:C.redBg, borderRadius:8, color:C.red, fontSize:12, marginBottom:14 }}>{err}</div>}
          <Btn onClick={send} disabled={busy} submit>{busy?"Sending...":"Send Reset Link"}</Btn>
          <div style={{ marginTop:12, textAlign:"center" }}>
            <button type="button" onClick={goLogin} style={{ background:"none", border:"none", color:C.blue, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>← Back to sign in</button>
          </div>
        </>
      ) : (
        <>
          <div style={{ textAlign:"center", padding:"8px 0 18px" }}>
            <div style={{ fontSize:44, marginBottom:12 }}>📧</div>
            <p style={{ color:C.textMid, fontSize:14 }}>
              If an account exists for <strong>{email}</strong>, a reset link has been sent. Check your inbox.
            </p>
          </div>
          <Btn onClick={goLogin} variant="ghost">← Back to Sign In</Btn>
        </>
      )}
    </AuthShell>
  );
}

function ResetPasswordScreen({ goLogin }) {
  const [pass,    setPass]    = useState("");
  const [confirm, setConfirm] = useState("");
  const [err,     setErr]     = useState("");
  const [busy,    setBusy]    = useState(false);
  const [done,    setDone]    = useState(false);

  const submit = async () => {
    if (!pass || !confirm)    { setErr("Please fill in both fields."); return; }
    if (pass !== confirm)     { setErr("Passwords do not match."); return; }
    if (pass.length < 8)      { setErr("Password must be at least 8 characters."); return; }
    if (!supabase) { setErr("Database not configured."); return; }
    setBusy(true); setErr("");
    const { error } = await supabase.auth.updateUser({ password: pass });
    if (error) { setErr(error.message); setBusy(false); return; }
    await supabase.auth.signOut();
    setBusy(false); setDone(true);
  };

  if (done) return (
    <AuthShell title="Password updated ✓" sub="">
      <div style={{ textAlign:"center", padding:"8px 0 18px" }}>
        <div style={{ width:60, height:60, borderRadius:"50%", background:C.greenBg, border:"2px solid "+C.green,
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:28, margin:"0 auto 16px" }}>✓</div>
        <p style={{ color:C.textMid, fontSize:14, lineHeight:1.6, marginBottom:20 }}>
          Your password has been updated. Sign in with your new password to continue.
        </p>
      </div>
      <Btn onClick={goLogin}>Sign in →</Btn>
    </AuthShell>
  );

  return (
    <AuthShell title="Set new password" sub="Choose a strong password for your account" onSubmit={submit}>
      <FInput label="New password" type="password" value={pass} onChange={setPass} placeholder="Minimum 8 characters" />
      <FInput label="Confirm new password" type="password" value={confirm} onChange={setConfirm} placeholder="Repeat your new password" />
      {err && <div style={{ padding:"10px 14px", background:C.redBg, border:"1px solid #fca5a5", borderRadius:8, color:C.red, fontSize:12, marginBottom:14 }}>{err}</div>}
      <Btn onClick={submit} disabled={busy} submit>{busy?"Updating password...":"Update password →"}</Btn>
    </AuthShell>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   PROFILE SCREEN
═══════════════════════════════════════════════════════════════════ */
function ProfileScreen({ user, onSave }) {
  const [name,  setName]  = useState(user.name  || "");
  const [empId, setEmpId] = useState(user.emp_id || "");
  const [rank,  setRank]  = useState(user.rank  || "Captain");
  const [base,  setBase]  = useState(user.home_base || "DEL");
  const [err,   setErr]   = useState("");
  const [busy,  setBusy]  = useState(false);

  const incomplete = !name || !base || !empId;

  const save = async () => {
    if (!name || !empId || !base) { setErr("Name, Employee ID, and Home Base are required."); return; }
    setBusy(true); setErr("");
    if (supabase) {
      const { error } = await supabase.from("profiles").update({
        name, emp_id: empId.trim(), rank, home_base: base.toUpperCase().slice(0, 3),
      }).eq("id", user.id);
      if (error) {
        const msg = (error.message || "").toLowerCase();
        if (msg.includes("emp_id") || msg.includes("profiles_emp_id_unique")) {
          setErr("This employee ID is already registered to another account.");
        } else {
          setErr(error.message);
        }
        setBusy(false); return;
      }
    }
    onSave({ ...user, name, emp_id: empId.trim(), rank, home_base: base.toUpperCase().slice(0, 3) });
    setBusy(false);
  };

  return (
    <div style={{ padding:"16px 16px 90px", maxWidth:500, margin:"0 auto" }}>
      <div style={{ background:"linear-gradient(120deg,"+C.blue+","+C.navy+")", borderRadius:18,
        padding:"20px", marginBottom:24, boxShadow:"0 4px 20px rgba(26,111,212,0.22)" }}>
        <div style={{ fontSize:11, color:"rgba(255,255,255,0.65)", letterSpacing:"0.12em", textTransform:"uppercase", marginBottom:4 }}>Pilot Profile</div>
        <div style={{ fontSize:22, fontWeight:900, color:C.white }}>Complete your profile</div>
        <div style={{ fontSize:13, color:"rgba(255,255,255,0.6)", marginTop:3 }}>
          {incomplete ? "Required before you can calculate allowances." : "Your profile is complete — update as needed."}
        </div>
      </div>
      {incomplete && (
        <div style={{ padding:"12px 14px", background:C.goldBg, border:"1.5px solid "+C.goldBorder, borderRadius:10, fontSize:12, color:C.goldText, marginBottom:20 }}>
          ⚠ Your profile is incomplete. Please fill in the fields below before calculating.
        </div>
      )}
      <Card>
        <div onKeyDown={e => { if (e.key === "Enter") save(); }}>
          <FInput label="Full Name" value={name}  onChange={setName}  placeholder="Your name as on IndiGo ID" />
          <FInput label="Employee ID" value={empId} onChange={setEmpId} placeholder="Your IndiGo employee number" hint="Required" />
          <FSelect label="Rank" value={rank} onChange={setRank} options={RANKS} />
          <FInput label="Home Base (IATA)" value={base} onChange={v => setBase(v.toUpperCase().slice(0,3))} placeholder="e.g. DEL" hint="3-letter IATA code of your home base airport" />
          {err && <div style={{ padding:"10px 14px", background:C.redBg, borderRadius:8, color:C.red, fontSize:12, marginBottom:14 }}>{err}</div>}
          <Btn onClick={save} disabled={busy}>{busy?"Saving...":"Save profile →"}</Btn>
        </div>
      </Card>

      {/* Subscription management — hidden for admins (unlimited) and comp users (free, no Stripe relationship) */}
      {!user.is_admin && user.subscription_plan !== "free" && user.stripe_customer_id && (
        <Card style={{ marginTop:16 }}>
          <div style={{ fontSize:14, fontWeight:800, color:C.navy, marginBottom:10 }}>Subscription</div>
          <div style={{ display:"grid", gap:6, fontSize:13, color:C.textMid, marginBottom:14 }}>
            <div style={{ display:"flex", justifyContent:"space-between" }}>
              <span>Plan</span>
              <span style={{ fontWeight:700, color:C.navy }}>{user.subscription_plan === "12mo" ? "Annual" : user.subscription_plan === "1mo" ? "Monthly" : user.subscription_plan || "—"}</span>
            </div>
            <div style={{ display:"flex", justifyContent:"space-between" }}>
              <span>Status</span>
              <span style={{ fontWeight:700, color: user.subscription_status === "active" ? C.green : C.gold }}>
                {user.subscription_status || "—"}
              </span>
            </div>
            {user.subscription_current_period_end && (
              <div style={{ display:"flex", justifyContent:"space-between" }}>
                <span>{user.subscription_cancel_at_period_end ? "Access until" : "Renews on"}</span>
                <span style={{ fontWeight:700, color:C.navy }}>
                  {new Date(user.subscription_current_period_end).toLocaleDateString("en-IN", { day:"numeric", month:"short", year:"numeric" })}
                </span>
              </div>
            )}
          </div>
          <ManageSubscriptionBtn userId={user.id} />
        </Card>
      )}

      {/* Comp account — read-only info card */}
      {!user.is_admin && user.subscription_plan === "free" && (
        <Card style={{ marginTop:16 }}>
          <div style={{ fontSize:14, fontWeight:800, color:C.navy, marginBottom:8 }}>Account</div>
          <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, color:C.textMid, marginBottom:6 }}>
            <span>Plan</span>
            <span style={{ fontWeight:700, color:C.green }}>Comp · Free</span>
          </div>
          <div style={{ fontSize:12, color:C.textLo, lineHeight:1.5 }}>
            You have complimentary access to Crew Allowance. Questions?{" "}
            <a href="mailto:help@crewallowance.com" style={{ color:C.blue }}>help@crewallowance.com</a>
          </div>
        </Card>
      )}
    </div>
  );
}

function ManageSubscriptionBtn({ userId }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const resp = await fetch("/api/customer-portal", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ userId }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      window.location.href = data.url;
    } catch (err) { alert(err.message); }
    setBusy(false);
  };
  return (
    <Btn onClick={open} disabled={busy} variant="ghost" small>
      {busy ? "Opening..." : "Manage subscription →"}
    </Btn>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   UPGRADE SCREEN  (after trial used — pick a subscription)
═══════════════════════════════════════════════════════════════════ */
function UpgradeScreen({ user, onActivated, goBack }) {
  // Filter out the trial plan — only show the 2 subscription options.
  const subPlans = Object.entries(PLANS).filter(([, p]) => p.kind === "subscription");
  const [planKey,    setPlanKey]    = useState(subPlans[0][0]);
  const [loading,    setLoading]    = useState(false);
  const [payErr,     setPayErr]     = useState("");
  const [stripeReady,setStripeReady]= useState(false);

  const stripeRef         = useRef(null);
  const elementsRef       = useRef(null);
  const paymentElementRef = useRef(null);
  const paymentDivRef     = useRef(null);

  const plan = PLANS[planKey];

  // Load Stripe.js
  useEffect(() => {
    const STRIPE_PK = import.meta.env.VITE_STRIPE_PK || "";
    if (!STRIPE_PK) return;
    if (!window.Stripe) {
      const script = document.createElement("script");
      script.src = "https://js.stripe.com/v3/";
      script.onload = () => { stripeRef.current = window.Stripe(STRIPE_PK); };
      document.head.appendChild(script);
    } else { stripeRef.current = window.Stripe(STRIPE_PK); }
  }, []);

  // Mount Payment Element in deferred mode — no Subscription created until Pay.
  useEffect(() => {
    if (!stripeRef.current || !paymentDivRef.current) return;
    if (paymentElementRef.current) return;
    const elements = stripeRef.current.elements({
      mode: "payment",
      amount: plan.total * 100,
      currency: "inr",
      paymentMethodCreation: "manual",
      appearance: { theme:"stripe", variables: { fontFamily:"'Nunito','Segoe UI',sans-serif", colorPrimary:"#1a6fd4", borderRadius:"10px" } },
    });
    const paymentEl = elements.create("payment", { layout: "tabs" });
    paymentEl.mount(paymentDivRef.current);
    paymentEl.on("ready", () => setStripeReady(true));
    elementsRef.current = elements;
    paymentElementRef.current = paymentEl;
    return () => {
      if (paymentElementRef.current) {
        paymentElementRef.current.unmount();
        paymentElementRef.current = null;
        elementsRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stripeReady]);

  // Update Element's amount when plan changes (no remount).
  useEffect(() => {
    if (elementsRef.current) elementsRef.current.update({ amount: plan.total * 100 });
  }, [plan.total]);

  const handlePay = async () => {
    setPayErr(""); setLoading(true);
    if (!stripeRef.current || !elementsRef.current) {
      setPayErr("Payment form not ready. Please wait a moment."); setLoading(false); return;
    }
    try {
      // Step 1: validate input.
      const { error: submitErr } = await elementsRef.current.submit();
      if (submitErr) throw new Error(submitErr.message);

      // Step 2: create the Subscription only now.
      const resp = await fetch("/api/create-subscription", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ plan:planKey, userId:user.id, email:user.email }),
      });
      const { clientSecret, error: serverErr } = await resp.json();
      if (serverErr) throw new Error(serverErr);
      if (!clientSecret) throw new Error("Payment session could not be created.");

      // Step 3: confirm.
      const { error: confirmErr, paymentIntent } = await stripeRef.current.confirmPayment({
        elements: elementsRef.current,
        clientSecret,
        confirmParams: { return_url: window.location.origin + "?payment_status=success" },
        redirect: "if_required",
      });
      if (confirmErr) throw new Error(confirmErr.message);
      if (paymentIntent?.status === "succeeded" || !paymentIntent) {
        onActivated();
      } else {
        setPayErr("Payment did not complete. Please try again.");
      }
    } catch (err) { setPayErr(err.message); }
    setLoading(false);
  };

  return (
    <div style={{ padding:"16px 16px 90px", maxWidth:520, margin:"0 auto" }}>
      <div style={{ background:"linear-gradient(120deg,"+C.blue+","+C.navy+")", borderRadius:18,
        padding:"24px 20px", marginBottom:20, textAlign:"center", boxShadow:"0 4px 20px rgba(26,111,212,0.22)" }}>
        <div style={{ fontSize:32, marginBottom:8 }}>🎉</div>
        <div style={{ fontSize:20, fontWeight:900, color:C.white, marginBottom:6 }}>Liked what you saw?</div>
        <div style={{ fontSize:13, color:"rgba(255,255,255,0.7)", lineHeight:1.5 }}>
          Your trial run is complete. Pick a subscription to keep running unlimited reports each month.
        </div>
      </div>

      <div style={{ display:"grid", gap:10, marginBottom:18 }}>
        {subPlans.map(([key, p]) => {
          const selected = key === planKey;
          return (
            <button key={key} type="button" onClick={() => setPlanKey(key)}
              style={{
                textAlign:"left", cursor:"pointer", fontFamily:"inherit",
                background: selected ? C.blueXLight : C.white,
                border: "2px solid " + (selected ? C.blue : C.border),
                borderRadius:12, padding:"14px 16px",
                display:"flex", justifyContent:"space-between", alignItems:"center", gap:12,
              }}>
              <div>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ fontSize:15, fontWeight:800, color:C.navy }}>{p.label}</span>
                  {p.badge && (
                    <span style={{ fontSize:10, fontWeight:800, background:C.green, color:C.white,
                      padding:"2px 7px", borderRadius:99, letterSpacing:"0.04em" }}>{p.badge}</span>
                  )}
                </div>
                <div style={{ fontSize:12, color:C.textMid, marginTop:3 }}>{p.sub}</div>
              </div>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontSize:18, fontWeight:900, color:C.navy }}>{fmtINR(p.total)}</div>
                <div style={{ fontSize:11, color:C.textLo }}>billed today</div>
              </div>
            </button>
          );
        })}
      </div>

      <div style={{ background:C.white, borderRadius:14, border:"1.5px solid "+C.border, padding:"16px 18px", marginBottom:14 }}>
        <div style={{ fontSize:11, color:C.textMid, marginBottom:10 }}>
          🔒 Payment handled securely by Stripe. Card and UPI accepted.
        </div>
        <div ref={paymentDivRef} style={{ minHeight:46 }} />
        {!stripeReady && <div style={{ fontSize:11, color:C.textLo, marginTop:6 }}>Loading secure payment form...</div>}
      </div>

      {payErr && <div style={{ padding:"10px 14px", background:C.redBg, border:"1px solid #fca5a5", borderRadius:8, color:C.red, fontSize:12, marginBottom:14 }}>{payErr}</div>}

      <Btn onClick={handlePay} disabled={loading || !stripeReady} icon={loading?"⟳":"🔒"}>
        {loading ? "Processing..." : `Subscribe — ${fmtINR(plan.total)} →`}
      </Btn>
      <div style={{ marginTop:10, textAlign:"center" }}>
        <button type="button" onClick={goBack} style={{ background:"none", border:"none", color:C.textLo, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>
          ← Back to calculator
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   CALC SCREEN  (PCSR-based, single file upload)
═══════════════════════════════════════════════════════════════════ */
function CalcScreen({ user, rates, onNeedProfile, onTrialUsed, onUpgrade }) {
  const [pcsrFile,   setPcsrFile]   = useState(null);
  const [pcsrData,   setPcsrData]   = useState(null);   // parsed PCSR result
  const [result,     setResult]     = useState(null);
  const [err,        setErr]        = useState("");
  const [phase,      setPhase]      = useState("idle"); // idle | fetching | calculating | done
  const [progress,   setProgress]   = useState({ current:0, total:0, flight:"" });
  const [svStatus,   setSvStatus]   = useState(null);   // "found" | "missing"
  const [svSourceMonth, setSvSourceMonth] = useState(null); // actual month SV was loaded from (may differ from roster month)
  const [apiStats,   setApiStats]   = useState(null);   // { fetched, cached, failed }

  const homeBase = user.home_base || "DEL";
  const rank     = user.rank || "Captain";

  // Fetch SV data for a given month from Supabase.
  // Falls back up to 3 months prior if the target month has no upload yet —
  // sector values rarely change month-to-month so this keeps night flying
  // computable even before the current month's SV is uploaded. Returns
  // { rows, sourceMonth } where sourceMonth may differ from the requested month.
  const fetchSV = async (month) => {
    if (!supabase) return { rows: [], sourceMonth: null };
    // Helper: subtract N months from a YYYY-MM string.
    const subMonths = (yyyyMm, n) => {
      const [y, m] = yyyyMm.split("-").map(Number);
      const d = new Date(Date.UTC(y, m - 1 - n, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    };
    for (let offset = 0; offset <= 3; offset++) {
      const tryMonth = offset === 0 ? month : subMonths(month, offset);
      const { data } = await supabase.from("sector_values")
        .select("data").eq("month", tryMonth)
        .order("uploaded_at", { ascending: false }).limit(1).maybeSingle();
      if (data?.data?.length) {
        return { rows: data.data, sourceMonth: tryMonth };
      }
    }
    return { rows: [], sourceMonth: null };
  };

  const onPcsrParsed = useCallback((file, parsed) => {
    // Ownership check: a non-admin can only upload their own PCSR. We compare
    // the employee_id parsed from the PDF against the user's profile emp_id.
    // Admins can upload anyone's PCSR (they need this to help debug user reports).
    if (!user.is_admin) {
      const pcsrEmpId = String(parsed?.pilot?.employee_id || "").trim();
      const myEmpId   = String(user.emp_id || "").trim();
      if (pcsrEmpId && myEmpId && pcsrEmpId !== myEmpId) {
        setPcsrFile(null); setPcsrData(null); setResult(null);
        setErr(`This PCSR belongs to employee ${pcsrEmpId}, but your account is registered to employee ${myEmpId}. You can only upload your own PCSR.`);
        return;
      }
    }

    // Completeness check: PCSRs for the current calendar month or any future
    // month are still subject to change (delays, swaps, sectors yet to fly).
    // Calculating against an incomplete PCSR produces misleading numbers, so
    // we reject upfront. Admins bypass for testing/reproduction purposes.
    if (!user.is_admin && parsed?.month) {
      const now = new Date();
      const currentYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      if (parsed.month >= currentYm) {
        setPcsrFile(null); setPcsrData(null); setResult(null);
        const monthName = new Date(parsed.month + "-01").toLocaleDateString("en-IN", { month: "long", year: "numeric" });
        setErr(`This PCSR is for ${monthName}, which hasn't finished yet. Allowance calculations need a complete month — please upload your PCSR after the month ends (typically the 1st-3rd of the following month, once eCrew finalises actual times).`);
        return;
      }
    }

    setErr(""); setPcsrFile(file); setPcsrData(parsed); setResult(null);
  }, [user.is_admin, user.emp_id]);

  const calculate = async () => {
    if (!pcsrData) return;

    // Access gate: a user can run a calculation if they have an active
    // subscription, OR if they paid for a trial and haven't used it yet,
    // OR if they have free-code access (subscription_plan = 'free').
    const isAdmin        = !!user.is_admin;
    const hasActiveSub   = ["active", "trialing"].includes(user.subscription_status);
    const hasUnusedTrial = !!user.trial_paid_at && !user.trial_used;
    const hasFreeAccess  = user.subscription_plan === "free";
    if (!isAdmin && !hasActiveSub && !hasUnusedTrial && !hasFreeAccess) {
      if (typeof onUpgrade === "function") onUpgrade();
      return;
    }

    setErr(""); setResult(null); setPhase("fetching");

    try {
      // 1. Fetch SV data from Supabase (with up to 3 months of fallback)
      const { rows: svData, sourceMonth: svFromMonth } = await fetchSV(pcsrData.month);
      setSvStatus(svData.length ? "found" : "missing");
      setSvSourceMonth(svFromMonth);

      // 2. Map pcsrParser sector fields to calculate.js conventions
      const [y, mo] = pcsrData.month.split("-").map(Number);
      const parsedPeriod = new Date(y, mo - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
      const sectors = pcsrData.sectors.map(s => ({
        date:   s.date,
        flight: s.flight_no,
        dep:    s.dep,
        arr:    s.arr,
        atd:    s.atd_local,
        ata:    s.ata_local,
        is_dhf: s.is_dhf,
        is_dht: s.is_dht,
      }));
      console.log("[calculate] pcsrParser sectors:", sectors.length, "period:", parsedPeriod);

      // 3. Filter SV to only flights in parsed sectors
      const sectorFlights = new Set(
        sectors.map(s => String(s.flight).replace(/^6E/i, ""))
      );
      const svFiltered = (svData || []).filter(r => sectorFlights.has(String(r.FLTNBR)));
      console.log("[calculate] SV rows full:", (svData||[]).length, "filtered:", svFiltered.length);

      // 4. Sort sectors chronologically before any downstream use.
      sectors.sort((a, b) => {
        if (a.date < b.date) return -1;
        if (a.date > b.date) return  1;
        const ta = a.atd ?? "23:59";
        const tb = b.atd ?? "23:59";
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });

      // 5. Fetch schedule data (ADB or FR24 per admin setting) for parsed sectors
      setPhase("fetching");
      const source = await fetchScheduleSource();
      const { map: schedMap, fetched, cached, failed } = await buildSchedMap(
        sectors,
        (cur, total, flight) => setProgress({ current: cur, total, flight }),
        source,
      );
      setApiStats({ fetched, cached, failed, source });
      console.log(`[calculate] ${source.toUpperCase()} done — fetched:`, fetched, "cached:", cached, "failed:", failed);

      // 6. Run deterministic JS calculations
      setPhase("calculating");
      const pilot = { name: user.name, employee_id: user.emp_id, home_base: homeBase, rank };
      // Pass the hotel list from the PCSR — calculateLayover uses it to gate
      // TLPD so long station sits that were not actually hotelled (e.g., early
      // next-day positioning flights) are excluded.
      const hotels = pcsrData?.hotels || [];
      const res = runCalculations(parsedPeriod, sectors, schedMap, svFiltered, pilot, null, hotels);

      console.log("[calculate] Result — total:", res.total,
        "deadhead:", res.deadhead?.sectors?.length,
        "layover:", res.layover?.events?.length,
        "transit:", res.transit?.halts?.length,
        "tailSwap:", res.tailSwap?.count);

      setResult(res);
      setPhase("done");

      // Bump the calculation-runs counter (admin runs are filtered out
      // server-side by the RPC, so this is safe to call regardless — the
      // client-side check is just to avoid the wasted round-trip).
      // Period is the machine-form YYYY-MM (e.g. "2026-01"), not the
      // display name, so periods aggregate cleanly across locales.
      if (!isAdmin && supabase) {
        supabase.rpc("bump_calculation_run", { p_period: pcsrData.month })
          .then(({ error }) => {
            if (error) console.warn("[runs] bump error:", error.message);
          });
      }

      // If this calculation was the trial run, mark it used (server-side + local).
      // We deliberately do this AFTER setResult so failures upstream don't
      // burn the trial — only successful completions count.
      if (hasUnusedTrial && !isAdmin && !hasActiveSub && !hasFreeAccess) {
        if (supabase) {
          await supabase.from("profiles").update({ trial_used: true }).eq("id", user.id);
        }
        // Mutate user object so subsequent calc attempts in this session also
        // hit the upgrade gate. Parent App holds the source of truth — propagate.
        if (typeof onTrialUsed === "function") onTrialUsed();
      }
    } catch (e) {
      setErr(e?.message || String(e));
      setPhase("idle");
    }
  };

  const reset = () => {
    setPcsrFile(null); setPcsrData(null); setResult(null);
    setErr(""); setPhase("idle"); setProgress({ current:0, total:0, flight:"" });
    setApiStats(null); setSvStatus(null); setSvSourceMonth(null);
  };

  const profileIncomplete = !user.home_base || !user.emp_id;

  return (
    <div style={{ padding:"16px 16px 90px", maxWidth:680, margin:"0 auto" }}>
      <div style={{ background:"linear-gradient(120deg,"+C.blue+","+C.navy+")", borderRadius:18,
        padding:"20px", marginBottom:20, boxShadow:"0 4px 20px rgba(26,111,212,0.22)" }}>
        <div style={{ fontSize:11, color:"rgba(255,255,255,0.65)", letterSpacing:"0.12em", textTransform:"uppercase", marginBottom:4 }}>
          {rank} · {user.emp_id || "—"} · {homeBase}
        </div>
        <div style={{ fontSize:22, fontWeight:900, color:C.white }}>Hi, {user.name?.split(" ")[0]} 👋</div>
        <div style={{ fontSize:13, color:"rgba(255,255,255,0.6)", marginTop:3 }}>
          Upload your Personal Crew Schedule Report (PCSR) to calculate this month's allowances.
        </div>
      </div>

      {profileIncomplete && (
        <div style={{ padding:"12px 14px", background:C.goldBg, border:"1.5px solid "+C.goldBorder, borderRadius:10, fontSize:12, color:C.goldText, marginBottom:16, display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
          <span>⚠ Your pilot profile is incomplete — please add your home base and employee ID.</span>
          <button type="button" onClick={onNeedProfile} style={{ background:"none", border:"1px solid "+C.goldBorder, borderRadius:8, padding:"4px 10px", color:C.goldText, fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" }}>Complete profile →</button>
        </div>
      )}

      {/* Trial banner — shown when user paid trial but hasn't used it yet */}
      {user.trial_paid_at && !user.trial_used && !user.is_admin && !["active","trialing"].includes(user.subscription_status) && (
        <div style={{ padding:"12px 14px", background:C.blueXLight, border:"1.5px solid "+C.blue, borderRadius:10, fontSize:12, color:C.navy, marginBottom:16, display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:16 }}>✨</span>
          <div>
            <div style={{ fontWeight:800 }}>Trial active — one calculation remaining</div>
            <div style={{ color:C.textMid, marginTop:2 }}>Upload your PCSR and run your report below. Unlimited reports require a subscription.</div>
          </div>
        </div>
      )}

      {!result && phase !== "fetching" && phase !== "calculating" && (
        <>
          <PcsrDropZone file={pcsrFile} onParsed={onPcsrParsed} onFail={setErr} />

          {pcsrData && (
            <div style={{ marginTop:14, padding:"12px 16px", background: pcsrData.sectors.length < 3 ? C.goldBg : C.greenBg, border:"1.5px solid "+(pcsrData.sectors.length < 3 ? C.goldBorder : C.green), borderRadius:10, fontSize:13, color: pcsrData.sectors.length < 3 ? C.goldText : C.green }}>
              <strong>Parsed:</strong> {pcsrData.sectors.length} sectors · {pcsrData.month} · Format: {pcsrData.format}
              {pcsrData.pilot?.name && <span> · {pcsrData.pilot.name}</span>}
              {pcsrData.sectors.length < 3 && pcsrData._rawSample && (
                <details style={{ marginTop:8 }}>
                  <summary style={{ cursor:"pointer", fontSize:11, fontWeight:700 }}>Show raw PDF text (for debugging)</summary>
                  <pre style={{ marginTop:8, fontSize:10, whiteSpace:"pre-wrap", wordBreak:"break-all", background:"rgba(0,0,0,0.05)", padding:8, borderRadius:6, maxHeight:300, overflow:"auto", color:C.text }}>
                    {pcsrData._rawSample}
                  </pre>
                </details>
              )}
              {pcsrData.sectors.length >= 1 && (
                <details style={{ marginTop:8 }}>
                  <summary style={{ cursor:"pointer", fontSize:11, fontWeight:700 }}>Show parsed sectors (debug)</summary>
                  <div style={{ marginTop:8, marginBottom:4 }}>
                    <button
                      onClick={() => {
                        const fmt = t => t ? t.slice(0,5) : "";
                        const rows = [
                          ["#","Date","Flight","Dep","Arr","DHF","DHT","ATD","ATA"],
                          ...pcsrData.sectors.map((s, i) => [
                            i + 1,
                            s.date,
                            s.flight_no,
                            s.dep,
                            s.arr,
                            s.is_dhf ? "true" : "false",
                            s.is_dht ? "true" : "false",
                            fmt(s.atd_local),
                            fmt(s.ata_local),
                          ])
                        ];
                        const csv = rows.map(r => r.join(",")).join("\n");
                        const a = document.createElement("a");
                        a.href = URL.createObjectURL(new Blob([csv], { type:"text/csv" }));
                        a.download = "sectors.csv";
                        a.click();
                      }}
                      style={{ fontSize:11, padding:"3px 10px", borderRadius:5, border:"1px solid rgba(0,0,0,0.2)", background:"rgba(0,0,0,0.05)", cursor:"pointer" }}
                    >Download CSV</button>
                  </div>
                  <div style={{ marginTop:8, overflowX:"auto" }}>
                    <table style={{ width:"100%", borderCollapse:"collapse", fontSize:10, color:C.text, background:"rgba(0,0,0,0.04)", borderRadius:6 }}>
                      <thead>
                        <tr style={{ background:"rgba(0,0,0,0.08)" }}>
                          {["#","Date","Flight","Dep","Arr","DHF","DHT","ATD (local)","ATA (local)"].map(h => (
                            <th key={h} style={{ padding:"4px 6px", textAlign:"left", fontWeight:700, whiteSpace:"nowrap", borderBottom:"1px solid rgba(0,0,0,0.1)" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {pcsrData.sectors.map((s, i) => (
                          <tr key={i} style={{ background: i % 2 === 0 ? "transparent" : "rgba(0,0,0,0.03)" }}>
                            <td style={{ padding:"3px 6px", color:"rgba(0,0,0,0.4)" }}>{i + 1}</td>
                            <td style={{ padding:"3px 6px", whiteSpace:"nowrap" }}>{s.date}</td>
                            <td style={{ padding:"3px 6px", whiteSpace:"nowrap", fontWeight:600 }}>{s.flight_no}</td>
                            <td style={{ padding:"3px 6px" }}>{s.dep}</td>
                            <td style={{ padding:"3px 6px" }}>{s.arr}</td>
                            <td style={{ padding:"3px 6px", textAlign:"center" }}>{s.is_dhf ? "✓" : ""}</td>
                            <td style={{ padding:"3px 6px", textAlign:"center" }}>{s.is_dht ? "✓" : ""}</td>
                            <td style={{ padding:"3px 6px", whiteSpace:"nowrap" }}>{s.atd_local || "—"}</td>
                            <td style={{ padding:"3px 6px", whiteSpace:"nowrap" }}>{s.ata_local || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </div>
          )}

          {err && <div style={{ marginTop:12, padding:"12px 14px", background:C.redBg, border:"1px solid #fca5a5", borderRadius:10, color:C.red, fontSize:12 }}>{err}</div>}

          <div style={{ marginTop:16 }}>
            <Btn onClick={calculate} disabled={!pcsrData || profileIncomplete} icon="▶">
              Calculate allowances →
            </Btn>
            {profileIncomplete && pcsrData && (
              <div style={{ marginTop:6, fontSize:11, color:C.textLo, textAlign:"center" }}>Complete your profile first to enable calculation.</div>
            )}
          </div>
        </>
      )}

      {phase === "fetching" && (
        <div style={{ marginTop:20, padding:"24px 20px", background:C.white, borderRadius:16, border:"1.5px solid "+C.border, textAlign:"center", boxShadow:C.shadow }}>
          <div style={{ fontSize:32, marginBottom:12 }}>✈</div>
          <div style={{ fontSize:15, fontWeight:800, color:C.navy, marginBottom:6 }}>Fetching schedule data…</div>
          <div style={{ fontSize:12, color:C.textMid, marginBottom:16 }}>
            {progress.total > 0
              ? `${progress.current} / ${progress.total} sectors — ${progress.flight}`
              : "Checking Supabase cache…"}
          </div>
          {progress.total > 0 && (
            <div style={{ background:C.border, borderRadius:4, height:6, overflow:"hidden" }}>
              <div style={{ width:`${(progress.current/progress.total)*100}%`, height:"100%",
                background:"linear-gradient(90deg,"+C.blue+","+C.blueMid+")", transition:"width 0.4s" }} />
            </div>
          )}
          <div style={{ marginTop:14, fontSize:11, color:C.textLo }}>Schedule data API · results cached to avoid repeat calls</div>
        </div>
      )}

      {phase === "calculating" && (
        <div style={{ marginTop:20, padding:"24px 20px", background:C.white, borderRadius:16, border:"1.5px solid "+C.border, textAlign:"center", boxShadow:C.shadow }}>
          <div style={{ fontSize:32, marginBottom:12 }}>🤖</div>
          <div style={{ fontSize:15, fontWeight:800, color:C.navy, marginBottom:6 }}>Reading PCSR…</div>
          <div style={{ fontSize:12, color:C.textMid, marginBottom:16 }}>Claude is extracting your sectors. This takes 10–20 seconds.</div>
          <div style={{ background:C.border, borderRadius:4, height:6, overflow:"hidden" }}>
            <div style={{ width:"100%", height:"100%", background:"linear-gradient(90deg,"+C.blue+","+C.blueMid+")",
              animation:"pulse 1.8s ease-in-out infinite", opacity:0.7 }} />
          </div>
          <div style={{ marginTop:14, fontSize:11, color:C.textLo }}>Claude Sonnet · extracting sectors · allowances calculated in JS</div>
        </div>
      )}

      {result && (
        <div style={{ marginTop:4 }}>
          <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:12 }}>
            <Btn onClick={reset} variant="ghost" small full={false} icon="↩">New calculation</Btn>
          </div>

          {svStatus === "missing" && (
            <div style={{ marginBottom:14, padding:"10px 14px", background:C.goldBg, border:"1px solid "+C.goldBorder, borderRadius:10, fontSize:12, color:C.goldText }}>
              ⚠ No Sector Values found for {result.period}. Night allowance cannot be calculated. Ask your admin to upload the SV file for this month.
            </div>
          )}

          {svStatus === "found" && svSourceMonth && pcsrData?.month && svSourceMonth !== pcsrData.month && (
            <div style={{ marginBottom:14, padding:"10px 14px", background:C.goldBg, border:"1px solid "+C.goldBorder, borderRadius:10, fontSize:12, color:C.goldText, lineHeight:1.55 }}>
              <strong>⚠ Approximation in use.</strong> Sector Values for {result.period} have not been uploaded yet, so night flying has been calculated using the {new Date(svSourceMonth + "-01").toLocaleDateString("en-IN", { month:"long", year:"numeric" })} SV data. Since SVs rarely change month-to-month this is usually close to exact, but the final figure could differ by a few minutes once your admin uploads the current month.
            </div>
          )}

          {apiStats && (apiStats.failed > 0 || apiStats.fetched > 0 || apiStats.cached > 0) && (
            <div style={{ marginBottom:14, padding:"10px 14px", borderRadius:10, fontSize:12,
              background: apiStats.failed === apiStats.fetched + apiStats.cached + apiStats.failed ? C.redBg : apiStats.failed > 0 ? C.goldBg : C.greenBg,
              border:"1px solid "+(apiStats.failed > 0 && apiStats.fetched + apiStats.cached === 0 ? "#fca5a5" : apiStats.failed > 0 ? C.goldBorder : C.green),
              color: apiStats.failed > 0 && apiStats.fetched + apiStats.cached === 0 ? C.red : apiStats.failed > 0 ? C.goldText : C.green }}>
              Schedule data: {apiStats.fetched} fetched from {apiStats.source === "fr24" ? "FR24" : apiStats.source === "aeroapi" ? "FlightAware" : "AeroDataBox"} · {apiStats.cached} from cache · {apiStats.failed} failed
              {apiStats.failed > 0 && apiStats.fetched + apiStats.cached === 0 && ` — tail-swap requires schedule data. Check ${apiStats.source === "fr24" ? "FR24_API_TOKEN" : apiStats.source === "aeroapi" ? "AEROAPI_KEY" : "RAPIDAPI_KEY"} or try again.`}
              {apiStats.failed > 0 && apiStats.fetched + apiStats.cached > 0 && " — deadhead/night calculated from actual times for failed sectors."}
            </div>
          )}

          <div style={{ background:"linear-gradient(135deg,"+C.goldText+" 0%,#8a5500 100%)", borderRadius:18,
            padding:"22px 20px", marginBottom:20, boxShadow:"0 6px 24px rgba(180,112,0,0.28)",
            display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div>
              <div style={{ fontSize:11, color:"rgba(255,255,255,0.7)", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:4 }}>Total Allowance</div>
              <div style={{ fontSize:12, color:"rgba(255,255,255,0.65)" }}>{result.period} · {rank}</div>
            </div>
            <div style={{ fontSize:32, fontWeight:900, color:C.white }}>{fmtINR(result.total)}</div>
          </div>

          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:20 }}>
            {[["Deadhead",result.deadhead.amount,result.deadhead.sectors.length+" sectors"],
              ["Night Flying",result.night.amount,result.night.sectors.length+" sectors"],
              ["Layover",result.layover.amount,result.layover.events.length+" stays"],
              ["Tail Swap",result.tailSwap.amount,result.tailSwap.count+" swaps"],
              ["Transit",result.transit.amount,result.transit.halts.length+" halts"]
            ].map(([lbl,amt,meta]) => (
              <Card key={lbl} style={{ padding:"14px 16px" }}>
                <div style={{ fontSize:10, color:C.blue, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:4 }}>{lbl}</div>
                <div style={{ fontSize:20, fontWeight:900, color:C.navy }}>{fmtINR(amt)}</div>
                <div style={{ fontSize:11, color:C.textLo, marginTop:2 }}>{meta}</div>
              </Card>
            ))}
          </div>

          <div style={{ marginBottom:20 }}>
            <Btn onClick={() => dlCSV(result, user)} variant="ghost" icon="↓">Download Full Breakdown (CSV)</Btn>
          </div>

          {result.deadhead.sectors.length > 0 && (
            <CollapsibleTable title="Deadhead Allowance" total={result.deadhead.amount}
              note={"Rate: "+fmtINR(rates.deadhead[rankBucket(rank)])+"/hr · Scheduled block hours used"}
              headers={["Date","Flight","Route","Sched Block","Amount"]} rows={result.deadhead.sectors}
              renderRow={(s,i) => (
                <tr key={i}><TC i={i}>{s.date}</TC><TC i={i}>{s.flight}</TC><TC i={i}>{s.from}→{s.to}</TC>
                  <TC i={i}>{fmtHM(s.scheduled_block_mins)}</TC><TC i={i} right gold>{fmtINR(s.amount)}</TC></tr>
              )} />
          )}
          {result.night.sectors.length > 0 && (
            <CollapsibleTable title="Night Flying Allowance" total={result.night.amount}
              note="PAH §9.0: STD (IST) + Sector Value → intersect with 00:00–06:00 IST"
              headers={["Date","Flight","Route","STD","Est. ATA","Night Mins","SV","Amount"]} rows={result.night.sectors}
              renderRow={(s,i) => (
                <tr key={i}><TC i={i}>{s.date}</TC><TC i={i}>{s.flight}</TC><TC i={i}>{s.from}→{s.to}</TC>
                  <TC i={i}>{s.std_ist}</TC><TC i={i}>{s.sta_ist}</TC><TC i={i}>{s.night_mins}m</TC>
                  <TC i={i}><Badge color="green">{s.sv_used}m</Badge></TC>
                  <TC i={i} right gold>{fmtINR(s.amount)}</TC></tr>
              )} />
          )}
          {result.layover.events.length > 0 && (
            <CollapsibleTable title="Domestic Layover Allowance" total={result.layover.amount}
              note="Qualifying: >10h 01m away from home base. Extra rate beyond 24h (rounded up to next hour). International layovers are listed but not paid in this calculation."
              headers={["Station","Date In","Date Out","Duration","Base","Extra","Total"]} rows={result.layover.events}
              renderRow={(e,i) => (
                <tr key={i}><TC i={i}>
                  <strong>{e.station}</strong>
                  {e.international && <span style={{ marginLeft:6 }}><Badge color="gold">Int'l</Badge></span>}
                </TC><TC i={i}>{e.date_in}</TC><TC i={i}>{e.date_out}</TC>
                  <TC i={i}>{e.duration_hrs}h</TC>
                  {e.international ? (
                    <TC i={i} colSpan={3}><span style={{ color:C.textLo, fontStyle:"italic", fontSize:11 }}>International — calculated separately</span></TC>
                  ) : (
                    <>
                      <TC i={i}>{fmtINR(e.base_amount)}</TC>
                      <TC i={i}>{e.extra_amount>0?fmtINR(e.extra_amount):"—"}</TC>
                      <TC i={i} right gold>{fmtINR(e.total)}</TC>
                    </>
                  )}
                </tr>
              )} />
          )}
          {result.tailSwap.swaps.length > 0 && (
            <CollapsibleTable title={"Tail-Swap Allowance ("+result.tailSwap.count+")"} total={result.tailSwap.amount}
              note="Aircraft registration changes between consecutive sectors in same duty. DHT and DHF+DHF excluded."
              headers={["Date","Sectors","Stn","Reg Out","Reg In","Amount"]} rows={result.tailSwap.swaps}
              renderRow={(s,i) => (
                <tr key={i}><TC i={i}>{s.date}{s.date_shifted && (
                  <span title="Sector delayed across midnight — verified against the previous day's schedule"
                    style={{ marginLeft:6, fontSize:10, padding:"1px 5px", borderRadius:4,
                      background:C.goldBg, color:C.goldText, border:"1px solid "+C.goldBorder, fontWeight:700, letterSpacing:"0.04em" }}>↺ SHIFTED</span>
                )}</TC><TC i={i}>{s.sector_pair}</TC>
                  <TC i={i}><strong>{s.station}</strong></TC><TC i={i}>{s.reg_out}</TC><TC i={i}>{s.reg_in}</TC>
                  <TC i={i} right gold>{s.unverifiable ? "?" : fmtINR(s.amount)}</TC></tr>
              )} />
          )}
          {result.transit.halts.length > 0 && (
            <CollapsibleTable title="Transit Allowance" total={result.transit.amount}
              note="PAH §7.0: scheduled halt primary; actual if differs >15 mins. Min 90 mins, capped 4 hrs."
              headers={["Date","Station","Arrived","Departed","Halt","Billable","Basis","Amount"]} rows={result.transit.halts}
              renderRow={(h,i) => (
                <tr key={i}><TC i={i}>{h.date}</TC><TC i={i}><strong>{h.station}</strong></TC>
                  <TC i={i}>{h.arrived_ist}</TC><TC i={i}>{h.departed_ist}</TC><TC i={i}>{h.halt_mins}m</TC>
                  <TC i={i}>{h.billable_mins}m</TC>
                  <TC i={i}><Badge color={h.basis==="scheduled"?"green":"gold"}>{h.basis}</Badge></TC>
                  <TC i={i} right gold>{fmtINR(h.amount)}</TC></tr>
              )} />
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   API USAGE PANEL  (admin → Data Source tab)
═══════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════
   USAGE METRICS PANEL  (admin → Usage tab)
   Pilot calculation runs over time. Admins are filtered server-side
   by bump_calculation_run RPC, so they never appear in these counts.
═══════════════════════════════════════════════════════════════════ */
function UsageMetricsPanel() {
  const [rows, setRows] = useState([]);   // raw run rows: { user_id, period, ran_at }
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = async () => {
    if (!supabase) { setErr("Supabase not configured."); setLoading(false); return; }
    setLoading(true); setErr("");
    try {
      // Pull the last 90 days for trends + all-time for totals via two queries.
      // The 90-day window is overshoot for the 12-week chart so we have headroom.
      const { data, error } = await supabase.from("calculation_runs")
        .select("user_id, period, ran_at")
        .order("ran_at", { ascending: false })
        .limit(10000);
      if (error) throw error;
      setRows(data || []);
    } catch (e) { setErr(e?.message || String(e)); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  // ── Aggregations ─────────────────────────────────────────────────────────
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const totalAllTime = rows.length;
  const thisMonth    = rows.filter(r => new Date(r.ran_at) >= monthStart);
  const monthRuns    = thisMonth.length;
  const uniquePilotsThisMonth = new Set(thisMonth.map(r => r.user_id)).size;
  const uniquePilotsAllTime   = new Set(rows.map(r => r.user_id)).size;

  // Top 5 most-rerun periods (signal: pilots re-running suggests they're
  // not yet trusting a result, or our data updated and they came back).
  const periodCounts = {};
  for (const r of rows) periodCounts[r.period] = (periodCounts[r.period] || 0) + 1;
  const topPeriods = Object.entries(periodCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // 12-week trend (Mon–Sun buckets, oldest left → newest right).
  const weekBuckets = [];
  const oneWeekMs = 7 * 86400000;
  for (let i = 11; i >= 0; i--) {
    const start = new Date(now.getTime() - (i + 1) * oneWeekMs);
    const end   = new Date(now.getTime() - i * oneWeekMs);
    const count = rows.filter(r => {
      const t = new Date(r.ran_at).getTime();
      return t >= start.getTime() && t < end.getTime();
    }).length;
    const label = `${end.getUTCDate()}/${end.getUTCMonth() + 1}`;
    weekBuckets.push({ label, count, start, end });
  }
  const maxBucket = Math.max(1, ...weekBuckets.map(b => b.count));

  // Most active pilots this month (UUID-only, no PII fetched).
  const pilotCountsThisMonth = {};
  for (const r of thisMonth) pilotCountsThisMonth[r.user_id] = (pilotCountsThisMonth[r.user_id] || 0) + 1;
  const topPilots = Object.entries(pilotCountsThisMonth)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const monthName = new Date().toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  return (
    <div>
      {/* ── Hero stats ─────────────────────────────────────────────── */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:14 }}>
        <Card color="blue">
          <div style={{ fontSize:11, color:C.textMid, letterSpacing:"0.04em", textTransform:"uppercase", marginBottom:4 }}>All-time runs</div>
          <div style={{ fontSize:28, fontWeight:900, color:C.navy }}>{totalAllTime.toLocaleString("en-IN")}</div>
          <div style={{ fontSize:11, color:C.textLo, marginTop:4 }}>{uniquePilotsAllTime} unique pilots</div>
        </Card>
        <Card color="blue">
          <div style={{ fontSize:11, color:C.textMid, letterSpacing:"0.04em", textTransform:"uppercase", marginBottom:4 }}>{monthName}</div>
          <div style={{ fontSize:28, fontWeight:900, color:C.green }}>{monthRuns.toLocaleString("en-IN")}</div>
          <div style={{ fontSize:11, color:C.textLo, marginTop:4 }}>{uniquePilotsThisMonth} unique pilots</div>
        </Card>
      </div>

      {err && <div style={{ padding:"10px 14px", background:C.redBg, borderRadius:8, color:C.red, fontSize:12, marginBottom:10 }}>{err}</div>}

      {/* ── 12-week trend ──────────────────────────────────────────── */}
      <Card style={{ marginBottom:14 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <div style={{ fontSize:13, fontWeight:700, color:C.navy }}>Runs per week — last 12 weeks</div>
          <button type="button" onClick={load} disabled={loading}
            style={{ background:"none", border:"1px solid "+C.border, borderRadius:8,
              padding:"4px 10px", fontSize:11, color:C.textMid, cursor:"pointer", fontFamily:"inherit" }}>
            {loading ? "..." : "↻ Refresh"}
          </button>
        </div>
        <div style={{ display:"flex", alignItems:"flex-end", gap:4, height:120, padding:"4px 0" }}>
          {weekBuckets.map((b, i) => {
            const h = Math.round((b.count / maxBucket) * 100);
            return (
              <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:4 }}>
                <div style={{ fontSize:10, color:C.textMid, fontWeight:700 }}>{b.count || ""}</div>
                <div title={`Week ending ${b.label}: ${b.count} runs`}
                  style={{ width:"100%", height:`${h}%`, minHeight: b.count > 0 ? 3 : 0,
                    background:C.blue, borderRadius:"3px 3px 0 0", transition:"height 0.2s" }} />
                <div style={{ fontSize:9, color:C.textLo }}>{b.label}</div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* ── Most-rerun periods ─────────────────────────────────────── */}
      <Card style={{ marginBottom:14 }}>
        <div style={{ fontSize:13, fontWeight:700, color:C.navy, marginBottom:6 }}>Most-rerun periods</div>
        <div style={{ fontSize:11, color:C.textMid, marginBottom:10, lineHeight:1.6 }}>
          Periods that pilots re-run most often. High counts can mean low trust in the result, or that we improved data after their first run and they came back.
        </div>
        {topPeriods.length === 0 ? (
          <div style={{ fontSize:12, color:C.textLo, fontStyle:"italic" }}>No runs yet.</div>
        ) : (
          <div style={{ border:"1px solid "+C.border, borderRadius:10, overflow:"hidden" }}>
            {topPeriods.map(([period, cnt], i) => (
              <div key={period} style={{ display:"grid", gridTemplateColumns:"1fr 80px", gap:10,
                padding:"9px 12px", fontSize:13, color:C.text,
                borderTop: i > 0 ? "1px solid "+C.border : "none",
                background: i === 0 ? C.blueXLight : "transparent" }}>
                <div style={{ fontFamily:"'Courier New', monospace" }}>{period}</div>
                <div style={{ textAlign:"right", fontWeight:700, color:C.navy }}>{cnt.toLocaleString("en-IN")}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── Top pilots this month ──────────────────────────────────── */}
      <Card style={{ marginBottom:14 }}>
        <div style={{ fontSize:13, fontWeight:700, color:C.navy, marginBottom:6 }}>Most active pilots this month</div>
        <div style={{ fontSize:11, color:C.textMid, marginBottom:10, lineHeight:1.6 }}>
          Top 5 by run count. Pilot identity shown as user UUID prefix only — cross-reference with the Users tab if you need to identify someone.
        </div>
        {topPilots.length === 0 ? (
          <div style={{ fontSize:12, color:C.textLo, fontStyle:"italic" }}>No runs this month yet.</div>
        ) : (
          <div style={{ border:"1px solid "+C.border, borderRadius:10, overflow:"hidden" }}>
            {topPilots.map(([uid, cnt], i) => (
              <div key={uid} style={{ display:"grid", gridTemplateColumns:"1fr 80px", gap:10,
                padding:"9px 12px", fontSize:13, color:C.text,
                borderTop: i > 0 ? "1px solid "+C.border : "none" }}>
                <div style={{ fontFamily:"'Courier New', monospace", fontSize:11, color:C.textMid }}>{uid.slice(0, 8)}…</div>
                <div style={{ textAlign:"right", fontWeight:700, color:C.navy }}>{cnt.toLocaleString("en-IN")}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div style={{ fontSize:11, color:C.textLo, marginTop:10, lineHeight:1.6 }}>
        Admin runs (yours) are excluded server-side and never appear in these counts. The chart shows up to the last 10,000 runs (limit will be raised if you ever hit it).
      </div>
    </div>
  );
}

function ApiUsagePanel() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // Per-call cost estimates in USD. Used only to compute estimated $ — you can
  // adjust these as plans change. FR24 is flat-rate, so we display "—".
  // fr24_fallback shares FR24's flat plan, so cost is also "—".
  const COST_PER_CALL_USD = {
    adb:            0.001,    // RapidAPI varies; ~$0.001 typical for AeroDataBox basic
    fr24:           null,     // flat $90/mo, no per-call cost
    aeroapi:        0.002,    // AeroAPI Standard
    fr24_fallback:  null,     // same flat $90/mo bucket as FR24
  };
  const PROVIDER_LABEL = {
    adb:            "AeroDataBox",
    fr24:           "Flightradar24",
    aeroapi:        "FlightAware AeroAPI",
    fr24_fallback:  "FR24 fallback (FA reg gap)",
  };

  const load = async () => {
    if (!supabase) { setErr("Supabase not configured."); setLoading(false); return; }
    setLoading(true); setErr("");
    try {
      // First day of the current calendar month (UTC).
      const now = new Date();
      const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,"0")}-01`;
      const { data, error } = await supabase.from("api_usage")
        .select("source, date, call_count")
        .gte("date", monthStart)
        .order("date", { ascending: false });
      if (error) throw error;
      setRows(data || []);
    } catch (e) { setErr(e?.message || String(e)); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  // Aggregate by source for the current month.
  const totals = {};
  for (const r of rows) {
    if (!totals[r.source]) totals[r.source] = 0;
    totals[r.source] += r.call_count || 0;
  }
  // Always show all four rows so you see "0 calls" for the inactive ones too.
  for (const s of ["aeroapi", "fr24_fallback", "fr24", "adb"]) {
    if (totals[s] == null) totals[s] = 0;
  }
  // Hit rate: how often did fallback fire vs primary AeroAPI calls?
  const aeroapiCalls  = totals.aeroapi || 0;
  const fallbackCalls = totals.fr24_fallback || 0;
  const hitRatePct    = aeroapiCalls > 0 ? (fallbackCalls / aeroapiCalls) * 100 : 0;

  const monthName = new Date().toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  return (
    <Card>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
        <div style={{ fontSize:13, fontWeight:700, color:C.navy }}>API usage — {monthName}</div>
        <button type="button" onClick={load} disabled={loading}
          style={{ background:"none", border:"1px solid "+C.border, borderRadius:8,
            padding:"4px 10px", fontSize:11, color:C.textMid, cursor:"pointer", fontFamily:"inherit" }}>
          {loading ? "..." : "↻ Refresh"}
        </button>
      </div>

      <div style={{ fontSize:12, color:C.textMid, marginBottom:14, lineHeight:1.6 }}>
        Counts every live call to a schedule API (cache hits don't count). Resets at the start of each calendar month.
      </div>

      {err && <div style={{ padding:"10px 14px", background:C.redBg, borderRadius:8, color:C.red, fontSize:12, marginBottom:10 }}>{err}</div>}

      <div style={{ border:"1px solid "+C.border, borderRadius:10, overflow:"hidden" }}>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 80px 100px", gap:10,
          padding:"10px 12px", background:C.blueXLight, fontSize:11, fontWeight:700, color:C.navy, letterSpacing:"0.04em", textTransform:"uppercase" }}>
          <div>Provider</div>
          <div style={{ textAlign:"right" }}>Calls</div>
          <div style={{ textAlign:"right" }}>Est. cost</div>
        </div>
        {["aeroapi", "fr24_fallback", "fr24", "adb"].map((s, i) => {
          const cnt = totals[s] || 0;
          const cpc = COST_PER_CALL_USD[s];
          const cost = cpc != null ? `$${(cnt * cpc).toFixed(2)}` : "—";
          return (
            <div key={s} style={{ display:"grid", gridTemplateColumns:"1fr 80px 100px", gap:10,
              padding:"10px 12px", fontSize:13, color:C.text,
              borderTop: i > 0 ? "1px solid "+C.border : "none" }}>
              <div>{PROVIDER_LABEL[s]}</div>
              <div style={{ textAlign:"right", fontWeight:700, color: cnt > 0 ? C.navy : C.textLo }}>
                {cnt.toLocaleString("en-IN")}
              </div>
              <div style={{ textAlign:"right", fontWeight:700, color: cnt > 0 ? C.gold : C.textLo }}>
                {cost}
              </div>
            </div>
          );
        })}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 80px 100px", gap:10,
          padding:"10px 12px", fontSize:13, color:C.navy, fontWeight:800,
          background:C.sky, borderTop:"1px solid "+C.border }}>
          <div>Total</div>
          <div style={{ textAlign:"right" }}>{Object.values(totals).reduce((a,b) => a+b, 0).toLocaleString("en-IN")}</div>
          <div style={{ textAlign:"right", color:C.gold }}>
            ${
              Object.entries(totals).reduce((sum, [s, cnt]) => {
                const cpc = COST_PER_CALL_USD[s];
                return cpc != null ? sum + cnt * cpc : sum;
              }, 0).toFixed(2)
            }
          </div>
        </div>
      </div>

      {aeroapiCalls > 0 && (
        <div style={{ marginTop:12, padding:"10px 14px", borderRadius:8, fontSize:12,
          background: hitRatePct > 10 ? C.goldBg : C.blueXLight,
          color: hitRatePct > 10 ? C.goldText : C.textMid,
          border: "1px solid " + (hitRatePct > 10 ? C.goldBorder : C.border),
          lineHeight:1.6 }}>
          <strong>Fallback hit rate:</strong> {fallbackCalls.toLocaleString("en-IN")} / {aeroapiCalls.toLocaleString("en-IN")}
          {" "}AeroAPI calls needed FR24 to fill in a missing aircraft reg ({hitRatePct.toFixed(1)}%).
          {hitRatePct > 10
            ? " That's a meaningful gap — keep the fallback ON until FlightAware fixes their data."
            : hitRatePct > 0
              ? " Low rate — FA is mostly returning regs cleanly."
              : ""}
        </div>
      )}

      <div style={{ fontSize:11, color:C.textLo, marginTop:10, lineHeight:1.6 }}>
        FR24 cost is flat $90/month (Essential) so per-call cost is shown as "—".
        AeroAPI cost based on Standard tier ($0.002/query) — adjust in code if your tier differs.
        Fallback calls share the FR24 quota, so they don't add to the bill.
      </div>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   API PROBE PANEL  (admin → API Probe tab)
   Lets admins type in a flight + date and see the raw API response.
   Useful for debugging "why is this sector wrong?" questions from users.
═══════════════════════════════════════════════════════════════════ */
function ApiProbePanel() {
  const [provider, setProvider] = useState("aeroapi");
  const [flight,   setFlight]   = useState("6E");
  const [dep,      setDep]      = useState("");
  const [arr,      setArr]      = useState("");
  // Default date = yesterday (most useful for "what happened on this flight?")
  const yesterday = (() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const [date,     setDate]     = useState(yesterday);
  const [loading,  setLoading]  = useState(false);
  const [err,      setErr]      = useState("");
  const [result,   setResult]   = useState(null);
  const [showRaw,  setShowRaw]  = useState(false);

  const PROVIDER_LABEL = {
    aeroapi: "FlightAware AeroAPI",
    fr24:    "Flightradar24",
    adb:     "AeroDataBox",
  };
  const PROVIDER_ENDPOINT = {
    aeroapi: "/api/aeroapi",
    fr24:    "/api/fr24",
    adb:     "/api/aerodatabox",
  };

  const run = async () => {
    setErr(""); setResult(null);
    if (!flight || !dep || !arr || !date) {
      setErr("All fields are required."); return;
    }
    setLoading(true);
    try {
      const url = `${PROVIDER_ENDPOINT[provider]}?flight=${encodeURIComponent(flight.trim())}`
                + `&dep=${encodeURIComponent(dep.trim().toUpperCase())}`
                + `&arr=${encodeURIComponent(arr.trim().toUpperCase())}`
                + `&date=${encodeURIComponent(date)}&debug=1`;
      const resp = await fetch(url);
      const text = await resp.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { _rawText: text }; }
      setResult({ status: resp.status, ok: resp.ok, json });
    } catch (e) { setErr(e?.message || String(e)); }
    setLoading(false);
  };

  // Pull a parsed summary from the proxy's normalised response when present.
  // (When debug=1, the proxy returns BOTH the raw upstream payload and the
  // parsed fields in some cases — but FA/FR24 only return raw, so we re-parse
  // by reading the `flights[]` / `data[]` array.)
  const summary = (() => {
    if (!result?.json || result.json.error) return null;
    if (result.json._debug) {
      // FA shape: raw.flights[]   FR24 shape: raw.data[]
      const raw = result.json.raw;
      const arr = Array.isArray(raw?.flights) ? raw.flights
                : Array.isArray(raw?.data)    ? raw.data
                : [];
      return { count: arr.length, first: arr[0] || null };
    }
    // Direct (non-debug) response — already normalised
    return { normalised: result.json };
  })();

  const fmt = (v) => v == null ? "—" : String(v);

  return (
    <Card>
      <div style={{ fontSize:13, fontWeight:700, color:C.navy, marginBottom:8 }}>API Probe</div>
      <div style={{ fontSize:12, color:C.textMid, marginBottom:14, lineHeight:1.6 }}>
        Pull the raw response for a single flight from any provider. Useful for debugging
        user reports (&quot;why was my Deadhead off?&quot;) or sanity-checking a sector before
        switching providers. Counts toward your API usage budget.
      </div>

      {/* Provider selector */}
      <div style={{ display:"flex", gap:6, marginBottom:14 }}>
        {Object.entries(PROVIDER_LABEL).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setProvider(id)}
            style={{
              flex:1, padding:"8px 10px", borderRadius:8, fontFamily:"inherit", fontSize:12, fontWeight:700,
              cursor:"pointer", transition:"all 0.15s",
              background: provider === id ? C.blue : C.white,
              color:      provider === id ? C.white : C.textMid,
              border: "1.5px solid " + (provider === id ? C.blue : C.border),
            }}>{label}</button>
        ))}
      </div>

      {/* Form */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:14 }}>
        <FInput label="Flight" value={flight} onChange={setFlight} placeholder="e.g. 6E2448" />
        <FInput label="Date" type="date" value={date} onChange={setDate} />
        <FInput label="From (IATA)" value={dep} onChange={v => setDep(v.toUpperCase().slice(0,3))} placeholder="DEL" />
        <FInput label="To (IATA)"   value={arr} onChange={v => setArr(v.toUpperCase().slice(0,3))} placeholder="BOM" />
      </div>

      <Btn onClick={run} disabled={loading} icon={loading?"⟳":"🔍"} full={false}>
        {loading ? "Querying..." : "Run probe"}
      </Btn>

      {err && (
        <div style={{ marginTop:14, padding:"10px 14px", background:C.redBg, border:"1px solid #fca5a5", borderRadius:8, color:C.red, fontSize:12 }}>
          {err}
        </div>
      )}

      {/* Result */}
      {result && (
        <div style={{ marginTop:18 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
            <Badge color={result.ok ? "green" : "red"}>HTTP {result.status}</Badge>
            <span style={{ fontSize:12, color:C.textMid }}>{PROVIDER_LABEL[provider]}</span>
          </div>

          {/* Error case */}
          {!result.ok && (
            <div style={{ padding:"12px 14px", background:C.redBg, border:"1px solid #fca5a5", borderRadius:10, color:C.red, fontSize:12, lineHeight:1.6, marginBottom:14 }}>
              <div style={{ fontWeight:700, marginBottom:4 }}>{result.json?.error || "Request failed"}</div>
              {result.json?.detail && <div style={{ fontSize:11, opacity:0.85 }}>{result.json.detail}</div>}
            </div>
          )}

          {/* Parsed summary */}
          {summary && (
            <Card color="blue" style={{ marginBottom:14 }}>
              <div style={{ fontSize:12, fontWeight:700, color:C.navy, marginBottom:8 }}>
                {summary.count != null
                  ? `${summary.count} matching leg${summary.count === 1 ? "" : "s"} returned`
                  : "Normalised response"}
              </div>
              {summary.first && (() => {
                // Render an ISO datetime as both UTC and IST (UTC+5:30).
                // Returns the original value for non-datetime fields.
                const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
                const renderTime = (v) => {
                  if (!v || typeof v !== "string" || !ISO_RE.test(v)) return fmt(v);
                  const d = new Date(v);
                  if (isNaN(d)) return fmt(v);
                  const fmtUtc = (d) => d.toISOString().replace("T", " ").slice(0, 16) + "Z";
                  const fmtIst = (d) => {
                    const ist = new Date(d.getTime() + (5 * 60 + 30) * 60 * 1000);
                    return ist.toISOString().replace("T", " ").slice(0, 16) + " IST";
                  };
                  return (
                    <span>
                      <span>{fmtUtc(d)}</span>
                      <span style={{ color:C.textLo, marginLeft:10 }}>·</span>
                      <span style={{ color:C.blue, marginLeft:10 }}>{fmtIst(d)}</span>
                    </span>
                  );
                };
                return (
                  <div style={{ display:"grid", gridTemplateColumns:"140px 1fr", rowGap:4, fontSize:12, color:C.text, fontFamily:"'Courier New', monospace" }}>
                    {[
                      ["Flight",         summary.first.flight ?? summary.first.ident],
                      ["Operator",       summary.first.operator ?? summary.first.operating_as],
                      ["Registration",   summary.first.registration ?? summary.first.reg],
                      ["Aircraft type",  summary.first.aircraft_type ?? summary.first.type],
                      ["Origin",         (summary.first.origin?.code_iata) ?? summary.first.orig_iata],
                      ["Destination",    (summary.first.destination?.code_iata) ?? summary.first.dest_iata],
                      ["Scheduled out",  summary.first.scheduled_out],
                      ["Estimated out",  summary.first.estimated_out],
                      ["Actual out",     summary.first.actual_out ?? summary.first.datetime_takeoff],
                      ["Scheduled in",   summary.first.scheduled_in],
                      ["Estimated in",   summary.first.estimated_in],
                      ["Actual in",      summary.first.actual_in ?? summary.first.datetime_landed],
                      ["Cancelled",      summary.first.cancelled],
                      ["Diverted",       summary.first.diverted],
                    ].filter(([,v]) => v !== undefined && v !== null && v !== "").flatMap(([k,v]) => [
                      <div key={k+"-l"} style={{ color:C.textLo }}>{k}</div>,
                      <div key={k+"-v"} style={{ color:C.navy }}>{renderTime(v)}</div>
                    ])}
                  </div>
                );
              })()}
              {summary.normalised && (
                <pre style={{ fontSize:11, color:C.text, fontFamily:"'Courier New', monospace", margin:0, whiteSpace:"pre-wrap" }}>
                  {JSON.stringify(summary.normalised, null, 2)}
                </pre>
              )}
            </Card>
          )}

          {/* Raw JSON toggle */}
          <button type="button" onClick={() => setShowRaw(!showRaw)}
            style={{ background:"none", border:"1px solid "+C.border, borderRadius:8,
              padding:"6px 12px", fontSize:11, color:C.textMid, cursor:"pointer", fontFamily:"inherit" }}>
            {showRaw ? "Hide" : "Show"} raw JSON
          </button>
          {showRaw && (
            <pre style={{ marginTop:10, padding:"12px 14px", background:C.sky, borderRadius:10,
              border:"1px solid "+C.border, fontSize:11, color:C.text,
              fontFamily:"'Courier New', monospace", overflowX:"auto", maxHeight:400, overflowY:"auto",
              whiteSpace:"pre-wrap", wordBreak:"break-word" }}>
              {JSON.stringify(result.json, null, 2)}
            </pre>
          )}
        </div>
      )}
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ADMIN SCREEN
═══════════════════════════════════════════════════════════════════ */
function AdminScreen({ rates }) {
  const [tab,   setTab]   = useState("users");
  const [users, setUsers] = useState([]);
  const [userQuery, setUserQuery] = useState("");
  const [svMonth,    setSvMonth]    = useState("");
  const [svFile,     setSvFile]     = useState(null);
  const [svUploading,setSvUploading]= useState(false);
  const [svMsg,      setSvMsg]      = useState("");
  const [svHistory,  setSvHistory]  = useState([]);
  const [source,        setSource]        = useState("aeroapi");
  const [sourceSaving,  setSourceSaving]  = useState(false);
  const [sourceMsg,     setSourceMsg]     = useState("");
  // Phase 2: FR24 fallback for missing FA reg (default ON; toggle in Data Source tab).
  const [fallbackOn,     setFallbackOn]     = useState(true);
  const [fallbackSaving, setFallbackSaving] = useState(false);
  const [fallbackMsg,    setFallbackMsg]    = useState("");
  // Maintenance toggle state
  const [maintEnabled, setMaintEnabled] = useState(false);
  const [maintMessage, setMaintMessage] = useState("");
  const [maintSaving,  setMaintSaving]  = useState(false);
  const [maintMsg,     setMaintMsg]     = useState("");
  const svFileRef = useRef();

  const tabs = [
    { id:"users",  label:"Users" },
    { id:"usage",  label:"Usage" },
    { id:"sv",     label:"Sector Values" },
    { id:"source", label:"Data Source" },
    { id:"probe",  label:"API Probe" },
    { id:"maint",  label:"Maintenance" },
    { id:"rates",  label:"Current Rates" },
  ];

  useEffect(() => {
    if (!supabase) return;
    if (tab === "users") {
      supabase.from("profiles").select("*").order("created_at").then(({ data }) => { if (data) setUsers(data); });
    }
    if (tab === "sv") {
      supabase.from("sector_values").select("month,uploaded_at,row_count").order("uploaded_at", { ascending: false }).limit(10)
        .then(({ data }) => { if (data) setSvHistory(data); });
    }
    if (tab === "source") {
      supabase.from("app_settings").select("value").eq("key", "schedule_source").maybeSingle()
        .then(({ data }) => {
          const v = (data?.value || "adb").toLowerCase();
          setSource(["fr24","aeroapi","adb"].includes(v) ? v : "adb");
        });
      // Phase 2 toggle (defaults ON if no row exists yet).
      supabase.from("app_settings").select("value").eq("key", "fr24_fallback_enabled").maybeSingle()
        .then(({ data }) => {
          if (!data?.value) { setFallbackOn(true); return; }
          const v = String(data.value).toLowerCase();
          setFallbackOn(v !== "false" && v !== "0");
        });
    }
    if (tab === "maint") {
      supabase.from("app_settings").select("value").eq("key", "maintenance_mode").maybeSingle()
        .then(({ data }) => {
          if (!data?.value) { setMaintEnabled(false); setMaintMessage(""); return; }
          try {
            const parsed = JSON.parse(data.value);
            setMaintEnabled(!!parsed.enabled);
            setMaintMessage(String(parsed.message || ""));
          } catch {
            setMaintEnabled(data.value === "true");
            setMaintMessage("");
          }
        });
    }
  }, [tab]);

  const saveSource = async (next) => {
    if (!supabase) { setSourceMsg("Supabase not configured."); return; }
    setSourceSaving(true); setSourceMsg("");
    try {
      const { error } = await supabase.from("app_settings").upsert({
        key: "schedule_source", value: next, updated_at: new Date().toISOString(),
      }, { onConflict: "key" });
      if (error) throw error;
      setSource(next);
      setSourceMsg(`✓ Saved — new calculations will use ${next === "fr24" ? "FR24" : next === "aeroapi" ? "FlightAware" : "AeroDataBox"}. Existing cached rows are unchanged.`);
    } catch (e) {
      setSourceMsg("Error: " + (e?.message || String(e)));
    }
    setSourceSaving(false);
  };

  const saveFallback = async (next) => {
    if (!supabase) { setFallbackMsg("Supabase not configured."); return; }
    setFallbackSaving(true); setFallbackMsg("");
    try {
      const { error } = await supabase.from("app_settings").upsert({
        key: "fr24_fallback_enabled", value: next ? "true" : "false",
        updated_at: new Date().toISOString(),
      }, { onConflict: "key" });
      if (error) throw error;
      setFallbackOn(next);
      setFallbackMsg(next
        ? "✓ Fallback ON — when FlightAware returns no aircraft reg, FR24 will be queried to fill it. (Cost: zero — FR24 is flat $90/mo.)"
        : "✓ Fallback OFF — only the primary provider will be used. Missing regs will stay null."
      );
    } catch (e) {
      setFallbackMsg("Error: " + (e?.message || String(e)));
    }
    setFallbackSaving(false);
  };

  const saveMaintenance = async (enabled, message) => {
    if (!supabase) { setMaintMsg("Supabase not configured."); return; }
    setMaintSaving(true); setMaintMsg("");
    try {
      const value = JSON.stringify({ enabled: !!enabled, message: String(message || "") });
      const { error } = await supabase.from("app_settings").upsert({
        key: "maintenance_mode", value, updated_at: new Date().toISOString(),
      }, { onConflict: "key" });
      if (error) throw error;
      setMaintMsg(enabled
        ? "✓ Maintenance mode is now ON. Non-admin users will see the maintenance screen within 60 seconds."
        : "✓ Maintenance mode is OFF. The site is back to normal.");
    } catch (e) {
      setMaintMsg("Error: " + (e?.message || String(e)));
    }
    setMaintSaving(false);
  };

  const toggleUser = async (id, currentState) => {
    if (!supabase) return;
    await supabase.from("profiles").update({ is_active: !currentState }).eq("id", id);
    setUsers(prev => prev.map(u => u.id === id ? { ...u, is_active: !currentState } : u));
  };

  const uploadSV = async () => {
    if (!svFile || !svMonth) { setSvMsg("Select a file and enter the month (YYYY-MM)."); return; }
    setSvUploading(true); setSvMsg("");
    try {
      const { read, utils } = await import("xlsx");
      const buf = await svFile.arrayBuffer();
      const wb = read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = utils.sheet_to_json(ws);
      if (!rows.length) throw new Error("Excel file appears empty.");
      // Normalise column names
      const normRows = rows.map(r => {
        const out = {};
        for (const [k, v] of Object.entries(r)) {
          const key = k.trim().replace(/\s+/g,"_");
          out[key] = v;
        }
        return out;
      });
      if (!supabase) throw new Error("Supabase not configured.");
      await supabase.from("sector_values").upsert({
        month: svMonth,
        data: normRows,
        row_count: normRows.length,
        uploaded_at: new Date().toISOString(),
      }, { onConflict: "month" });
      setSvMsg(`✓ Uploaded ${normRows.length} rows for ${svMonth}.`);
      setSvFile(null);
      // Refresh history
      const { data } = await supabase.from("sector_values").select("month,uploaded_at,row_count").order("uploaded_at", { ascending: false }).limit(10);
      if (data) setSvHistory(data);
    } catch (e) {
      setSvMsg("Error: " + (e?.message || String(e)));
    }
    setSvUploading(false);
  };

  return (
    <div style={{ padding:"16px 16px 90px", maxWidth:680, margin:"0 auto" }}>
      <div style={{ background:"linear-gradient(120deg,"+C.navy+","+C.blue+")", borderRadius:18,
        padding:"20px", marginBottom:20, boxShadow:"0 4px 20px rgba(26,111,212,0.22)" }}>
        <div style={{ fontSize:11, color:"rgba(255,255,255,0.6)", letterSpacing:"0.12em", textTransform:"uppercase", marginBottom:4 }}>Admin Panel</div>
        <div style={{ fontSize:22, fontWeight:900, color:C.white }}>System Management</div>
      </div>

      <div style={{ display:"flex", gap:4, background:C.blueXLight, borderRadius:12, padding:4, marginBottom:20, border:"1.5px solid "+C.border }}>
        {tabs.map(({ id, label }) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ flex:1, padding:"9px 6px", borderRadius:9, fontFamily:"inherit", fontSize:12, fontWeight:700,
              cursor:"pointer", border:"none", transition:"all 0.15s",
              background:tab===id ? C.white : "transparent", color:tab===id ? C.blue : C.textMid,
              boxShadow:tab===id ? C.shadow : "none" }}>
            {label}
          </button>
        ))}
      </div>

      {tab === "users" && (() => {
        // ── Stats summary (always over the full user set, not filtered) ──
        const total      = users.length;
        const active     = users.filter(u => u.is_active || u.is_admin).length;
        const adminCount = users.filter(u => u.is_admin).length;
        const compCount  = users.filter(u => !u.is_admin && u.subscription_plan === "free").length;
        const paying     = users.filter(u => !u.is_admin && (u.subscription_plan === "1mo" || u.subscription_plan === "12mo")).length;
        const trialUsed  = users.filter(u => !u.is_admin && u.trial_paid_at && u.trial_used).length;
        const trialOpen  = users.filter(u => !u.is_admin && u.trial_paid_at && !u.trial_used).length;

        // ── Filter by search query (name / email / emp_id, case-insensitive) ──
        const q = userQuery.trim().toLowerCase();
        const filtered = q
          ? users.filter(u =>
              (u.name || "").toLowerCase().includes(q) ||
              (u.email || "").toLowerCase().includes(q) ||
              String(u.emp_id || "").toLowerCase().includes(q)
            )
          : users;

        return (
        <div>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
            <div style={{ fontSize:15, fontWeight:700, color:C.navy }}>Registered Users</div>
            <Badge color="green">{active} active</Badge>
          </div>

          {/* Stats summary */}
          <div style={{ background:C.blueXLight, border:"1px solid "+C.border, borderRadius:10, padding:"10px 12px", marginBottom:12, fontSize:12, color:C.textMid, display:"flex", flexWrap:"wrap", gap:"4px 14px" }}>
            <span><strong style={{ color:C.navy }}>{total}</strong> total</span>
            <span style={{ color:C.borderMid }}>·</span>
            <span><strong style={{ color:C.green }}>{paying}</strong> paying</span>
            <span style={{ color:C.borderMid }}>·</span>
            <span><strong style={{ color:C.gold }}>{compCount}</strong> comp</span>
            <span style={{ color:C.borderMid }}>·</span>
            <span><strong style={{ color:C.blue }}>{trialOpen}</strong> trial open</span>
            <span style={{ color:C.borderMid }}>·</span>
            <span><strong style={{ color:C.red }}>{trialUsed}</strong> trial used</span>
            <span style={{ color:C.borderMid }}>·</span>
            <span><strong style={{ color:C.navy }}>{adminCount}</strong> admin</span>
          </div>

          {/* Search box */}
          <div style={{ marginBottom:14, position:"relative" }}>
            <input value={userQuery} onChange={e => setUserQuery(e.target.value)}
              placeholder="Search by name, email, or employee ID..."
              style={{ width:"100%", boxSizing:"border-box", background:C.white, border:"1.5px solid "+C.border,
                borderRadius:10, padding:"10px 14px 10px 36px", color:C.text, fontFamily:"inherit", fontSize:13, outline:"none" }} />
            <span style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", fontSize:14, color:C.textLo, pointerEvents:"none" }}>🔍</span>
            {userQuery && (
              <button type="button" onClick={() => setUserQuery("")}
                style={{ position:"absolute", right:8, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", color:C.textLo, fontSize:16, cursor:"pointer", padding:"4px 8px" }}>×</button>
            )}
          </div>
          {q && (
            <div style={{ fontSize:11, color:C.textLo, marginBottom:10 }}>
              Showing {filtered.length} of {total} {filtered.length === 1 ? "match" : "matches"}
            </div>
          )}

          {users.length === 0 && <div style={{ textAlign:"center", padding:40, color:C.textLo }}>No users yet, or database not connected.</div>}
          {users.length > 0 && filtered.length === 0 && <div style={{ textAlign:"center", padding:30, color:C.textLo, fontSize:13 }}>No users match "{q}"</div>}
          {(filtered).map(u => {
            const effectivelyActive = u.is_active || u.is_admin;
            // Plan label + badge colour
            let planLabel, planColor;
            if (u.is_admin) { planLabel = null; planColor = null; }
            else if (u.subscription_plan === "free") { planLabel = "Comp · Free"; planColor = "gold"; }
            else if (u.subscription_plan === "12mo") { planLabel = "Annual · ₹1000/yr"; planColor = "green"; }
            else if (u.subscription_plan === "1mo")  { planLabel = "Monthly · ₹100/mo"; planColor = "green"; }
            else if (u.trial_paid_at && !u.trial_used) { planLabel = "Trial · unused"; planColor = "blue"; }
            else if (u.trial_paid_at && u.trial_used)  { planLabel = "Trial · used"; planColor = "red"; }
            else { planLabel = "No plan"; planColor = "red"; }
            return (
            <Card key={u.id} style={{ marginBottom:10, display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, flexWrap:"wrap" }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:14, fontWeight:700, color:C.navy, marginBottom:2 }}>{u.name}</div>
                <div style={{ fontSize:12, color:C.textMid }}>{u.email || "—"}</div>
                <div style={{ fontSize:11, color:C.textLo, marginTop:2 }}>ID: {u.emp_id} · {u.rank} · Base: {u.home_base}</div>
                {planLabel && <div style={{ marginTop:6 }}><Badge color={planColor}>{planLabel}</Badge></div>}
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
                {u.subscription_status === "pending_approval" && !u.is_active
                  ? <Badge color="gold">Pending approval (comp)</Badge>
                  : <Badge color={effectivelyActive ? "green" : "red"}>{effectivelyActive ? "Active" : "Inactive"}</Badge>
                }
                {!u.is_admin && (
                  <Btn onClick={() => toggleUser(u.id, u.is_active)} variant={u.is_active?"danger":"ghost"} small full={false}>
                    {u.is_active ? "Deactivate" : "Activate"}
                  </Btn>
                )}
                {u.is_admin && <Badge color="blue">Admin</Badge>}
              </div>
            </Card>
            );
          })}
        </div>
        );
      })()}

      {tab === "sv" && (
        <div>
          <Card color="blue" style={{ marginBottom:16 }}>
            <div style={{ fontSize:13, fontWeight:700, color:C.navy, marginBottom:8 }}>Upload Sector Values (Excel)</div>
            <div style={{ fontSize:12, color:C.textMid, marginBottom:14, lineHeight:1.6 }}>
              Upload the SV Excel file once per month (~22nd). All users share this data.
              Expected columns: <code style={{ background:C.sky, padding:"1px 5px", borderRadius:4 }}>FLTNBR, DEP, ARR, Time_Slot, SectorValue</code>
            </div>
            <FInput label="Month (YYYY-MM)" value={svMonth} onChange={setSvMonth} placeholder="e.g. 2026-01" hint="The month these sector values apply to" />
            <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:14 }}>
              <input ref={svFileRef} type="file" accept=".xlsx,.xls" style={{ display:"none" }}
                onChange={e => { if (e.target.files[0]) setSvFile(e.target.files[0]); }} />
              <button type="button" onClick={() => svFileRef.current?.click()}
                style={{ background:C.white, border:"1.5px solid "+C.borderMid, borderRadius:10,
                  padding:"10px 16px", fontSize:13, fontWeight:700, color:C.blue, cursor:"pointer", fontFamily:"inherit" }}>
                Choose Excel file
              </button>
              {svFile && <span style={{ fontSize:12, color:C.blue }}>✓ {svFile.name}</span>}
            </div>
            <Btn onClick={uploadSV} disabled={svUploading || !svFile || !svMonth} icon="⬆">
              {svUploading ? "Uploading..." : "Upload SV data →"}
            </Btn>
            {svMsg && (
              <div style={{ marginTop:10, padding:"10px 14px", borderRadius:8, fontSize:12,
                background: svMsg.startsWith("✓") ? C.greenBg : C.redBg,
                color: svMsg.startsWith("✓") ? C.green : C.red,
                border: "1px solid " + (svMsg.startsWith("✓") ? C.green : "#fca5a5") }}>
                {svMsg}
              </div>
            )}
          </Card>

          {svHistory.length > 0 && (
            <Card>
              <div style={{ fontSize:13, fontWeight:700, color:C.navy, marginBottom:10 }}>Upload History</div>
              {svHistory.map((h, i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                  padding:"10px 0", borderBottom:i<svHistory.length-1?"1px solid "+C.border:"none" }}>
                  <div>
                    <div style={{ fontSize:13, fontWeight:700, color:C.navy }}>{h.month}</div>
                    <div style={{ fontSize:11, color:C.textLo }}>{h.row_count} rows · {new Date(h.uploaded_at).toLocaleDateString("en-IN")}</div>
                  </div>
                  <Badge color="green">Uploaded</Badge>
                </div>
              ))}
            </Card>
          )}
        </div>
      )}

      {tab === "source" && (
        <div>
          <Card color="blue" style={{ marginBottom:16 }}>
            <div style={{ fontSize:13, fontWeight:700, color:C.navy, marginBottom:8 }}>Schedule Data Provider</div>
            <div style={{ fontSize:12, color:C.textMid, marginBottom:14, lineHeight:1.6 }}>
              Choose which external API supplies scheduled/actual flight times and aircraft registrations. This setting applies globally to every crew member using the app. Cached rows are never overwritten — switching sources only affects <em>new</em> lookups.
            </div>

            {[
              { id:"adb",     title:"AeroDataBox",     note:"Cheapest. Quality has been inconsistent for IndiGo (wrong STA on some sectors); kept as a fallback." },
              { id:"fr24",    title:"Flightradar24",   note:"Excellent actuals + aircraft regs. NO scheduled times — derived from actuals. Best for tail-swap detection." },
              { id:"aeroapi", title:"FlightAware",     note:"Best of both: scheduled AND actual gate times AND aircraft reg. History to 2011. Pay-per-query (~$0.002/call)." },
            ].map(opt => (
              <label key={opt.id}
                style={{ display:"block", cursor:"pointer", marginBottom:10,
                  border:"1.5px solid "+(source === opt.id ? C.blue : C.border),
                  borderRadius:12, padding:"12px 14px",
                  background: source === opt.id ? C.blueLight : C.white,
                  transition:"all 0.15s" }}>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <input type="radio" name="scheduleSource" value={opt.id}
                    checked={source === opt.id} onChange={() => setSource(opt.id)}
                    style={{ accentColor: C.blue, transform:"scale(1.15)" }} />
                  <div style={{ fontSize:14, fontWeight:700, color:C.navy }}>{opt.title}</div>
                </div>
                <div style={{ fontSize:12, color:C.textMid, marginTop:4, marginLeft:26, lineHeight:1.55 }}>{opt.note}</div>
              </label>
            ))}

            <div style={{ display:"flex", alignItems:"center", gap:10, marginTop:6 }}>
              <Btn onClick={() => saveSource(source)} disabled={sourceSaving} icon="💾" full={false}>
                {sourceSaving ? "Saving..." : "Save selection"}
              </Btn>
              <div style={{ fontSize:11, color:C.textLo }}>Current: <strong>{source === "fr24" ? "FR24" : source === "aeroapi" ? "FlightAware" : "AeroDataBox"}</strong></div>
            </div>

            {sourceMsg && (
              <div style={{ marginTop:12, padding:"10px 14px", borderRadius:8, fontSize:12,
                background: sourceMsg.startsWith("✓") ? C.greenBg : C.redBg,
                color: sourceMsg.startsWith("✓") ? C.green : C.red,
                border: "1px solid " + (sourceMsg.startsWith("✓") ? C.green : "#fca5a5") }}>
                {sourceMsg}
              </div>
            )}
          </Card>

          {/* ── Phase 2: FR24 fallback toggle ───────────────────────────── */}
          <Card color="blue" style={{ marginBottom:16 }}>
            <div style={{ fontSize:13, fontWeight:700, color:C.navy, marginBottom:8 }}>
              FR24 fallback for missing aircraft reg
            </div>
            <div style={{ fontSize:12, color:C.textMid, marginBottom:14, lineHeight:1.6 }}>
              FlightAware sometimes returns <code style={{ background:C.sky, padding:"1px 5px", borderRadius:4 }}>null</code> for aircraft registration on certain IndiGo flights (e.g. 6E2230 DEL-KNU on 1 Jan, 6E2052 DEL-HYD on 11 Jan). When this happens, the calculator can make a secondary call to FR24 — which has carried valid regs for the same flights — and merge the reg into the cached row. Only fires when the primary provider is <strong>FlightAware</strong>.
              <br /><br />
              <strong>Cost: zero.</strong> FR24 Essential is flat $90/month, so fallback calls don't add to the bill. Disable this once FlightAware fixes their data so your usage panel goes back to a single provider.
              <br /><br />
              <em>Cache caveat:</em> the fallback only fires on fresh primary calls, never on cache hits. Rows already cached with a null reg (from before this feature existed) will stay null-reg unless you delete them from <code style={{ background:C.sky, padding:"1px 5px", borderRadius:4 }}>flight_schedule_cache</code>.
            </div>

            <div style={{ display:"flex", alignItems:"center", gap:14, padding:"12px 14px",
              background: fallbackOn ? C.greenBg : C.blueXLight, borderRadius:10,
              border: "1.5px solid " + (fallbackOn ? C.green : C.border) }}>
              <div style={{ fontSize:22 }}>{fallbackOn ? "🛟" : "○"}</div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:13, fontWeight:800, color: fallbackOn ? C.green : C.textMid }}>
                  Fallback is {fallbackOn ? "ON" : "OFF"}
                </div>
                <div style={{ fontSize:11, color:C.textMid, marginTop:2 }}>
                  {fallbackOn
                    ? "Missing FA regs will be filled from FR24 automatically."
                    : "Missing FA regs will stay null — tail-swap detection may suffer."}
                </div>
              </div>
              <Btn onClick={() => saveFallback(!fallbackOn)} disabled={fallbackSaving}
                variant={fallbackOn ? "ghost" : "primary"} small full={false}>
                {fallbackSaving ? "Saving..." : (fallbackOn ? "Turn OFF" : "Turn ON")}
              </Btn>
            </div>

            {fallbackMsg && (
              <div style={{ marginTop:12, padding:"10px 14px", borderRadius:8, fontSize:12,
                background: fallbackMsg.startsWith("✓") ? C.greenBg : C.redBg,
                color: fallbackMsg.startsWith("✓") ? C.green : C.red,
                border: "1px solid " + (fallbackMsg.startsWith("✓") ? C.green : "#fca5a5") }}>
                {fallbackMsg}
              </div>
            )}

            {source !== "aeroapi" && fallbackOn && (
              <div style={{ marginTop:12, padding:"10px 14px", borderRadius:8, fontSize:12,
                background: C.goldBg, color: C.goldText, border:"1px solid "+C.goldBorder }}>
                Note: fallback only fires when the primary provider is <strong>FlightAware</strong>. Currently selected: <strong>{source === "fr24" ? "FR24" : "AeroDataBox"}</strong>, so the toggle has no effect right now.
              </div>
            )}
          </Card>

          <Card style={{ background:C.goldBg, border:"1.5px solid "+C.goldBorder, marginBottom:16 }}>
            <div style={{ fontSize:12, color:C.goldText, lineHeight:1.7 }}>
              <strong>Required env vars in Vercel</strong>:{" "}
              <code style={{ background:C.sky, padding:"1px 5px", borderRadius:4 }}>RAPIDAPI_KEY</code> for AeroDataBox,{" "}
              <code style={{ background:C.sky, padding:"1px 5px", borderRadius:4 }}>FR24_API_TOKEN</code> for FR24,{" "}
              <code style={{ background:C.sky, padding:"1px 5px", borderRadius:4 }}>AEROAPI_KEY</code> for FlightAware.
              <br /><br />
              Existing cached rows are never overwritten when you switch sources — only NEW lookups use the selected provider.
            </div>
          </Card>

          <ApiUsagePanel />
        </div>
      )}

      {tab === "usage" && (
        <UsageMetricsPanel />
      )}

      {tab === "probe" && (
        <div>
          <ApiProbePanel />
        </div>
      )}

      {tab === "maint" && (
        <div>
          <Card color={maintEnabled ? "gold" : "blue"} style={{ marginBottom:16 }}>
            <div style={{ fontSize:13, fontWeight:700, color:C.navy, marginBottom:8 }}>Maintenance Mode</div>
            <div style={{ fontSize:12, color:C.textMid, marginBottom:14, lineHeight:1.6 }}>
              When enabled, all non-admin users see a "Down for maintenance" screen instead of the app. Admins (you) can still log in and use the site normally.
              <br /><br />
              Use this when you're switching data providers, running migrations, or fixing something user-visible — anything where in-flight calculations would produce wrong results.
              <br /><br />
              Changes propagate within 60 seconds (the app polls the flag at that interval).
            </div>

            <div style={{ display:"flex", alignItems:"center", gap:14, marginBottom:14, padding:"12px 14px",
              background: maintEnabled ? C.redBg : C.greenBg, borderRadius:10,
              border: "1.5px solid " + (maintEnabled ? "#fca5a5" : C.green) }}>
              <div style={{ fontSize:24 }}>{maintEnabled ? "🔧" : "✓"}</div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:13, fontWeight:800, color: maintEnabled ? C.red : C.green }}>
                  {maintEnabled ? "Maintenance mode is ON" : "Site is live"}
                </div>
                <div style={{ fontSize:11, color:C.textMid, marginTop:2 }}>
                  {maintEnabled ? "Non-admin users are locked out." : "All users have normal access."}
                </div>
              </div>
              <Btn onClick={() => saveMaintenance(!maintEnabled, maintMessage)}
                disabled={maintSaving}
                variant={maintEnabled ? "ghost" : "danger"}
                small full={false}>
                {maintSaving ? "Saving..." : (maintEnabled ? "Turn OFF" : "Turn ON")}
              </Btn>
            </div>

            <label style={{ display:"block", fontSize:12, fontWeight:700, color:C.navy, marginBottom:6 }}>
              Custom message (optional)
            </label>
            <textarea value={maintMessage} onChange={e => setMaintMessage(e.target.value)}
              placeholder="Defaults to: 'Crew Allowance is temporarily down while we ship some improvements. Please check back in a little while — we won't be long.'"
              rows={3}
              style={{ width:"100%", boxSizing:"border-box", background:C.white, border:"1.5px solid "+C.border,
                borderRadius:10, padding:"10px 14px", color:C.text, fontFamily:"inherit", fontSize:13, outline:"none", resize:"vertical" }} />
            <div style={{ fontSize:11, color:C.textLo, marginTop:4, marginBottom:14 }}>
              Shown to non-admin users on the maintenance screen. Leave empty to use the default message.
            </div>

            <Btn onClick={() => saveMaintenance(maintEnabled, maintMessage)} disabled={maintSaving} icon="💾" full={false}>
              {maintSaving ? "Saving..." : "Save message"}
            </Btn>

            {maintMsg && (
              <div style={{ marginTop:12, padding:"10px 14px", borderRadius:8, fontSize:12,
                background: maintMsg.startsWith("✓") ? C.greenBg : C.redBg,
                color: maintMsg.startsWith("✓") ? C.green : C.red,
                border: "1px solid " + (maintMsg.startsWith("✓") ? C.green : "#fca5a5") }}>
                {maintMsg}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === "rates" && (
        <div>
          <Card color="blue" style={{ marginBottom:14 }}>
            <div style={{ fontSize:11, color:C.blue, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Source</div>
            <div style={{ fontSize:14, fontWeight:700, color:C.navy }}>{rates.source}</div>
            <div style={{ fontSize:12, color:C.textMid, marginTop:2 }}>Effective: {rates.lastUpdated}</div>
          </Card>
          {[["Deadhead (per sched block hr)", rates.deadhead],
            ["Night Flying (per hr)", rates.night],
            ["Tail Swap (per swap)", rates.tailSwap],
            ["Transit (per hr)", rates.transit]
          ].map(([lbl, obj]) => (
            <Card key={lbl} style={{ marginBottom:10 }}>
              <div style={{ fontSize:11, color:C.blue, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:10 }}>{lbl}</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                {["Captain","First Officer","Cabin Crew"].map(r => (
                  <div key={r} style={{ textAlign:"center", padding:"10px 6px", background:C.sky, borderRadius:10 }}>
                    <div style={{ fontSize:10, color:C.textMid, marginBottom:5, fontWeight:600 }}>{r}</div>
                    <div style={{ fontSize:16, fontWeight:900, color:obj[r] ? C.navy : C.textLo }}>
                      {obj[r] ? fmtINR(obj[r]) : <span style={{ fontSize:12 }}>N/A</span>}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
          <div style={{ padding:"12px 16px", background:C.goldBg, border:"1.5px solid "+C.goldBorder,
            borderRadius:12, fontSize:12, color:C.goldText, lineHeight:1.6, marginTop:8 }}>
            <strong>To update rates:</strong> edit DEFAULT_RATES in the app source when a new IndiGo circular is issued.
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ROOT APP
═══════════════════════════════════════════════════════════════════ */
export default function App() {
  const [screen,      setScreen]      = useState("loading");
  const [user,        setUser]        = useState(null);
  const [tab,         setTab]         = useState("calc");
  const [rates]                       = useState(DEFAULT_RATES);
  const [pendingUser, setPendingUser] = useState(null);
  const [maintenance, setMaintenance] = useState({ enabled: false, message: "" });

  // Re-check maintenance flag on every navigation/auth change. Cheap call.
  useEffect(() => {
    fetchMaintenanceMode().then(setMaintenance);
    // Re-check every 60s in case admin flips it while a user is mid-session.
    const id = setInterval(() => fetchMaintenanceMode().then(setMaintenance), 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!supabase) { Promise.resolve().then(() => setScreen("landing")); return; }

    // Password-recovery links land with `#access_token=…&type=recovery` in the URL.
    // Supabase parses that into a real session, which means getSession() below
    // would happily load the user's profile and boot them into the app —
    // racing against the PASSWORD_RECOVERY event. Detect the recovery hash up
    // front and stay on the reset-password screen until the user sets a new
    // password (or signs out).
    // UPI / redirect-based payments return with ?payment_status=success.
    // Clean the URL and go to login so they can sign in with their new active account.
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("payment_status") === "success") {
      window.history.replaceState({}, "", window.location.pathname);
      Promise.resolve().then(() => setScreen("login"));
      return;
    }

    const isRecovery = typeof window !== "undefined"
      && typeof window.location?.hash === "string"
      && /[#&]type=recovery\b/.test(window.location.hash);

    if (isRecovery) {
      Promise.resolve().then(() => setScreen("reset-password"));
    } else {
      supabase.auth.getSession().then(async ({ data: { session } }) => {
        if (session) {
          const { data: profile } = await supabase.from("profiles").select("*").eq("id", session.user.id).single();
          if (profile && (profile.is_active || profile.is_admin)) {
            setUser({ ...profile, email: session.user.email });
            setTab(profile.is_admin ? "admin" : "calc");
            setScreen("app");
          } else {
            setScreen("login");
          }
        } else {
          setScreen("landing");
        }
      });
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === "PASSWORD_RECOVERY") { setScreen("reset-password"); return; }
      if (event === "SIGNED_OUT" || !session) { setUser(null); setScreen("landing"); }
    });
    return () => subscription.unsubscribe();
  }, []);

  const onLogin = u => {
    setUser(u);
    setTab(u.is_admin ? "admin" : "calc");
    setScreen("app");
  };
  const onLogout = async () => {
    if (supabase) await supabase.auth.signOut();
    setUser(null); setScreen("landing");
  };
  const onActivate   = u => setPendingUser(u);
  const goCheckout   = u => { setPendingUser(u); setScreen("checkout"); };
  const onProfileSave = u => { setUser(u); setTab("calc"); };
  const onTrialUsed  = () => setUser(u => u ? { ...u, trial_used: true } : u);
  // After upgrading from trial → subscription, refresh the user from the DB
  // so subscription_status / plan are picked up before we go back to the calc.
  const onTrialReset = async () => {
    if (supabase && user?.id) {
      const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
      if (profile) setUser({ ...profile, email: user.email });
    }
    setTab("calc");
  };

  const nav = [
    { id:"calc",    icon:"🧮", label:"Calculator" },
    { id:"profile", icon:"👤", label:"Profile"    },
    ...(user?.is_admin ? [{ id:"admin", icon:"⚙", label:"Admin" }] : []),
  ];

  if (screen === "loading") return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center",
      background:"linear-gradient(160deg,"+C.skyMid+","+C.sky+")", fontFamily:"'Nunito','Segoe UI',sans-serif" }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ width:54, height:54, borderRadius:16, background:"linear-gradient(135deg,"+C.blue+","+C.navy+")",
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, margin:"0 auto 16px",
          boxShadow:"0 6px 20px rgba(26,111,212,0.3)" }}>✈</div>
        <div style={{ fontSize:14, color:C.textMid }}>Loading...</div>
      </div>
    </div>
  );

  // Maintenance mode: lock everyone out except admins. Admins can still log
  // in (so they can flip the flag back off); the login screen is reachable
  // to allow that. Already-logged-in admins continue normally.
  if (maintenance.enabled && !user?.is_admin && screen !== "login" && screen !== "reset-password") {
    return <MaintenanceScreen message={maintenance.message} onAdminLogin={() => setScreen("login")} />;
  }

  if (screen === "landing")        return <LandingPage goLogin={() => setScreen("login")} goSignup={() => setScreen("signup")} />;
  if (screen === "login")          return <LoginScreen onLogin={onLogin} goSignup={() => setScreen("signup")} goForgot={() => setScreen("forgot")} goLanding={() => setScreen("landing")} />;
  if (screen === "signup")         return <SignupScreen goLogin={() => setScreen("login")} goLanding={() => setScreen("landing")} goCheckout={goCheckout} goForgot={() => setScreen("forgot")} />;
  if (screen === "checkout")       return <CheckoutScreen pendingUser={pendingUser} goLogin={() => setScreen("login")} onActivate={onActivate} />;
  if (screen === "forgot")         return <ForgotScreen goLogin={() => setScreen("login")} />;
  if (screen === "reset-password") return <ResetPasswordScreen goLogin={() => setScreen("login")} />;

  return (
    <div style={{ minHeight:"100vh", background:C.sky, fontFamily:"'Nunito','Segoe UI',sans-serif", color:C.text }}>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap" rel="stylesheet" />

      <div style={{ background:C.white, borderBottom:"1px solid "+C.border, padding:"12px 16px",
        display:"flex", alignItems:"center", justifyContent:"space-between",
        position:"sticky", top:0, zIndex:20, boxShadow:"0 1px 8px rgba(26,111,212,0.07)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:36, height:36, borderRadius:11, background:"linear-gradient(135deg,"+C.blue+","+C.navy+")",
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, boxShadow:"0 2px 8px rgba(26,111,212,0.28)" }}>✈</div>
          <div>
            <div style={{ fontSize:16, fontWeight:900, color:C.navy, letterSpacing:"-0.02em", lineHeight:1 }}>{APP_NAME}</div>
            <div style={{ fontSize:9, color:C.blue, letterSpacing:"0.1em", textTransform:"uppercase", opacity:0.75 }}>{CONFIG.airline}</div>
          </div>
        </div>
        <button type="button" onClick={onLogout} style={{ background:C.blueXLight, border:"1px solid "+C.border,
          borderRadius:9, color:C.textMid, fontSize:12, padding:"7px 14px", cursor:"pointer", fontWeight:700 }}>
          Sign out
        </button>
      </div>

      <div style={{ animation:"fadeUp 0.25s ease" }}>
        {tab === "calc"    && <CalcScreen    user={user} rates={rates} onNeedProfile={() => setTab("profile")} onTrialUsed={onTrialUsed} onUpgrade={() => setTab("upgrade")} />}
        {tab === "upgrade" && <UpgradeScreen user={user} onActivated={onTrialReset} goBack={() => setTab("calc")} />}
        {tab === "profile" && <ProfileScreen user={user} onSave={onProfileSave} />}
        {tab === "admin"   && <AdminScreen   rates={rates} />}
      </div>

      <div style={{ position:"fixed", bottom:0, left:0, right:0, background:C.white,
        borderTop:"1px solid "+C.border, display:"flex", zIndex:20,
        boxShadow:"0 -2px 16px rgba(26,111,212,0.08)",
        paddingBottom:"env(safe-area-inset-bottom,0px)" }}>
        {nav.map(({ id, icon, label }) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ flex:1, padding:"10px 8px 12px", background:"transparent", border:"none",
              color:tab===id ? C.blue : C.textLo, cursor:"pointer", transition:"all 0.15s",
              borderTop:"2.5px solid "+(tab===id ? C.blue : "transparent") }}>
            <div style={{ fontSize:22, marginBottom:2 }}>{icon}</div>
            <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.04em", textTransform:"uppercase" }}>{label}</div>
          </button>
        ))}
        <div style={{ flex:1, padding:"10px 8px 12px", display:"flex", flexDirection:"column",
          alignItems:"center", justifyContent:"center", borderTop:"2.5px solid transparent" }}>
          <div style={{ width:28, height:28, borderRadius:"50%",
            background:"linear-gradient(135deg,"+C.blue+","+C.navy+")",
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:11, fontWeight:900, color:C.white, marginBottom:2 }}>
            {user?.name?.split(" ").map(w => w[0]).slice(0, 2).join("")}
          </div>
          <div style={{ fontSize:9, fontWeight:700, color:C.textLo, letterSpacing:"0.04em", textTransform:"uppercase" }}>
            {user?.rank === "First Officer" || user?.rank === "Senior First Officer" ? "F/O"
              : user?.rank === "Captain" || user?.rank === "Senior Captain" ? "Capt"
              : user?.is_admin ? "Admin" : user?.rank?.split(" ")[0]}
          </div>
        </div>
      </div>
    </div>
  );
}
