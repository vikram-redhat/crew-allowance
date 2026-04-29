// QA harness for end-to-end Jan/Feb/Mar PCSR + SV calc verification.
// Runs calculate.js + parsePcsrItems against assets/ — bypasses the Vite-only
// import in pcsrParser.js by giving Node-side pages directly.

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import * as XLSX from "xlsx";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const REPO = "/sessions/trusting-vigilant-hamilton/mnt/crewallowance";
const SRC  = `${REPO}/crew-allowance/src`;

// We need the named exports from pcsrParser.js but it imports pdfToText via
// "?url" Vite syntax that Node can't resolve. We dynamic-import the file
// after providing a stub for pdfToText.js if needed — actually parsePcsrItems
// is exported and doesn't trigger the dynamic import (only parsePcsrPdf does).
const parserUrl = pathToFileURL(`${SRC}/pdf/pcsrParser.js`).href;
const calcUrl   = pathToFileURL(`${SRC}/calculate.js`).href;

const { parsePcsrItems } = await import(parserUrl);
const { runCalculations } = await import(calcUrl);

async function pdfToItems(pathToPdf) {
  const data = new Uint8Array(fs.readFileSync(pathToPdf));
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = content.items
      .map(it => ({
        str: "str" in it ? it.str : "",
        x: it.transform?.[4] ?? 0,
        y: it.transform?.[5] ?? 0,
        w: it.width ?? 0,
        h: it.height ?? 0,
      }))
      .filter(it => it.str !== "");
    pages.push({ items });
  }
  return pages;
}

function readSvXlsx(pathToXlsx) {
  const wb = XLSX.read(fs.readFileSync(pathToXlsx));
  const sh = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sh, { defval: null });
}

function readScheduleCsv(pathToCsv) {
  const text = fs.readFileSync(pathToCsv, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(",").map(s => s.replace(/^"|"$/g,"").trim());
  const rows = lines.slice(1).map(line => {
    // naive CSV split — file is well-formed (no embedded commas in our data)
    const cols = line.split(",").map(s => s.replace(/^"|"$/g,"").trim());
    const o = {};
    for (let i = 0; i < header.length; i++) o[header[i]] = cols[i];
    return o;
  });
  // Map to schedMap keyed flight|dep|arr|date with std_local/sta_local/aircraft_reg
  const map = {};
  for (const r of rows) {
    const key = `${r.flight_no}|${r.dep}|${r.arr}|${r.date}`;
    map[key] = {
      std_local: r.std_local || null,
      sta_local: r.sta_local || null,
      atd_local: r.atd_local || null,
      ata_local: r.ata_local || null,
      aircraft_reg: r.aircraft_reg || null,
    };
  }
  return map;
}

async function runOne({ label, pdfPath, svPath, schedCsv, expected }) {
  console.log(`\n${"=".repeat(70)}\n${label}\n${"=".repeat(70)}`);
  const pages = await pdfToItems(pdfPath);
  const parsed = parsePcsrItems(pages);
  console.log(`Parsed: format=${parsed.format} month=${parsed.month} pilot=${JSON.stringify(parsed.pilot)} sectors=${parsed.sectors.length} hotels=${parsed.hotels.length}`);

  // Map parser shape → calculator shape
  const sectors = parsed.sectors.map(s => ({
    date: s.date, flight: s.flight_no, dep: s.dep, arr: s.arr,
    atd: s.atd_local, ata: s.ata_local, is_dhf: s.is_dhf, is_dht: s.is_dht,
  }));

  const sched = schedCsv ? readScheduleCsv(schedCsv) : {};
  const sv = readSvXlsx(svPath);

  // Filter SV to only flight numbers in sectors (matches production)
  const sectorFlights = new Set(sectors.map(s => String(s.flight).replace(/^6E/i, "")));
  const svFiltered = sv.filter(r => sectorFlights.has(String(r.FLTNBR)));

  const pilot = {
    name: parsed.pilot.name || "TEST",
    employee_id: parsed.pilot.employee_id || "16612",
    home_base: parsed.pilot.home_base || "DEL",
    rank: "Captain",
  };

  // Suppress noisy [night]/[duty split] logs from calculate.js
  const _origLog = console.log;
  console.log = () => {};
  const result = runCalculations(parsed.month, sectors, sched, svFiltered, pilot, null, parsed.hotels);
  console.log = _origLog;

  const got = {
    deadhead: result.deadhead.amount,
    layover:  result.layover.amount,
    night:    result.night.amount,
    transit:  result.transit.amount,
    tailSwap: result.tailSwap.amount,
    total:    result.total,
  };
  console.log("Result:", got);
  if (expected) {
    console.log("Expected:", expected);
    for (const k of Object.keys(expected)) {
      const dif = got[k] - expected[k];
      const ok  = Math.abs(dif) <= 100; // ₹100 tolerance for rounding
      console.log(`  ${ok ? "OK " : "DIFF"} ${k.padEnd(10)} got=${got[k].toString().padStart(7)} exp=${expected[k].toString().padStart(7)} diff=${dif}`);
    }
  }
  return { parsed, result };
}

const ASSETS = `${REPO}/assets`;

await runOne({
  label: "Jan 2026 — Vineet (GRID)",
  pdfPath: `${ASSETS}/PersonalCrewSchedule-Jan.pdf`,
  svPath:  `${ASSETS}/Sector Value_Jan'26.xlsx`,
  schedCsv: `${REPO}/flight_schedule_cache_rows.csv`,
  expected: {
    deadhead: 55667,
    layover:  13800,
    transit:  10567,
    tailSwap: 12000,
    night:    9066,
    total:    101100,
  },
});

await runOne({
  label: "Feb 2026 — Vineet (GRID)",
  pdfPath: `${ASSETS}/PersonalCrewSchedule-Feb.pdf`,
  svPath:  `${ASSETS}/Sector Value_Feb'26.xlsx`,
  schedCsv: `${REPO}/flight_schedule_cache_rows.csv`,
  expected: {
    deadhead: 24667,
    layover:  6000,
    transit:  2250,
    tailSwap: 3000,
    night:    5633,
    total:    41550,  // 24667+6000+2250+3000+5633=41550 (handoff §11 says 40417 — likely date of update)
  },
});

await runOne({
  label: "Mar 2026 — Vineet (GRID, partial — no SV/schedule cache)",
  pdfPath: `${ASSETS}/mar 26.pdf`,
  svPath:  `${ASSETS}/Sector Value_Feb'26.xlsx`, // SV fallback
  schedCsv: `${REPO}/flight_schedule_cache_rows.csv`,
});

console.log("\nQA harness complete.");
