// Deterministic client-side allowance calculator.
// Receives sectors from api/parse.js; all monetary logic lives here.

function toMins(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

// Attach _atdDate and _ataDate (Date objects at UTC midnight of the sector date,
// with _ataDate bumped +1 day when ATA time-of-day < ATD time-of-day).
function applyMidnightCorrection(sectors) {
  return sectors.map(s => {
    const atdMins = toMins(s.atd);
    const ataMins = toMins(s.ata);
    const atdDate = new Date(s.date);
    const ataDate = new Date(s.date);
    if (atdMins !== null && ataMins !== null && ataMins < atdMins) {
      ataDate.setUTCDate(ataDate.getUTCDate() + 1);
    }
    return { ...s, _atdDate: atdDate, _ataDate: ataDate };
  });
}

function getScheduled(sector, scheduledTimes) {
  const key = `${sector.flight}|${sector.dep}|${sector.arr}|${sector.date}`;
  return scheduledTimes[key] || null;
}

// Absolute ms: corrected ATA datetime
function absAtaMs(sector) {
  const ataMins = toMins(sector.ata);
  if (ataMins === null) return null;
  return sector._ataDate.getTime() + ataMins * 60000;
}

// Absolute ms: ATD datetime (falls back to AeroDataBox STD)
function absAtdMs(sector, scheduledTimes) {
  const atdMins = toMins(sector.atd);
  if (atdMins !== null) return sector._atdDate.getTime() + atdMins * 60000;
  const sched = getScheduled(sector, scheduledTimes);
  const stdMins = toMins(sched?.std_local);
  if (stdMins !== null) return sector._atdDate.getTime() + stdMins * 60000;
  return null;
}

// Absolute ms: AeroDataBox STA (midnight-corrected via STD comparison)
function absStaMs(sector, scheduledTimes) {
  const sched = getScheduled(sector, scheduledTimes);
  const staMins = toMins(sched?.sta_local);
  const stdMins = toMins(sched?.std_local);
  if (staMins === null) return null;
  let ms = sector._atdDate.getTime() + staMins * 60000;
  if (stdMins !== null && staMins < stdMins) ms += 86400000; // crosses midnight
  return ms;
}

export function groupIntoDuties(sectors, scheduledTimes) {
  if (!sectors.length) return [];
  const duties = [[sectors[0]]];

  for (let i = 1; i < sectors.length; i++) {
    const prev = sectors[i - 1];
    const curr = sectors[i];

    let prevEndMs = absAtaMs(prev);
    if (prevEndMs === null) prevEndMs = absStaMs(prev, scheduledTimes);

    const currStartMs = absAtdMs(curr, scheduledTimes);

    if (prevEndMs === null || currStartMs === null) {
      duties[duties.length - 1].push(curr);
      continue;
    }

    const gapMins = (currStartMs - prevEndMs) / 60000;
    if (gapMins < 0) {
      // sectors overlap or are concurrent — same duty
      duties[duties.length - 1].push(curr);
      continue;
    }

    if (gapMins > 480) {
      console.log('[duty split] gap:', gapMins, 'mins between',
        prev.flight, prev.arr, prev.date, prev.ata,
        '→', curr.flight, curr.dep, curr.date, curr.atd);
      duties.push([curr]);
    } else {
      duties[duties.length - 1].push(curr);
    }
  }

  return duties;
}

function getRates(rank) {
  const cap = rank === "Captain";
  return {
    deadhead:     (cap ? 4000 : 2000) / 60,
    layoverBase:  cap ? 3000 : 1500,
    layoverExtra: cap ? 150  : 75,
    transit:      (cap ? 1000 : 500) / 60,
    night:        (cap ? 2000 : 1000) / 60,
    tailSwap:     cap ? 1500 : 750,
  };
}

export function calculateDeadhead(sectors, scheduledTimes, pilot) {
  const r = getRates(pilot.rank);
  let total = 0;
  const result = [];

  for (const s of sectors.filter(s => s.is_dhf)) {
    const sched = getScheduled(s, scheduledTimes);
    const stdMins = toMins(sched?.std_local);
    const staMins = toMins(sched?.sta_local);
    if (stdMins === null || staMins === null) continue;
    let block_mins = staMins - stdMins;
    if (block_mins < 0) block_mins += 1440;
    const amount = Math.round(block_mins * r.deadhead);
    total += amount;
    result.push({ date: s.date, flight: s.flight, from: s.dep, to: s.arr,
      scheduled_block_mins: block_mins, amount });
  }

  return { sectors: result, total };
}

export function calculateLayover(sectors, duties, scheduledTimes, pilot, priorMonthTail) {
  const r = getRates(pilot.rank);
  const events = [];
  let total = 0;

  const addEvent = (station, date_in, date_out, chocksOnMs, chocksOffMs, chocksOnStr, chocksOffStr) => {
    const duration_hrs = (chocksOffMs - chocksOnMs) / 3600000;
    if (duration_hrs <= 10 + 1 / 60) return; // must be STRICTLY MORE than 10h01m
    const base  = r.layoverBase;
    const extra = duration_hrs > 24 ? Math.ceil(duration_hrs - 24) * r.layoverExtra : 0;
    const eventTotal = base + extra;
    total += eventTotal;
    events.push({ station, date_in, date_out,
      check_in_ist: chocksOnStr, check_out_ist: chocksOffStr,
      duration_hrs: Math.round(duration_hrs * 100) / 100,
      base_amount: base, extra_amount: extra, total: eventTotal });
  };

  // Spill layover from prior month
  if (priorMonthTail?.station && priorMonthTail?.chocks_on && priorMonthTail?.date && duties.length > 0) {
    const firstSector = duties[0][0];
    if (firstSector.dep === priorMonthTail.station) {
      const chocksOnMs  = new Date(priorMonthTail.date).getTime() + toMins(priorMonthTail.chocks_on) * 60000;
      const chocksOffMs = absAtdMs(firstSector, scheduledTimes);
      if (chocksOffMs !== null) {
        addEvent(priorMonthTail.station, priorMonthTail.date, firstSector.date,
          chocksOnMs, chocksOffMs, priorMonthTail.chocks_on, firstSector.atd || "");
      }
    }
  }

  // Regular layovers between consecutive duties
  for (let i = 0; i < duties.length - 1; i++) {
    const lastSector  = duties[i][duties[i].length - 1];
    const firstSector = duties[i + 1][0];
    if (lastSector.arr.trim() === pilot.home_base.trim()) continue;
    if (lastSector.arr.trim() !== firstSector.dep.trim()) continue;

    const chocksOnMs  = absAtaMs(lastSector);
    const chocksOffMs = absAtdMs(firstSector, scheduledTimes);
    if (chocksOnMs === null || chocksOffMs === null) continue;

    addEvent(lastSector.arr, lastSector.date, firstSector.date,
      chocksOnMs, chocksOffMs, lastSector.ata || "", firstSector.atd || "");
  }

  return { events, total };
}

export function calculateNightFlying(sectors, scheduledTimes, svData, pilot) {
  const r = getRates(pilot.rank);
  const eligible = sectors.filter(s => !s.is_dhf && !s.is_dht);
  const result = [];
  let total = 0;

  for (const s of eligible) {
    const sched = getScheduled(s, scheduledTimes);
    const STD_mins = toMins(sched?.std_local);
    if (STD_mins === null) continue;

    const UTC_hour = Math.floor(((STD_mins - 330) + 1440) % 1440 / 60);
    const slot     = `${UTC_hour}_${UTC_hour + 1}`;
    const flightNum = parseInt(String(s.flight).replace(/^6E/i, ""), 10);

    const sv = svData.find(row =>
      parseInt(String(row.FLTNBR), 10) === flightNum &&
      String(row.DEP).trim() === s.dep &&
      String(row.ARR).trim() === s.arr &&
      String(row.Time_Slot).trim() === slot
    );
    console.log('[night] sector:', s.flight, s.dep, s.arr,
      'STD_mins:', STD_mins, 'slot:', slot, 'flightNum:', flightNum,
      'svMatch:', sv ? 'FOUND SectorValue=' + sv.SectorValue : 'NOT FOUND',
      'sample SV keys:', svData.slice(0, 2).map(r =>
        String(r.FLTNBR) + '|' + String(r.DEP).trim() + '|' +
        String(r.ARR).trim() + '|' + r.Time_Slot));
    if (!sv) continue;

    const SV = Number(sv.SectorValue);
    if (!SV) continue;

    const SV_arrival = STD_mins + SV;
    let night_mins;

    if (SV_arrival <= 1440) {
      night_mins = Math.max(0, Math.min(SV_arrival, 360) - Math.max(STD_mins, 1));
    } else {
      const seg1    = Math.max(0, Math.min(1440, 360) - Math.max(STD_mins, 1));
      const seg2End = SV_arrival % 1440;
      const seg2    = Math.max(0, Math.min(seg2End, 360) - 1);
      night_mins = seg1 + seg2;
    }

    console.log('[night] night_mins:', night_mins, 'SV_arrival:', SV_arrival, 'for', s.flight);
    if (night_mins === 0) continue;

    const amount = Math.round(night_mins * r.night);
    total += amount;
    const sv_arr = SV_arrival % 1440;
    result.push({
      date: s.date, flight: s.flight, from: s.dep, to: s.arr,
      std_ist: sched.std_local,
      sta_ist: `${String(Math.floor(sv_arr / 60)).padStart(2, "0")}:${String(sv_arr % 60).padStart(2, "0")}`,
      night_mins, sv_used: SV, amount,
    });
  }

  return { sectors: result, total };
}

export function calculateTransit(sectors, duties, scheduledTimes, pilot) {
  const r = getRates(pilot.rank);
  const halts = [];
  let total = 0;

  for (const duty of duties) {
    for (let i = 0; i < duty.length - 1; i++) {
      const sA = duty[i];
      const sB = duty[i + 1];
      if (sA.arr.trim() !== sB.dep.trim()) continue;
      if (sA.is_dht || sB.is_dht) continue;

      const schedA   = getScheduled(sA, scheduledTimes);
      const schedB   = getScheduled(sB, scheduledTimes);
      const staMinsA = toMins(schedA?.sta_local);
      const stdMinsB = toMins(schedB?.std_local);
      if (staMinsA === null || stdMinsB === null) continue;

      let sched_halt = stdMinsB - staMinsA;
      if (sched_halt < 0) sched_halt += 1440;

      let actual_halt = null;
      const ataMinsA = toMins(sA.ata);
      const atdMinsB = toMins(sB.atd);
      if (ataMinsA !== null && atdMinsB !== null) {
        actual_halt = (sB._atdDate.getTime() + atdMinsB * 60000
                     - sA._ataDate.getTime() - ataMinsA * 60000) / 60000;
      }

      const diff      = actual_halt !== null ? Math.abs(actual_halt - sched_halt) : 0;
      const qualifies = sched_halt >= 90 || (actual_halt !== null && actual_halt >= 90 && diff > 15);
      if (!qualifies) continue;

      const pay_basis = (actual_halt !== null && diff > 15) ? actual_halt : sched_halt;
      const billable  = Math.min(pay_basis, 240);
      const amount    = Math.round(billable * r.transit);
      total += amount;

      halts.push({
        date: sB.date, station: sA.arr,
        arrived_ist: sA.ata || "", departed_ist: sB.atd || "",
        halt_mins: actual_halt ?? sched_halt, billable_mins: billable,
        basis: (actual_halt !== null && diff > 15) ? "actual" : "scheduled",
        amount,
      });
    }
  }

  return { halts, total };
}

export function calculateTailSwap(sectors, duties, scheduledTimes, pilot) {
  const r = getRates(pilot.rank);
  const swaps = [];
  let total = 0;

  for (const duty of duties) {
    for (let i = 0; i < duty.length - 1; i++) {
      const sA = duty[i];
      const sB = duty[i + 1];
      if (sA.arr !== sB.dep) continue;
      if (sA.is_dht || sB.is_dht) continue;
      if (sA.is_dhf && sB.is_dhf) continue;

      const regA = getScheduled(sA, scheduledTimes)?.aircraft_reg ?? null;
      const regB = getScheduled(sB, scheduledTimes)?.aircraft_reg ?? null;

      if (regA === null || regB === null) {
        const missing = [regA === null ? `${sA.flight} ${sA.dep}→${sA.arr} ${sA.date}` : null,
                         regB === null ? `${sB.flight} ${sB.dep}→${sB.arr} ${sB.date}` : null]
                        .filter(Boolean).join(", ");
        console.log(`[tailSwap] unverifiable — missing reg for: ${missing}`);
        continue;
      }
      if (regA === regB) continue;

      const amount = r.tailSwap;
      total += amount;
      swaps.push({
        date: sB.date,
        sector_pair: `${sA.flight} / ${sB.flight}`,
        station: sA.arr, reg_out: regA, reg_in: regB, amount,
      });
    }
  }

  return { swaps, count: swaps.length, total };
}

export function runCalculations(period, sectors, scheduledTimes, svData, pilot, priorMonthTail) {
  const corrected = applyMidnightCorrection(sectors);
  const duties    = groupIntoDuties(corrected, scheduledTimes);

  const dh = calculateDeadhead(corrected, scheduledTimes, pilot);
  const lv = calculateLayover(corrected, duties, scheduledTimes, pilot, priorMonthTail);
  const nt = calculateNightFlying(corrected, scheduledTimes, svData, pilot);
  const tr = calculateTransit(corrected, duties, scheduledTimes, pilot);
  const ts = calculateTailSwap(corrected, duties, scheduledTimes, pilot);

  return {
    period,
    deadhead: { sectors: dh.sectors, total_mins: dh.sectors.reduce((s, x) => s + x.scheduled_block_mins, 0), amount: dh.total },
    layover:  { events: lv.events,   amount: lv.total },
    night:    { sectors: nt.sectors, total_mins: nt.sectors.reduce((s, x) => s + x.night_mins, 0), amount: nt.total },
    transit:  { halts: tr.halts,     amount: tr.total },
    tailSwap: { swaps: ts.swaps,     count: ts.count, amount: ts.total },
    total: dh.total + lv.total + nt.total + tr.total + ts.total,
  };
}
