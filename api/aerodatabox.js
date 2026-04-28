// Vercel serverless — proxies AeroDataBox, key never reaches browser.
// Returns scheduled + actual times and aircraft reg for one flight leg.
// Cached in Supabase flight_schedule_cache by the client after each call.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { flight, dep, arr, date } = req.query;
  if (!flight || !dep || !arr || !date) {
    return res.status(400).json({ error: "Missing params: flight, dep, arr, date required" });
  }
  if (!process.env.RAPIDAPI_KEY) {
    return res.status(500).json({ error: "RAPIDAPI_KEY not configured on server" });
  }

  // NOTE: ADB interprets `date` as a calendar day in the airport's local time
  // (which for IndiGo's DEL/BOM/etc. is also IST). For early-IST-morning
  // flights this happens to align with the IST date in our PCSR, so this
  // works in practice — but the alignment is implicit, not explicit. If we
  // ever need ADB for a non-Indian dep airport, this would need an IST→UTC
  // shift like the FR24 and AeroAPI proxies do.
  const url = `https://aerodatabox.p.rapidapi.com/flights/number/${encodeURIComponent(flight)}/${date}`;

  let raw;
  try {
    const response = await fetch(url, {
      headers: {
        "x-rapidapi-host": "aerodatabox.p.rapidapi.com",
        "x-rapidapi-key":  process.env.RAPIDAPI_KEY,
      },
    });
    if (!response.ok) {
      return res.status(response.status).json({ error: `AeroDataBox returned ${response.status}` });
    }
    raw = await response.json();
  } catch (err) {
    return res.status(500).json({ error: `Fetch failed: ${err.message}` });
  }

  // AeroDataBox returns an array of legs for the flight number on that date.
  // Find the leg matching dep→arr airports.
  const legs = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const leg = legs.find(f =>
    f?.departure?.airport?.iata === dep &&
    f?.arrival?.airport?.iata   === arr
  );
  if (!leg) {
    return res.status(404).json({ error: `No ${dep}→${arr} leg found for ${flight} on ${date}` });
  }

  // Extract HH:MM from a local datetime string like "2026-01-07 23:30+05:30"
  const hhmm = str => str?.match(/\d{4}-\d{2}-\d{2}[\sT](\d{2}:\d{2})/)?.[1] ?? null;

  return res.json({
    std_local:    hhmm(leg?.departure?.scheduledTime?.local),
    sta_local:    hhmm(leg?.arrival?.scheduledTime?.local),
    atd_local:    hhmm(leg?.departure?.actualTime?.local),
    ata_local:    hhmm(leg?.arrival?.actualTime?.local),
    aircraft_reg: leg?.aircraft?.reg ?? null,
  });
}
