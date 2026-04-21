// Simulate production exactly: use ALL parsed Feb PCSR sectors (no month filter)
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

const PILOT = { name:"GOYAL, VINEET", emp_id:"16612", employee_id:"16612", home_base:"DEL", rank:"Captain" };

// silence parser logs
const origLog = console.log;
console.log = (...args) => {
  const f = args[0];
  if (typeof f === "string" && (
    f.startsWith("[gridRow") || f.startsWith("[parseGrid]") ||
    f.startsWith("[night]") || f.startsWith("[tailSwap]") || f.startsWith("[duty split]")
  )) return;
  origLog(...args);
};

const buf = await readFile(path.join(ASSETS, "PersonalCrewSchedule-Feb.pdf"));
const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
const pages = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const c = await page.getTextContent();
  pages.push({ items: c.items.map(it => ({
    str: "str" in it ? it.str : "", x: it.transform?.[4]||0, y: it.transform?.[5]||0,
    w: it.width||0, h: it.height||0,
  })).filter(it => it.str !== "")});
}
const parsed = parsePcsrItems(pages);

// Adapt — production does NOT filter by month
const sectors = parsed.sectors.map(s => ({
  date: s.date, flight: s.flight_no, dep: s.dep, arr: s.arr,
  atd: s.atd_local, ata: s.ata_local, is_dhf: s.is_dhf, is_dht: s.is_dht,
}));
sectors.sort((a, b) => {
  if (a.date < b.date) return -1; if (a.date > b.date) return 1;
  const ta = a.atd ?? "23:59"; const tb = b.atd ?? "23:59";
  return ta < tb ? -1 : ta > tb ? 1 : 0;
});

console.error("Total parsed sectors:", sectors.length);
console.error("Date range:", sectors[0]?.date, "→", sectors.at(-1)?.date);
console.error("\nAll sectors:");
for (const s of sectors) {
  console.error(`  ${s.date} ${s.flight} ${s.dep}→${s.arr} atd=${s.atd} ${s.is_dhf?"DHF":""}`);
}

// Load cache
function parseCsv(t) {
  const lines = t.trim().split(/\r?\n/);
  const h = lines.shift().split(",");
  return lines.map(l => { const p = l.split(","); const r = {}; h.forEach((k,i) => r[k]=p[i]); return r; });
}
const cacheRows = parseCsv(await readFile(path.join(WORKSPACE, "flight_schedule_cache_rows.csv"), "utf8"));
const scheduledTimes = {};
for (const r of cacheRows) {
  scheduledTimes[`${r.flight_no}|${r.dep}|${r.arr}|${r.date}`] = {
    std_local:r.std_local||null, sta_local:r.sta_local||null,
    atd_local:r.atd_local||null, ata_local:r.ata_local||null,
    aircraft_reg:r.aircraft_reg||null,
  };
}

// SV
const svBuf = await readFile(path.join(ASSETS, "Sector Value_Feb'26.xlsx"));
const wb = XLSX.read(svBuf, { type: "buffer" });
const svData = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });

// Production-style filter
const sectorFlights = new Set(sectors.map(s => String(s.flight).replace(/^6E/i, "")));
const svFiltered = svData.filter(r => sectorFlights.has(String(r.FLTNBR)));

// Run with NO month filter (production behavior)
const res = runCalculations("February 2026", sectors, scheduledTimes, svFiltered, PILOT, null, parsed.hotels || []);

console.error("\n========= PRODUCTION SIMULATION (no month filter) =========");
console.error("Deadhead ₹", res.deadhead.amount);
console.error("Layover  ₹", res.layover.amount, "—", res.layover.events.length, "events");
for (const e of res.layover.events) console.error("  ", e.station, e.date_in, "→", e.date_out, e.duration_hrs+"h", "₹"+e.total);
console.error("Transit  ₹", res.transit.amount);
console.error("Tail Swap ₹", res.tailSwap.amount, "—", res.tailSwap.swaps.length, "total");
for (const s of res.tailSwap.swaps) console.error(`  ${s.unverifiable?"?":"✓"} ${s.date} ${s.sector_pair} @ ${s.station}  ${s.reg_out}→${s.reg_in}  ${s.amount===null?"unverifiable":"₹"+s.amount}`);
console.error("Night    ₹", res.night.amount, "—", res.night.sectors.length, "sectors");
for (const s of res.night.sectors) console.error("  ", s.date, s.flight, s.from+"→"+s.to, "STD="+s.std_ist, "night="+s.night_mins+"m", "₹"+s.amount);
