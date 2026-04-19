// Vercel serverless — sends PCSR PDF + context to Claude, returns structured allowance JSON.
// ANTHROPIC_API_KEY must be set in Vercel environment variables (no VITE_ prefix).

export const maxDuration = 60;

function buildPrompt(pilot, sv_data, scheduled_times) {
  return `Calculate IndiGo pilot allowances from the attached PCSR PDF and return this JSON object — nothing else:

{
  "period": "Month YYYY",
  "allowances": {
    "deadhead": {"sectors":[{"flight":"","date":"","dep":"","arr":"","std":"","sta":"","block_mins":0,"amount":0}],"total":0},
    "layover":  {"stations":[{"station":"","date_in":"","date_out":"","chocks_on":"","chocks_off":"","duration_hrs":0,"base":0,"extra":0,"total":0}],"total":0},
    "transit":  {"halts":[{"station":"","date":"","arrived":"","departed":"","sched_halt":0,"actual_halt":0,"basis":"","billable_mins":0,"amount":0}],"total":0},
    "night":    {"sectors":[{"flight":"","date":"","dep":"","arr":"","std":"","sv":0,"sv_arrival":"","night_mins":0,"amount":0}],"total":0},
    "tail_swap":{"swaps":[{"date":"","sectors":"","station":"","reg_out":"","reg_in":"","status":"confirmed","amount":0}],"total":0}
  },
  "grand_total":0
}

PILOT:
- Employee ID: ${pilot.employee_id}
- Home Base: ${pilot.home_base}
- Rank: ${pilot.rank}

SECTOR VALUES (minutes, from 6eBreeze SV report):
${JSON.stringify(sv_data)}

SCHEDULED TIMES FROM AERODATABOX (keyed flight|dep|arr|date):
${JSON.stringify(scheduled_times)}

RATES:
- Deadhead (§1.0): ₹4,000 per scheduled block hour, prorated to minute. Scheduled block = AeroDataBox STA − STD.
- Layover (§2.0): ₹3,000 flat for 10:01–24:00h away from home base. Beyond 24h: +₹150 per hour rounded UP to next hour.
- Tail Swap (§6.0): ₹1,500 per swap. A swap = aircraft_reg changes between consecutive sectors in same duty.
- Transit (§7.0): ₹1,000/hr prorated to minute, capped at 4 hours (₹4,000 max per halt).
- Night Flying (§9.0): ₹2,000 per night hour, prorated to minute.

STEP 1 — PARSE SECTORS FROM THE PCSR PDF:
Extract every flight sector for employee ${pilot.employee_id}.
For each sector record: date (YYYY-MM-DD), flight, dep, arr, atd (HH:MM), ata (HH:MM), is_dhf, is_dht.
A sector is DHF if the employee appears as "DHF" in the Other Crew section for that flight, or if there is an asterisk on the departure airport in the grid.
A sector is DHT if the employee appears as "DHT" in the Other Crew section.
IMPORTANT: Use the Transfer Information section to validate dates for early-morning sectors.
"Hotel to Airport: DD/MM/YYYY" means the outbound sector from that station is on that date.
"Airport to Hotel: DD/MM/YYYY" means the inbound sector to that station is on that date.
IMPORTANT: When a sector's ATA is earlier than its ATD (e.g. ATD 23:37, ATA 01:23), the ATA is on the next calendar day.
Do NOT include training entries from the Training Details section as sectors.

STEP 2 — GROUP INTO DUTIES:
A new duty starts when the gap between the previous sector's ATA and the next sector's ATD exceeds 8 hours.
Apply midnight crossing correction before computing gaps: if ATA < ATD on the same date, ATA belongs to ATD_date + 1 day.

STEP 3 — DEADHEAD (§1.0):
For each DHF sector, find its entry in scheduled_times to get STD and STA.
Scheduled block minutes = STA − STD (handle overnight: if STA < STD, add 24h).
Pay = block_minutes × (4000 / 60), rounded to nearest rupee.
Only DHF sectors qualify. Do not use actual block or SV for this calculation.

STEP 4 — LAYOVER (§2.0):
A layover exists when: the last sector of duty N arrives at a station that is NOT ${pilot.home_base}, AND the first sector of duty N+1 departs FROM that same station.
DHF sectors are valid as the outbound leg of a layover.
Chocks-ON = ATA of the last sector of duty N (apply midnight correction if needed).
Chocks-OFF = ATD of the first sector of duty N+1. If ATD is missing, use AeroDataBox scheduled STD for that sector.
Duration = Chocks-OFF minus Chocks-ON in hours.
If duration <= 10h01m: no allowance.
If duration 10h01m to 24h00m: ₹3,000.
If duration > 24h00m: ₹3,000 + (ceil(duration_hours - 24) × ₹150).

STEP 5 — TRANSIT (§7.0):
For every consecutive sector pair within the same duty:
- SKIP if either sector is DHT. DHF is NOT DHT — do not skip DHF pairs.
- Compute scheduled halt = scheduled_times[arr_flight].sta to scheduled_times[dep_flight].std.
- Compute actual halt = ATA of arriving sector to ATD of departing sector (apply midnight correction).
- Eligibility:
  Condition (i): scheduled halt >= 90 minutes
  Condition (ii): actual halt >= 90 minutes AND |actual - scheduled| > 15 minutes
  If neither condition met: no allowance.
- If eligible:
  If |actual - scheduled| <= 15 minutes: pay on scheduled halt minutes.
  If |actual - scheduled| > 15 minutes: pay on actual halt minutes.
  Billable minutes = min(pay_basis, 240).
  Pay = billable_minutes × (1000 / 60), rounded to nearest rupee.

STEP 6 — NIGHT FLYING (§9.0):
For each NON-DHF sector:
1. Look up STD from scheduled_times. If not found: skip this sector, night_mins = 0.
2. If STD >= 06:00 IST: skip this sector, night_mins = 0.
3. Look up SV from sv_data using flight number (without "6E"), dep, arr, and the UTC time slot of STD (STD IST minus 5 hours 30 minutes, then take the hour).
4. SV_arrival_IST = STD + SV minutes (handle midnight crossing).
5. Night window = 00:01 to 06:00 IST.
6. Night minutes = overlap of [STD, SV_arrival] with [00:01, 06:00].
7. Pay = night_minutes × (2000 / 60), rounded to nearest rupee.
Do NOT use ATD or ATA for this calculation. Only STD and SV.

STEP 7 — TAIL SWAP (§6.0):
For every consecutive sector pair within the same duty:
- SKIP if either sector is DHT.
- SKIP if both sectors are DHF.
- Look up aircraft_reg from scheduled_times for both sectors.
- If both regs are known AND they differ: count as one tail swap, pay ₹1,500.
- If either reg is null: set status "unverifiable" for that pair.

Do not write any text outside the JSON object.
`;
}

// Map Claude's output shape → UI shape expected by CalcScreen
function normalise(c) {
  const a = c.allowances || {};

  const dh = a.deadhead || {};
  const dhSectors = (dh.sectors || []).map(s => ({
    date:                 s.date   || "",
    flight:               s.flight || "",
    from:                 s.dep    || "",
    to:                   s.arr    || "",
    scheduled_block_mins: s.block_mins ?? 0,
    amount:               s.amount    ?? 0,
  }));

  const lv = a.layover || {};
  const lvEvents = (lv.stations || []).map(e => ({
    station:       e.station      || "",
    date_in:       e.date_in      || "",
    date_out:      e.date_out     || "",
    check_in_ist:  e.chocks_on    || "",
    check_out_ist: e.chocks_off   || "",
    duration_hrs:  e.duration_hrs ?? 0,
    base_amount:   e.base         ?? 0,
    extra_amount:  e.extra        ?? 0,
    total:         e.total        ?? 0,
  }));

  const ts = a.tail_swap || {};
  const tsSwaps = (ts.swaps || []).filter(s => s.status !== "unverifiable").map(s => ({
    date:        s.date    || "",
    sector_pair: s.sectors || "",
    station:     s.station || "",
    reg_out:     s.reg_out || "",
    reg_in:      s.reg_in  || "",
    amount:      s.amount  ?? 0,
  }));

  const tr = a.transit || {};
  const trHalts = (tr.halts || []).map(h => ({
    date:          h.date         || "",
    station:       h.station      || "",
    arrived_ist:   h.arrived      || "",
    departed_ist:  h.departed     || "",
    halt_mins:     h.actual_halt  ?? h.sched_halt ?? 0,
    billable_mins: h.billable_mins ?? 0,
    basis:         h.basis        || "scheduled",
    amount:        h.amount       ?? 0,
  }));

  const nt = a.night || {};
  const ntSectors = (nt.sectors || []).map(s => ({
    date:      s.date       || "",
    flight:    s.flight     || "",
    from:      s.dep        || "",
    to:        s.arr        || "",
    std_ist:   s.std        || "",
    sta_ist:   s.sv_arrival || "",
    night_mins: s.night_mins ?? 0,
    sv_used:   s.sv         ?? 0,
    amount:    s.amount     ?? 0,
  }));

  return {
    period: c.period || "",
    pilot:    c.pilot || {},
    deadhead: { sectors: dhSectors, total_mins: dhSectors.reduce((s, x) => s + (x.scheduled_block_mins || 0), 0), amount: dh.total ?? 0 },
    night:    { sectors: ntSectors, total_mins: ntSectors.reduce((s, x) => s + (x.night_mins || 0), 0),           amount: nt.total ?? 0 },
    layover:  { events: lvEvents,   amount: lv.total ?? 0 },
    tailSwap: { swaps: tsSwaps,     count: tsSwaps.length, amount: ts.total ?? 0 },
    transit:  { halts: trHalts,     amount: tr.total ?? 0 },
    total: c.grand_total ?? 0,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { pdf_base64, sv_data, pilot, scheduled_times } = req.body ?? {};
  if (!pdf_base64) return res.status(400).json({ error: "pdf_base64 required" });
  if (!pilot)      return res.status(400).json({ error: "pilot required" });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on server" });
  }

  const prompt = buildPrompt(pilot, sv_data ?? [], scheduled_times ?? {});

  let anthropicRes;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta":    "pdfs-2024-09-25",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        max_tokens: 16000,
        system: "You are a JSON calculator. You output ONLY a single valid JSON object. You never write any text, explanation, reasoning, steps, or markdown outside the JSON. Your response starts with { and ends with }. If you are tempted to explain your reasoning, put it inside a JSON field called \"_debug\" instead.",
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf_base64 } },
            { type: "text",     text: prompt },
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
  console.log("[calculate] Claude raw response length:", text?.length);
  console.log("[calculate] Claude stop_reason:", data.stop_reason);
  console.log("[calculate] Claude raw (first 500):", text?.slice(0, 500));
  console.log("[calculate] Claude raw (last 300):", text?.slice(-300));
  if (!text) return res.status(500).json({ error: "Empty response from Claude" });

  let raw;
  try {
    const stripped = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "");
    const start = stripped.indexOf("{");
    const end   = stripped.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON object found in response");
    raw = JSON.parse(stripped.slice(start, end + 1));
  } catch (parseErr) {
    return res.status(500).json({
      error: `Claude response was not valid JSON: ${parseErr.message}`,
      raw_first500: text?.slice(0, 500),
      raw_last300:  text?.slice(-300),
      stop_reason:  data.stop_reason,
    });
  }

  return res.json(normalise(raw));
}
