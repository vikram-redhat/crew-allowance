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
 * Each row is anchored by a date token DD/MM/YY or DD/MM.
 * Flight entries look like:
 *   "01/01/26  6E2316  DEL - IXC  06:30  A07:36 - A08:30  09:45"
 * DHF rows have an asterisk prefix: "*DEL - IXC"
 *
 * We scan line-by-line for date-anchored blocks, extract flight# route and times.
 */
function parseEom(text) {
  const lines = text.split(/\n/).map(norm).filter(Boolean);
  const fullText = lines.join(" ");

  const pilot = extractPilotHeader(fullText);
  const month = extractMonth(fullText);
  const [year, mo] = month.split("-").map(Number);

  const sectors = [];
  const hotels = [];

  // Date pattern at line start
  const DATE_RE = /^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.*)/;

  // We'll collect all lines that start with a date, then group continuations
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const dm = line.match(DATE_RE);
    if (dm) {
      if (cur) blocks.push(cur);
      cur = { date: dm[1], rest: dm[2] };
    } else if (cur) {
      cur.rest += " " + line;
    }
  }
  if (cur) blocks.push(cur);

  for (const blk of blocks) {
    const { date, rest } = blk;
    const isoDate = parseDate(date, year) || `${year}-${String(mo).padStart(2,"0")}-${date.slice(0,2).padStart(2,"0")}`;

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
 * Grid layout (Vineet style):
 *
 * Page 1: calendar grid — each column is a day, each row is an activity slot.
 *   Column headers: "01/01  02/01 ... 31/01"
 *   Cells contain flight numbers, times, or codes (OFF, SBY, etc.)
 *   This page is hard to parse reliably from linear text — we do best-effort.
 *
 * Pages 2–4: "Other Crew" section — cleanly tabular:
 *   "Date  Flight  From  To  STD  STA  [crew list]"
 *   Crew entries have "CP - DHF", "FO - DHT", etc.
 *
 * We rely on Other Crew for sector list + DHF/DHT flags.
 * We use page 1 to try to extract actual times (A-prefixed) and supplement.
 */
function parseGrid(text, allPagesText) {
  const fullText = norm(text);
  const pilot = extractPilotHeader(fullText);
  const month = extractMonth(fullText);
  const [year, mo] = month.split("-").map(Number);

  const sectors = [];
  const hotels = [];

  // ── Parse "Other Crew" section ──────────────────────────────────────────────
  // Find the section (may span multiple pages)
  const otherCrewIdx = allPagesText.search(/Other\s+Crew/i);
  if (otherCrewIdx === -1) {
    // Fallback: try to parse from grid page (less reliable)
    return parseGridFromPage1Only(text, pilot, month, year, mo);
  }

  const otherCrewSection = allPagesText.slice(otherCrewIdx);

  // Sector header pattern: date + flight + airports
  // "05/01 5077 DEL BOM 06:30 08:15" or "05/01/26 5077 DEL BOM ..."
  const SECTOR_BLOCK_RE =
    /(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(\d{3,5})\s+([A-Z]{3})\s+([A-Z]{3})\s+(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})/g;

  // Crew row: "CP - DHF - 16612 - GOYAL, VINEET" or "FO - DHT - 91461 - YADAV, ABHISHEK"
  const CREW_RE = /(CP|FO|SE|LD|CA)\s*[-–]\s*(DHF|DHT|DH)\s*[-–]\s*(\d{4,6})\s*[-–]\s*([A-Z ,.]+)/gi;

  // Find all sector blocks in Other Crew section
  let sectorBlocks = [];
  let m;
  const re = new RegExp(SECTOR_BLOCK_RE.source, "g");
  while ((m = re.exec(otherCrewSection)) !== null) {
    const [, date, flt, dep, arr, std, sta] = m;
    const isoDate = parseDate(date, year) ||
      `${year}-${String(mo).padStart(2,"0")}-${date.slice(0,2).padStart(2,"0")}`;
    sectorBlocks.push({
      isoDate,
      flight_no: `6E${flt}`,
      dep: dep.toUpperCase(),
      arr: arr.toUpperCase(),
      std_local: hhmm(std),
      sta_local: hhmm(sta),
      startIdx: m.index,
    });
  }

  // For each sector block, scan crew between this block and the next for DHF/DHT
  for (let i = 0; i < sectorBlocks.length; i++) {
    const blk = sectorBlocks[i];
    const nextIdx = sectorBlocks[i + 1]?.startIdx ?? otherCrewSection.length;
    const crewChunk = otherCrewSection.slice(blk.startIdx, nextIdx);

    let is_dhf = false, is_dht = false;
    let crewM;
    const crewRe = new RegExp(CREW_RE.source, "gi");
    while ((crewM = crewRe.exec(crewChunk)) !== null) {
      const rank = crewM[1].toUpperCase();
      const duty = crewM[2].toUpperCase();
      const empId = crewM[3];
      // Match against pilot's employee_id, or if unknown, match CP/FO rank
      const isPilotRank = rank === "CP" || rank === "FO";
      const isThisPilot = pilot.employee_id
        ? empId === pilot.employee_id
        : isPilotRank;

      if (isThisPilot) {
        if (duty === "DHF") is_dhf = true;
        if (duty === "DHT") is_dht = true;
      }
    }

    sectors.push({
      date: blk.isoDate,
      flight_no: blk.flight_no,
      dep: blk.dep,
      arr: blk.arr,
      is_dhf,
      is_dht,
      atd_local: null, // actual times not reliably available in Other Crew section
      ata_local: null,
    });
  }

  // ── Try to enrich actual times from page 1 grid text ──────────────────────
  // Page 1 may have "A07:36" actual time annotations near flight numbers
  enrichActualTimesFromGridPage(text.split("\n")[0] || text, sectors);

  // ── Hotel section ──────────────────────────────────────────────────────────
  parseHotelSection(allPagesText, sectors, hotels);

  return { format: "GRID", month, pilot, sectors, hotels };
}

function parseGridFromPage1Only(text, pilot, month, year, mo) {
  // Minimal fallback: extract flight numbers and dates from grid, no DHF/DHT
  const sectors = [];
  // Look for patterns like "6E5077" or standalone "5077" near dates
  const FLT_DATE_RE = /(\d{1,2}\/\d{1,2})\s+(?:6E\s*)?(\d{3,5})\s+([A-Z]{3})\s+([A-Z]{3})/g;
  let m;
  while ((m = FLT_DATE_RE.exec(text)) !== null) {
    const isoDate = `${year}-${String(mo).padStart(2,"0")}-${m[1].split("/")[0].padStart(2,"0")}`;
    sectors.push({
      date: isoDate,
      flight_no: `6E${m[2]}`,
      dep: m[3].toUpperCase(),
      arr: m[4].toUpperCase(),
      is_dhf: false,
      is_dht: false,
      atd_local: null,
      ata_local: null,
    });
  }
  return { format: "GRID", month, pilot, sectors, hotels: [] };
}

function enrichActualTimesFromGridPage(pageText, sectors) {
  // Grid page may have "A HH:MM" near flight numbers — best-effort match
  // "5077 ... A07:36 ... A08:30"
  const lines = norm(pageText).split(/\s{3,}|\n/);
  for (const line of lines) {
    const fltM = line.match(/\b(\d{3,5})\b/);
    if (!fltM) continue;
    const actM = [...line.matchAll(/A(\d{1,2}:\d{2})/g)];
    if (!actM.length) continue;
    const fltNo = `6E${fltM[1]}`;
    const sector = sectors.find(s => s.flight_no === fltNo && !s.atd_local);
    if (sector && actM[0]) {
      sector.atd_local = hhmm(actM[0][1]);
      if (actM[1]) sector.ata_local = hhmm(actM[1][1]);
    }
  }
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
