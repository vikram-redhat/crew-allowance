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

  // Name patterns.
  // Third token is optional (middle name), but must be 4+ letters so we don't
  // accidentally swallow a 3-letter IATA base code (e.g. "GOYAL, VINEET DEL").
  const nameM = head.match(/(?:Name\s*[:-]\s*)?([A-Z]{2,20},\s*[A-Z]{2,20}(?:\s+[A-Z]{4,20})?)/);
  if (nameM) {
    name = nameM[1].trim()
      // Defensive: if we still captured a 3-letter trailing token followed by a base
      // separator ("DEL-", "DEL,", "DEL "), strip it.
      .replace(/\s+[A-Z]{3}$/, "");
  }

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
 * Parse page-1 items as a 2-D grid, using the calendar date-header row
 * (y≈486, items matching "DD/MM") to map each sector cell to a calendar date
 * via x-coordinate nearest-column lookup.
 *
 * This is the authoritative source for sector dates. The Other Crew section
 * on pages 2+ is known to mis-date overnight-continuation sectors (e.g.
 * 6E770 TRZ→DEL on 2026-01-13 gets incorrectly dated 2026-01-12 in OC).
 *
 * Each grid cell has this vertical structure (top → bottom in y-descending
 * order, ~8pt row height):
 *    row 1: flight_no         e.g. "2073"
 *    row 2: atd_local         e.g. "A15:53" ("A" = actual, else scheduled)
 *    row 3: dep (IATA)        e.g. "HYD"    ("*DEL" = DHF — passenger leg)
 *    row 4: arr (IATA)
 *    row 5: ata_local
 *    row 6: actype            e.g. "[321]" or "Delay" or "(T)" etc.
 *
 * Non-flight cells can contain just indicators (OFG, CL, single time like "07:25").
 * Returns sectors with dates sourced from column x-position.
 */
function parseGridFromItems(page1Items, pilot, year, mo) {
  if (!Array.isArray(page1Items) || !page1Items.length) return [];

  // 1. Find the date-header row. Items look like "DD/MM" on a single y line.
  const DATE_HEADER_RE = /^(\d{1,2})\/(\d{1,2})$/;
  const headerCandidates = {};
  for (const it of page1Items) {
    if (!DATE_HEADER_RE.test(it.str.trim())) continue;
    const yKey = Math.round(it.y);
    headerCandidates[yKey] = (headerCandidates[yKey] ?? 0) + 1;
  }
  // Pick the y with the most date-pattern hits (≥20 strongly implies header row).
  let headerY = null, bestCount = 0;
  for (const [y, c] of Object.entries(headerCandidates)) {
    if (c > bestCount) { bestCount = c; headerY = Number(y); }
  }
  if (headerY === null || bestCount < 20) return [];

  // 2. Build column list: one entry per date header item.
  const columns = page1Items
    .filter(it => Math.abs(it.y - headerY) < 2 && DATE_HEADER_RE.test(it.str.trim()))
    .map(it => {
      const [, dd, mm] = it.str.trim().match(DATE_HEADER_RE);
      return {
        x_center: it.x + it.w / 2,
        x_left:   it.x,
        date: `${year}-${String(mo).padStart(2, "0")}-${dd.padStart(2, "0")}`,
      };
    })
    .sort((a, b) => a.x_center - b.x_center);

  // Column half-width = half the spacing to the adjacent column.
  const colForX = (x) => {
    let best = null, bestDist = Infinity;
    for (const c of columns) {
      const d = Math.abs(x - c.x_center);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  };

  // 3. Index items by (column index, y) — one bucket per column.
  // We use a column-index keyed map so we can look up the right-adjacent
  // column when a sector's arrow "→" points to the next day.
  const colIdxByDate = new Map();
  columns.forEach((c, idx) => colIdxByDate.set(c.date, idx));
  const buckets = columns.map(() => []);
  for (const it of page1Items) {
    if (it.y >= headerY - 1) continue;  // header + above = not grid data
    const col = colForX(it.x + it.w / 2);
    if (!col) continue;
    // Reject items too far horizontally from the nearest column (>18px).
    if (Math.abs((it.x + it.w / 2) - col.x_center) > 18) continue;
    buckets[colIdxByDate.get(col.date)].push(it);
  }
  for (const b of buckets) b.sort((a, b2) => b2.y - a.y);  // top of page first

  // 4. Parse each column top-to-bottom as a sequence of sector blocks.
  const sectors = [];
  const FLIGHT_RE  = /^\d{3,5}$/;
  const IATA_RE    = /^(\*?)([A-Z]{3})$/;
  const TIME_RE    = /^(A?)(\d{1,2}):(\d{2})$/;
  const ACTYPE_RE  = /^\[\d{3}\]$/;
  const ARROW_RE   = /^[\u2192\u2193]$/;  // → or ↓
  const INDICATOR  = /^(OFG|CL|Delay|SL|AL|RP|DO|PL|\([A-Z]\))$/;  // includes (T),(R),(L),(W),(C)
  const DAY_RE     = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/;  // column day names

  // Helper: reads arr+ata from the top of a column's bucket and marks those
  // items as consumed so we don't read them again for another sector.
  const consumeTop = new WeakSet();
  const readTopArrAta = (colIdx) => {
    if (colIdx >= buckets.length) return null;
    const col = buckets[colIdx];
    let nArr = null, nAta = null;
    for (const it of col) {
      if (consumeTop.has(it)) continue;
      const t = it.str.trim();
      if (t === "" || t === "↓" || t === "→") { consumeTop.add(it); continue; }
      // Day-of-week cells ("Mon"/"Tue"/…) sit between the date header and the
      // cross-in arr. Skip past them. Same for stray indicator tokens.
      if (DAY_RE.test(t)) { consumeTop.add(it); continue; }
      if (INDICATOR.test(t)) { consumeTop.add(it); continue; }
      if (!nArr) {
        const ia = t.match(IATA_RE);
        if (ia) { nArr = ia[2]; consumeTop.add(it); continue; }
        // Real sector data (flight#, actype, or a bare time) → this column
        // doesn't actually start with a cross-in arrival. Abort.
        if (FLIGHT_RE.test(t) || TIME_RE.test(t) || ACTYPE_RE.test(t)) return null;
        // Otherwise keep hunting — unknown stray token.
        continue;
      }
      if (nArr && nAta === null) {
        const tm = t.match(TIME_RE);
        if (tm) {
          const [, aFlag, hh, mm2] = tm;
          nAta = { time: `${hh.padStart(2, "0")}:${mm2}`, actual: aFlag === "A" };
          consumeTop.add(it);
        }
        break;
      }
    }
    return nArr ? { arr: nArr, ata: nAta } : null;
  };

  for (let colIdx = 0; colIdx < buckets.length; colIdx++) {
    const items = buckets[colIdx];
    const date  = columns[colIdx].date;

    for (let i = 0; i < items.length; i++) {
      if (consumeTop.has(items[i])) continue;
      const fi = items[i];
      const s  = fi.str.trim();
      if (!FLIGHT_RE.test(s)) continue;

      // Find atd / dep / arr / ata / actype from subsequent items.
      let atd = null, dep = null, arr = null, ata = null, star = false;
      let crossedColumn = false;
      let j = i + 1;
      while (j < items.length) {
        const it = items[j];
        if (consumeTop.has(it)) { j++; continue; }
        const t  = it.str.trim();
        if (FLIGHT_RE.test(t)) break;  // next sector starts

        if (atd === null && TIME_RE.test(t)) {
          const [, aFlag, hh, mm2] = t.match(TIME_RE);
          atd = { time: `${hh.padStart(2, "0")}:${mm2}`, actual: aFlag === "A" };
          j++; continue;
        }
        const ia = t.match(IATA_RE);
        // Normally atd comes before dep, but DHF sectors can omit atd
        // entirely (the PCSR has no actual-departure time for a passive
        // deadhead), so we only require "no dep yet" here.
        if (!dep && ia) {
          star = ia[1] === "*";
          dep  = ia[2];
          j++; continue;
        }
        // Arrow after dep → arr+ata live in top of next column.
        if (dep && !arr && ARROW_RE.test(t)) {
          const crossed = readTopArrAta(colIdx + 1);
          if (crossed) {
            arr = crossed.arr;
            ata = crossed.ata;
            crossedColumn = true;
          }
          j++; break;
        }
        if (dep && !arr && ia) {
          arr = ia[2];
          j++; continue;
        }
        if (arr && ata === null && TIME_RE.test(t)) {
          const [, aFlag, hh, mm2] = t.match(TIME_RE);
          ata = { time: `${hh.padStart(2, "0")}:${mm2}`, actual: aFlag === "A" };
          j++; continue;
        }
        if (arr && ata && ACTYPE_RE.test(t)) { j++; break; }
        if (INDICATOR.test(t)) { j++; continue; }
        if (ACTYPE_RE.test(t)) { j++; continue; }  // stray actype before block
        // Unknown token — if we've already got dep+arr, stop; else keep scanning.
        if (arr) break;
        // Bare HH:MM before ata is a scheduled-time display — skip it.
        if (TIME_RE.test(t)) { j++; continue; }
        j++;
      }

      if (!dep || !arr) continue;  // not a sector cell

      sectors.push({
        date,
        flight_no: `6E${parseInt(s, 10)}`,
        dep, arr,
        atd_local: atd?.actual ? atd.time : null,
        ata_local: ata?.actual ? ata.time : null,
        is_dhf: star,
        is_dht: false,
        _gridX: fi.x,
        _gridY: fi.y,
        _crossedColumn: crossedColumn,
      });

      i = j - 1;
    }
  }

  // Sort chronologically by (date asc, atd asc, y desc within day).
  sectors.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const ta = a.atd_local ?? "";
    const tb = b.atd_local ?? "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return b._gridY - a._gridY;
  });

  // Strip internal debug coordinates before returning.
  return sectors.map(s => {
    const { _gridX, _gridY, _crossedColumn, ...rest } = s;
    return rest;
  });
}

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
 * Strategy (GRID-FIRST — page 1 is authoritative):
 *  1. If page-1 items are available, parse the calendar grid via x-coordinate
 *     → the primary source of (date, flight_no, dep, arr, atd, ata, is_dhf).
 *  2. Parse Other Crew section only to determine is_dht per flight_no (needs
 *     pilot's employee_id to disambiguate DHT rows from other crew rows).
 *  3. Fallback: if no page-1 items were provided (legacy callers that only
 *     pass raw text), use the original text-based regex parser.
 */
function parseGrid(text, allPagesText, page1Items) {
  const flat = norm(allPagesText.replace(/\n/g, " "));

  const pilot = extractPilotHeader(flat);
  const month = extractMonth(flat);
  const [year, mo] = month.split("-").map(Number);

  const sectors = [];
  const hotels  = [];

  // otherCrewIdx in flat is kept solely to cut page1Text for the grid regex below.
  const otherCrewIdx = flat.search(/Other\s*Crew/i);
  const ocSectors = [];

  // Normalise "6E0715" and "6E715" to the same key by dropping leading zeros
  const normFlt = f => `6E${parseInt(f, 10)}`;

  // ── 1. Other Crew section ─────────────────────────────────────────────────
  // Run on flat (no newlines). ROW_RE requires a full 4-digit year so that
  // employee IDs (which follow "CP - " / "FO - " patterns, never a YYYY date)
  // cannot be mistaken for flight number tokens.
  if (otherCrewIdx !== -1) {
    const ocBoundary = flat.slice(otherCrewIdx).search(
      /\b(?:Training\s+Details|Hotel\s+Details|Transfer\s+Details)\b/i
    );
    const section = flat.slice(
      otherCrewIdx,
      ocBoundary !== -1 ? otherCrewIdx + ocBoundary : flat.length
    );

    const ROW_RE = /(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{3,5})\s+/g;
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

  // ── 2a. GRID-FIRST path (preferred — requires page-1 items) ───────────────
  // Ignores text-based regex completely and reads the calendar grid by
  // x-coordinate, so sectors end up under the correct date column regardless
  // of what the Other Crew section claims.
  let usedGridFirst = false;
  if (Array.isArray(page1Items) && page1Items.length) {
    const gridSectors = parseGridFromItems(page1Items, pilot, year, mo);
    if (gridSectors.length) {
      usedGridFirst = true;

      // Build a flight_no -> is_dht lookup from OC (only signal we still
      // need from pages 2+, because it requires employee_id matching).
      // Key is `flt|YYYY-MM-DD` so multi-occurrence flights don't confuse.
      const dhtByKey = new Map();
      const dhfByKey = new Map();
      for (const oc of ocSectors) {
        const key = `${oc.flight_no}|${oc.date}`;
        if (oc.is_dht) dhtByKey.set(key, true);
        if (oc.is_dhf) dhfByKey.set(key, true);
      }

      for (const gs of gridSectors) {
        const key = `${gs.flight_no}|${gs.date}`;
        // Also match OC entries one day off (e.g. 6E770 grid=2026-01-13 but
        // OC says 2026-01-12 — still pick up its DHT flag if set).
        const [y2, m2, d2] = gs.date.split("-").map(Number);
        const prev = `${gs.flight_no}|${y2}-${String(m2).padStart(2, "0")}-${String(d2 - 1).padStart(2, "0")}`;
        const next = `${gs.flight_no}|${y2}-${String(m2).padStart(2, "0")}-${String(d2 + 1).padStart(2, "0")}`;
        const is_dht = dhtByKey.get(key) || dhtByKey.get(prev) || dhtByKey.get(next) || false;
        const is_dhf = gs.is_dhf || dhfByKey.get(key) || dhfByKey.get(prev) || dhfByKey.get(next) || false;

        sectors.push({
          ...gs,
          is_dhf,
          is_dht,
        });
      }
    }
  }

  // ── 2b. Text-fallback path (legacy — no page1Items available) ─────────────
  if (!usedGridFirst) {
    const page1Text = otherCrewIdx !== -1 ? flat.slice(0, otherCrewIdx) : flat;
    const G_RE = /\b(\d{3,5})\s+(A?)(\d{1,2}:\d{2})\s+(\*?)([A-Z]{3})[\s\u2192\u2193]{1,120}([A-Z]{3})\s{0,20}(?:(A?)(\d{1,2}:\d{2}))?/gu;
    const gridSectors = [];
    let gm;
    while ((gm = G_RE.exec(page1Text)) !== null) {
      gridSectors.push({
        flight_no: normFlt(gm[1]),
        atd_local: gm[2] === "A" ? hhmm(gm[3]) : null,
        dep: gm[5].toUpperCase(),
        arr: gm[6].toUpperCase(),
        ata_local: (gm[7] === "A" && gm[8]) ? hhmm(gm[8]) : null,
        star: gm[4] === "*",
      });
    }

    if (ocSectors.length) {
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
          _dateFromOC: true,
        });
      }
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
  }

  // ── 3. Hotel section ───────────────────────────────────────────────────────
  parseHotelSection(flat, sectors, hotels);

  // ── 4. Transfer section — only applied in text-fallback path.
  // The grid-first path already has authoritative dates from x-coordinates,
  // so applying transfer corrections there can only introduce regressions.
  if (!usedGridFirst) {
    const transfers = parseTransferSection(flat);
    applyTransferDateCorrections(sectors, transfers);
  }

  return { format: "GRID", month, pilot, sectors, hotels };
}

function parseHotelSection(text, sectors, hotels) {
  const hotelIdx = text.search(/\bHotel\s+Information\b/i);
  if (hotelIdx === -1) return;
  // Stop at the following section (Transfer Information) so we don't scan past.
  let section = text.slice(hotelIdx, hotelIdx + 5000);
  const cut = section.search(/\bTransfer\s+Information\b/i);
  if (cut !== -1) section = section.slice(0, cut);

  // Real PCSR hotel layout (linearised):
  //   "TRZ   TRZ HOTEL   11/01/2026 - BLOSSOMS_TRZ 12/01/2026 - BLOSSOMS_TRZ"
  //   "HYD   HYD HOTEL   16/01/2026 - NOVOTELHYD"
  // The entry starts with an IATA code doubled (e.g. "TRZ   TRZ HOTEL"), then
  // one or more "DD/MM/YYYY - HOTEL_NAME" pairs. Check-in/check-out times are
  // NOT in this section; they live in Transfer Information.
  const BLOCK_RE = /\b([A-Z]{3})\s+\1\s+HOTEL\s+((?:\d{1,2}\/\d{1,2}\/\d{2,4}\s*-\s*\S+\s*)+)/gi;
  let bm;
  while ((bm = BLOCK_RE.exec(section)) !== null) {
    const station = bm[1].toUpperCase();
    const body = bm[2];
    // Pull every "DD/MM/YYYY - NAME" pair out of this block.
    const DATE_RE = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\S+)/g;
    let dm;
    while ((dm = DATE_RE.exec(body)) !== null) {
      const date = parseDate(dm[1]);
      if (!date) continue;
      hotels.push({
        date,
        station,
        hotel_name: dm[2],
        check_in: null,
        check_out: null,
      });
    }
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
  // Stop at the following section so we don't scan into "Pax Transfer Information".
  const idx = text.search(/\bTransfer\s+(?:Information|Details)\b/i);
  if (idx === -1) return [];
  let section = text.slice(idx, idx + 5000);
  const paxIdx = section.search(/\bPax\s+Transfer\s+Information\b/i);
  if (paxIdx !== -1) section = section.slice(0, paxIdx);

  const entries = [];
  // Format in the PCSR text stream (linearised):
  //   "Airport to Hotel:   11/01/2026   18:00   TRZ TRANSPORT"
  //   "Hotel to Airport:   13/01/2026   03:40   TRZ TRANSPORTER"
  // The IATA station code sits immediately AFTER the time, before the
  // transport company name (which may be "TRANSPORT", "TRANSPORTER", etc.).
  const ENTRY_RE = /(Airport\s+to\s+Hotel|Hotel\s+to\s+Airport)[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s+(\d{1,2}:\d{2})\s+([A-Z]{3})\b/gi;
  let m;
  while ((m = ENTRY_RE.exec(section)) !== null) {
    const type = /Airport\s+to\s+Hotel/i.test(m[1]) ? "inbound" : "outbound";
    const date = parseDate(m[2]);
    if (!date) continue;
    entries.push({
      type,
      date,
      time: hhmm(m[3]),
      station: m[4].toUpperCase(),
    });
  }
  return entries;
}

/**
 * CRITICAL DATE CORRECTION — apply before finalising any sector date.
 *
 * Step 1: Transfer Information entries override whatever date the PCSR grid implies.
 *   "Hotel to Airport" (outbound) → the sector DEPARTING from that station gets that date.
 *   "Airport to Hotel" (inbound)  → the sector ARRIVING at that station gets that date.
 *   Match: station equality only; entries with no station are skipped.
 *
 * Step 2: For early-morning sectors (ATD 00:01–08:00) not covered by Transfer
 *   Information, look at the immediately preceding sector. If it arrived at the same
 *   station, the departure date is the SAME calendar date as that arrival (the PCSR
 *   grid tends to assign the wrong date for these overnight-continuation sectors).
 */
export function applyTransferDateCorrections(sectors, transfers) {
  const outbound = transfers.filter(t => t.type === "outbound"); // Hotel to Airport
  const inbound  = transfers.filter(t => t.type === "inbound");  // Airport to Hotel

  // Track which sectors were corrected in Step 1 so Step 2 skips them.
  const correctedInStep1 = new Set();

  // Days-between helper. Strings are YYYY-MM-DD ISO dates.
  const daysBetween = (a, b) => {
    if (!a || !b) return Infinity;
    const da = new Date(a).getTime();
    const db = new Date(b).getTime();
    if (isNaN(da) || isNaN(db)) return Infinity;
    return Math.abs((da - db) / 86400000);
  };

  // Step 1 — station-based matching. The Other Crew section is the
  // authoritative date source for flight sectors in the GRID format, so
  // skip sectors whose date came from OC. Transfer dates then only
  // correct grid-only sectors whose dates are inferred. We also keep the
  // date-proximity gate so a single transfer entry can't reach across
  // the month to clobber unrelated sectors.
  const NEAR_DAYS = 1;

  for (let i = 0; i < sectors.length; i++) {
    const s = sectors[i];
    if (s._dateFromOC) continue;

    for (const tr of outbound) {
      if (!tr.station) continue;
      if (s.dep !== tr.station) continue;
      if (daysBetween(s.date, tr.date) > NEAR_DAYS) continue;
      s.date = tr.date;
      correctedInStep1.add(i);
      break;
    }

    for (const tr of inbound) {
      if (!tr.station) continue;
      if (s.arr !== tr.station) continue;
      if (daysBetween(s.date, tr.date) > NEAR_DAYS) continue;
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
    if (s.date !== prev.date) continue; // OC already assigned a different date — trust it
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
  const { pdfArrayBufferToItems } = await import("./pdfToText.js");
  const { pages } = await pdfArrayBufferToItems(buffer);
  const rawText = pages.map(p => p.items.map(it => it.str).join(" ")).join("\n");

  const format = detectFormat(rawText);

  let result;
  if (format === "EOM") {
    result = parseEom(rawText);
  } else {
    const page1Items = pages[0]?.items ?? [];
    result = parseGrid(rawText, rawText, page1Items);
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
 * Falls back to text-based grid parsing (no x-coordinate dating).
 */
export function parsePcsrText(rawText) {
  const format = detectFormat(rawText);
  if (format === "EOM") return parseEom(rawText);
  return parseGrid(rawText, rawText);
}

/**
 * Parse PCSR from pre-extracted page items (diagnostic harness / Node-side).
 * Prefers the grid-first (x-coordinate) path when items are available.
 */
export function parsePcsrItems(pages) {
  const rawText = pages.map(p => p.items.map(it => it.str).join(" ")).join("\n");
  const format = detectFormat(rawText);
  if (format === "EOM") return parseEom(rawText);
  const page1Items = pages[0]?.items ?? [];
  return parseGrid(rawText, rawText, page1Items);
}
