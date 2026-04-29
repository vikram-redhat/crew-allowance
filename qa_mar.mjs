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
const pages = await pdfToItems(`${REPO}/assets/mar 26.pdf`);
const parsed = parsePcsrItems(pages);
console.log("Mar parsed:", JSON.stringify({format:parsed.format, month:parsed.month, pilot:parsed.pilot, sectors:parsed.sectors.length, hotels:parsed.hotels.length}, null, 2));
console.log("Sectors:");
for (const s of parsed.sectors) console.log(`  ${s.date} ${s.flight_no} ${s.dep}→${s.arr} atd=${s.atd_local||"-"} ata=${s.ata_local||"-"} dhf=${s.is_dhf} dht=${s.is_dht}`);
console.log("Hotels:", parsed.hotels);
