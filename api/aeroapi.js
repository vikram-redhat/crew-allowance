// Vercel serverless — proxies the FlightAware AeroAPI, key stays server-side.
// Returns scheduled + actual times and aircraft reg for one flight leg.
//
// Why FlightAware: returns BOTH scheduled and actual gate times (FR24 gives only
// actuals). History back to Jan 2011, so older PCSRs work.
//
// Same response shape as /api/aerodatabox and /api/fr24 so the frontend treats
// all three as interchangeable.
//
// Configuration:
//   AEROAPI_KEY  — API key from https://www.flightaware.com/aeroapi/portal
//
// Docs reference: GET /history/flights/{ident}
//   https://www.flightaware.com/aeroapi/portal/documentation

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { flight, dep, arr, date, debug } = req.query;
  if (!flight || !dep || !arr || !date) {
    return res.status(400).json({ error: "Missing params: flight, dep, arr, date required" });
  }
  if (!process.env.AEROAPI_KEY) {
    return res.status(500).json({ error: "AEROAPI_KEY not configured on server" });
  }

  // Future-flight guard. AeroAPI's history endpoint rejects future dates,
  // so we catch them up front to give a clearer error.
  const target = new Date(date + "T00:00:00Z");
  if (isNaN(target)) return res.status(400).json({ error: `Invalid date: ${date}` });
  const now = new Date();
  if ((target - now) / 86400000 > 1) {
    return res.status(404).json({ error: `AeroAPI /history covers past flights only; ${date} has not yet operated.` });
  }

  // Date range: bracket the flight day in UTC. AeroAPI's `start` is inclusive,
  // `end` is exclusive — so we ask for date 00:00:00Z through next day 00:00:00Z.
  const startISO = `${date}T00:00:00Z`;
  const endDate  = new Date(target.getTime() + 86400000);
  const endISO   = endDate.toISOString().slice(0, 10) + "T00:00:00Z";

  // Strip any "6E" prefix — FA expects the bare number with operator code.
  // For IndiGo: ident "IGO2448" works (ICAO operator code).
  // We pass the raw flight (e.g. "6E2448") and let FA's designator parser handle
  // it, with ident_type=designator forcing flight-number interpretation.
  const ident = String(flight).trim();

  const url = `https://aeroapi.flightaware.com/aeroapi/history/flights/${encodeURIComponent(ident)}`
            + `?ident_type=designator`
            + `&start=${encodeURIComponent(startISO)}`
            + `&end=${encodeURIComponent(endISO)}`
            + `&max_pages=1`;

  let raw;
  try {
    const response = await fetch(url, {
      headers: {
        "x-apikey": process.env.AEROAPI_KEY,
        "Accept":   "application/json",
      },
    });
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("retry-after") || "0", 10);
      return res.status(429).json({ error: "AeroAPI rate limit", retryAfter });
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return res.status(response.status).json({
        error: `AeroAPI returned ${response.status}`,
        detail: body.slice(0, 300),
      });
    }
    raw = await response.json();
  } catch (err) {
    return res.status(500).json({ error: `Fetch failed: ${err.message}` });
  }

  if (debug) {
    return res.json({ _debug: true, _request: { flight, dep, arr, date }, raw });
  }

  // Match the right leg by orig/dest IATA. AeroAPI returns flights[] with
  // origin.code_iata / destination.code_iata.
  const flights = Array.isArray(raw?.flights) ? raw.flights : [];
  const leg = flights.find(f =>
    f?.origin?.code_iata === dep && f?.destination?.code_iata === arr
  );
  if (!leg) {
    return res.status(404).json({
      error: `No ${dep}→${arr} leg found for ${flight} on ${date}.`,
      detail: flights.length ? `Found ${flights.length} other legs that day.` : "No legs returned.",
    });
  }

  // ISO datetime → IST HH:MM (UTC+5:30) for the calculator (which works in IST).
  const utcToIstHhmm = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    const ist = new Date(d.getTime() + (5 * 60 + 30) * 60 * 1000);
    const hh = String(ist.getUTCHours()).padStart(2, "0");
    const mm = String(ist.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  };

  // Use gate times (scheduled_out/in, actual_out/in) — these are chocks-off /
  // chocks-on, matching what the PCSR uses for ATD/ATA.
  return res.json({
    std_local:    utcToIstHhmm(leg.scheduled_out),
    sta_local:    utcToIstHhmm(leg.scheduled_in),
    atd_local:    utcToIstHhmm(leg.actual_out),
    ata_local:    utcToIstHhmm(leg.actual_in),
    aircraft_reg: leg.registration ?? null,
    _source:      "aeroapi",
    _meta: {
      cancelled:        !!leg.cancelled,
      diverted:         !!leg.diverted,
      aircraft_type:    leg.aircraft_type ?? null,
    },
  });
}
