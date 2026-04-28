// Vercel serverless — proxies the Flightradar24 API, key never reaches browser.
// Returns scheduled + actual times and aircraft reg for one flight leg.
//
// FR24 Flight Summary is a HISTORICAL product: it returns flights that have
// already operated. On the tier the app targets, only the LAST 30 DAYS of
// data are accessible. Requests outside that window return 404 with a clear
// message so the client can either fall back to the cache or to AeroDataBox.
//
// Same response shape as /api/aerodatabox so the client can treat the two
// proxies as interchangeable.
//
// Configuration:
//   FR24_API_TOKEN   — bearer token from https://fr24api.flightradar24.com
//
// Docs reference (FR24 Flight Summary "full" endpoint):
//   https://fr24api.flightradar24.com/docs/endpoints#get-flight-summary-full

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { flight, dep, arr, date, debug } = req.query;
  if (!flight || !dep || !arr || !date) {
    return res.status(400).json({ error: "Missing params: flight, dep, arr, date required" });
  }
  if (!process.env.FR24_API_TOKEN) {
    return res.status(500).json({ error: "FR24_API_TOKEN not configured on server" });
  }

  // ── Future-date guard ──────────────────────────────────────────────────────
  // FR24 Flight Summary covers past flights only. Future dates are rejected
  // up front (with a 1-day grace for timezone ambiguity).
  // Note: the 30-day historical limit applied to the Explorer tier; on
  // Essential ($90/mo) we have 2 years of history, so no upper-bound guard.
  const target = new Date(date + "T00:00:00Z");
  if (isNaN(target)) {
    return res.status(400).json({ error: `Invalid date: ${date}` });
  }
  const now = new Date();
  const daysAgo = (now - target) / 86400000;
  if (daysAgo < -1) {
    return res.status(404).json({
      error: `FR24 Flight Summary does not cover future flights; ${date} has not yet operated.`,
    });
  }

  // ── Call FR24 ──────────────────────────────────────────────────────────────
  // Bracket the query to the full local date (in UTC — the response carries
  // its own local times so day-boundary fuzziness is OK).
  const fromIso = `${date}T00:00:00`;
  const toIso   = `${date}T23:59:59`;
  const url = `https://fr24api.flightradar24.com/api/flight-summary/full`
            + `?flights=${encodeURIComponent(flight)}`
            + `&flight_datetime_from=${encodeURIComponent(fromIso)}`
            + `&flight_datetime_to=${encodeURIComponent(toIso)}`;

  let raw;
  try {
    const response = await fetch(url, {
      headers: {
        "Authorization":   `Bearer ${process.env.FR24_API_TOKEN}`,
        "Accept":          "application/json",
        "Accept-Version":  "v1",
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return res.status(response.status).json({
        error: `FR24 returned ${response.status}`,
        detail: body.slice(0, 300),
      });
    }
    raw = await response.json();
  } catch (err) {
    return res.status(500).json({ error: `Fetch failed: ${err.message}` });
  }

  // Debug: append `&debug=1` to the request to see the raw FR24 response
  // (admins use this when our field-name guesses don't match the real payload).
  if (debug) {
    return res.json({ _debug: true, _request: { flight, dep, arr, date }, raw });
  }

  // FR24 Flight Summary returns { data: [ ... ] } where each leg has:
  //   datetime_takeoff:  "2026-02-02T13:30:31Z"  (UTC actual departure)
  //   datetime_landed:   "2026-02-02T14:32:18Z"  (UTC actual arrival)
  //   orig_iata, dest_iata, reg, callsign, flight, flight_time (seconds)
  //
  // Note: FR24 does NOT publish scheduled times on this endpoint — they're a
  // flight tracker, not a schedule provider. We use actual times as the best
  // available substitute for both std/sta and atd/ata. This matches what
  // IndiGo actually pays based on (e.g. Deadhead is paid on airborne time).
  const records = Array.isArray(raw?.data) ? raw.data
                : Array.isArray(raw)       ? raw
                : [];
  const leg = records.find(r =>
    (r?.orig_iata === dep || r?.dep_iata === dep) &&
    (r?.dest_iata === arr || r?.arr_iata === arr)
  );
  if (!leg) {
    return res.status(404).json({
      error: `No ${dep}→${arr} leg found for ${flight} on ${date} in FR24 summary.`,
    });
  }

  // Convert ISO UTC timestamp → IST HH:MM (UTC+5:30).
  // All allowance rules are evaluated in IST per IndiGo's PAH.
  const utcToIstHhmm = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    // Add 5h 30m for IST.
    const ist = new Date(d.getTime() + (5 * 60 + 30) * 60 * 1000);
    const hh = String(ist.getUTCHours()).padStart(2, "0");
    const mm = String(ist.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  };

  const atd = utcToIstHhmm(leg.datetime_takeoff);
  const ata = utcToIstHhmm(leg.datetime_landed);

  // FR24 has actuals only; reuse them for scheduled times so calculations
  // that depend on STD/STA (Deadhead block hours, Night Flying eligibility)
  // can still proceed. Documented in calculate.js.
  return res.json({
    std_local:    atd,
    sta_local:    ata,
    atd_local:    atd,
    ata_local:    ata,
    aircraft_reg: leg?.reg ?? null,
    _source:      "fr24",
  });
}
