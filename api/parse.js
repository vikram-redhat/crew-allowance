export const maxDuration = 120;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { pcsr_text, employee_id } = req.body ?? {};
  if (!pcsr_text)    return res.status(400).json({ error: "pcsr_text required" });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  const prompt = `Extract all flight sectors for employee ${employee_id} from this PCSR text.

RULES:
- DHF = this pilot is a passenger. Detect by: asterisk on departure airport in the flight grid, OR "DHF - ${employee_id}" appearing next to this flight in the Other Crew section.
- DHT = other crew are passengers on this pilot's sector. Detect by: "DHT" appearing in the Other Crew section for this flight.
- Times prefixed with "A" in the PCSR grid are actuals (ATD/ATA). Times without "A" prefix are scheduled.
- The Transfer Information section contains ground truth dates. "Hotel to Airport: DD/MM/YYYY" means the outbound sector from that station is on that date. "Airport to Hotel: DD/MM/YYYY" means the inbound sector to that station is on that date. Use these to correct any early-morning sector dates that may be misassigned.
- The Training Details section contains time ranges that look like flight numbers (e.g. "1603 - 1835"). Do NOT parse these as sectors.
- The same flight number can appear twice in one duty (e.g. 6E6732 DEL→AMD then AMD→BOM). Use date+flight+dep+arr as unique key.
- Times are in HH:MM format (IST).

Return ONLY this JSON with no explanation, no markdown, starting with {:
{
  "period": "Month YYYY",
  "sectors": [
    {
      "date": "YYYY-MM-DD",
      "flight": "6EXXXX",
      "dep": "AAA",
      "arr": "BBB",
      "atd": "HH:MM or null",
      "ata": "HH:MM or null",
      "is_dhf": true,
      "is_dht": false
    }
  ]
}`;

  let anthropicRes;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        max_tokens: 8000,
        messages: [{
          role: "user",
          content: [{ type: "text", text: `PCSR TEXT CONTENT:\n${pcsr_text}\n\n${prompt}` }],
        }],
      }),
    });
  } catch (fetchErr) {
    return res.status(500).json({ error: `Anthropic API request failed: ${fetchErr.message}` });
  }

  if (!anthropicRes.ok) {
    let body = "";
    try { body = await anthropicRes.text(); } catch {}
    console.error("[parse] Anthropic error", anthropicRes.status, body);
    return res.status(500).json({ error: `Anthropic API ${anthropicRes.status}`, detail: body });
  }

  const data = await anthropicRes.json();
  const textBlocks = (data.content || []).filter(b => b.type === "text");
  const text = textBlocks.map(b => b.text).join("");
  console.log("[parse] stop_reason:", data.stop_reason, "text length:", text.length);

  try {
    const stripped = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "");
    const start = stripped.indexOf("{");
    const end   = stripped.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON object found");
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    console.log("[parse] sectors:", parsed.sectors?.length, "period:", parsed.period);
    return res.json(parsed);
  } catch (parseErr) {
    console.error("[parse] JSON parse error:", parseErr.message);
    return res.status(500).json({
      error:        `Parse response was not valid JSON: ${parseErr.message}`,
      raw_first500: text.slice(0, 500),
    });
  }
}
