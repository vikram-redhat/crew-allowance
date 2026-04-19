// Vercel serverless — sends PCSR PDF + context to Claude, returns structured allowance JSON.
// ANTHROPIC_API_KEY must be set in Vercel environment variables (no VITE_ prefix).

export const maxDuration = 300; // extended thinking can take 60–120s

function buildPrompt(pilot, sv_data, scheduled_times, prior_month_tail) {
  return `From the attached PCSR PDF, calculate IndiGo allowances for employee ${pilot.employee_id}, home base ${pilot.home_base}.

AERODATABOX DATA (key="flight|dep|arr|date"): ${JSON.stringify(scheduled_times)}
SECTOR VALUES (FLTNBR/DEP/ARR/Time_Slot/SV_mins): ${JSON.stringify(sv_data)}
PRIOR MONTH TAIL (last duty of previous month, for spill-layover detection): ${JSON.stringify(prior_month_tail ?? null)}

RULES (apply silently, output only the final JSON):
- DHF = pilot is passenger (asterisk on dep in grid OR "DHF - ${pilot.employee_id}" in Other Crew). DHT = other crew on this pilot sector, skip for all allowances.
- Duties: FIRST apply midnight correction to every sector: if a sector's ATA time-of-day is earlier than its ATD time-of-day on the same calendar date, that ATA belongs to ATD_date+1. Apply this to ALL sectors before computing any gaps or durations. THEN: gap between midnight-corrected prev ATA and next ATD > 8h = new duty.
- Transfer section overrides parsed dates: "Hotel to Airport DD/MM/YYYY" = outbound sector date, "Airport to Hotel DD/MM/YYYY" = inbound sector date.
- DEADHEAD: DHF sectors. block_mins=AeroDataBox STA-STD (add 1440 if negative). amount=block_mins×(4000/60) rounded.
- LAYOVER: duty N last sector arrives at outstation≠${pilot.home_base}, duty N+1 first sector departs same outstation. DHF valid as outbound. chocks_on=ATA of last sector (midnight-corrected). chocks_off=ATD of first sector next duty (use AeroDataBox STD if ATD missing). Skip if duration<10h01m. base=3000, extra=ceil(hrs-24)×150 if >24h.
- LAYOVER SPILL: if prior_month_tail shows the pilot ended at an outstation ≠ ${pilot.home_base}, and the first duty of this month departs from that same outstation, compute the layover duration from prior_month_tail.chocks_on to this month's first ATD. Attribute it to this month.
- TRANSIT: consecutive pairs within duty where arr==dep. Exclude any pair where EITHER sector is DHT. DHF is NOT DHT — a DHF sector as either the arriving or departing leg is fully eligible for transit (PAH §7.0 excludes DHT only). sched_halt=AeroDataBox STA to next STD. actual_halt=ATA to next ATD. Qualify if sched_halt≥90min OR (actual≥90min AND |diff|>15min). Pay on actual if |diff|>15min else scheduled. billable=min(mins,240). amount=billable×(1000/60) rounded.
- NIGHT: non-DHF/DHT sectors where AeroDataBox STD is available. Do NOT pre-filter by time of day. UTC_slot=floor((STD_IST_mins-330+1440)%1440/60). Match sv_data by FLTNBR (no 6E prefix), DEP, ARR, slot. Compute STD_mins (0–1439). SV_arrival_mins=(STD_mins+SV)%1440. Night window=[1,360]. If SV_arrival_mins<STD_mins (midnight cross), split and sum overlaps with [1,360] from both segments. night_mins=total overlap. Skip sector only if night_mins=0. amount=night_mins×(2000/60) rounded.
- TAIL SWAP: consecutive non-DHT pairs in same duty, arr==dep, not both DHF. If aircraft_reg is available for both sectors and they differ → swap confirmed, amount=1500. If aircraft_reg is null/missing for either sector → emit swap with status="unverifiable" and amount=0. If regs are known and identical → no swap.

Return ONLY this JSON with actual values (empty arrays if none qualify):
{"period":"Month YYYY","allowances":{"deadhead":{"sectors":[{"flight":"","date":"","dep":"","arr":"","std":"","sta":"","block_mins":0,"amount":0}],"total":0},"layover":{"stations":[{"station":"","date_in":"","date_out":"","chocks_on":"","chocks_off":"","duration_hrs":0,"base":0,"extra":0,"total":0}],"total":0},"transit":{"halts":[{"station":"","date":"","arrived":"","departed":"","sched_halt":0,"actual_halt":0,"basis":"","billable_mins":0,"amount":0}],"total":0},"night":{"sectors":[{"flight":"","date":"","dep":"","arr":"","std":"","sv":0,"sv_arrival":"","night_mins":0,"amount":0}],"total":0},"tail_swap":{"swaps":[{"date":"","sectors":"","station":"","reg_out":"","reg_in":"","status":"confirmed","amount":0}],"total":0}},"grand_total":0}`;
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

  const { pdf_base64, sv_data, pilot, scheduled_times, prior_month_tail } = req.body ?? {};
  if (!pdf_base64) return res.status(400).json({ error: "pdf_base64 required" });
  if (!pilot)      return res.status(400).json({ error: "pilot required" });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on server" });
  }

  const prompt = buildPrompt(pilot, sv_data ?? [], scheduled_times ?? {}, prior_month_tail ?? null);

  let anthropicRes;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        // Both betas needed: pdfs for document blocks, interleaved-thinking for extended thinking
        "anthropic-beta":    "pdfs-2024-09-25,interleaved-thinking-2025-05-14",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        // budget_tokens for reasoning + headroom for JSON output
        max_tokens: 12000,
        thinking:   { type: "enabled", budget_tokens: 10000 },
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
  // Extended thinking returns multiple content blocks; collect only text blocks
  const textBlocks = (data.content || []).filter(b => b.type === "text");
  const text = textBlocks.map(b => b.text).join("");
  console.log("[calculate] stop_reason:", data.stop_reason, "text blocks:", textBlocks.length, "text length:", text.length);
  console.log("[calculate] Claude text output (first 500):", text.slice(0, 500));
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
