/**
 * Parse text extracted from IndiGo / AIMS-style PDF exports into CSV strings
 * that match what runCalc() expects (same columns as the CSV templates).
 *
 * PDF layout varies by export; these patterns cover common text orderings.
 * If your PDF fails, paste a redacted text sample — patterns can be extended.
 */

function parseCSVLine(header, rows) {
  const lines = rows.map((r) =>
    Array.isArray(r) ? r.join(",") : header.map((h) => r[h] ?? "").join(",")
  );
  return [header.join(","), ...lines].join("\n");
}

const canonDateKey = (s) => {
  if (!s || typeof s !== "string") return "";
  const t = s.trim();
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return "";
  let [, d, mo, y] = m;
  let Y = parseInt(y, 10);
  if (Y < 100) Y += 2000;
  return `${Y}-${parseInt(mo, 10)}-${parseInt(d, 10)}`;
};

/** Fill empty Operated_As (e.g. AIMS PDF) from schedule Duty_Code DHF/DHT. */
export function enrichLogbookOperatedAsFromSchedule(logCSV, schedCSV) {
  if (!logCSV?.trim() || !schedCSV?.trim()) return logCSV;
  const parseCSV = (t) => {
    const l = t.trim().split(/\r?\n/);
    const h = l[0].split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
    return l.slice(1).filter((x) => x.trim()).map((r) => {
      const v = r.split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
      return Object.fromEntries(h.map((k, i) => [k, v[i] ?? ""]));
    });
  };
  const log = parseCSV(logCSV);
  const sched = parseCSV(schedCSV);
  if (!log.length) return logCSV;
  const header = Object.keys(log[0]);
  for (const row of log) {
    if ((row.Operated_As || "").trim()) continue;
    const dk = canonDateKey(row.Date);
    const s = sched.find(
      (x) =>
        canonDateKey(x.Date) === dk &&
        x.From_Airport === row.Dep_Airport &&
        x.To_Airport === row.Arr_Airport
    );
    const duty = String(s?.Duty_Code || "").toUpperCase();
    if (duty === "DHF" || duty === "DHT") row.Operated_As = duty;
  }
  return parseCSVLine(
    header,
    log.map((r) => header.map((col) => r[col] ?? ""))
  );
}

/** Fill empty Flight_No on logbook rows by matching date + sector to schedule. */
export function enrichLogbookCsvWithScheduleFlightNo(logCSV, schedCSV) {
  if (!logCSV?.trim() || !schedCSV?.trim()) return logCSV;
  const parseCSV = (t) => {
    const l = t.trim().split(/\r?\n/);
    const h = l[0].split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
    return l.slice(1).filter((x) => x.trim()).map((r) => {
      const v = r.split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
      return Object.fromEntries(h.map((k, i) => [k, v[i] ?? ""]));
    });
  };
  const log = parseCSV(logCSV);
  const sched = parseCSV(schedCSV);
  if (!log.length) return logCSV;
  const header = Object.keys(log[0]);
  const schedBySector = new Map();
  for (const s of sched) {
    const k = `${canonDateKey(s.Date)}|${s.From_Airport}|${s.To_Airport}`;
    if (!schedBySector.has(k)) schedBySector.set(k, []);
    schedBySector.get(k).push(s);
  }
  for (const row of log) {
    if ((row.Flight_No || "").trim()) continue;
    const k = `${canonDateKey(row.Date)}|${row.Dep_Airport}|${row.Arr_Airport}`;
    const candidates = schedBySector.get(k);
    if (candidates?.length === 1) row.Flight_No = candidates[0].Flight_No || "";
    else if (candidates?.length > 1) {
      const depM = timeToMins(row.Dep_Time_UTC);
      let best = candidates[0];
      let bestDiff = Infinity;
      for (const c of candidates) {
        const sm = timeToMins(c.STD_Local);
        if (sm == null) continue;
        let d = Math.abs(sm - depM);
        if (d > 720) d = 1440 - d;
        if (d < bestDiff) {
          bestDiff = d;
          best = c;
        }
      }
      if (best) row.Flight_No = best.Flight_No || "";
    }
  }
  const h = header;
  return parseCSVLine(
    h,
    log.map((r) => h.map((col) => r[col] ?? ""))
  );
}

function timeToMins(t) {
  if (!t || !String(t).includes(":")) return null;
  const [h, m] = String(t).split(":").map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}

const normSpaces = (s) => s.replace(/\s+/g, " ").trim();

/**
 * Split PDF text into chunks starting at DD/MM/YY dates (handles line breaks mid-row).
 */
function chunksStartingWithDate(text) {
  const flat = normSpaces(text);
  const re = /\d{1,2}\/\d{1,2}\/\d{2,4}/g;
  const idx = [];
  let m;
  while ((m = re.exec(flat)) !== null) idx.push(m.index);
  if (idx.length === 0) return [];
  const chunks = [];
  for (let i = 0; i < idx.length; i++) {
    chunks.push(flat.slice(idx[i], idx[i + 1] ?? flat.length).trim());
  }
  return chunks;
}

// Logbook row (CSV / some exports): Date [Flight?] Dep DepUTC Arr ArrUTC …
const LOGBOOK_RE =
  /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(?:(\d{3,5})\s+)?([A-Z]{3})\s+(\d{1,2}:\d{2})\s+([A-Z]{3})\s+(\d{1,2}:\d{2})\s+(\d{3})\s+(VT[A-Z0-9]{2,5})\s+(\d{1,2}:\d{2})(?:\s+(PIC|FO|SIC|CP|FP|TRAINING|TRG|DHF|DHT|DH|DEADHEAD))?/i;

// AIMS Pilot Logbook PDF: Date DepAirport DepUTC ArrAirport ArrUTC Type Reg Block (no flight # in text)
const LOGBOOK_AIMS_PDF_RE =
  /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+([A-Z]{3})\s+(\d{1,2}:\d{2})\s+([A-Z]{3})\s+(\d{1,2}:\d{2})\s+(\d{3})\s+(VT[A-Z0-9]{2,5})\s+(\d{1,2}:\d{2})/i;

const LOGBOOK_HEADER = [
  "Date",
  "Flight_No",
  "Dep_Airport",
  "Dep_Time_UTC",
  "Arr_Airport",
  "Arr_Time_UTC",
  "Aircraft_Type",
  "Aircraft_Reg",
  "Block_Time",
  "Operated_As",
  "Home_Base",
];

function extractHomeBaseFromAimsHeader(text) {
  const m = normSpaces(text).slice(0, 800).match(/\(([A-Z]{3})-\d{3}-(?:CP|FO|LD|CA)\)/i);
  return m ? m[1].toUpperCase() : "DEL";
}

export function parseLogbookPdfTextToCsv(text) {
  const rows = [];
  const defaultBase = extractHomeBaseFromAimsHeader(text);
  for (const chunk of chunksStartingWithDate(text)) {
    const line = normSpaces(chunk);
    let date,
      flightNo,
      dep,
      depU,
      arr,
      arrU,
      acType,
      reg,
      block,
      role = "";
    let matchedLen = 0;
    const csvStyle = line.match(LOGBOOK_RE);
    if (csvStyle) {
      [, date, flightNo, dep, depU, arr, arrU, acType, reg, block, role] = csvStyle;
      matchedLen = csvStyle[0].length;
    } else {
      const aims = line.match(LOGBOOK_AIMS_PDF_RE);
      if (!aims) continue;
      [, date, dep, depU, arr, arrU, acType, reg, block] = aims;
      flightNo = "";
      matchedLen = aims[0].length;
    }
    let base = defaultBase;
    if (csvStyle) {
      const after = line.slice(matchedLen).trim();
      const baseM = after.match(/^([A-Z]{3})(?:\s|$)/);
      if (baseM && baseM[1].length === 3) base = baseM[1].toUpperCase();
    }
    rows.push({
      Date: date,
      Flight_No: flightNo || "",
      Dep_Airport: dep.toUpperCase(),
      Dep_Time_UTC: depU,
      Arr_Airport: arr.toUpperCase(),
      Arr_Time_UTC: arrU,
      Aircraft_Type: acType,
      Aircraft_Reg: reg.toUpperCase(),
      Block_Time: block,
      Operated_As: role ? String(role).toUpperCase() : "",
      Home_Base: base,
    });
  }
  if (!rows.length) {
    throw new Error(
      "No logbook rows found in PDF text. Check that the file is a text-based AIMS Pilot Logbook export (not a scan). Expected columns: date, airports, UTC times, type, VT-reg, block."
    );
  }
  return parseCSVLine(
    LOGBOOK_HEADER,
    rows.map((r) => LOGBOOK_HEADER.map((h) => r[h] ?? ""))
  );
}

// Schedule: Date Flight [Duty?] STD STA From To Type
const SCHED_RE =
  /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{3,5})\s+(?:(DHF|DHT|DH)\s+)?(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})\s+([A-Z]{3})\s+([A-Z]{3})\s+(\d{3})\b/i;

const SCHED_HEADER = [
  "Date",
  "Flight_No",
  "Duty_Code",
  "STD_Local",
  "STA_Local",
  "From_Airport",
  "To_Airport",
  "Aircraft_Type",
];

export function parseSchedulePdfTextToCsv(text) {
  if (/Personal\s+Crew\s+Schedule/i.test(normSpaces(text))) {
    throw new Error(
      "This IndiGo Personal Crew Schedule PDF uses a graphical layout that is not auto-parsed. Use a schedule CSV export, or “Load from assets” if you keep a CrewSchedule*.csv next to it in src/assets."
    );
  }
  const rows = [];
  for (const chunk of chunksStartingWithDate(text)) {
    const line = normSpaces(chunk);
    const x = line.match(SCHED_RE);
    if (!x) continue;
    const [, date, flight, duty, std, sta, from, to, acType] = x;
    rows.push({
      Date: date,
      Flight_No: flight,
      Duty_Code: duty || "",
      STD_Local: std,
      STA_Local: sta,
      From_Airport: from.toUpperCase(),
      To_Airport: to.toUpperCase(),
      Aircraft_Type: acType,
    });
  }
  if (!rows.length) {
    throw new Error(
      "No schedule rows found in PDF text. Expected: date, flight number, optional DHF/DHT, STD, STA, from/to IATA, aircraft type (320/321)."
    );
  }
  return parseCSVLine(
    SCHED_HEADER,
    rows.map((r) => SCHED_HEADER.map((h) => r[h] ?? ""))
  );
}

export async function csvFromPdfBuffer(buffer, kind) {
  const { pdfArrayBufferToText } = await import("./pdfToText.js");
  const raw = await pdfArrayBufferToText(buffer);
  if (kind === "logbook") return parseLogbookPdfTextToCsv(raw);
  if (kind === "schedule") return parseSchedulePdfTextToCsv(raw);
  throw new Error("kind must be logbook or schedule");
}
