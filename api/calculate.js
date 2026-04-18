// Vercel serverless — sends PCSR PDF + context to Claude, returns structured allowance JSON.
// ANTHROPIC_API_KEY must be set in Vercel environment variables (no VITE_ prefix).

export const maxDuration = 60; // Vercel Pro: allow up to 60s for Claude response

const rankBucket = r => {
  const v = (r || "").toLowerCase();
  if (v.includes("cabin")) return "Cabin Crew";
  if (v.includes("first") || v.includes("fo")) return "First Officer";
  return "Captain";
};

function buildPrompt(pilot, bkt, sv_csv, scheduled_times, rates) {
  const dhRate = (rates?.deadhead?.[bkt]) ?? 4000;
  const nRate  = (rates?.night?.[bkt])    ?? 2000;
  const tsRate = (rates?.tailSwap?.[bkt]) ?? 1500;
  const trRate = (rates?.transit?.[bkt])  ?? 1000;
  const lvRate = (rates?.layover?.[bkt])  ?? { base: 3000, beyondRate: 150 };

  return `You are calculating IndiGo pilot allowances for the attached PCSR PDF.

PILOT PROFILE:
- Name: ${pilot.name}
- Employee ID: ${pilot.employee_id}
- Home Base: ${pilot.home_base}
- Rank: ${pilot.rank}

RATES (PAH FLT Issue 01 Rev 46):
- Deadhead (DHF): ₹${dhRate}/scheduled block hour, pro-rated to the minute. Use AeroDataBox STA−STD. Fall back to actual ATA−ATD only if both scheduled times are missing.
- Night Flying: ₹${nRate}/night hour. STD (not ATD) + SV minutes, intersected with 00:01–06:00 IST window.
- Layover: ₹${lvRate.base} flat for 10h01m–24h; +₹${lvRate.beyondRate}/hr beyond 24h, rounded up each hour.
- Tail Swap: ₹${tsRate} per swap.
- Transit: ₹${trRate}/hr, capped 4h.

SECTOR VALUE TABLE (SV in minutes — for night flying only):
Columns: FLTNBR, DEP, ARR, Time_Slot (UTC "H_H+1"), SectorValue
UTC slot = floor((STD_IST_minutes − 330 + 1440) % 1440 / 60)
${sv_csv || "(none)"}

AERODATABOX SCHEDULE DATA (keyed "flight_no|dep|arr|date" = YYYY-MM-DD):
Each value: { std_local, sta_local, atd_local, ata_local, aircraft_reg }
${JSON.stringify(scheduled_times ?? {})}

CALCULATION RULES — follow exactly:

1. PARSE ALL SECTORS from the PCSR PDF.
   - Grid format: calendar grid on page 1 gives flight number, dep, arr, actual times. Other Crew section gives dates and DHF/DHT flags for employee ${pilot.employee_id}.
   - EOM format: tabular rows with date, route, actual times.
   - DATE CORRECTION: the Transfer Information section lists "Hotel to Airport: DD/MM/YYYY HH:MM" entries. For any sector with ATD between 00:00–08:00 whose parsed date doesn't match the transfer date, use the transfer date. This is authoritative for early-morning departures.

2. DHF = this pilot is a passenger (deadhead flying). Identified by: asterisk on departure airport in grid (*DEP), OR "DHF" next to employee ID ${pilot.employee_id} in Other Crew section.
   DHT = other crew deadheading on this pilot's sector — exclude from all allowances.

3. GROUP INTO DUTIES: consecutive sectors with ATA→ATD gap < 601 minutes are in the same duty.
   MIDNIGHT CROSSING: if a sector's ATA (clock time) is earlier than its ATD (clock time), the actual landing was on ATD_date + 1 day. Use the corrected ATA date when computing the ATA→ATD gap to the next sector.

4. DEADHEAD: for each DHF sector, block = AeroDataBox STA − STD. If STA/STD unavailable, use ATA − ATD (add 1440 if negative for overnight).

5. LAYOVER: applies when duty N ends at an outstation (not ${pilot.home_base}) AND duty N+1's first sector departs from that same outstation.
   - DHF sectors ARE valid outbound legs (pilot deadheading home after layover still earns allowance).
   - Chocks-ON = ATA of the last sector of duty N (PCSR actual only).
   - Chocks-OFF = ATD of the first sector of duty N+1. If ATD is blank and it is a DHF sector, use AeroDataBox STD as fallback.
   - Midnight correction: if the inbound sector crossed midnight (ATA < ATD by clock), chocks-ON date = inbound sector date + 1 day.
   - Date continuity: if the parser assigned the outbound sector the wrong date, derive checkout date by ensuring chocks-OFF is chronologically after chocks-ON. If computed duration < 0, add 1 day.
   - Duration must EXCEED 10h 01m (601 minutes). Extra rate beyond 24h is rounded up per full hour.

6. TRANSIT: for consecutive sector pairs within the same duty where arr of sector A == dep of sector B:
   - Gap > 480 min (8h): skip — different operational duties for transit purposes.
   - Qualification threshold: SCHEDULED gap ≥ 90 min (even if actual < 90 min).
   - Billing: use actual gap if it differs > 15 min from scheduled; otherwise use scheduled gap.
   - Cap billing at 240 min (4h). DHT sectors excluded.

7. NIGHT FLYING: operating (non-DHF, non-DHT) sectors only. Use STD (not ATD). SV lookup: find row matching FLTNBR + DEP + ARR + UTC time slot. Night minutes = intersection of [STD_IST, STD_IST + SV] with [1 min, 360 min] (00:01–06:00 IST).

8. TAIL SWAP: within each duty, for consecutive non-DHT sector pairs where arr == dep of next:
   - Both aircraft_reg values must be known and different.
   - Op→Op, Op→DHF, DHF→Op qualify. DHF→DHF does not. DHT excluded.

Return ONLY valid JSON — no markdown fences, no explanatory text. Use this exact structure (empty arrays when no events):
{
  "period": "<Month YYYY>",
  "pilot": { "rank": "${pilot.rank}", "homeBase": "${pilot.home_base}" },
  "deadhead": {
    "sectors": [{ "date": "YYYY-MM-DD", "flight": "6EXXXX", "from": "AAA", "to": "BBB", "scheduled_block_mins": 0, "amount": 0 }],
    "total_mins": 0,
    "amount": 0
  },
  "night": {
    "sectors": [{ "date": "YYYY-MM-DD", "flight": "6EXXXX", "from": "AAA", "to": "BBB", "std_ist": "HH:MM", "sta_ist": "HH:MM", "night_mins": 0, "sv_used": 0, "amount": 0 }],
    "total_mins": 0,
    "amount": 0
  },
  "layover": {
    "events": [{ "station": "AAA", "date_in": "YYYY-MM-DD", "date_out": "YYYY-MM-DD", "check_in_ist": "HH:MM", "check_out_ist": "HH:MM", "duration_hrs": 0, "base_amount": 0, "extra_amount": 0, "total": 0 }],
    "amount": 0
  },
  "tailSwap": {
    "swaps": [{ "date": "YYYY-MM-DD", "sector_pair": "6EXXXX→6EXXXX", "station": "AAA", "reg_out": "VT-XXX", "reg_in": "VT-XXX", "amount": 0 }],
    "count": 0,
    "amount": 0
  },
  "transit": {
    "halts": [{ "date": "YYYY-MM-DD", "station": "AAA", "arrived_ist": "HH:MM", "departed_ist": "HH:MM", "halt_mins": 0, "billable_mins": 0, "basis": "scheduled", "amount": 0 }],
    "amount": 0
  },
  "total": 0
}`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { pdf_base64, sv_csv, pilot, scheduled_times, rates } = req.body ?? {};
  if (!pdf_base64) return res.status(400).json({ error: "pdf_base64 required" });
  if (!pilot)      return res.status(400).json({ error: "pilot required" });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on server" });
  }

  const bkt    = rankBucket(pilot.rank);
  const prompt = buildPrompt(pilot, bkt, sv_csv, scheduled_times, rates);

  let anthropicRes;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":     "application/json",
        "x-api-key":        process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta":   "pdfs-2024-09-25",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        max_tokens: 8192,
        messages: [{
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: pdf_base64 },
            },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
  } catch (fetchErr) {
    return res.status(500).json({ error: `Anthropic API request failed: ${fetchErr.message}` });
  }

  if (!anthropicRes.ok) {
    let body = "";
    try { body = await anthropicRes.text(); } catch { /* ignore */ }
    return res.status(500).json({ error: `Anthropic API ${anthropicRes.status}: ${body.slice(0, 300)}` });
  }

  const data = await anthropicRes.json();
  const text = data.content?.[0]?.text;
  if (!text) return res.status(500).json({ error: "Empty response from Claude" });

  let result;
  try {
    const clean = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();
    result = JSON.parse(clean);
  } catch (parseErr) {
    return res.status(500).json({
      error: `Claude response was not valid JSON: ${parseErr.message}`,
      raw:   text.slice(0, 600),
    });
  }

  return res.json(result);
}
