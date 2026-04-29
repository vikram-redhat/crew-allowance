import { readFile } from "node:fs/promises";
import path from "node:path";
const APP = "/sessions/determined-adoring-fermat/mnt/crewallowance/crew-allowance";
const ASSETS = "/sessions/determined-adoring-fermat/mnt/crewallowance/assets";
const { getDocument } = await import(path.join(APP, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
const { parsePcsrItems } = await import(path.join(APP, "src/pdf/pcsrParser.js"));

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
console.error(`>> format = ${parsed.format}`);
console.error(`>> month = ${parsed.month}`);
console.error(`>> pilot = ${JSON.stringify(parsed.pilot)}`);
console.error(`>> sectors.length = ${parsed.sectors.length}`);
console.error(`>> hotels.length = ${(parsed.hotels||[]).length}`);
console.error(`>> first 3 sectors:`);
for (const s of parsed.sectors.slice(0, 3)) console.error(`   ${JSON.stringify(s)}`);
console.error(`>> all sectors (date/flight/dep-arr/atd-ata/dh):`);
for (const s of parsed.sectors) {
  const tag = s.is_dhf ? "DHF" : s.is_dht ? "DHT" : "   ";
  console.error(`   ${s.date}  ${(s.flight_no||"").padEnd(6)} ${s.dep}-${s.arr}  ${(s.atd_local||"-").padEnd(5)}-${(s.ata_local||"-").padEnd(5)} ${tag}`);
}
console.error(`>> hotels:`);
for (const h of (parsed.hotels||[])) console.error(`   ${JSON.stringify(h)}`);
