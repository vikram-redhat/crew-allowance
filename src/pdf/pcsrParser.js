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

// HH:MM string → minutes since midnight
function t2m_local(s) {
  if (!s) return NaN;
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
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

  // Pattern 2: standalone XXXXXX before CP/FO/LD
  if (!employee_id) {
    const m2 = head.match(/\b(\d{4,6})\s+(?:CP|FO|LD|SE|CA)\b/i);
    if (m2) employee_id = m2[1];
  }

  // Pattern 2b: IndiGo PCSR header — "16612 GOYAL, VINEET DEL,CP,320"
  if (!employee_id) {
    const m2b = head.match(/\b(\d{4,6})\s+[A-Z]{2,},\s*[A-Z]+/);
    if (m2b) employee_id = m2b[1];
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

  // Base: explicit label
  const baseM = head.match(/(?:Base|Home\s*Base|Station)\s*[:-]\s*([A-Z]{3})\b/i);
  if (baseM) home_base = baseM[1].toUpperCase();

  // Base: IndiGo PCSR inline format "...VINEET DEL,CP,320" or "...VINEET DEL-CP-320"
  if (!baseM) {
    const inlineBase = head.match(/[A-Z]{2,},\s*[A-Z]+\s+([A-Z]{3})[,-](CP|FO|LD|SE|CA)\b/i);
    if (inlineBase) home_base = inlineBase[1].toUpperCase();
  }

  // Fleet
  const fleetM = head.match(/(?:Fleet|Type|A\/C)\s*[:-]?\s*[A3]?(3[012][0-9])/i);
  if (fleetM) fleet = fleetM[1];

  return { employee_id: employee_id || null, name: name || null, home_base, fleet };
}

// ─── month extraction ─────────────────────────────────────────────────────────

function extractMonth(text) {
  const flat = norm(text);
  // Highest priority: explicit report date range "DD/MM/YYYY - DD/MM/YYYY"
  // This is always the canonical period and beats any month-name in footers/headers.
  const rangeM = flat.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\s*[-–]\s*\d{2}\/\d{2}\/\d{4}\b/);
  if (rangeM) return `${rangeM[3]}-${rangeM[2].padStart(2, "0")}`;

  const t = flat.slice(0, 600);
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const m1 = t.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[,\s]+(\d{4})\b/i);
  if (m1) {
    const mi = months.findIndex(x => m1[1].toLowerCase().startsWith(x)) + 1;
    return `${m1[2]}-${String(mi).padStart(2, "0")}`;
  }
  const m2 = t.match(/\b(\d{1,2})[/-](\d{4})\b/);
  if (m2) return `${m2[2]}-${m2[1].padStart(2, "0")}`;
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

  const transfers = parseTransferSection(fullText);
  applyTransferDateCorrections(sectors, transfers);

  return { format: "EOM", month, pilot, sectors, hotels };
}

// ─── GRID format parser ───────────────────────────────────────────────────────

/**
 * Grid layout (Vineet style).
 *
 * Page 1: calendar grid linearised as date-column headers then sector stream.
 *   Sector format: flight_no A[atd] [*]DEP [→↓] ARR A[ata] [[type]]
 *   '*' on DEP means this pilot is deadheading (DHF).
 *
 * Pages 2+: "Other Crew" section.
 *   Columns: Date | Duty (= flight_no) | Details
 *   Details: pipe-separated entries like "CP - PIC - 16612 - GOYAL, VINEET | FO - DHT - 91461 - ..."
 *   Each entry is either: RANK - DUTY - EMP_ID - NAME  or  RANK - EMP_ID - NAME
 *
 * Strategy:
 *  1. Parse Other Crew section → (date, flight_no, is_dhf, is_dht) per sector.
 *  2. Parse grid page 1 → (flight_no, dep, arr, atd_local, ata_local) per sector.
 *  3. Zip by flight_no in chronological order to produce complete sector records.
 */
function parseGrid(text, allPagesText) {
  const flat = norm(allPagesText.replace(/\n/g, " "));

  const pilot = extractPilotHeader(flat);
  const month = extractMonth(flat);
  const [year, mo] = month.split("-").map(Number);

  const sectors = [];
  const hotels  = [];

  // ── 1. Other Crew section: date + flight_no + DHF/DHT per sector ──────────
  const otherCrewIdx = flat.search(/Other\s*Crew/i);
  const ocSectors = [];

  // Normalise "6E0715" and "6E715" to the same key by dropping leading zeros
  const normFlt = f => `6E${parseInt(f, 10)}`;

  // ── 1. Other Crew section: date + flight_no + DHF/DHT per sector ──────────
  if (otherCrewIdx !== -1) {
    // Stop before Training/Hotel/Transfer sections that follow Other Crew —
    // those sections contain time ranges (e.g. "1603 - 1835") that ROW_RE
    // would misread as flight numbers.
    const ocBoundary = flat.slice(otherCrewIdx).search(
      /\b(?:Training\s+Details|Hotel\s+Details|Transfer\s+Details)\b/i
    );
    const section = flat.slice(
      otherCrewIdx,
      ocBoundary !== -1 ? otherCrewIdx + ocBoundary : flat.length
    );

    // Each row starts with: DD/MM/YY[YY]   6E<flight_no>   [details...]
    // Requiring "6E" prefix prevents 5-digit employee IDs in the details column
    // from being misread as flight number tokens and corrupting date assignments.
    const ROW_RE = /(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+6E(\d{3,5})\s+/g;
    const rows = [];
    let rm;
    while ((rm = ROW_RE.exec(section)) !== null) {
      rows.push({ date: rm[1], flt: rm[2], detailsAt: rm.index + rm[0].length, rowAt: rm.index });
    }

    for (let i = 0; i < rows.length; i++) {
      const { date, flt, detailsAt } = rows[i];
      const detailsEnd = rows[i + 1]?.rowAt ?? section.length;
      const details = section.slice(detailsAt, detailsEnd);
      const isoDate = parseDate(date) ||
        `${year}-${String(mo).padStart(2,"0")}-${date.slice(0,2).padStart(2,"0")}`;

      let is_dhf = false, is_dht = false;
      const DH_RE = /(CP|FO)\s*-\s*(DHF|DHT)\s*-\s*(\d{4,6})/gi;
      let cm;
      while ((cm = DH_RE.exec(details)) !== null) {
        const duty  = cm[2].toUpperCase();
        const empId = cm[3];
        const rankIsPilot = cm[1].toUpperCase() === "CP" || cm[1].toUpperCase() === "FO";
        const isThisPilot = pilot.employee_id ? empId === pilot.employee_id : rankIsPilot;
        if (isThisPilot) {
          if (duty === "DHF") is_dhf = true;
          if (duty === "DHT") is_dht = true;
        }
      }

      ocSectors.push({ date: isoDate, flight_no: normFlt(flt), is_dhf, is_dht });
    }
  }

  // ── 2. Grid page 1: flight_no + dep + arr + actual times ─────────────────
  // Format: flight_no [A]atd [*]DEP [→ ↓ spaces] ARR [A]ata
  // "A" prefix = actual time; no prefix = scheduled/unknown.
  // Arrival time is optional (overnight sectors may span two columns in the grid).
  // DEP→ARR gap widened to 120 to handle column-boundary linearisation artefacts.
  const page1Text = otherCrewIdx !== -1 ? flat.slice(0, otherCrewIdx) : flat;
  const G_RE = /\b(\d{3,5})\s+(A?)(\d{1,2}:\d{2})\s+(\*?)([A-Z]{3})[\s\u2192\u2193]{1,120}([A-Z]{3})\s{0,20}(?:(A?)(\d{1,2}:\d{2}))?/gu;
  const gridSectors = [];
  let gm;
  while ((gm = G_RE.exec(page1Text)) !== null) {
    const _idx = gridSectors.length;
    const _flt = normFlt(gm[1]);
    const _dep = gm[5].toUpperCase();
    const _arr = gm[6].toUpperCase();
    const _atd = gm[2] === "A" ? hhmm(gm[3]) : `sched:${gm[3]}`;
    const _ata = (gm[7] === "A" && gm[8]) ? hhmm(gm[8]) : (gm[8] ? `sched:${gm[8]}` : "—");
    console.log(`[gridRow ${_idx}] flt=${_flt} dep=${_dep} arr=${_arr} atd=${_atd} ata=${_ata} star=${gm[4]==="*"} matchAt=${gm.index}`);
    gridSectors.push({
      flight_no: _flt,
      atd_local: gm[2] === "A" ? hhmm(gm[3]) : null,
      dep: _dep,
      arr: _arr,
      ata_local: (gm[7] === "A" && gm[8]) ? hhmm(gm[8]) : null,
      star: gm[4] === "*",
    });
  }
  console.log(`[gridRow total] ${gridSectors.length} grid sectors extracted`);

  // ── 3. Merge ───────────────────────────────────────────────────────────────
  if (ocSectors.length) {
    // Zip OC entries with grid entries by flight_no in order
    const gridByFlt = new Map();
    for (const gs of gridSectors) {
      if (!gridByFlt.has(gs.flight_no)) gridByFlt.set(gs.flight_no, []);
      gridByFlt.get(gs.flight_no).push(gs);
    }
    const usedCount = new Map();
    for (const oc of ocSectors) {
      const list = gridByFlt.get(oc.flight_no) || [];
      const n    = usedCount.get(oc.flight_no) || 0;
      const gs   = list[n] || null;
      usedCount.set(oc.flight_no, n + 1);
      sectors.push({
        date:      oc.date,
        flight_no: oc.flight_no,
        dep:       gs?.dep || "",
        arr:       gs?.arr || "",
        is_dhf:    oc.is_dhf || gs?.star || false,
        is_dht:    oc.is_dht,
        atd_local: gs?.atd_local || null,
        ata_local: gs?.ata_local || null,
      });
    }

    // Bug fix: if a flight has more grid legs than OC entries (same flight_no,
    // multiple dep→arr pairs e.g. 6E6458 DIB→GAU then GAU→AMD), emit the
    // unconsumed legs using the last matched OC entry for date/DHF/DHT.
    for (const [fltNo, gridList] of gridByFlt) {
      const used = usedCount.get(fltNo) || 0;
      if (used >= gridList.length) continue;
      const ocMatches = ocSectors.filter(oc => oc.flight_no === fltNo);
      const refOC = ocMatches[ocMatches.length - 1] || null;
      for (let k = used; k < gridList.length; k++) {
        const gs = gridList[k];
        sectors.push({
          date:      refOC?.date || `${year}-${String(mo).padStart(2,"0")}-01`,
          flight_no: fltNo,
          dep:       gs.dep,
          arr:       gs.arr,
          is_dhf:    refOC?.is_dhf || gs.star || false,
          is_dht:    refOC?.is_dht || false,
          atd_local: gs.atd_local,
          ata_local: gs.ata_local,
        });
      }
    }
  } else if (gridSectors.length) {
    // No OC section — use grid sectors, dates unknown (placeholder first of month)
    for (const gs of gridSectors) {
      sectors.push({
        date:      `${year}-${String(mo).padStart(2,"0")}-01`,
        flight_no: gs.flight_no,
        dep:       gs.dep,
        arr:       gs.arr,
        is_dhf:    gs.star,
        is_dht:    false,
        atd_local: gs.atd_local,
        ata_local: gs.ata_local,
      });
    }
  }

  // ── 4. Hotel section ───────────────────────────────────────────────────────
  parseHotelSection(flat, sectors, hotels);

  // ── 5. Transfer section — correct early-morning sector dates ──────────────
  const transfers = parseTransferSection(flat);
  applyTransferDateCorrections(sectors, transfers);

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

// ─── Transfer section: date-based sector correction ──────────────────────────

/**
 * Parse "Transfer Details / Transfer Information" section.
 * Returns entries like { type: "inbound"|"outbound", date, time, station|null }.
 * "Airport to Hotel" = inbound (pilot just arrived at layover station).
 * "Hotel to Airport" = outbound (pilot departing from layover station).
 */
export function parseTransferSection(text) {
  const idx = text.search(/\bTransfer\s+(?:Information|Details)\b/i);
  if (idx === -1) return [];
  const section = text.slice(idx, idx + 5000);
  const entries = [];
  const ENTRY_RE = /(Airport\s+to\s+Hotel|Hotel\s+to\s+Airport)[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s+(\d{1,2}:\d{2})/gi;
  let m;
  while ((m = ENTRY_RE.exec(section)) !== null) {
    const type = /Airport\s+to\s+Hotel/i.test(m[1]) ? "inbound" : "outbound";
    const date = parseDate(m[2]);
    if (!date) continue;
    const time = hhmm(m[3]);
    // Nearest preceding IATA station code in this section
    const before = section.slice(0, m.index);
    const stM = before.match(/\b([A-Z]{3})\b\s*$/);
    entries.push({ type, date, time, station: stM ? stM[1] : null });
  }
  return entries;
}

/**
 * CRITICAL DATE CORRECTION — apply before finalising any sector date.
 *
 * Step 1: Transfer Information entries override whatever date the PCSR grid implies.
 *   "Hotel to Airport" (outbound) → the sector DEPARTING from that station gets that date.
 *   "Airport to Hotel" (inbound)  → the sector ARRIVING at that station gets that date.
 *   Match: station equality; time used only when station is unknown (within 3 h).
 *
 * Step 2: For early-morning sectors (ATD 00:01–08:00) not covered by Transfer
 *   Information, look at the immediately preceding sector. If it arrived at the same
 *   station, the departure date is the SAME calendar date as that arrival (the PCSR
 *   grid tends to assign the wrong date for these overnight-continuation sectors).
 *
 * Step 3: The 8-hour duty gap rule must be applied AFTER this function returns.
 */
export function applyTransferDateCorrections(sectors, transfers) {
  const outbound = transfers.filter(t => t.type === "outbound"); // Hotel to Airport
  const inbound  = transfers.filter(t => t.type === "inbound");  // Airport to Hotel

  // Track which sectors were corrected in Step 1 so Step 2 skips them.
  const correctedInStep1 = new Set();

  // Step 1 — Transfer Information overrides (no time-of-day restriction).
  for (let i = 0; i < sectors.length; i++) {
    const s = sectors[i];

    for (const tr of outbound) {
      if (tr.station && s.dep !== tr.station) continue;
      // When station is unknown fall back to time proximity (≤3 h).
      if (!tr.station) {
        if (!s.atd_local) continue;
        if (Math.abs(t2m_local(s.atd_local) - t2m_local(tr.time)) > 180) continue;
      }
      s.date = tr.date;
      correctedInStep1.add(i);
      break;
    }

    for (const tr of inbound) {
      if (tr.station && s.arr !== tr.station) continue;
      if (!tr.station) {
        if (!s.ata_local) continue;
        if (Math.abs(t2m_local(s.ata_local) - t2m_local(tr.time)) > 180) continue;
      }
      s.date = tr.date;
      correctedInStep1.add(i);
      break;
    }
  }

  // Step 2 — Early-morning sectors (00:01–08:00) with no Transfer Information entry.
  // The PCSR grid rolls the date forward one day too many for these; if the previous
  // sector in the same duty arrived at the same station, the correct departure date
  // is the SAME calendar date as that arrival.
  for (let i = 1; i < sectors.length; i++) {
    if (correctedInStep1.has(i)) continue;
    const s = sectors[i];
    if (!s.atd_local) continue;
    const atdM = t2m_local(s.atd_local);
    if (isNaN(atdM) || atdM === 0 || atdM > 480) continue; // 00:01–08:00 only

    const prev = sectors[i - 1];
    if (!prev || prev.arr !== s.dep) continue;
    s.date = prev.date;
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

  // Attach debug text
  const flat = rawText.replace(/\n/g, " ");
  const otherIdx = flat.search(/Other\s*Crew/i);
  const otherSection = otherIdx !== -1 ? flat.slice(otherIdx, otherIdx + 3000) : "";

  // Show first 3 SECT_RE matches with captured groups for diagnosis
  const SECT_RE_DBG = /(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(\d{3,5})\s+([A-Z]{3})\s+([A-Z]{3})\s+(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})/g;
  const sectMatches = [];
  let sm;
  while ((sm = SECT_RE_DBG.exec(flat.slice(otherIdx !== -1 ? otherIdx : 0))) !== null && sectMatches.length < 5) {
    sectMatches.push(`  match[${sectMatches.length}]: "${sm[0]}" → date=${sm[1]} flt=${sm[2]} dep=${sm[3]} arr=${sm[4]} std=${sm[5]} sta=${sm[6]}`);
  }

  result._rawText = rawText;
  result._rawSample =
    "=== FIRST 1000 ===\n" + flat.slice(0, 1000) +
    (otherIdx !== -1
      ? "\n\n=== OTHER CREW SECTION (first 3000) ===\n" + otherSection
      : "\n\n[No 'Other Crew' section found]") +
    "\n\n=== SECT_RE MATCHES (" + sectMatches.length + ") ===\n" +
    (sectMatches.length ? sectMatches.join("\n") : "  [none]");

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
