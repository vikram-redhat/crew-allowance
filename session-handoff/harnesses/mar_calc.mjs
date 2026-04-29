import { readFile } from "node:fs/promises";
import path from "node:path";
const APP = "/sessions/determined-adoring-fermat/mnt/crewallowance/crew-allowance";
const ASSETS = "/sessions/determined-adoring-fermat/mnt/crewallowance/assets";
const WORKSPACE = "/sessions/determined-adoring-fermat/mnt/crewallowance";
const { getDocument } = await import(path.join(APP, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
const { parsePcsrItems } = await import(path.join(APP, "src/pdf/pcsrParser.js"));
const { runCalculations } = await import(path.join(APP, "src/calculate.js"));
const xlsxMod = await import(path.join(APP, "node_modules/xlsx/xlsx.mjs"));
const XLSX = xlsxMod.default ?? xlsxMod;

// silence parser logs
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

function parseCsv(t) {
  const lines = t.trim().split(/\r?\n/);
  const h = lines.shift().split(",");
  return lines.map(l => { const p = l.split(","); const r = {}; h.forEach((k,i) => r[k]=p[i]); return r; });
}
// Try multiple cache file names
let cacheText = null;
for (const name of ["flight_schedule_cache_rows.csv", "flight_schedule_cache_rows (2).csv"]) {
  try {
    cacheText = await readFile(path.join(WORKSPACE, name), "utf8");
    console.error(`>> using cache: ${name}`);
    break;
  } catch {}
}
const cacheRows = cacheText ? parseCsv(cacheText) : [];
const scheduledTimes = {};
for (const r of cacheRows) {
  scheduledTimes[`${r.flight_no}|${r.dep}|${r.arr}|${r.date}`] = {
    std_local:r.std_local||null, sta_local:r.sta_local||null,
    atd_local:r.atd_local||null, ata_local:r.ata_local||null,
    aircraft_reg:r.aircraft_reg||null,
  };
}

const buf = await readFile(path.join(ASSETS, "mar 26.pdf"));
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

const PILOT = {
  name: parsed.pilot.name, emp_id: parsed.pilot.employee_id,
  employee_id: parsed.pilot.employee_id, home_base: parsed.pilot.home_base,
  rank: "Captain",
};

const sectors = parsed.sectors.map(s => ({
  date: s.date, flight: s.flight_no, dep: s.dep, arr: s.arr,
  atd: s.atd_local, ata: s.ata_local, is_dhf: s.is_dhf, is_dht: s.is_dht,
}));
sectors.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

// Use Feb SV as fallback (rates similar between months)
const svBuf = await readFile(path.join(ASSETS, "Sector Value_Feb'26.xlsx"));
const wb = XLSX.read(svBuf, { type: "buffer" });
const svData = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
const sectorFlights = new Set(sectors.map(s => String(s.flight).replace(/^6E/i, "")));
const svFiltered = svData.filter(r => sectorFlights.has(String(r.FLTNBR)));
console.error(`>> SV rows matched: ${svFiltered.length} / ${sectors.length} sectors (using Feb SV)`);

console.error("\n===== VINEET-MARCH (GRID) =====");
console.error(`Pilot:    ${PILOT.name} (${PILOT.emp_id}) ${PILOT.home_base}`);
console.error(`Format:   ${parsed.format}`);
console.error(`Month:    ${parsed.month}`);
console.error(`Sectors:  ${sectors.length}`);
console.error(`Hotels:   ${(parsed.hotels||[]).length}`);

const res = runCalculations("March 2026", sectors, scheduledTimes, svFiltered, PILOT, null, parsed.hotels || []);
console.error(`\nDeadhead ₹${res.deadhead.amount}  (${res.deadhead.sectors?.length || 0} DH sectors)`);
console.error(`Layover  ₹${res.layover.amount}  (${res.layover.events.length} events)`);
for (const e of res.layover.events) {
  console.error(`  ${e.station} ${e.date_in}→${e.date_out}  ${e.duration_hrs}h  ₹${e.total}`);
}
console.error(`Transit  ₹${res.transit.amount}`);
console.error(`TailSwap ₹${res.tailSwap.amount}`);
console.error(`Night    ₹${res.night.amount}  (${res.night.sectors.length} sectors)`);
console.error(`\nTOTAL    ₹${
  res.deadhead.amount + res.layover.amount + res.transit.amount +
  res.tailSwap.amount + res.night.amount
}`);
