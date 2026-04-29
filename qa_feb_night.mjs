// Drill into Feb night-flying calculation.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import * as XLSX from "xlsx";
import fs from "fs";
import { pathToFileURL } from "url";

const REPO = "/sessions/trusting-vigilant-hamilton/mnt/crewallowance";
const SRC  = `${REPO}/crew-allowance/src`;

const { parsePcsrItems } = await import(pathToFileURL(`${SRC}/pdf/pcsrParser.js`).href);
const { runCalculations } = await import(pathToFileURL(`${SRC}/calculate.js`).href);

async function pdfToItems(p) {
  const data = new Uint8Array(fs.readFileSync(p));
  const doc = await pdfjs.getDocument({ data }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const c = await pg.getTextContent();
    out.push({ items: c.items.map(it => ({
      str: it.str ?? "", x: it.transform?.[4] ?? 0, y: it.transform?.[5] ?? 0,
      w: it.width ?? 0, h: it.height ?? 0,
    })).filter(it => it.str !== "") });
  }
  return out;
}

const pages = await pdfToItems(`${REPO}/assets/PersonalCrewSchedule-Feb.pdf`);
const parsed = parsePcsrItems(pages);
const sectors = parsed.sectors.map(s => ({
  date: s.date, flight: s.flight_no, dep: s.dep, arr: s.arr,
  atd: s.atd_local, ata: s.ata_local, is_dhf: s.is_dhf, is_dht: s.is_dht,
}));

// Read SV
const sv = XLSX.utils.sheet_to_json(
  XLSX.read(fs.readFileSync(`${REPO}/assets/Sector Value_Feb'26.xlsx`)).Sheets["Sheet1"]
  ?? XLSX.read(fs.readFileSync(`${REPO}/assets/Sector Value_Feb'26.xlsx`)).Sheets[
       Object.keys(XLSX.read(fs.readFileSync(`${REPO}/assets/Sector Value_Feb'26.xlsx`)).Sheets)[0]
     ],
  { defval: null }
);
console.log("SV row 0:", sv[0]);

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
console.log("Schedule cache: rows =", Object.keys(sched).length);
const febKeys = Object.keys(sched).filter(k => k.includes("|2026-02-"));
console.log("Feb sched cache keys:", febKeys.length);
console.log(febKeys.slice(0,10));

// Eligible night candidates (non-DHF, non-DHT)
const cands = sectors.filter(s => !s.is_dhf && !s.is_dht);
console.log("\nNon-DHF/DHT Feb sectors:", cands.length);
for (const s of cands) {
  const k = `${s.flight}|${s.dep}|${s.arr}|${s.date}`;
  const sc = sched[k];
  const std = sc?.std_local;
  let info = `  ${s.date} ${s.flight} ${s.dep}→${s.arr} std=${std || "MISS"}`;
  if (std) {
    const [h,m] = std.split(":").map(Number);
    const stdM = h*60+m;
    if (stdM <= 360 || stdM >= 23*60) info += "  ★ NIGHT-WINDOW";
  }
  console.log(info);
}

// Find SV for the missing case (DEL→PNQ 26 Feb 04:40 → 80 night mins ₹2,667)
console.log("\nSV lookup for DEL→PNQ 6E2471, slot 23_24:");
const sv2471 = sv.filter(r => parseInt(String(r.FLTNBR),10) === 2471 && String(r.DEP).trim() === "DEL" && String(r.ARR).trim() === "PNQ");
console.log(sv2471);
