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

  const { flight, dep, arr, date } = req.query;
  if (!flight || !dep || !arr || !date) {
    return res.status(400).json({ error: "Missing params: flight, dep, arr, date required" });
  }
  if (!process.env.FR24_API_TOKEN) {
    return res.status(500).json({ error: "FR24_API_TOKEN not configured on server" });
  }

  // ── 30-day window guard ────────────────────────────────────────────────────
  // The target tier only exposes the previous 30 days. We reject dates outside
  // a ±1-day grace (to absorb tz ambiguity) around that window and tell the
  // client to try the alternate provider.
  const target = new Date(date + "T00:00:00Z");
  if (isNaN(target)) {
    return res.status(400).json({ error: `Invalid date: ${date}` });
  }
  const now = new Date();
  const daysAgo = (now - target) / 86400000;
  if (daysAgo > 31) {
    return res.status(404).json({
      error: `FR24 tier only exposes the last 30 days; ${date} is ${Math.floor(daysAgo)} days old. Use AeroDataBox for this sector.`,
    });
  }
  if (daysAgo < -1) {
    return res.status(404).json({
      error: `FR24 Flight Summary does not cover future flights; ${date} has not yet operated. Use AeroDataBox for forward rosters.`,
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

  // FR24 returns either an object with `data` array or an array directly,
  // depending on endpoint variant. Normalise.
  const records = Array.isArray(raw?.data) ? raw.data
                : Array.isArray(raw)       ? raw
                : [];
  // Match on dep/arr IATA. FR24 field names vary slightly between variants;
  // check common ones.
  const pickIata = (r, side) =>
    r?.[`${side}_iata`] ?? r?.[`${side}_airport_iata`] ?? r?.airport?.[side]?.iata ?? null;
  const leg = records.find(r =>
    pickIata(r, "orig") === dep && pickIata(r, "dest") === arr
  ) || records.find(r =>
    pickIata(r, "dep") === dep && pickIata(r, "arr") === arr
  );
  if (!leg) {
    return res.status(404).json({
      error: `No ${dep}→${arr} leg found for ${flight} on ${date} in FR24 summary.`,
    });
  }

  // Extract HH:MM (local) from an ISO datetime string. FR24 typically provides
  // both UTC and local. Prefer local. If only UTC is present, pass it through
  // — the client expects local times but we can't synthesise a timezone here.
  const hhmm = str => {
    if (!str) return null;
    const m = String(str).match(/(\d{2}:\d{2})(?::\d{2})?/);
    return m ? m[1] : null;
  };

  return res.json({
    std_local:    hhmm(leg?.datetime_sched_dep_local ?? leg?.datetime_sched_takeoff_local ?? leg?.std_local ?? leg?.scheduled_departure_local),
    sta_local:    hhmm(leg?.datetime_sched_arr_local ?? leg?.datetime_sched_landed_local ?? leg?.sta_local ?? leg?.scheduled_arrival_local),
    atd_local:    hhmm(leg?.datetime_takeoff_local   ?? leg?.datetime_actual_dep_local   ?? leg?.atd_local ?? leg?.actual_departure_local),
    ata_local:    hhmm(leg?.datetime_landed_local    ?? leg?.datetime_actual_arr_local   ?? leg?.ata_local ?? leg?.actual_arrival_local),
    aircraft_reg: leg?.reg ?? leg?.aircraft_reg ?? leg?.aircraft?.reg ?? null,
    _source: "fr24",
  });
}
