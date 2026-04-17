/**
 * PCSR PDF parser — supports two IndiGo formats:
 *   "EOM"  – Anshu / End-Of-Month tabular layout (Schedule Details table)
 *   "GRID" – Vineet / Monthly calendar grid + Other Crew section
 *
 * Both return the same shape:
 * {
 *   format: "EOM" | "GRID",
 *   month: "YYYY-MM",
 *   pilot: { employee_id, name, home_base, fleet },
 *   sectors: [
 *     { date, flight_no, dep, arr, is_dhf, is_dht, atd_local, ata_local }
 *   ],
 *   hotels: [{ date, station, check_in, check_out }],    // best-effort
 * }
 *
 * Uses the same pdfToText.js infrastructure (one long string per page joined by "\n").
 */

// ─── helpers ─────────────────────────────────────────────────────────────────

const norm = (s) => s.replace(/\s+/g, " ").trim();

function hhmm(s) {
  const m = String(s || "").match(/(\d{1,2}:\d{2})/);
  return m ? m[1].padStart(5, "0") : null;
}

// Parse DD/MM/YY or DD/MM/YYYY → "YYYY-MM-DD"
function parseDate(d) {
  if (!d) return null;
  const m = d.trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (!m) return null;
  let [, dd, mm, yy] = m;
  let yr = parseInt(yy, 10);
  if (yr < 100) yr += 2000;
  return `${yr}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

// ─── pilot header extraction (shared) ────────────────────────────────────────

/**
 * Try to extract pilot info from the first 800 chars of text.
 * IndiGo PCSRs typically have lines like:
 *   "GOYAL, VINEET  16612  CP  DEL-320"
 * or from header block:
 *   "Employee ID : 12345   Name : SHARMA, ANSHU   Base : DEL   Fleet: A320"
 */
function extractPilotHeader(text) {
  const head = norm(text).slice(0, 1200);

  let employee_id = null, name = null, home_base = "DEL", fleet = "320";

  // Pattern 1: "Emp(loyee)? (ID|No|#)? : 12345"
  const empM = head.match(/Emp(?:loyee)?(?:\s*(?:ID|No|#))?\s*[:-]\s*(\d{4,6})/i);
  if (empM) employee_id = empM[1];

  // Pattern 2: surname, first mid - standalone XXXXXX before CP/FO/LD
  if (!employee_id) {
    const m2 = head.match(/\b(\d{4,6})\s+(?:CP|FO|LD|SE|CA)\b/i);
    if (m2) employee_id = m2[1];
  }

  // Pattern 3: parenthetical like (DEL-320-CP-16612) or (DEL-320-FO)
  const parM = head.match(/\(([A-Z]{3})[- ](\d{3})[- ](?:CP|FO|LD|SE|CA)[- ]?(\d{4,6})?\)/i);
  if (parM) {
    home_base = parM[1].toUpperCase();
    fleet = parM[2];
    if (parM[3] && !employee_id) employee_id = parM[3];
  }

  // Name patterns
  const nameM = head.match(/(?:Name\s*[:-]\s*)?([A-Z]{2,20},\s*[A-Z]{2,20}(?:\s+[A-Z]{2,20})?)/);
  if (nameM) name = nameM[1].trim();

  // Base patterns
  const baseM = head.match(/(?:Base|Home\s*Base|Station)\s*[:-]\s*([A-Z]{3})\b/i);
  if (baseM) home_base = baseM[1].toUpperCase();

  // Fleet
  const fleetM = head.match(/(?:Fleet|Type|A\/C)\s*[:-]?\s*[A3]?(3[012][0-9])/i);
  if (fleetM) fleet = fleetM[1];

  return { employee_id: employee_id || null, name: name || null, home_base, fleet };
}

// ─── month extraction ─────────────────────────────────────────────────────────

function extractMonth(text) {
  const t = norm(text).slice(0, 600);
  // "January 2026", "Jan 2026", "01/2026"
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const m1 = t.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[,\s]+(\d{4})\b/i);
  if (m1) {
    const mi = months.findIndex(x => m1[1].toLowerCase().startsWith(x)) + 1;
    return `${m1[2]}-${String(mi).padStart(2, "0")}`;
  }
  const m2 = t.match(/\b(\d{1,2})[/-](\d{4})\b/);
  if (m2) return `${m2[2]}-${m2[1].padStart(2, "0")}`;
  // fall back to current year-month from current date context
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// ─── EOM format parser ────────────────────────────────────────────────────────

/**
 * EOM layout (Anshu style):
 *   Date | Duties | Details | Report | Actual | Debrief | Indicators
 *
 * pdfToText.js produces one string per page joined by "\n".
 * We flatten everything and split on date positions (DD/MM/YY anchors),
 * same technique used by indiGoPdfParsers.js.
 */
function parseEom(text) {
  // Flatten all pages into one string
  const fullText = norm(text.replace(/\n/g, " "));

  const pilot = extractPilotHeader(fullText);
  const month = extractMonth(fullText);
  const [year, mo] = month.split("-").map(Number);

  const sectors = [];
  const hotels = [];

  // Split on every DD/MM/YY or DD/MM/YYYY date occurrence
  const DATE_ANCHOR = /\d{1,2}\/\d{1,2}\/\d{2,4}/g;
  const idx = [];
  let m;
  while ((m = DATE_ANCHOR.exec(fullText)) !== null) idx.push(m.index);

  if (!idx.length) return { format: "EOM", month, pilot, sectors, hotels };

  // Build blocks: each block starts at a date and ends at the next date
  const blocks = idx.map((start, i) => {
    const chunk = fullText.slice(start, idx[i + 1] ?? fullText.length).trim();
    const dateM = chunk.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})/);
    return { date: dateM ? dateM[1] : null, rest: chunk };
  }).filter(b => b.date);

  for (const blk of blocks) {
    const { date, rest } = blk;
    const isoDate = parseDate(date) || `${year}-${String(mo).padStart(2,"0")}-${date.slice(0,2).padStart(2,"0")}`;

    // Find all route matches in this block (may have multiple sectors same day)
    const routeMatches = [...rest.matchAll(/(\*?)([A-Z]{3})\s*[-–]\s*([A-Z]{3})/g)];
    if (!routeMatches.length) continue;

    // Find all flight numbers in order
    const fltMatches = [...rest.matchAll(/\b(?:6E\s*)?(\d{3,5})\b/g)];
    let fltIdx = 0;

    // Find actual time pairs
    const actualPairs = [...rest.matchAll(/A(\d{1,2}:\d{2})\s*[-–]\s*A(\d{1,2}:\d{2})/g)];
    let actIdx = 0;

    for (let i = 0; i < routeMatches.length; i++) {
      const [, star, dep, arr] = routeMatches[i];
      const is_dhf = star === "*";

      let flight_no = "";
      if (fltMatches[fltIdx]) {
        flight_no = `6E${fltMatches[fltIdx][1]}`;
        fltIdx++;
      }

      let atd_local = null, ata_local = null;
      if (actualPairs[actIdx]) {
        atd_local = hhmm(actualPairs[actIdx][1]);
        ata_local = hhmm(actualPairs[actIdx][2]);
        actIdx++;
      }

      sectors.push({
        date: isoDate,
        flight_no,
        dep: dep.toUpperCase(),
        arr: arr.toUpperCase(),
        is_dhf,
        is_dht: false, // EOM has no Other Crew section
        atd_local,
        ata_local,
      });
    }

    // Hotel check-in lines: look for "CHECK IN" or hotel name patterns
    if (/hotel|check.?in/i.test(rest)) {
      const stM = rest.match(/CHECK\s*IN[:\s]+(\d{1,2}:\d{2})/i);
      const stOut = rest.match(/CHECK\s*OUT[:\s]+(\d{1,2}:\d{2})/i);
      // station is last arr airport of the day
      const lastSector = sectors[sectors.length - 1];
      if (lastSector && lastSector.date === isoDate) {
        hotels.push({
          date: isoDate,
          station: lastSector.arr,
          check_in: stM ? hhmm(stM[1]) : null,
          check_out: stOut ? hhmm(stOut[1]) : null,
        });
      }
    }
  }

  return { format: "EOM", month, pilot, sectors, hotels };
}

// ─── GRID format parser ───────────────────────────────────────────────────────

/**
 * Grid layout (Vineet style).
 *
 * pdfToText.js gives one string per page joined by "\n" — the grid page 1
 * linearises poorly.  Pages 2+ contain the "Other Crew" section which has
 * clean sector rows:  "05/01 5077 DEL BOM 06:30 08:15"
 * followed by crew lines: "CP - DHF - 16612 - GOYAL, VINEET"
 *
 * Strategy:
 *  1. Normalise ALL text into one flat string (kills \n / extra spaces).
 *  2. Find "Other Crew" and parse sector + crew blocks from it.
 *  3. If that yields nothing, fall back to date-chunk scan of full text
 *     (same approach as the EOM parser) — no DHF/DHT info in that case.
 */
function parseGrid(text, allPagesText) {
  // Normalise everything first — this is the critical fix vs the old version
  const flat = norm(allPagesText.replace(/\n/g, " "));

  const pilot = extractPilotHeader(flat);
  const month = extractMonth(flat);
  const [year, mo] = month.split("-").map(Number);

  const sectors = [];
  const hotels  = [];

  // ── 1. Other Crew section ──────────────────────────────────────────────────
  const otherCrewIdx = flat.search(/Other\s*Crew/i);

  if (otherCrewIdx !== -1) {
    const section = flat.slice(otherCrewIdx);

    // "05/01 5077 DEL BOM 06:30 08:15"  (year optional)
    const SECT_RE = /(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(\d{3,5})\s+([A-Z]{3})\s+([A-Z]{3})\s+(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})/g;
    // "CP - DHF - 16612 - ..."  or  "FO - DHT - 91461 - ..."
    const CREW_RE = /(CP|FO|SE|LD|CA)\s*[-–]\s*(DHF|DHT|DH)\s*[-–]\s*(\d{4,6})/gi;

    const blocks = [];
    let m;
    while ((m = SECT_RE.exec(section)) !== null) {
      const [, date, flt, dep, arr, std, sta] = m;
      const isoDate = parseDate(date) ||
        `${year}-${String(mo).padStart(2,"0")}-${date.slice(0,2).padStart(2,"0")}`;
      blocks.push({ isoDate, flt, dep: dep.toUpperCase(), arr: arr.toUpperCase(),
        std_local: hhmm(std), sta_local: hhmm(sta), startIdx: m.index });
    }

    for (let i = 0; i < blocks.length; i++) {
      const blk  = blocks[i];
      const next = blocks[i + 1]?.startIdx ?? section.length;
      const crew = section.slice(blk.startIdx, next);

      let is_dhf = false, is_dht = false;
      const crewRe = new RegExp(CREW_RE.source, "gi");
      let cm;
      while ((cm = crewRe.exec(crew)) !== null) {
        const rank  = cm[1].toUpperCase();
        const duty  = cm[2].toUpperCase();
        const empId = cm[3];
        const isPilotRank  = rank === "CP" || rank === "FO";
        const isThisPilot  = pilot.employee_id ? empId === pilot.employee_id : isPilotRank;
        if (isThisPilot) {
          if (duty === "DHF") is_dhf = true;
          if (duty === "DHT") is_dht = true;
        }
      }

      sectors.push({ date: blk.isoDate, flight_no: `6E${blk.flt}`,
        dep: blk.dep, arr: blk.arr, is_dhf, is_dht,
        atd_local: null, ata_local: null });
    }
  }

  // ── 2. Fallback: date-chunk scan (no DHF/DHT data) ─────────────────────────
  if (!sectors.length) {
    const DATE_ANCHOR = /\d{1,2}\/\d{1,2}\/\d{2,4}/g;
    const idx = [];
    let ma;
    while ((ma = DATE_ANCHOR.exec(flat)) !== null) idx.push(ma.index);

    for (let i = 0; i < idx.length; i++) {
      const chunk  = flat.slice(idx[i], idx[i + 1] ?? flat.length);
      const dateM  = chunk.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})/);
      if (!dateM) continue;
      const isoDate = parseDate(dateM[1]) || "";
      if (!isoDate) continue;
      const routes = [...chunk.matchAll(/(\*?)([A-Z]{3})\s*[-–]\s*([A-Z]{3})/g)];
      const flts   = [...chunk.matchAll(/\b(?:6E\s*)?(\d{3,5})\b/g)];
      routes.forEach((r, ri) => {
        sectors.push({ date: isoDate, flight_no: flts[ri] ? `6E${flts[ri][1]}` : "",
          dep: r[2].toUpperCase(), arr: r[3].toUpperCase(),
          is_dhf: r[1] === "*", is_dht: false,
          atd_local: null, ata_local: null });
      });
    }
  }

  // ── 3. Hotel section ───────────────────────────────────────────────────────
  parseHotelSection(flat, sectors, hotels);

  return { format: "GRID", month, pilot, sectors, hotels };
}

function parseHotelSection(text, sectors, hotels) {
  const hotelIdx = text.search(/\bHotel\b/i);
  if (hotelIdx === -1) return;
  const hotelSection = text.slice(hotelIdx, hotelIdx + 3000);

  // "DD/MM  STATION  CHECK IN  CHECK OUT  HOTEL NAME"
  const HOTEL_ROW_RE = /(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+([A-Z]{3})\s+(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})/g;
  let m;
  while ((m = HOTEL_ROW_RE.exec(hotelSection)) !== null) {
    hotels.push({
      date: m[1],
      station: m[2].toUpperCase(),
      check_in: hhmm(m[3]),
      check_out: hhmm(m[4]),
    });
  }
}

// ─── format detection ─────────────────────────────────────────────────────────

function detectFormat(text) {
  const t = norm(text).slice(0, 2000);
  // EOM has a "Schedule Details" or "Actual times" column header
  if (/Schedule\s+Details|Actual\s+times|Debrief|Indicator/i.test(t)) return "EOM";
  // Grid has "Other Crew" section or calendar column headers like "01/01  02/01"
  if (/Other\s+Crew|Personal\s+Crew\s+Schedule/i.test(t)) return "GRID";
  // Date column headers across the page: three or more "DD/MM" within 200 chars
  const dateHeaders = (t.match(/\b\d{2}\/\d{2}\b/g) || []).length;
  if (dateHeaders >= 5) return "GRID";
  return "EOM"; // default
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Parse an ArrayBuffer containing a PCSR PDF.
 * Returns the parsed object or throws on failure.
 */
export async function parsePcsrPdf(buffer) {
  const { pdfArrayBufferToText } = await import("./pdfToText.js");
  const rawText = await pdfArrayBufferToText(buffer);

  const format = detectFormat(rawText);

  let result;
  if (format === "EOM") {
    result = parseEom(rawText);
  } else {
    result = parseGrid(rawText, rawText);
  }

  if (!result.sectors.length) {
    throw new Error(
      `No sectors found in PCSR PDF (detected format: ${format}). ` +
        "Ensure the PDF is a text-based PCSR export (not a scan). " +
        "Contact support if this PDF is valid."
    );
  }

  return result;
}

/**
 * Parse raw text (already extracted from PDF) — for testing without a real file.
 */
export function parsePcsrText(rawText) {
  const format = detectFormat(rawText);
  if (format === "EOM") return parseEom(rawText);
  return parseGrid(rawText, rawText);
}
