import { readFile } from "node:fs/promises";
const APP = "/sessions/determined-adoring-fermat/mnt/crewallowance/crew-allowance";
const { getDocument } = await import(APP + "/node_modules/pdfjs-dist/legacy/build/pdf.mjs");

const buf = await readFile("/sessions/determined-adoring-fermat/mnt/crewallowance/assets/Anshu-Jan-EOM-Schedule.pdf");
const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
const pages = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const content = await page.getTextContent();
  const items = content.items.map(it => ({
    str: it.str,
    x: it.transform[4],
    y: it.transform[5],
    w: it.width || 0,
    h: it.height || 0,
  })).filter(it => it.str.trim() !== "");
  pages.push({ items });
}

// Inline mimic of parseEomItems — print every row's assignment
const parseDate = (d) => {
  const m = d.trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (!m) return null;
  let [, dd, mm, yy] = m;
  let yr = parseInt(yy, 10);
  if (yr < 100) yr += 2000;
  return `${yr}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
};

for (const [pi, page] of pages.entries()) {
  const items = page.items;
  const anchors = [];
  for (const it of items) {
    if (it.x >= 50) continue;
    const m = String(it.str).match(/^\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
    if (!m) continue;
    const iso = parseDate(m[1]);
    if (iso) anchors.push({ y: it.y, date: iso });
  }
  if (!anchors.length) continue;

  console.log(`\n===== PAGE ${pi+1} ANCHORS =====`);
  for (const a of anchors) console.log(`  y=${a.y.toFixed(2)}  ${a.date}`);

  // Cluster into rows
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const rows = [];
  for (const it of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - it.y) <= 2) last.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }

  console.log(`\n===== PAGE ${pi+1} ROWS (sector attempts) =====`);
  for (const row of rows) {
    const pickIn = (xLo, xHi) => {
      let hit = null;
      for (const it of row.items) if (it.x >= xLo && it.x < xHi) if (!hit || it.x > hit.x) hit = it;
      return hit;
    };
    const dutyIt = pickIn(100, 180);
    const routeIt = pickIn(180, 380);
    const actualIt = pickIn(460, 620);
    if (!dutyIt || !routeIt) continue;
    const fm = String(dutyIt.str).trim().match(/^(?:6E\s*)?(\d{3,5})(?:\s*\[\d{3}\])?$/);
    if (!fm) continue;
    const rm = String(routeIt.str).trim().match(/^(\*?)\s*([A-Z]{3})\s*[-–]\s*([A-Z]{3})\s*$/);
    if (!rm) continue;

    // Nearest date by |Δy|
    let best = anchors[0], bestD = Math.abs(row.y - best.y);
    for (let i = 1; i < anchors.length; i++) {
      const d = Math.abs(row.y - anchors[i].y);
      if (d < bestD) { best = anchors[i]; bestD = d; }
    }
    console.log(`  y=${row.y.toFixed(2)}  6E${fm[1]}  ${rm[2]}-${rm[3]}  → ${best.date} (dist=${bestD.toFixed(1)})`);
  }
}
