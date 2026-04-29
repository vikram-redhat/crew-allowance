import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "fs";
import { pathToFileURL } from "url";
const REPO = "/sessions/trusting-vigilant-hamilton/mnt/crewallowance";
const { parsePcsrItems } = await import(pathToFileURL(`${REPO}/crew-allowance/src/pdf/pcsrParser.js`).href);
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
const s46 = parsed.sectors.find(s => s.flight_no === "6E6846");
const s45 = parsed.sectors.find(s => s.flight_no === "6E6845");
console.log("6E6845:", s45);
console.log("6E6846:", s46);

// inEarlyMorning logic from CrewAllowance.jsx
const inEarlyMorning = (hhmm) => {
  const m = hhmm?.match(/^(\d{2}):(\d{2})$/);
  if (!m) return false;
  const mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return mins >= 0 && mins <= 360;
};
console.log("\nFor 6E6846, atd_local =", s46.atd_local);
console.log("inEarlyMorning(atd_local) =", inEarlyMorning(s46.atd_local));
console.log("⇒ Phase 3 trigger condition (PCSR ATD early-AM AND API ATD not early-AM):");
console.log("   PCSR ATD =", s46.atd_local || "null", "(early-AM =", inEarlyMorning(s46.atd_local), ")");
console.log("   API would return atd_local for 2026-01-07 = '00:11' (early-AM = true)");
console.log("   So Phase 3 trigger requires API atd NOT early-AM, but it IS early-AM → Phase 3 will NOT fire.");
