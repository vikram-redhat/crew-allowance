/**
 * Load verification/sample crew data from files in this folder (src/assets).
 * Picks PDFs/CSVs by filename pattern — no month is hardcoded in code; your files
 * can be named e.g. PilotLogBookReport-Jan.pdf or PilotLogBookReport-2026-01.pdf.
 */
const pdfModules = import.meta.glob("./*.pdf", { query: "?url", import: "default" });
const csvRaw = import.meta.glob("./*.csv", { query: "?raw", eager: true, import: "default" });

function norm(p) {
  return p.replace(/\\/g, "/");
}

function basename(p) {
  const n = norm(p).split("/").pop() || "";
  return n;
}

function pickSortedKeys(filter) {
  return Object.keys(pdfModules)
    .filter(filter)
    .sort((a, b) => basename(a).localeCompare(basename(b)));
}

function findPdfLoader(predicate) {
  const keys = pickSortedKeys(predicate);
  const key = keys[0];
  return key ? { key, load: pdfModules[key] } : null;
}

function pickLogCsvText() {
  const entries = Object.entries(csvRaw).filter(([path]) => {
    const b = basename(path).toLowerCase();
    if (/template/.test(b)) return false;
    if (/crewschedule|personalcrewschedule/.test(b)) return false;
    return /pilotlogbookreport|logbookreport/.test(b);
  });
  entries.sort((a, b) => basename(a[0]).localeCompare(basename(b[0])));
  const hit = entries[0];
  if (!hit) {
    throw new Error(
      "No logbook CSV in src/assets (expected a filename like PilotLogBookReport*.csv, excluding *Template*)."
    );
  }
  return { text: hit[1], source: basename(hit[0]) };
}

function pickScheduleCsvText() {
  const entries = Object.entries(csvRaw).filter(([path]) => {
    const b = basename(path).toLowerCase();
    if (/template/.test(b)) return false;
    if (/pilotlogbook|logbookreport/.test(b)) return false;
    return /^crewschedule/.test(b);
  });
  entries.sort((a, b) => basename(a[0]).localeCompare(basename(b[0])));
  const hit = entries[0];
  if (!hit) {
    throw new Error(
      "No schedule CSV in src/assets (expected a filename like CrewSchedule*.csv)."
    );
  }
  return { text: hit[1], source: basename(hit[0]) };
}

/**
 * Loads bundled files from src/assets for calculator verification.
 * @returns {{ logCSV: string, schedCSV: string, logSource: string, schedSource: string }}
 */
export async function loadBundledSampleFromAssets() {
  const { csvFromPdfBuffer } = await import("../pdf/indiGoPdfParsers.js");
  const out = {
    logCSV: "",
    schedCSV: "",
    logSource: "",
    schedSource: "",
  };

  const logPdf = findPdfLoader((k) => /pilotlogbookreport/i.test(basename(k)));
  const schedPdf = findPdfLoader((k) => {
    const b = basename(k);
    return (
      /personalcrewschedule|^crewschedule/i.test(b) && !/pilotlogbook/i.test(b)
    );
  });

  if (logPdf) {
    const url = await logPdf.load();
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    out.logCSV = await csvFromPdfBuffer(buf, "logbook");
    out.logSource = basename(logPdf.key);
  } else {
    const { text, source } = pickLogCsvText();
    out.logCSV = text;
    out.logSource = source;
  }

  const schedName = schedPdf ? basename(schedPdf.key) : "";
  const useScheduleCsv =
    !schedPdf || /personalcrewschedule/i.test(schedName);

  if (schedPdf && !useScheduleCsv) {
    const url = await schedPdf.load();
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    out.schedCSV = await csvFromPdfBuffer(buf, "schedule");
    out.schedSource = schedName;
  } else {
    const { text, source } = pickScheduleCsvText();
    out.schedCSV = text;
    out.schedSource = schedPdf
      ? `${source} (paired with ${schedName} — grid PDF not parsed)`
      : source;
  }

  return out;
}
