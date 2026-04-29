// Regression harness: run parser on BOTH Jan (grid) and Feb (grid) PCSRs.
// Confirms EOM rewrite did not regress the grid path.
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

async function parsePcsrFile(pdfPath) {
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
  return parsePcsrItems(pages);
}

async function runCase(label, pdfPath, svXlsx, month) {
  const parsed = await parsePcsrFile(pdfPath);
  const sectors = parsed.sectors.map(s => ({
    date: s.date, flight: s.flight_no, dep: s.dep, arr: s.arr,
    atd: s.atd_local, ata: s.ata_local, is_dhf: s.is_dhf, is_dht: s.is_dht,
  }));
  sectors.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const svBuf = await readFile(svXlsx);
  const wb = XLSX.read(svBuf, { type: "buffer" });
  const svData = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  const sectorFlights = new Set(sectors.map(s => String(s.flight).replace(/^6E/i, "")));
  const svFiltered = svData.filter(r => sectorFlights.has(String(r.FLTNBR)));

  const res = runCalculations(month, sectors, scheduledTimes, svFiltered, PILOT, null, parsed.hotels || []);
  console.error(`\n===== ${label} (${parsed.format}) =====`);
  console.error(`Sectors: ${sectors.length}  Hotels: ${(parsed.hotels||[]).length}`);
  console.error(`Deadhead ₹${res.deadhead.amount}`);
  console.error(`Layover  ₹${res.layover.amount} (${res.layover.events.length})`);
  console.error(`Transit  ₹${res.transit.amount}`);
  console.error(`TailSwap ₹${res.tailSwap.amount}`);
  console.error(`Night    ₹${res.night.amount}`);
  console.error(`TOTAL    ₹${
    res.deadhead.amount + res.layover.amount + res.transit.amount +
    res.tailSwap.amount + res.night.amount
  }`);
  return { parsed, res };
}

await runCase("JAN grid", path.join(ASSETS, "PersonalCrewSchedule-Jan.pdf"),
  path.join(ASSETS, "Sector Value_Jan'26.xlsx"), "January 2026");
await runCase("FEB grid", path.join(ASSETS, "PersonalCrewSchedule-Feb.pdf"),
  path.join(ASSETS, "Sector Value_Feb'26.xlsx"), "February 2026");
