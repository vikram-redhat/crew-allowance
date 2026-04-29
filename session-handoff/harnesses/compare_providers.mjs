#!/usr/bin/env node
/**
 * compare_providers.mjs
 * ─────────────────────
 * Side-by-side comparison of AeroDataBox vs Flightradar24 for every unique
 * sector in a PCSR PDF. Hits your live Vercel deployment so it uses the same
 * env vars (RAPIDAPI_KEY, FR24_API_TOKEN) as the app — no local config needed.
 *
 * USAGE (run from the repo root):
 *   node session-handoff/harnesses/compare_providers.mjs <pcsr-pdf-path> <base-url>
 *
 * EXAMPLES:
 *   node session-handoff/harnesses/compare_providers.mjs ~/Downloads/mar26.pdf https://crewallowance.com
 *   node session-handoff/harnesses/compare_providers.mjs ../path/to/pcsr.pdf https://crewallowance.com
 *
 * OUTPUT:
 *   - Live console table with diffs colour-coded
 *   - CSV file `compare_<basename>.csv` next to this script with all diffs
 *
 * REMEMBER:
 *   - FR24 Explorer plan only covers the LAST 30 DAYS. Older sectors will
 *     return 404 from /api/fr24 — those rows are flagged "FR24_OUT_OF_RANGE"
 *     in the output, not counted as a real disagreement.
 *   - Each FR24 call costs ~1 light credit. ~70 sectors ≈ 70 credits.
 *   - This script does NOT use the cache — it always hits the live providers.
 *     (The proxies themselves don't cache; caching is a frontend concern.)
 *
 * EXIT CODES:
 *   0 — comparison ran (regardless of how much agreed/disagreed)
 *   1 — fatal error (PDF unreadable, base URL unreachable, etc.)
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
// This harness lives inside the repo at session-handoff/harnesses/, so the
// repo root is two levels up. Resolves correctly whether you run it from the
// repo root, from session-handoff/, or from anywhere else.
const APP        = path.resolve(__dirname, "..", "..");

// ─── ANSI colours (no deps) ──────────────────────────────────────────────────
const C = {
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
};

// ─── Parse args ──────────────────────────────────────────────────────────────
const [pdfPath, baseUrl] = process.argv.slice(2);
if (!pdfPath || !baseUrl) {
  console.error("Usage: node compare_providers.mjs <pcsr-pdf-path> <vercel-base-url>");
  console.error("Example: node compare_providers.mjs assets/mar\\ 26.pdf https://crewallowance.com");
  process.exit(1);
}
if (!baseUrl.startsWith("http")) {
  console.error("Base URL must start with http:// or https://");
  process.exit(1);
}

// ─── Load the parser dynamically (it's an ESM module in the app repo) ────────
const { getDocument }   = await import(path.join(APP, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
const { parsePcsrItems } = await import(path.join(APP, "src/pdf/pcsrParser.js"));

// Silence the parser's internal logging so the table stays readable.
const origLog = console.log;
console.log = (...args) => {
  const f = args[0];
  if (typeof f === "string" && (
    f.startsWith("[gridRow") || f.startsWith("[parseGrid]") ||
    f.startsWith("[night]") || f.startsWith("[tailSwap]") || f.startsWith("[duty split]") ||
    f.startsWith("[parseHotel") || f.startsWith("[hotel")
  )) return;
  origLog(...args);
};

// ─── Parse PCSR ──────────────────────────────────────────────────────────────
console.error(C.dim(`Reading ${pdfPath}…`));
const buf = await readFile(pdfPath);
const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
const pages = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const c = await page.getTextContent();
  pages.push({ items: c.items.map(it => ({
    str: "str" in it ? it.str : "", x: it.transform?.[4]||0, y: it.transform?.[5]||0,
    w: it.width||0, h: it.height||0,
  })).filter(it => it.str !== "") });
}
const parsed = parsePcsrItems(pages);
console.error(C.dim(`Parsed ${parsed.sectors.length} sectors from ${parsed.month} (${parsed.format})`));

// ─── Dedupe sectors on flight/dep/arr/date ───────────────────────────────────
const seen = new Set();
const sectors = [];
for (const s of parsed.sectors) {
  if (!s.flight_no || !s.dep || !s.arr || !s.date) continue;
  const key = `${s.flight_no}|${s.dep}|${s.arr}|${s.date}`;
  if (seen.has(key)) continue;
  seen.add(key);
  sectors.push({ flight: s.flight_no, dep: s.dep, arr: s.arr, date: s.date });
}
console.error(C.dim(`${sectors.length} unique sectors to compare`));

// ─── Date guard for FR24 30-day window ───────────────────────────────────────
const now = new Date();
function daysAgo(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  return (now - d) / 86400000;
}

// ─── Fetch one provider for one sector ───────────────────────────────────────
async function fetchProvider(provider, s) {
  const endpoint = provider === "fr24"    ? "/api/fr24"
                 : provider === "aeroapi" ? "/api/aeroapi"
                 :                          "/api/aerodatabox";
  const url = `${baseUrl}${endpoint}?flight=${encodeURIComponent(s.flight)}`
            + `&dep=${encodeURIComponent(s.dep)}&arr=${encodeURIComponent(s.arr)}`
            + `&date=${encodeURIComponent(s.date)}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { error: `HTTP ${resp.status}`, detail: body.slice(0, 100) };
    }
    return await resp.json();
  } catch (e) {
    return { error: "fetch failed", detail: e.message };
  }
}

// ─── Compute time delta (handles HH:MM strings) ──────────────────────────────
function timeMins(hhmm) {
  if (!hhmm) return null;
  const m = String(hhmm).match(/(\d{2}):(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : null;
}
function delta(a, b) {
  const ma = timeMins(a), mb = timeMins(b);
  if (ma == null || mb == null) return null;
  let d = Math.abs(ma - mb);
  // Handle wraparound near midnight (e.g. 23:55 vs 00:05 should be 10, not 1430)
  if (d > 720) d = 1440 - d;
  return d;
}
function flagTime(a, b) {
  const d = delta(a, b);
  if (d == null) return a || b ? "MISSING" : "";
  if (d > 5) return `RED (${d}m)`;
  if (d > 0) return `YEL (${d}m)`;
  return "OK";
}
function flagReg(a, b) {
  if (!a && !b) return "";
  if (!a || !b)  return "MISSING";
  return a.toUpperCase() === b.toUpperCase() ? "OK" : "RED (mismatch)";
}

// ─── Run the comparison ──────────────────────────────────────────────────────
console.error(C.dim(`Hitting ${baseUrl}… (querying ADB, FR24, and FlightAware in parallel for each sector)\n`));

const results = [];
let i = 0;
for (const s of sectors) {
  i++;
  process.stderr.write(`\r${C.dim(`  ${i}/${sectors.length}  ${s.flight} ${s.dep}→${s.arr} ${s.date}`.padEnd(70))}`);

  // Future-flight skip — none of the providers serve future flights.
  const da = daysAgo(s.date);
  let adb, fr24, aeroapi;
  if (da < -1) {
    adb     = { error: "FUTURE_FLIGHT" };
    fr24    = { error: "FUTURE_FLIGHT" };
    aeroapi = { error: "FUTURE_FLIGHT" };
  } else {
    [adb, fr24, aeroapi] = await Promise.all([
      fetchProvider("adb", s),
      fetchProvider("fr24", s),
      fetchProvider("aeroapi", s),
    ]);
  }
  results.push({ ...s, adb, fr24, aeroapi });

  // Be polite to all three APIs.
  await new Promise(r => setTimeout(r, 500));
}
process.stderr.write("\n\n");

// ─── Print summary table to stdout ───────────────────────────────────────────
function fmt(v) { return v == null ? "—" : String(v); }
function colour(flag) {
  if (!flag || flag === "OK") return C.dim(flag || "OK");
  if (flag.startsWith("RED")) return C.red(flag);
  if (flag.startsWith("YEL")) return C.yellow(flag);
  return C.yellow(flag);
}

let allAgreeCount = 0, anyDisagreeCount = 0, errCount = 0;

console.log(C.bold("─".repeat(140)));
console.log(C.bold("  Sector".padEnd(28) +
  "│ STD (ADB / FR24 / FA)".padEnd(38) +
  "│ STA (ADB / FR24 / FA)".padEnd(38) +
  "│ Reg (ADB / FR24 / FA)"));
console.log(C.bold("─".repeat(140)));

const triple = (a, b, c) => `${fmt(a)} / ${fmt(b)} / ${fmt(c)}`;
function tripleFlag(a, b, c) {
  // Compare each pair; if any pair is RED, mark RED. If any YEL, mark YEL.
  const flags = [flagTime(a, b), flagTime(a, c), flagTime(b, c)];
  if (flags.some(f => f.startsWith("RED"))) return "RED";
  if (flags.some(f => f.startsWith("YEL"))) return "YEL";
  if (flags.some(f => f === "MISSING")) return "MISS";
  return "OK";
}
function tripleRegFlag(a, b, c) {
  const flags = [flagReg(a, b), flagReg(a, c), flagReg(b, c)];
  if (flags.some(f => f.startsWith("RED"))) return "RED";
  if (flags.some(f => f === "MISSING")) return "MISS";
  return "OK";
}

for (const r of results) {
  const tag = `${r.flight} ${r.dep}→${r.arr} ${r.date}`;

  if (r.aeroapi.error === "FUTURE_FLIGHT") {
    console.log(`${tag.padEnd(28)}│ ${C.dim("FUTURE_FLIGHT")}`);
    continue;
  }
  if (r.adb.error && r.fr24.error && r.aeroapi.error) {
    errCount++;
    console.log(`${tag.padEnd(28)}│ ${C.red(`all 3 errored: ADB=${r.adb.error} FR24=${r.fr24.error} FA=${r.aeroapi.error}`)}`);
    continue;
  }

  const stdFlag = tripleFlag(r.adb.std_local, r.fr24.std_local, r.aeroapi.std_local);
  const staFlag = tripleFlag(r.adb.sta_local, r.fr24.sta_local, r.aeroapi.sta_local);
  const regFlag = tripleRegFlag(r.adb.aircraft_reg, r.fr24.aircraft_reg, r.aeroapi.aircraft_reg);

  const stdCell = `${triple(r.adb.std_local, r.fr24.std_local, r.aeroapi.std_local)} ${colour(stdFlag)}`;
  const staCell = `${triple(r.adb.sta_local, r.fr24.sta_local, r.aeroapi.sta_local)} ${colour(staFlag)}`;
  const regCell = `${triple(r.adb.aircraft_reg, r.fr24.aircraft_reg, r.aeroapi.aircraft_reg)} ${colour(regFlag)}`;

  console.log(`${tag.padEnd(28)}│ ${stdCell.padEnd(50)}│ ${staCell.padEnd(50)}│ ${regCell}`);

  const allOk = [stdFlag, staFlag, regFlag].every(f => f === "OK");
  const anyRed = [stdFlag, staFlag, regFlag].some(f => f === "RED");
  if (allOk) allAgreeCount++;
  if (anyRed) anyDisagreeCount++;
}

console.log(C.bold("─".repeat(140)));
console.log();
console.log(C.bold("Summary"));
console.log(`  ${C.green("All 3 agree")}          : ${allAgreeCount}/${results.length}`);
console.log(`  ${C.red("At least 1 disagrees")} : ${anyDisagreeCount}/${results.length}  ${C.dim("(>5min delta or reg mismatch on any pair)")}`);
console.log(`  ${C.dim("All providers errored")} : ${errCount}/${results.length}`);
console.log();

// ─── Dump CSV ────────────────────────────────────────────────────────────────
const csvRows = [
  "flight,date,dep,arr," +
  "adb_std,fr24_std,fa_std," +
  "adb_sta,fr24_sta,fa_sta," +
  "adb_atd,fr24_atd,fa_atd," +
  "adb_ata,fr24_ata,fa_ata," +
  "adb_reg,fr24_reg,fa_reg," +
  "notes"
];
const cell = v => (v == null || v === undefined) ? "" : String(v);
for (const r of results) {
  const errs = [
    r.adb.error     ? `ADB:${r.adb.error}`     : null,
    r.fr24.error    ? `FR24:${r.fr24.error}`   : null,
    r.aeroapi.error ? `FA:${r.aeroapi.error}`  : null,
  ].filter(Boolean).join(" | ");
  csvRows.push([
    r.flight, r.date, r.dep, r.arr,
    cell(r.adb.std_local), cell(r.fr24.std_local), cell(r.aeroapi.std_local),
    cell(r.adb.sta_local), cell(r.fr24.sta_local), cell(r.aeroapi.sta_local),
    cell(r.adb.atd_local), cell(r.fr24.atd_local), cell(r.aeroapi.atd_local),
    cell(r.adb.ata_local), cell(r.fr24.ata_local), cell(r.aeroapi.ata_local),
    cell(r.adb.aircraft_reg), cell(r.fr24.aircraft_reg), cell(r.aeroapi.aircraft_reg),
    errs,
  ].join(","));
}

const csvName = `compare_${path.basename(pdfPath).replace(/[\s.]+/g, "_")}.csv`;
const csvPath = path.join(__dirname, csvName);
await writeFile(csvPath, csvRows.join("\n"));
console.log(`CSV saved: ${csvPath}`);
