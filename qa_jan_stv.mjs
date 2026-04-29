// Verify the STV Jan 7 phantom tail-swap (between 6E6845 and 6E6846).
// In Jan PCSR with cleared cache and Phase 3 active, this swap should disappear.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import * as XLSX from "xlsx";
import fs from "fs";
import { pathToFileURL } from "url";
const REPO = "/sessions/trusting-vigilant-hamilton/mnt/crewallowance";
const { parsePcsrItems } = await import(pathToFileURL(`${REPO}/crew-allowance/src/pdf/pcsrParser.js`).href);
const { runCalculations } = await import(pathToFileURL(`${REPO}/crew-allowance/src/calculate.js`).href);

async function pdfToItems(p) {
  const data = new Uint8Array(fs.readFileSync(p));
  const doc = await pdfjs.getDocument({ data }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const c = await pg.getTextContent();
    out.push({ items: c.items.map(it => ({ str: it.str ?? "", x: it.transform?.[4] ?? 0, y: it.transform?.[5] ?? 0, w: it.width ?? 0, h: it.height ?? 0 })).filter(it => it.str !== "") });
  }
  return out;
}
const pages = await pdfToItems(`${REPO}/assets/PersonalCrewSchedule-Jan.pdf`);
const parsed = parsePcsrItems(pages);
const stvSects = parsed.sectors.filter(s => s.dep === "STV" || s.arr === "STV");
console.log("STV sectors in Jan PCSR:");
for (const s of stvSects) console.log(`  ${s.date} ${s.flight_no} ${s.dep}→${s.arr} atd=${s.atd_local} ata=${s.ata_local} dhf=${s.is_dhf}`);

// Check 6E6845 / 6E6846
const s45 = parsed.sectors.find(s => s.flight_no === "6E6845");
const s46 = parsed.sectors.find(s => s.flight_no === "6E6846");
console.log("\n6E6845:", s45);
console.log("6E6846:", s46);

// Read schedule cache
const schedText = fs.readFileSync(`${REPO}/flight_schedule_cache_rows.csv`, "utf8");
const schedLines = schedText.split(/\r?\n/).filter(Boolean);
const sH = schedLines[0].split(",").map(s=>s.replace(/^"|"$/g,"").trim());
const sched = {};
for (const ln of schedLines.slice(1)) {
  const cols = ln.split(",").map(s=>s.replace(/^"|"$/g,"").trim());
  const o = {}; sH.forEach((h,i) => o[h]=cols[i]);
  sched[`${o.flight_no}|${o.dep}|${o.arr}|${o.date}`] = {
    std_local: o.std_local || null, sta_local: o.sta_local || null,
    atd_local: o.atd_local || null, ata_local: o.ata_local || null,
    aircraft_reg: o.aircraft_reg || null,
  };
}
console.log("\nSchedule cache for STV pair:");
console.log("  6E6845:", sched[`6E6845|DEL|STV|2026-01-06`], sched[`6E6845|DEL|STV|2026-01-07`]);
console.log("  6E6846:", sched[`6E6846|STV|DEL|2026-01-06`], sched[`6E6846|STV|DEL|2026-01-07`]);

// Run calc and look at tail-swap result
const sectors = parsed.sectors.map(s => ({
  date: s.date, flight: s.flight_no, dep: s.dep, arr: s.arr,
  atd: s.atd_local, ata: s.ata_local, is_dhf: s.is_dhf, is_dht: s.is_dht,
}));
const sv = XLSX.utils.sheet_to_json(XLSX.read(fs.readFileSync(`${REPO}/assets/Sector Value_Jan'26.xlsx`)).Sheets[Object.keys(XLSX.read(fs.readFileSync(`${REPO}/assets/Sector Value_Jan'26.xlsx`)).Sheets)[0]], { defval: null });
const _origLog = console.log; console.log = () => {};
const res = runCalculations(parsed.month, sectors, sched, sv, { name: "Vineet", employee_id: "16612", home_base: "DEL", rank: "Captain" }, null, parsed.hotels);
console.log = _origLog;

console.log("\nAll tail-swap rows:");
for (const sw of res.tailSwap.swaps) console.log(`  ${sw.date} ${sw.sector_pair} ${sw.station} ${sw.reg_out}→${sw.reg_in} amt=${sw.amount} unverifiable=${!!sw.unverifiable} shifted=${!!sw.date_shifted}`);
console.log(`Total tail-swap: ₹${res.tailSwap.amount}`);
