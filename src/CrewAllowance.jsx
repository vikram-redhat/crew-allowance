import { useState, useRef, useCallback, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";
import { runCalculations } from "./calculate.js";
import "./App.css";

/* ═══════════════════════════════════════════════════════════════════
   SUPABASE CLIENT
═══════════════════════════════════════════════════════════════════ */
const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL      || "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const supabase = SUPABASE_URL
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

const sbWarn = () => console.warn("Supabase not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY");

/* ═══════════════════════════════════════════════════════════════════
   APP CONFIGURATION
═══════════════════════════════════════════════════════════════════ */
const CONFIG = {
  appName:       "Crew Allowance",
  airline:       "IndiGo",
  tagline:       "Eff. Jan 2026",
  copyrightYear: "2026",
  siteUrl:       "https://crewallowance.in",
  emailSupport:  "support@crewallowance.in",
  emailPrivacy:  "privacy@crewallowance.in",
  currency:      "₹",
  priceMonthly:  299,
  priceLabel:    "₹299",
  discountCodes: {
    "CREW2026": { pct: 100, label: "100% off — Free"   },
    "LAUNCH50": { pct: 50,  label: "50% off — ₹149/mo" },
    "INDIGO10": { pct: 10,  label: "10% off — ₹269/mo" },
  },
  ranks: ["Captain", "Senior Captain", "First Officer", "Senior First Officer", "Cabin Crew"],
  layoverMinHours: 10.0167,
  governingLaw:    "New Delhi, India",
  effectiveDate:   "1 January 2026",
};

const APP_NAME       = CONFIG.appName;
const RANKS          = CONFIG.ranks;
const PRICE_INR      = CONFIG.priceMonthly;
const PRICE_LABEL    = CONFIG.priceLabel;
const DISCOUNT_CODES = CONFIG.discountCodes;

// Map display ranks → rate bucket
const rankBucket = r => {
  const v = (r || "").toLowerCase();
  if (v.includes("cabin")) return "Cabin Crew";
  if (v.includes("first") || v.includes("fo")) return "First Officer";
  return "Captain";
};

const DEFAULT_RATES = {
  lastUpdated: "1 January 2026",
  source: "IndiGo Revised Cockpit Crew Allowances",
  deadhead:  { Captain: 4000, "First Officer": 2000, "Cabin Crew": null },
  night:     { Captain: 2000, "First Officer": 1000, "Cabin Crew": null },
  layover:   { Captain: { base: 3000, beyondRate: 150 }, "First Officer": { base: 1500, beyondRate: 75 }, "Cabin Crew": null },
  tailSwap:  { Captain: 1500, "First Officer": 750,  "Cabin Crew": null },
  transit:   { Captain: 1000, "First Officer": 500,  "Cabin Crew": null },
  layoverMinHours: CONFIG.layoverMinHours,
};

const fmtHM  = m => { const h = Math.floor(Math.abs(m)/60), mn = Math.round(Math.abs(m)%60); return h+"h "+mn.toString().padStart(2,"0")+"m"; };
const fmtINR = n => "₹"+(Math.round(n||0)).toLocaleString("en-IN");


/* Calculation is server-side via /api/calculate — see api/calculate.js */
/* ═══════════════════════════════════════════════════════════════════
   AERO DATABOX API  (via serverless proxy, with Supabase cache)
═══════════════════════════════════════════════════════════════════ */
// Returns { data, fromCache } or null
async function fetchWithCache(flight, dep, arr, date) {
  if (supabase) {
    const { data } = await supabase.from("flight_schedule_cache")
      .select("*").eq("flight_no", flight).eq("dep", dep).eq("arr", arr).eq("date", date).limit(1).maybeSingle();
    if (data) return { data, fromCache: true };
  }
  const url = `/api/aerodatabox?flight=${encodeURIComponent(flight)}&dep=${encodeURIComponent(dep)}&arr=${encodeURIComponent(arr)}&date=${encodeURIComponent(date)}`;
  let resp;
  try {
    resp = await fetch(url);
  } catch (fetchErr) {
    console.warn(`AeroDataBox fetch error for ${flight} ${dep}→${arr} ${date}:`, fetchErr.message);
    return null;
  }
  if (!resp.ok) {
    let body = "";
    try { body = await resp.text(); } catch { /* ignore */ }
    console.warn(`AeroDataBox ${resp.status} for ${flight} ${dep}→${arr} ${date}:`, body.slice(0, 200));
    return null;
  }
  const json = await resp.json();
  if (supabase) {
    const { error: cacheErr } = await supabase.from("flight_schedule_cache").upsert({
      flight_no: flight, dep, arr, date,
      std_local: json.std_local ?? null, sta_local: json.sta_local ?? null,
      atd_local: json.atd_local ?? null, ata_local: json.ata_local ?? null,
      aircraft_reg: json.aircraft_reg ?? null,
      fetched_at: new Date().toISOString(),
    }, { onConflict: "flight_no,dep,arr,date" });
    if (cacheErr) console.warn("Cache write failed:", cacheErr.message);
  }
  return { data: json, fromCache: false };
}

// Returns { map, fetched, cached, failed }
async function buildSchedMap(sectors, onProgress) {
  const map = {};
  const unique = [];
  const seen = new Set();
  for (const s of sectors) {
    const key = `${s.flight_no}|${s.dep}|${s.arr}|${s.date}`;
    if (!seen.has(key)) { seen.add(key); unique.push(s); }
  }
  let fetched = 0, cached = 0, failed = 0;
  for (let i = 0; i < unique.length; i++) {
    const s = unique[i];
    onProgress?.(i + 1, unique.length, s.flight_no);
    if (!s.dep || !s.arr) {
      console.warn(`Skipping ${s.flight_no} on ${s.date}: dep/arr missing (grid zip miss)`);
      failed++;
      continue;
    }
    const key = `${s.flight_no}|${s.dep}|${s.arr}|${s.date}`;
    try {
      const result = await fetchWithCache(s.flight_no, s.dep, s.arr, s.date);
      if (result) {
        map[key] = result.data;
        if (result.fromCache) cached++; else fetched++;
      } else {
        failed++;
      }
    } catch (e) {
      console.warn("buildSchedMap error:", e.message);
      failed++;
    }
    if (i < unique.length - 1) await new Promise(r => setTimeout(r, 600));
  }
  return { map, fetched, cached, failed };
}

/* ═══════════════════════════════════════════════════════════════════
   CSV DOWNLOAD
═══════════════════════════════════════════════════════════════════ */
function dlCSV(res, pilot) {
  const rows = [], add = (...r) => rows.push(r.join(","));
  add("Crew Allowance Statement - " + res.period);
  add("Pilot: " + pilot.name, "ID: " + pilot.emp_id, "Rank: " + pilot.rank);
  add(); add("DEADHEAD"); add("Date","Flight","From","To","Sched Block (mins)","Amount (INR)");
  res.deadhead.sectors.forEach(s => add(s.date, s.flight, s.from, s.to, s.scheduled_block_mins, Math.round(s.amount)));
  add("TOTAL","","","","", Math.round(res.deadhead.amount)); add();
  add("NIGHT FLYING (00:00–06:00 IST, PAH §9.0)"); add("Date","Flight","From","To","STD IST","STA IST","Night Mins","SV","Amount (INR)");
  res.night.sectors.forEach(s => add(s.date, s.flight, s.from, s.to, s.std_ist, s.sta_ist, s.night_mins, s.sv_used ?? "—", Math.round(s.amount)));
  add("TOTAL","","","","","","", Math.round(res.night.amount)); add();
  add("LAYOVER"); add("Station","Date In","Date Out","Check-In","Check-Out","Hrs","Base","Extra","Total (INR)");
  res.layover.events.forEach(e => add(e.station, e.date_in, e.date_out, e.check_in_ist, e.check_out_ist, e.duration_hrs, Math.round(e.base_amount), Math.round(e.extra_amount), Math.round(e.total)));
  add("TOTAL","","","","","","","", Math.round(res.layover.amount)); add();
  add("TAIL-SWAP"); add("Date","Sectors","Station","Reg Out","Reg In","Amount (INR)");
  res.tailSwap.swaps.forEach(s => add(s.date, s.sector_pair, s.station, s.reg_out, s.reg_in, Math.round(s.amount)));
  add("TOTAL","","","","", Math.round(res.tailSwap.amount)); add();
  add("TRANSIT"); add("Date","Station","Arrived","Departed","Halt (mins)","Billable (mins)","Basis","Amount (INR)");
  res.transit.halts.forEach(h => add(h.date, h.station, h.arrived_ist, h.departed_ist, h.halt_mins, h.billable_mins, h.basis, Math.round(h.amount)));
  add("TOTAL","","","","","","", Math.round(res.transit.amount)); add();
  add("GRAND TOTAL INR", Math.round(res.total));
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `CrewAllowance_${pilot.emp_id}_${res.period?.replace(/\s/g, "_")}.csv`;
  a.click();
}

/* ═══════════════════════════════════════════════════════════════════
   DESIGN TOKENS
═══════════════════════════════════════════════════════════════════ */
const C = {
  sky:"#f0f7ff", skyMid:"#daeeff", white:"#ffffff",
  blue:"#1a6fd4", blueMid:"#3d8ef0", blueLight:"#e8f2fd", blueXLight:"#f4f9ff",
  navy:"#0f3460",
  gold:"#b87000", goldBg:"#fff8e6", goldBorder:"#f0d080", goldText:"#c47f00",
  green:"#0e7a5a", greenBg:"#edfaf5",
  red:"#c0132a", redBg:"#fff1f3",
  text:"#1e293b", textMid:"#475569", textLo:"#94a3b8",
  border:"#e2eaf4", borderMid:"#c8d8ee",
  shadow:"0 2px 12px rgba(26,111,212,0.08)",
  shadowMd:"0 4px 24px rgba(26,111,212,0.12)",
};

/* ═══════════════════════════════════════════════════════════════════
   SHARED UI COMPONENTS
═══════════════════════════════════════════════════════════════════ */
function FInput({ label, type="text", value, onChange, placeholder, autoComplete, hint, readOnly }) {
  const [f, setF] = useState(false);
  return (
    <div style={{ marginBottom: 16 }}>
      {label && <label style={{ display:"block", fontSize:12, fontWeight:700, color:C.navy, marginBottom:5 }}>{label}</label>}
      <input type={type} value={value}
        onChange={e => onChange && onChange(e.target.value)}
        placeholder={placeholder} autoComplete={autoComplete} readOnly={readOnly}
        onFocus={() => setF(true)} onBlur={() => setF(false)}
        style={{ width:"100%", background: readOnly ? "#f8fafc" : C.white,
          border:"1.5px solid "+(f ? C.blue : C.border), borderRadius:10,
          padding:"12px 14px", color:C.text, fontFamily:"inherit", fontSize:15,
          outline:"none", transition:"all 0.15s", boxSizing:"border-box",
          boxShadow: f ? "0 0 0 3px "+C.blueLight : "none" }} />
      {hint && <div style={{ fontSize:11, color:C.textLo, marginTop:4 }}>{hint}</div>}
    </div>
  );
}

function FSelect({ label, value, onChange, options }) {
  return (
    <div style={{ marginBottom: 16 }}>
      {label && <label style={{ display:"block", fontSize:12, fontWeight:700, color:C.navy, marginBottom:5 }}>{label}</label>}
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ width:"100%", background:C.white, border:"1.5px solid "+C.border, borderRadius:10,
          padding:"12px 14px", color:C.text, fontFamily:"inherit", fontSize:15,
          outline:"none", appearance:"none", cursor:"pointer", boxSizing:"border-box" }}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

const BtnS = {
  primary:  { background:"linear-gradient(135deg,"+C.blue+","+C.blueMid+")", color:C.white, border:"none", boxShadow:"0 2px 8px rgba(26,111,212,0.28)" },
  ghost:    { background:C.white, color:C.blue, border:"1.5px solid "+C.borderMid, boxShadow:C.shadow },
  danger:   { background:C.white, color:C.red, border:"1.5px solid #fca5a5", boxShadow:"none" },
  gold:     { background:"linear-gradient(135deg,"+C.goldText+",#8a5500)", color:C.white, border:"none", boxShadow:"0 2px 8px rgba(180,112,0,0.28)" },
  disabled: { background:"#e9eef5", color:C.textLo, border:"none", boxShadow:"none", cursor:"not-allowed" },
};

function Btn({ children, onClick, variant="primary", small, disabled, full=true, icon }) {
  const s = disabled ? BtnS.disabled : (BtnS[variant] || BtnS.primary);
  return (
    <button onClick={disabled ? undefined : onClick}
      style={{ ...s, width:full?"100%":"auto", padding:small?"8px 14px":"13px 20px",
        borderRadius:10, fontFamily:"inherit", fontSize:small?12:14, fontWeight:700,
        letterSpacing:"0.02em", cursor:disabled?"not-allowed":"pointer",
        transition:"all 0.15s", display:"inline-flex", alignItems:"center",
        justifyContent:"center", gap:6, boxSizing:"border-box" }}>
      {icon && <span>{icon}</span>}{children}
    </button>
  );
}

function Card({ children, style, color }) {
  const b  = color==="gold" ? C.goldBorder : color==="blue" ? C.blue : color==="green" ? C.green : C.border;
  const bg = color==="gold" ? C.goldBg : color==="blue" ? C.blueXLight : color==="green" ? C.greenBg : C.white;
  return <div style={{ background:bg, border:"1.5px solid "+b, borderRadius:14, padding:"16px", boxShadow:C.shadow, ...style }}>{children}</div>;
}

function Badge({ children, color="blue" }) {
  const m = { blue:{bg:C.blueLight,c:C.blue}, green:{bg:C.greenBg,c:C.green}, red:{bg:C.redBg,c:C.red}, gold:{bg:C.goldBg,c:C.goldText} };
  const t = m[color] || m.blue;
  return <span style={{ display:"inline-block", padding:"2px 9px", borderRadius:20, fontSize:11, fontWeight:700, background:t.bg, color:t.c }}>{children}</span>;
}

function CollapsibleTable({ title, total, note, headers, rows, renderRow }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom:14, borderRadius:14, border:"1.5px solid "+C.border, overflow:"hidden", boxShadow:C.shadow }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
          padding:"12px 16px", background:C.sky, cursor:"pointer", userSelect:"none" }}>
        <span style={{ fontSize:13, fontWeight:700, color:C.navy }}>{title}</span>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:15, fontWeight:800, color:C.goldText }}>{fmtINR(total)}</span>
          <span style={{ color:C.textLo, transition:"transform 0.2s", display:"inline-block", transform:open?"rotate(180deg)":"none" }}>▾</span>
        </div>
      </div>
      {open && (
        <div style={{ overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
            <thead>
              <tr>{headers.map((h, i) => (
                <th key={i} style={{ background:"#f8fbff", color:C.textMid, padding:"8px 10px", textAlign:"left",
                  fontWeight:700, fontSize:10, letterSpacing:"0.05em", textTransform:"uppercase",
                  borderBottom:"1.5px solid "+C.border, whiteSpace:"nowrap" }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>{rows.map((row, i) => renderRow(row, i))}</tbody>
            {note && (
              <tfoot><tr><td colSpan={99} style={{ padding:"8px 12px", background:C.blueXLight,
                color:C.textMid, fontSize:11, fontStyle:"italic", borderTop:"1px solid "+C.border }}>
                ⓘ {note}
              </td></tr></tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

function TC({ children, i, right, gold }) {
  return (
    <td style={{ padding:"9px 10px", background:i%2===0 ? C.white : "#f8fbff",
      borderBottom:"1px solid "+C.border, color:gold ? C.goldText : C.text,
      fontWeight:gold ? 700 : 400, textAlign:right ? "right" : "left", whiteSpace:"nowrap" }}>
      {children}
    </td>
  );
}

function AuthShell({ children, title, sub, wide }) {
  return (
    <div style={{ minHeight:"100vh",
      background:"linear-gradient(160deg,"+C.skyMid+" 0%,"+C.sky+" 50%,"+C.white+" 100%)",
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"24px 16px" }}>
      <div style={{ textAlign:"center", marginBottom:24 }}>
        <div style={{ width:54, height:54, borderRadius:16,
          background:"linear-gradient(135deg,"+C.blue+","+C.navy+")",
          display:"flex", alignItems:"center", justifyContent:"center",
          fontSize:26, margin:"0 auto 12px", boxShadow:"0 6px 20px rgba(26,111,212,0.3)" }}>✈</div>
        <div style={{ fontSize:22, fontWeight:900, color:C.navy, letterSpacing:"-0.01em" }}>{APP_NAME}</div>
        <div style={{ fontSize:11, color:C.blue, letterSpacing:"0.12em", textTransform:"uppercase", marginTop:2, opacity:0.75 }}>{CONFIG.airline} · {CONFIG.tagline}</div>
      </div>
      <div style={{ width:"100%", maxWidth:wide ? 520 : 420, background:C.white, borderRadius:22,
        boxShadow:"0 12px 48px rgba(26,111,212,0.14)", padding:"28px 24px", border:"1px solid "+C.border }}>
        <h2 style={{ margin:"0 0 4px", fontSize:20, color:C.navy, fontWeight:900, letterSpacing:"-0.01em" }}>{title}</h2>
        {sub && <p style={{ margin:"0 0 20px", fontSize:13, color:C.textMid }}>{sub}</p>}
        {children}
      </div>
      <div style={{ marginTop:24, display:"flex", gap:6, alignItems:"center", opacity:0.3 }}>
        {Array.from({ length:9 }).map((_, i) => (
          <div key={i} style={{ width:i%3===1?28:16, height:4, borderRadius:2, background:C.blue }} />
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   PDF DROP ZONE  (PCSR)
═══════════════════════════════════════════════════════════════════ */
function PcsrDropZone({ file, onParsed, onFail }) {
  const [drag, setDrag]       = useState(false);
  const [parsing, setParsing] = useState(false);
  const ref = useRef();

  const ingest = useCallback(async f => {
    if (!f) return;
    if (!String(f.name || "").toLowerCase().endsWith(".pdf")) {
      onFail("Please choose a PDF file."); return;
    }
    setParsing(true);
    try {
      const { parsePcsrPdf } = await import("./pdf/pcsrParser.js");
      const result = await parsePcsrPdf(await f.arrayBuffer());
      onParsed(f, result);
    } catch (e) {
      onFail(e?.message || String(e));
    } finally {
      setParsing(false);
    }
  }, [onParsed, onFail]);

  const onDrop = useCallback(e => { e.preventDefault(); setDrag(false); if (!parsing) ingest(e.dataTransfer.files[0]); }, [ingest, parsing]);

  return (
    <div onClick={() => !parsing && ref.current?.click()}
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)} onDrop={onDrop}
      style={{ background:file ? C.blueXLight : drag ? C.blueLight : C.sky,
        border:"2px dashed "+(file ? C.blueMid : drag ? C.blue : C.borderMid),
        borderRadius:16, padding:"28px 20px", cursor:parsing?"wait":"pointer",
        transition:"all 0.2s", textAlign:"center", opacity:parsing?0.75:1 }}>
      <div style={{ fontSize:40, marginBottom:10 }}>📄</div>
      <div style={{ fontSize:15, fontWeight:800, color:C.navy, marginBottom:4 }}>
        {file ? "PCSR loaded ✓" : "Upload your PCSR PDF"}
      </div>
      <div style={{ fontSize:12, color:C.textMid, marginBottom:8 }}>
        Personal Crew Schedule Report — both EOM and grid formats supported
      </div>
      {parsing
        ? <div style={{ fontSize:12, color:C.blue, fontWeight:700 }}>Reading PDF...</div>
        : file
          ? <div style={{ fontSize:12, color:C.blue, fontWeight:600 }}>✓ {file.name}</div>
          : <div style={{ fontSize:12, color:C.textLo }}>Click or drag PDF here</div>}
      <input ref={ref} type="file" accept=".pdf,application/pdf" style={{ display:"none" }} disabled={parsing}
        onChange={e => { if (e.target.files[0]) ingest(e.target.files[0]); }} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   LANDING PAGE
═══════════════════════════════════════════════════════════════════ */
function LandingPage({ goLogin, goSignup }) {
  const steps = [
    { icon:"📄", title:"Export your PCSR from AIMS", body:"Download your Personal Crew Schedule Report as a PDF from AIMS. Both end-of-month (EOM) tabular format and monthly grid format are supported." },
    { icon:"⬆", title:"Upload your PCSR PDF", body:"Drop your PCSR PDF into the app. That's the only file you need. Sector Values are uploaded once per month by your admin — shared across all crew." },
    { icon:"⚡", title:"Instant enrichment & calculation", body:"The app fetches scheduled times and aircraft registrations automatically from AeroDataBox, then applies all IndiGo allowance rules instantly." },
    { icon:"📊", title:"Download your breakdown", body:"Get a complete itemised CSV breakdown of every allowance for the month — ready to verify against your payslip." },
  ];
  const allowances = [
    { name:"Deadhead",    icon:"🛫", desc:"Per scheduled block hour when positioned as non-operating crew",       captain:"₹4,000/hr",  fo:"₹2,000/hr"  },
    { name:"Night Flying",icon:"🌙", desc:"For each hour flown between 0000–0600 IST per PAH §9.0",              captain:"₹2,000/hr",  fo:"₹1,000/hr"  },
    { name:"Layover",     icon:"🏨", desc:"For stays away from home base exceeding 10 hours 01 minute",          captain:"₹3,000 base",fo:"₹1,500 base" },
    { name:"Tail-Swap",   icon:"✈️", desc:"When aircraft registration changes between consecutive sectors",       captain:"₹1,500/swap",fo:"₹750/swap"  },
    { name:"Transit",     icon:"⏱",  desc:"Pro-rata for domestic halts between 90 mins and 4 hrs (PAH §7.0)",   captain:"₹1,000/hr",  fo:"₹500/hr"    },
  ];
  return (
    <div style={{ background:C.white, fontFamily:"'Nunito','Segoe UI',sans-serif", color:C.text }}>
      <div style={{ position:"sticky", top:0, zIndex:20, background:"rgba(255,255,255,0.95)",
        backdropFilter:"blur(10px)", borderBottom:"1px solid "+C.border,
        padding:"12px 20px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:34, height:34, borderRadius:10,
            background:"linear-gradient(135deg,"+C.blue+","+C.navy+")",
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:18, boxShadow:"0 2px 8px rgba(26,111,212,0.28)" }}>✈</div>
          <div style={{ fontSize:16, fontWeight:900, color:C.navy, letterSpacing:"-0.01em" }}>{APP_NAME}</div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={goLogin} style={{ background:"transparent", border:"1.5px solid "+C.borderMid,
            borderRadius:9, color:C.textMid, fontSize:13, padding:"7px 14px", cursor:"pointer", fontWeight:700, fontFamily:"inherit" }}>Sign in</button>
          <button onClick={goSignup} style={{ background:"linear-gradient(135deg,"+C.blue+","+C.blueMid+")",
            border:"none", borderRadius:9, color:C.white, fontSize:13, padding:"7px 16px",
            cursor:"pointer", fontWeight:700, fontFamily:"inherit", boxShadow:"0 2px 8px rgba(26,111,212,0.28)" }}>Get started →</button>
        </div>
      </div>
      <div style={{ background:"linear-gradient(160deg,"+C.navy+" 0%,"+C.blue+" 60%,"+C.blueMid+" 100%)",
        padding:"60px 20px 80px", textAlign:"center", position:"relative", overflow:"hidden" }}>
        <div style={{ position:"relative", maxWidth:640, margin:"0 auto" }}>
          <div style={{ display:"inline-block", background:"rgba(255,255,255,0.12)", borderRadius:20,
            padding:"4px 14px", fontSize:12, color:"rgba(255,255,255,0.9)", fontWeight:700,
            letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:20 }}>For IndiGo Cockpit Crew</div>
          <h1 style={{ fontSize:"clamp(28px,6vw,48px)", fontWeight:900, color:C.white,
            lineHeight:1.1, letterSpacing:"-0.02em", margin:"0 0 18px" }}>
            Know exactly what<br />allowances you're owed
          </h1>
          <p style={{ fontSize:"clamp(14px,2.5vw,18px)", color:"rgba(255,255,255,0.75)",
            maxWidth:480, margin:"0 auto 32px", lineHeight:1.6 }}>
            Upload your PCSR PDF. Get an instant, itemised breakdown of every allowance — Deadhead, Night Flying, Layover, Tail-Swap, and Transit.
          </p>
          <div style={{ display:"flex", gap:12, justifyContent:"center", flexWrap:"wrap" }}>
            <button onClick={goSignup} style={{ background:C.white, border:"none", borderRadius:12,
              color:C.blue, fontSize:15, padding:"14px 28px", cursor:"pointer", fontWeight:800,
              fontFamily:"inherit", boxShadow:"0 4px 20px rgba(0,0,0,0.2)" }}>
              Get started — {PRICE_LABEL}/month →
            </button>
            <button onClick={goLogin} style={{ background:"rgba(255,255,255,0.15)",
              border:"1.5px solid rgba(255,255,255,0.3)", borderRadius:12, color:C.white,
              fontSize:15, padding:"14px 28px", cursor:"pointer", fontWeight:700, fontFamily:"inherit" }}>Sign in</button>
          </div>
          <div style={{ marginTop:20, fontSize:12, color:"rgba(255,255,255,0.5)" }}>No credit card required to try · Cancel anytime</div>
        </div>
      </div>
      <div style={{ background:C.sky, borderTop:"1px solid "+C.border, borderBottom:"1px solid "+C.border,
        padding:"20px", display:"flex", justifyContent:"center", gap:"clamp(20px,4vw,60px)", flexWrap:"wrap" }}>
        {[["1","File to upload"],["5","Allowance types"],["Jan 2026","Rules in effect"],["Auto","Schedule data"]].map(([n,l]) => (
          <div key={l} style={{ textAlign:"center" }}>
            <div style={{ fontSize:22, fontWeight:900, color:C.blue }}>{n}</div>
            <div style={{ fontSize:12, color:C.textMid, marginTop:2 }}>{l}</div>
          </div>
        ))}
      </div>
      <div style={{ maxWidth:700, margin:"0 auto", padding:"60px 20px" }}>
        <div style={{ textAlign:"center", marginBottom:40 }}>
          <div style={{ fontSize:12, fontWeight:700, color:C.blue, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:8 }}>How it works</div>
          <h2 style={{ fontSize:"clamp(22px,4vw,32px)", fontWeight:900, color:C.navy, letterSpacing:"-0.01em" }}>
            One file. Instant breakdown.
          </h2>
        </div>
        <div style={{ display:"grid", gap:16 }}>
          {steps.map((s, i) => (
            <div key={i} style={{ display:"flex", gap:16, alignItems:"flex-start", background:C.white,
              borderRadius:16, padding:"20px", border:"1.5px solid "+C.border, boxShadow:C.shadow }}>
              <div style={{ width:48, height:48, borderRadius:14, background:C.blueXLight,
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:24, flexShrink:0 }}>{s.icon}</div>
              <div>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                  <span style={{ width:22, height:22, borderRadius:"50%",
                    background:"linear-gradient(135deg,"+C.blue+","+C.navy+")",
                    display:"inline-flex", alignItems:"center", justifyContent:"center",
                    fontSize:11, fontWeight:900, color:C.white, flexShrink:0 }}>{i+1}</span>
                  <span style={{ fontSize:15, fontWeight:800, color:C.navy }}>{s.title}</span>
                </div>
                <p style={{ fontSize:13, color:C.textMid, lineHeight:1.6, margin:0 }}>{s.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ background:C.sky, padding:"60px 20px" }}>
        <div style={{ maxWidth:700, margin:"0 auto" }}>
          <div style={{ textAlign:"center", marginBottom:32 }}>
            <h2 style={{ fontSize:"clamp(22px,4vw,30px)", fontWeight:900, color:C.navy, letterSpacing:"-0.01em" }}>All five IndiGo allowances covered</h2>
            <p style={{ fontSize:13, color:C.textMid, marginTop:8 }}>Rates effective 1 January 2026</p>
          </div>
          <div style={{ display:"grid", gap:10 }}>
            {allowances.map((a, i) => (
              <div key={i} style={{ background:C.white, borderRadius:14, padding:"16px 18px",
                border:"1.5px solid "+C.border, boxShadow:C.shadow,
                display:"flex", alignItems:"center", gap:16, flexWrap:"wrap" }}>
                <div style={{ width:40, height:40, borderRadius:12, background:C.blueXLight,
                  display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>{a.icon}</div>
                <div style={{ flex:1, minWidth:160 }}>
                  <div style={{ fontSize:14, fontWeight:800, color:C.navy, marginBottom:3 }}>{a.name}</div>
                  <div style={{ fontSize:12, color:C.textMid }}>{a.desc}</div>
                </div>
                <div style={{ display:"flex", gap:12, flexShrink:0 }}>
                  <div style={{ textAlign:"center" }}>
                    <div style={{ fontSize:10, color:C.textLo, marginBottom:2 }}>Captain</div>
                    <div style={{ fontSize:13, fontWeight:800, color:C.goldText }}>{a.captain}</div>
                  </div>
                  <div style={{ textAlign:"center" }}>
                    <div style={{ fontSize:10, color:C.textLo, marginBottom:2 }}>F/O</div>
                    <div style={{ fontSize:13, fontWeight:800, color:C.blue }}>{a.fo}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div style={{ maxWidth:480, margin:"0 auto", padding:"60px 20px", textAlign:"center" }}>
        <h2 style={{ fontSize:"clamp(22px,4vw,30px)", fontWeight:900, color:C.navy, letterSpacing:"-0.01em", marginBottom:24 }}>Simple, affordable, monthly</h2>
        <div style={{ background:C.white, borderRadius:20, padding:"32px 28px",
          border:"2px solid "+C.blue, boxShadow:C.shadowMd, marginBottom:20 }}>
          <div style={{ fontSize:48, fontWeight:900, color:C.navy, letterSpacing:"-0.02em" }}>
            ₹299<span style={{ fontSize:16, fontWeight:600, color:C.textMid }}>/month</span>
          </div>
          <div style={{ fontSize:13, color:C.textMid, margin:"12px 0 24px" }}>Per crew member · Cancel anytime</div>
          <div style={{ display:"grid", gap:8, marginBottom:24, textAlign:"left" }}>
            {["Upload only your PCSR PDF","All 5 allowance types","Auto schedule data via AeroDataBox","CSV breakdown download","Rates kept up-to-date"].map(f => (
              <div key={f} style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, color:C.text }}>
                <span style={{ color:C.green, fontWeight:800, fontSize:15 }}>✓</span>{f}
              </div>
            ))}
          </div>
          <button onClick={goSignup} style={{ width:"100%", background:"linear-gradient(135deg,"+C.blue+","+C.blueMid+")",
            border:"none", borderRadius:11, color:C.white, fontSize:15, padding:"14px",
            cursor:"pointer", fontWeight:800, fontFamily:"inherit", boxShadow:"0 3px 12px rgba(26,111,212,0.3)" }}>
            Get started →
          </button>
        </div>
      </div>
      <div style={{ background:"linear-gradient(135deg,"+C.navy+","+C.blue+")", padding:"50px 20px", textAlign:"center" }}>
        <h2 style={{ fontSize:"clamp(20px,4vw,28px)", fontWeight:900, color:C.white, letterSpacing:"-0.01em", marginBottom:12 }}>
          Ready to know what you're owed?
        </h2>
        <button onClick={goSignup} style={{ background:C.white, border:"none", borderRadius:12,
          color:C.blue, fontSize:15, padding:"14px 32px", cursor:"pointer", fontWeight:800,
          fontFamily:"inherit", boxShadow:"0 4px 20px rgba(0,0,0,0.2)", marginTop:16 }}>
          Create your account →
        </button>
        <div style={{ marginTop:28, fontSize:11, color:"rgba(255,255,255,0.4)", letterSpacing:"0.06em" }}>
          © {CONFIG.copyrightYear} {CONFIG.appName} · For {CONFIG.airline} crew members
        </div>
        <div style={{ marginTop:12, display:"flex", gap:20, justifyContent:"center" }}>
          <a href="/privacy.html" style={{ fontSize:12, color:"rgba(255,255,255,0.45)", textDecoration:"none" }}>Privacy Policy</a>
          <a href="/terms.html"   style={{ fontSize:12, color:"rgba(255,255,255,0.45)", textDecoration:"none" }}>Terms of Service</a>
          <a href={"mailto:"+CONFIG.emailSupport} style={{ fontSize:12, color:"rgba(255,255,255,0.45)", textDecoration:"none" }}>Contact</a>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   AUTH SCREENS (Login, Signup, Checkout, Forgot, ResetPassword)
═══════════════════════════════════════════════════════════════════ */
function LoginScreen({ onLogin, goSignup, goForgot, goLanding }) {
  const [email, setEmail] = useState("");
  const [pass,  setPass]  = useState("");
  const [err,   setErr]   = useState("");
  const [busy,  setBusy]  = useState(false);

  const submit = async () => {
    setErr(""); setBusy(true);
    if (!supabase) { sbWarn(); setErr("Database not configured."); setBusy(false); return; }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password: pass });
    if (error) { setErr("Invalid email or password."); setBusy(false); return; }
    const { data: profile } = await supabase.from("profiles").select("*").eq("id", data.user.id).single();
    if (!profile) { setErr("Account not found. Please contact admin."); setBusy(false); return; }
    if (!profile.is_active) { setErr("Your account is not yet active. Please wait for admin approval."); setBusy(false); return; }
    onLogin({ ...profile, email: data.user.email });
    setBusy(false);
  };

  return (
    <AuthShell title="Welcome back" sub="Sign in to your Crew Allowance account">
      <FInput label="Email address" type="email" value={email} onChange={setEmail} placeholder="Your registered email address" autoComplete="email" />
      <FInput label="Password" type="password" value={pass} onChange={setPass} placeholder="Your password" autoComplete="current-password" />
      {err && <div style={{ padding:"10px 14px", background:C.redBg, border:"1px solid #fca5a5", borderRadius:8, color:C.red, fontSize:12, marginBottom:14 }}>{err}</div>}
      <Btn onClick={submit} disabled={busy}>{busy ? "Signing in..." : "Sign In →"}</Btn>
      <div style={{ marginTop:14, textAlign:"center" }}>
        <button onClick={goForgot} style={{ background:"none", border:"none", color:C.blue, fontSize:13, cursor:"pointer", fontFamily:"inherit", textDecoration:"underline" }}>Forgot password?</button>
      </div>
      <div style={{ marginTop:10, textAlign:"center", fontSize:13, color:C.textMid }}>
        New user?{" "}
        <button onClick={goSignup} style={{ background:"none", border:"none", color:C.blue, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:700 }}>Create an account</button>
      </div>
      <div style={{ marginTop:10, textAlign:"center" }}>
        <button onClick={goLanding} style={{ background:"none", border:"none", color:C.textLo, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>← Back to home</button>
      </div>
    </AuthShell>
  );
}

function SignupScreen({ goLogin, goLanding, goCheckout }) {
  const [name,    setName]    = useState("");
  const [email,   setEmail]   = useState("");
  const [empId,   setEmpId]   = useState("");
  const [rank,    setRank]    = useState("Captain");
  const [base,    setBase]    = useState("DEL");
  const [pass,    setPass]    = useState("");
  const [confirm, setConfirm] = useState("");
  const [err,     setErr]     = useState("");
  const [busy,    setBusy]    = useState(false);

  const submit = async () => {
    if (!name || !email || !empId || !pass) { setErr("All fields are required."); return; }
    if (pass !== confirm) { setErr("Passwords do not match."); return; }
    if (pass.length < 8)  { setErr("Password must be at least 8 characters."); return; }
    setErr(""); setBusy(true);
    if (!supabase) { sbWarn(); setErr("Database not configured."); setBusy(false); return; }
    const { data, error } = await supabase.auth.signUp({ email, password: pass });
    if (error) { setErr(error.message); setBusy(false); return; }
    await supabase.from("profiles").insert({
      id: data.user.id, name, emp_id: empId, rank, home_base: base.toUpperCase().slice(0, 3),
      is_admin: false, is_active: false,
    });
    setBusy(false);
    goCheckout({ id: data.user.id, name, email, emp_id: empId, rank, home_base: base });
  };

  return (
    <AuthShell title="Create account" sub="IndiGo crew only · Takes 60 seconds">
      <FInput label="Full name" value={name} onChange={setName} placeholder="Your full name as it appears on your ID" />
      <FInput label="IndiGo email address" type="email" value={email} onChange={setEmail} placeholder="Your official IndiGo email address" />
      <FInput label="Employee ID" value={empId} onChange={setEmpId} placeholder="Your IndiGo employee number" />
      <FSelect label="Rank" value={rank} onChange={setRank} options={RANKS} />
      <FInput label="Home Base (IATA)" value={base} onChange={setBase} placeholder="e.g. DEL" hint="3-letter IATA code of your home airport" />
      <FInput label="Password" type="password" value={pass} onChange={setPass} placeholder="Choose a strong password (min 8 characters)" />
      <FInput label="Confirm password" type="password" value={confirm} onChange={setConfirm} placeholder="Repeat your password" />
      {err && <div style={{ padding:"10px 14px", background:C.redBg, borderRadius:8, color:C.red, fontSize:12, marginBottom:14 }}>{err}</div>}
      <Btn onClick={submit} disabled={busy}>{busy ? "Creating account..." : "Continue to payment →"}</Btn>
      <div style={{ marginTop:12, textAlign:"center", fontSize:13, color:C.textMid }}>
        Already registered?{" "}
        <button onClick={goLogin} style={{ background:"none", border:"none", color:C.blue, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:700 }}>Sign in</button>
      </div>
      <div style={{ marginTop:8, textAlign:"center" }}>
        <button onClick={goLanding} style={{ background:"none", border:"none", color:C.textLo, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>← Back to home</button>
      </div>
    </AuthShell>
  );
}

function CheckoutScreen({ pendingUser, goLogin, onActivate }) {
  const [code,     setCode]     = useState("");
  const [discount, setDiscount] = useState(null);
  const [codeErr,  setCodeErr]  = useState("");
  const [loading,  setLoading]  = useState(false);
  const [done,     setDone]     = useState(false);
  const [payErr,   setPayErr]   = useState("");
  const [stripeReady, setStripeReady] = useState(false);

  const stripeRef      = useRef(null);
  const cardElementRef = useRef(null);
  const cardDivRef     = useRef(null);

  const finalPrice = discount ? Math.round(PRICE_INR * (1 - discount.pct / 100)) : PRICE_INR;
  const isFree     = finalPrice === 0;

  useEffect(() => {
    const STRIPE_PK = import.meta.env.VITE_STRIPE_PK || "";
    const mountCard = () => {
      if (!STRIPE_PK || !cardDivRef.current || cardElementRef.current) return;
      const stripe   = window.Stripe(STRIPE_PK);
      const elements = stripe.elements();
      const card = elements.create("card", {
        style: { base: { fontFamily:"'Nunito','Segoe UI',sans-serif", fontSize:"15px", color:"#1e293b", "::placeholder":{ color:"#94a3b8" } }, invalid:{ color:"#c0132a" } },
        hidePostalCode: true,
      });
      card.mount(cardDivRef.current);
      stripeRef.current = stripe; cardElementRef.current = card; setStripeReady(true);
    };
    if (!window.Stripe) {
      const script = document.createElement("script");
      script.src = "https://js.stripe.com/v3/"; script.onload = mountCard;
      document.head.appendChild(script);
    } else { mountCard(); }
    return () => { if (cardElementRef.current) { cardElementRef.current.unmount(); cardElementRef.current = null; } };
  }, []);

  useEffect(() => {
    if (!isFree && !cardElementRef.current && window.Stripe && cardDivRef.current) {
      const STRIPE_PK = import.meta.env.VITE_STRIPE_PK || "";
      if (!STRIPE_PK) return;
      const stripe = window.Stripe(STRIPE_PK);
      const elements = stripe.elements();
      const card = elements.create("card", {
        style: { base: { fontFamily:"'Nunito','Segoe UI',sans-serif", fontSize:"15px", color:"#1e293b", "::placeholder":{ color:"#94a3b8" } }, invalid:{ color:"#c0132a" } },
        hidePostalCode: true,
      });
      card.mount(cardDivRef.current);
      stripeRef.current = stripe; cardElementRef.current = card; setStripeReady(true);
    }
  }, [isFree]);

  const applyCode = () => {
    const upper = code.trim().toUpperCase();
    const d = DISCOUNT_CODES[upper];
    if (d) { setDiscount({ ...d, code: upper }); setCodeErr(""); }
    else   { setCodeErr("Invalid discount code."); setDiscount(null); }
  };

  const activateUser = async () => {
    if (supabase && pendingUser?.id) await supabase.from("profiles").update({ is_active: true }).eq("id", pendingUser.id);
    onActivate(pendingUser); setDone(true);
  };

  const handlePay = async () => {
    setPayErr(""); setLoading(true);
    if (isFree) { await activateUser(); setLoading(false); return; }
    if (!stripeRef.current || !cardElementRef.current) { setPayErr("Payment form not ready. Please wait a moment."); setLoading(false); return; }
    try {
      const resp = await fetch("/api/create-payment-intent", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ amount:finalPrice, discountCode:discount?.code||"", userId:pendingUser?.id||"", email:pendingUser?.email||"" }),
      });
      const { clientSecret, error: serverErr } = await resp.json();
      if (serverErr) throw new Error(serverErr);
      const { paymentIntent, error: stripeErr } = await stripeRef.current.confirmCardPayment(clientSecret, { payment_method:{ card:cardElementRef.current } });
      if (stripeErr) throw new Error(stripeErr.message);
      if (paymentIntent.status !== "succeeded") throw new Error("Payment did not complete. Please try again.");
      await activateUser();
    } catch (err) { setPayErr(err.message); }
    setLoading(false);
  };

  if (done) return (
    <AuthShell title="You're all set! 🎉" sub="">
      <div style={{ textAlign:"center", padding:"8px 0 18px" }}>
        <div style={{ width:60, height:60, borderRadius:"50%", background:C.greenBg, border:"2px solid "+C.green,
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:28, margin:"0 auto 16px" }}>✓</div>
        <p style={{ color:C.textMid, fontSize:14, lineHeight:1.6, marginBottom:20 }}>
          {isFree ? "Your free account is activated." : "Payment confirmed. Your account is now active."}
          <br />Welcome to Crew Allowance, {pendingUser?.name?.split(" ")[0]}!
        </p>
      </div>
      <Btn onClick={goLogin}>Sign in to your account →</Btn>
    </AuthShell>
  );

  return (
    <AuthShell title="Complete your subscription" sub={PRICE_LABEL+"/month · Cancel anytime"} wide>
      <div style={{ background:C.blueXLight, border:"1.5px solid "+C.border, borderRadius:12, padding:"14px 16px", marginBottom:20 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:discount?8:0 }}>
          <span style={{ fontSize:13, color:C.textMid }}>Crew Allowance — Monthly</span>
          <span style={{ fontSize:14, fontWeight:700, color:C.navy }}>{PRICE_LABEL}/mo</span>
        </div>
        {discount && (
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", paddingTop:8, borderTop:"1px solid "+C.border }}>
            <span style={{ fontSize:12, color:C.green, fontWeight:700 }}>Discount ({discount.code}) — {discount.pct}% off</span>
            <span style={{ fontSize:13, fontWeight:700, color:C.green }}>−₹{PRICE_INR - finalPrice}</span>
          </div>
        )}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
          paddingTop:8, borderTop:"1px solid "+C.borderMid, marginTop:discount?8:0 }}>
          <span style={{ fontSize:14, fontWeight:800, color:C.navy }}>Total today</span>
          <span style={{ fontSize:18, fontWeight:900, color:isFree?C.green:C.navy }}>{isFree?"Free":fmtINR(finalPrice)}</span>
        </div>
      </div>
      <div style={{ marginBottom:20 }}>
        <label style={{ display:"block", fontSize:12, fontWeight:700, color:C.navy, marginBottom:5 }}>Discount Code</label>
        <div style={{ display:"flex", gap:8 }}>
          <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="Enter code if you have one"
            onKeyDown={e => e.key==="Enter" && applyCode()}
            style={{ flex:1, background:C.white, border:"1.5px solid "+(codeErr?C.red:discount?C.green:C.border),
              borderRadius:10, padding:"11px 14px", color:C.text, fontFamily:"inherit", fontSize:14, outline:"none", letterSpacing:"0.06em" }} />
          <button onClick={applyCode} style={{ background:"linear-gradient(135deg,"+C.blue+","+C.blueMid+")",
            border:"none", borderRadius:10, color:C.white, fontSize:13, padding:"11px 18px",
            cursor:"pointer", fontWeight:700, fontFamily:"inherit", whiteSpace:"nowrap" }}>Apply</button>
        </div>
        {codeErr  && <div style={{ fontSize:11, color:C.red,   marginTop:4 }}>{codeErr}</div>}
        {discount && <div style={{ fontSize:11, color:C.green, marginTop:4, fontWeight:700 }}>✓ {discount.label} applied</div>}
      </div>
      {!isFree && (
        <div style={{ marginBottom:16 }}>
          <div style={{ background:C.blueXLight, border:"1.5px solid "+C.border, borderRadius:10, padding:"10px 14px", marginBottom:14, fontSize:11, color:C.textMid }}>
            🔒 Card details handled directly by <strong>Stripe</strong>. We never see or store your card number.
          </div>
          <label style={{ display:"block", fontSize:12, fontWeight:700, color:C.navy, marginBottom:6 }}>Card details</label>
          <div ref={cardDivRef} style={{ background:C.white, border:"1.5px solid "+C.border, borderRadius:10, padding:"13px 14px", minHeight:46 }} />
          {!stripeReady && <div style={{ fontSize:11, color:C.textLo, marginTop:4 }}>Loading secure card form...</div>}
        </div>
      )}
      {payErr && <div style={{ padding:"10px 14px", background:C.redBg, border:"1px solid #fca5a5", borderRadius:8, color:C.red, fontSize:12, marginBottom:14 }}>{payErr}</div>}
      <Btn onClick={handlePay} variant={isFree?"gold":"primary"} disabled={loading||(!isFree&&!stripeReady)} icon={loading?"⟳":isFree?"✨":"🔒"}>
        {loading ? (isFree?"Activating...":"Processing...") : (isFree?"Activate free account →":"Pay "+fmtINR(finalPrice)+" & activate →")}
      </Btn>
      <div style={{ marginTop:12, textAlign:"center" }}>
        <button onClick={goLogin} style={{ background:"none", border:"none", color:C.textLo, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>Already have an account? Sign in</button>
      </div>
    </AuthShell>
  );
}

function ForgotScreen({ goLogin }) {
  const [email, setEmail] = useState("");
  const [sent,  setSent]  = useState(false);
  const [busy,  setBusy]  = useState(false);
  const [err,   setErr]   = useState("");

  const send = async () => {
    if (!email) { setErr("Please enter your email address."); return; }
    setBusy(true); setErr("");
    if (supabase) await supabase.auth.resetPasswordForEmail(email, { redirectTo: CONFIG.siteUrl });
    setBusy(false); setSent(true);
  };

  return (
    <AuthShell title="Reset password" sub="We'll send a link to your inbox">
      {!sent ? (
        <>
          <FInput label="Your registered email address" type="email" value={email} onChange={setEmail} placeholder="The email address on your account" />
          {err && <div style={{ padding:"10px 14px", background:C.redBg, borderRadius:8, color:C.red, fontSize:12, marginBottom:14 }}>{err}</div>}
          <Btn onClick={send} disabled={busy}>{busy?"Sending...":"Send Reset Link"}</Btn>
          <div style={{ marginTop:12, textAlign:"center" }}>
            <button onClick={goLogin} style={{ background:"none", border:"none", color:C.blue, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>← Back to sign in</button>
          </div>
        </>
      ) : (
        <>
          <div style={{ textAlign:"center", padding:"8px 0 18px" }}>
            <div style={{ fontSize:44, marginBottom:12 }}>📧</div>
            <p style={{ color:C.textMid, fontSize:14 }}>
              If an account exists for <strong>{email}</strong>, a reset link has been sent. Check your inbox.
            </p>
          </div>
          <Btn onClick={goLogin} variant="ghost">← Back to Sign In</Btn>
        </>
      )}
    </AuthShell>
  );
}

function ResetPasswordScreen({ goLogin }) {
  const [pass,    setPass]    = useState("");
  const [confirm, setConfirm] = useState("");
  const [err,     setErr]     = useState("");
  const [busy,    setBusy]    = useState(false);
  const [done,    setDone]    = useState(false);

  const submit = async () => {
    if (!pass || !confirm)    { setErr("Please fill in both fields."); return; }
    if (pass !== confirm)     { setErr("Passwords do not match."); return; }
    if (pass.length < 8)      { setErr("Password must be at least 8 characters."); return; }
    if (!supabase) { setErr("Database not configured."); return; }
    setBusy(true); setErr("");
    const { error } = await supabase.auth.updateUser({ password: pass });
    if (error) { setErr(error.message); setBusy(false); return; }
    await supabase.auth.signOut();
    setBusy(false); setDone(true);
  };

  if (done) return (
    <AuthShell title="Password updated ✓" sub="">
      <div style={{ textAlign:"center", padding:"8px 0 18px" }}>
        <div style={{ width:60, height:60, borderRadius:"50%", background:C.greenBg, border:"2px solid "+C.green,
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:28, margin:"0 auto 16px" }}>✓</div>
        <p style={{ color:C.textMid, fontSize:14, lineHeight:1.6, marginBottom:20 }}>
          Your password has been updated. Sign in with your new password to continue.
        </p>
      </div>
      <Btn onClick={goLogin}>Sign in →</Btn>
    </AuthShell>
  );

  return (
    <AuthShell title="Set new password" sub="Choose a strong password for your account">
      <FInput label="New password" type="password" value={pass} onChange={setPass} placeholder="Minimum 8 characters" />
      <FInput label="Confirm new password" type="password" value={confirm} onChange={setConfirm} placeholder="Repeat your new password" />
      {err && <div style={{ padding:"10px 14px", background:C.redBg, border:"1px solid #fca5a5", borderRadius:8, color:C.red, fontSize:12, marginBottom:14 }}>{err}</div>}
      <Btn onClick={submit} disabled={busy}>{busy?"Updating password...":"Update password →"}</Btn>
    </AuthShell>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   PROFILE SCREEN
═══════════════════════════════════════════════════════════════════ */
function ProfileScreen({ user, onSave }) {
  const [name,  setName]  = useState(user.name  || "");
  const [empId, setEmpId] = useState(user.emp_id || "");
  const [rank,  setRank]  = useState(user.rank  || "Captain");
  const [base,  setBase]  = useState(user.home_base || "DEL");
  const [err,   setErr]   = useState("");
  const [busy,  setBusy]  = useState(false);

  const incomplete = !name || !empId || !base;

  const save = async () => {
    if (!name || !empId || !base) { setErr("Name, Employee ID and Home Base are required."); return; }
    setBusy(true); setErr("");
    if (supabase) {
      const { error } = await supabase.from("profiles").update({
        name, emp_id: empId, rank, home_base: base.toUpperCase().slice(0, 3),
      }).eq("id", user.id);
      if (error) { setErr(error.message); setBusy(false); return; }
    }
    onSave({ ...user, name, emp_id: empId, rank, home_base: base.toUpperCase().slice(0, 3) });
    setBusy(false);
  };

  return (
    <div style={{ padding:"16px 16px 90px", maxWidth:500, margin:"0 auto" }}>
      <div style={{ background:"linear-gradient(120deg,"+C.blue+","+C.navy+")", borderRadius:18,
        padding:"20px", marginBottom:24, boxShadow:"0 4px 20px rgba(26,111,212,0.22)" }}>
        <div style={{ fontSize:11, color:"rgba(255,255,255,0.65)", letterSpacing:"0.12em", textTransform:"uppercase", marginBottom:4 }}>Pilot Profile</div>
        <div style={{ fontSize:22, fontWeight:900, color:C.white }}>Complete your profile</div>
        <div style={{ fontSize:13, color:"rgba(255,255,255,0.6)", marginTop:3 }}>
          {incomplete ? "Required before you can calculate allowances." : "Your profile is complete — update as needed."}
        </div>
      </div>
      {incomplete && (
        <div style={{ padding:"12px 14px", background:C.goldBg, border:"1.5px solid "+C.goldBorder, borderRadius:10, fontSize:12, color:C.goldText, marginBottom:20 }}>
          ⚠ Your profile is incomplete. Please fill in the fields below before calculating.
        </div>
      )}
      <Card>
        <FInput label="Full Name" value={name}  onChange={setName}  placeholder="Your name as on IndiGo ID" />
        <FInput label="Employee ID" value={empId} onChange={setEmpId} placeholder="Your IndiGo employee number" />
        <FSelect label="Rank" value={rank} onChange={setRank} options={RANKS} />
        <FInput label="Home Base (IATA)" value={base} onChange={v => setBase(v.toUpperCase().slice(0,3))} placeholder="e.g. DEL" hint="3-letter IATA code of your home base airport" />
        {err && <div style={{ padding:"10px 14px", background:C.redBg, borderRadius:8, color:C.red, fontSize:12, marginBottom:14 }}>{err}</div>}
        <Btn onClick={save} disabled={busy}>{busy?"Saving...":"Save profile →"}</Btn>
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   CALC SCREEN  (PCSR-based, single file upload)
═══════════════════════════════════════════════════════════════════ */
function CalcScreen({ user, rates, onNeedProfile }) {
  const [pcsrFile,   setPcsrFile]   = useState(null);
  const [pcsrData,   setPcsrData]   = useState(null);   // parsed PCSR result
  const [result,     setResult]     = useState(null);
  const [err,        setErr]        = useState("");
  const [phase,      setPhase]      = useState("idle"); // idle | fetching | calculating | done
  const [progress,   setProgress]   = useState({ current:0, total:0, flight:"" });
  const [svStatus,   setSvStatus]   = useState(null);   // "found" | "missing"
  const [apiStats,   setApiStats]   = useState(null);   // { fetched, cached, failed }

  const homeBase = user.home_base || "DEL";
  const rank     = user.rank || "Captain";

  // Fetch SV data for a given month from Supabase
  const fetchSV = async (month) => {
    if (!supabase) return [];
    const { data } = await supabase.from("sector_values")
      .select("data").eq("month", month).order("uploaded_at", { ascending: false }).limit(1).maybeSingle();
    return data?.data || [];
  };

  const onPcsrParsed = useCallback((file, parsed) => {
    setErr(""); setPcsrFile(file); setPcsrData(parsed); setResult(null);
  }, []);

  const calculate = async () => {
    if (!pcsrData) return;
    setErr(""); setResult(null); setPhase("fetching");

    try {
      // 1. Fetch SV data from Supabase
      const svData = await fetchSV(pcsrData.month);
      setSvStatus(svData.length ? "found" : "missing");

      // 2. Fetch schedule + aircraft reg from AeroDataBox (with cache)
      const { map: schedMap, fetched, cached, failed } = await buildSchedMap(
        pcsrData.sectors,
        (cur, total, flight) => setProgress({ current: cur, total, flight })
      );
      setApiStats({ fetched, cached, failed });
      console.log("[calculate] AeroDataBox done — fetched:", fetched, "cached:", cached, "failed:", failed);
      console.log("[calculate] schedMap keys:", Object.keys(schedMap).length);

      // 3. Filter SV to only flights in this PCSR
      const sectorFlights = new Set(
        pcsrData.sectors.map(s => String(s.flight_no).replace(/^6E/i, ""))
      );
      const svFiltered = (svData || []).filter(r => sectorFlights.has(String(r.FLTNBR)));
      console.log("[calculate] SV rows full:", (svData||[]).length, "filtered:", svFiltered.length);

      // 4. Parse PCSR with Claude
      setPhase("calculating");
      const pcsrText = pcsrData._rawText;
      console.log("[calculate] Calling /api/parse… pcsr_text length:", pcsrText?.length);

      const parseResp = await fetch("/api/parse", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pcsr_text: pcsrText, employee_id: user.emp_id }),
      });
      if (!parseResp.ok) {
        const errBody = await parseResp.json().catch(() => ({ error: parseResp.statusText }));
        throw new Error(errBody.error || `Parse API error ${parseResp.status}`);
      }
      const { period: parsedPeriod, sectors } = await parseResp.json();
      console.log("[calculate] Parsed sectors:", sectors?.length, "period:", parsedPeriod);

      // 5. Run deterministic JS calculations
      const pilot = { name: user.name, employee_id: user.emp_id, home_base: homeBase, rank };
      const res = runCalculations(parsedPeriod, sectors, schedMap, svFiltered, pilot, null);

      console.log("[calculate] Result — total:", res.total,
        "deadhead:", res.deadhead?.sectors?.length,
        "layover:", res.layover?.events?.length,
        "transit:", res.transit?.halts?.length,
        "tailSwap:", res.tailSwap?.count);

      // Fallback period label if Claude didn't return one
      if (!res.period && pcsrData.month) {
        const [y, mo] = pcsrData.month.split("-").map(Number);
        res.period = new Date(y, mo - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
      }

      setResult(res);
      setPhase("done");
    } catch (e) {
      setErr(e?.message || String(e));
      setPhase("idle");
    }
  };

  const reset = () => {
    setPcsrFile(null); setPcsrData(null); setResult(null);
    setErr(""); setPhase("idle"); setProgress({ current:0, total:0, flight:"" });
    setApiStats(null);
  };

  const profileIncomplete = !user.home_base || !user.emp_id;

  return (
    <div style={{ padding:"16px 16px 90px", maxWidth:680, margin:"0 auto" }}>
      <div style={{ background:"linear-gradient(120deg,"+C.blue+","+C.navy+")", borderRadius:18,
        padding:"20px", marginBottom:20, boxShadow:"0 4px 20px rgba(26,111,212,0.22)" }}>
        <div style={{ fontSize:11, color:"rgba(255,255,255,0.65)", letterSpacing:"0.12em", textTransform:"uppercase", marginBottom:4 }}>
          {rank} · {user.emp_id || "—"} · {homeBase}
        </div>
        <div style={{ fontSize:22, fontWeight:900, color:C.white }}>Hi, {user.name?.split(" ")[0]} 👋</div>
        <div style={{ fontSize:13, color:"rgba(255,255,255,0.6)", marginTop:3 }}>
          Upload your PCSR PDF to calculate this month's allowances.
        </div>
      </div>

      {profileIncomplete && (
        <div style={{ padding:"12px 14px", background:C.goldBg, border:"1.5px solid "+C.goldBorder, borderRadius:10, fontSize:12, color:C.goldText, marginBottom:16, display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
          <span>⚠ Your pilot profile is incomplete — home base or employee ID missing.</span>
          <button onClick={onNeedProfile} style={{ background:"none", border:"1px solid "+C.goldBorder, borderRadius:8, padding:"4px 10px", color:C.goldText, fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" }}>Complete profile →</button>
        </div>
      )}

      {!result && phase !== "fetching" && phase !== "calculating" && (
        <>
          <PcsrDropZone file={pcsrFile} onParsed={onPcsrParsed} onFail={setErr} />

          {pcsrData && (
            <div style={{ marginTop:14, padding:"12px 16px", background: pcsrData.sectors.length < 3 ? C.goldBg : C.greenBg, border:"1.5px solid "+(pcsrData.sectors.length < 3 ? C.goldBorder : C.green), borderRadius:10, fontSize:13, color: pcsrData.sectors.length < 3 ? C.goldText : C.green }}>
              <strong>Parsed:</strong> {pcsrData.sectors.length} sectors · {pcsrData.month} · Format: {pcsrData.format}
              {pcsrData.pilot?.name && <span> · {pcsrData.pilot.name}</span>}
              {pcsrData.sectors.length < 3 && pcsrData._rawSample && (
                <details style={{ marginTop:8 }}>
                  <summary style={{ cursor:"pointer", fontSize:11, fontWeight:700 }}>Show raw PDF text (for debugging)</summary>
                  <pre style={{ marginTop:8, fontSize:10, whiteSpace:"pre-wrap", wordBreak:"break-all", background:"rgba(0,0,0,0.05)", padding:8, borderRadius:6, maxHeight:300, overflow:"auto", color:C.text }}>
                    {pcsrData._rawSample}
                  </pre>
                </details>
              )}
              {pcsrData.sectors.length >= 1 && (
                <details style={{ marginTop:8 }}>
                  <summary style={{ cursor:"pointer", fontSize:11, fontWeight:700 }}>Show parsed sectors (debug)</summary>
                  <div style={{ marginTop:8, marginBottom:4 }}>
                    <button
                      onClick={() => {
                        const fmt = t => t ? t.slice(0,5) : "";
                        const rows = [
                          ["#","Date","Flight","Dep","Arr","DHF","DHT","ATD","ATA"],
                          ...pcsrData.sectors.map((s, i) => [
                            i + 1,
                            s.date,
                            s.flight_no,
                            s.dep,
                            s.arr,
                            s.is_dhf ? "true" : "false",
                            s.is_dht ? "true" : "false",
                            fmt(s.atd_local),
                            fmt(s.ata_local),
                          ])
                        ];
                        const csv = rows.map(r => r.join(",")).join("\n");
                        const a = document.createElement("a");
                        a.href = URL.createObjectURL(new Blob([csv], { type:"text/csv" }));
                        a.download = "sectors.csv";
                        a.click();
                      }}
                      style={{ fontSize:11, padding:"3px 10px", borderRadius:5, border:"1px solid rgba(0,0,0,0.2)", background:"rgba(0,0,0,0.05)", cursor:"pointer" }}
                    >Download CSV</button>
                  </div>
                  <div style={{ marginTop:8, overflowX:"auto" }}>
                    <table style={{ width:"100%", borderCollapse:"collapse", fontSize:10, color:C.text, background:"rgba(0,0,0,0.04)", borderRadius:6 }}>
                      <thead>
                        <tr style={{ background:"rgba(0,0,0,0.08)" }}>
                          {["#","Date","Flight","Dep","Arr","DHF","DHT","ATD (local)","ATA (local)"].map(h => (
                            <th key={h} style={{ padding:"4px 6px", textAlign:"left", fontWeight:700, whiteSpace:"nowrap", borderBottom:"1px solid rgba(0,0,0,0.1)" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {pcsrData.sectors.map((s, i) => (
                          <tr key={i} style={{ background: i % 2 === 0 ? "transparent" : "rgba(0,0,0,0.03)" }}>
                            <td style={{ padding:"3px 6px", color:"rgba(0,0,0,0.4)" }}>{i + 1}</td>
                            <td style={{ padding:"3px 6px", whiteSpace:"nowrap" }}>{s.date}</td>
                            <td style={{ padding:"3px 6px", whiteSpace:"nowrap", fontWeight:600 }}>{s.flight_no}</td>
                            <td style={{ padding:"3px 6px" }}>{s.dep}</td>
                            <td style={{ padding:"3px 6px" }}>{s.arr}</td>
                            <td style={{ padding:"3px 6px", textAlign:"center" }}>{s.is_dhf ? "✓" : ""}</td>
                            <td style={{ padding:"3px 6px", textAlign:"center" }}>{s.is_dht ? "✓" : ""}</td>
                            <td style={{ padding:"3px 6px", whiteSpace:"nowrap" }}>{s.atd_local || "—"}</td>
                            <td style={{ padding:"3px 6px", whiteSpace:"nowrap" }}>{s.ata_local || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </div>
          )}

          {err && <div style={{ marginTop:12, padding:"12px 14px", background:C.redBg, border:"1px solid #fca5a5", borderRadius:10, color:C.red, fontSize:12 }}>{err}</div>}

          <div style={{ marginTop:16 }}>
            <Btn onClick={calculate} disabled={!pcsrData || profileIncomplete} icon="▶">
              Calculate allowances →
            </Btn>
            {profileIncomplete && pcsrData && (
              <div style={{ marginTop:6, fontSize:11, color:C.textLo, textAlign:"center" }}>Complete your profile first to enable calculation.</div>
            )}
          </div>
        </>
      )}

      {phase === "fetching" && (
        <div style={{ marginTop:20, padding:"24px 20px", background:C.white, borderRadius:16, border:"1.5px solid "+C.border, textAlign:"center", boxShadow:C.shadow }}>
          <div style={{ fontSize:32, marginBottom:12 }}>✈</div>
          <div style={{ fontSize:15, fontWeight:800, color:C.navy, marginBottom:6 }}>Fetching schedule data…</div>
          <div style={{ fontSize:12, color:C.textMid, marginBottom:16 }}>
            {progress.total > 0
              ? `${progress.current} / ${progress.total} sectors — ${progress.flight}`
              : "Checking Supabase cache…"}
          </div>
          {progress.total > 0 && (
            <div style={{ background:C.border, borderRadius:4, height:6, overflow:"hidden" }}>
              <div style={{ width:`${(progress.current/progress.total)*100}%`, height:"100%",
                background:"linear-gradient(90deg,"+C.blue+","+C.blueMid+")", transition:"width 0.4s" }} />
            </div>
          )}
          <div style={{ marginTop:14, fontSize:11, color:C.textLo }}>AeroDataBox API · results cached to avoid repeat calls</div>
        </div>
      )}

      {phase === "calculating" && (
        <div style={{ marginTop:20, padding:"24px 20px", background:C.white, borderRadius:16, border:"1.5px solid "+C.border, textAlign:"center", boxShadow:C.shadow }}>
          <div style={{ fontSize:32, marginBottom:12 }}>🤖</div>
          <div style={{ fontSize:15, fontWeight:800, color:C.navy, marginBottom:6 }}>Reading PCSR…</div>
          <div style={{ fontSize:12, color:C.textMid, marginBottom:16 }}>Claude is extracting your sectors. This takes 10–20 seconds.</div>
          <div style={{ background:C.border, borderRadius:4, height:6, overflow:"hidden" }}>
            <div style={{ width:"100%", height:"100%", background:"linear-gradient(90deg,"+C.blue+","+C.blueMid+")",
              animation:"pulse 1.8s ease-in-out infinite", opacity:0.7 }} />
          </div>
          <div style={{ marginTop:14, fontSize:11, color:C.textLo }}>Claude Sonnet · extracting sectors · allowances calculated in JS</div>
        </div>
      )}

      {result && (
        <div style={{ marginTop:4 }}>
          <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:12 }}>
            <Btn onClick={reset} variant="ghost" small full={false} icon="↩">New calculation</Btn>
          </div>

          {svStatus === "missing" && (
            <div style={{ marginBottom:14, padding:"10px 14px", background:C.goldBg, border:"1px solid "+C.goldBorder, borderRadius:10, fontSize:12, color:C.goldText }}>
              ⚠ No Sector Values found for {result.period}. Night allowance cannot be calculated. Ask your admin to upload the SV file for this month.
            </div>
          )}

          {apiStats && (apiStats.failed > 0 || apiStats.fetched > 0 || apiStats.cached > 0) && (
            <div style={{ marginBottom:14, padding:"10px 14px", borderRadius:10, fontSize:12,
              background: apiStats.failed === apiStats.fetched + apiStats.cached + apiStats.failed ? C.redBg : apiStats.failed > 0 ? C.goldBg : C.greenBg,
              border:"1px solid "+(apiStats.failed > 0 && apiStats.fetched + apiStats.cached === 0 ? "#fca5a5" : apiStats.failed > 0 ? C.goldBorder : C.green),
              color: apiStats.failed > 0 && apiStats.fetched + apiStats.cached === 0 ? C.red : apiStats.failed > 0 ? C.goldText : C.green }}>
              Schedule data: {apiStats.fetched} fetched from AeroDataBox · {apiStats.cached} from cache · {apiStats.failed} failed
              {apiStats.failed > 0 && apiStats.fetched + apiStats.cached === 0 && " — tail-swap requires schedule data. Check RAPIDAPI_KEY or try again."}
              {apiStats.failed > 0 && apiStats.fetched + apiStats.cached > 0 && " — deadhead/night calculated from actual times for failed sectors."}
            </div>
          )}

          <div style={{ background:"linear-gradient(135deg,"+C.goldText+" 0%,#8a5500 100%)", borderRadius:18,
            padding:"22px 20px", marginBottom:20, boxShadow:"0 6px 24px rgba(180,112,0,0.28)",
            display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div>
              <div style={{ fontSize:11, color:"rgba(255,255,255,0.7)", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:4 }}>Total Allowance</div>
              <div style={{ fontSize:12, color:"rgba(255,255,255,0.65)" }}>{result.period} · {rank}</div>
            </div>
            <div style={{ fontSize:32, fontWeight:900, color:C.white }}>{fmtINR(result.total)}</div>
          </div>

          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:20 }}>
            {[["Deadhead",result.deadhead.amount,result.deadhead.sectors.length+" sectors"],
              ["Night Flying",result.night.amount,result.night.sectors.length+" sectors"],
              ["Layover",result.layover.amount,result.layover.events.length+" stays"],
              ["Tail Swap",result.tailSwap.amount,result.tailSwap.count+" swaps"],
              ["Transit",result.transit.amount,result.transit.halts.length+" halts"]
            ].map(([lbl,amt,meta]) => (
              <Card key={lbl} style={{ padding:"14px 16px" }}>
                <div style={{ fontSize:10, color:C.blue, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:4 }}>{lbl}</div>
                <div style={{ fontSize:20, fontWeight:900, color:C.navy }}>{fmtINR(amt)}</div>
                <div style={{ fontSize:11, color:C.textLo, marginTop:2 }}>{meta}</div>
              </Card>
            ))}
          </div>

          <div style={{ marginBottom:20 }}>
            <Btn onClick={() => dlCSV(result, user)} variant="ghost" icon="↓">Download Full Breakdown (CSV)</Btn>
          </div>

          {result.deadhead.sectors.length > 0 && (
            <CollapsibleTable title="Deadhead Allowance" total={result.deadhead.amount}
              note={"Rate: "+fmtINR(rates.deadhead[rankBucket(rank)])+"/hr · Scheduled block hours used"}
              headers={["Date","Flight","Route","Sched Block","Amount"]} rows={result.deadhead.sectors}
              renderRow={(s,i) => (
                <tr key={i}><TC i={i}>{s.date}</TC><TC i={i}>{s.flight}</TC><TC i={i}>{s.from}→{s.to}</TC>
                  <TC i={i}>{fmtHM(s.scheduled_block_mins)}</TC><TC i={i} right gold>{fmtINR(s.amount)}</TC></tr>
              )} />
          )}
          {result.night.sectors.length > 0 && (
            <CollapsibleTable title="Night Flying Allowance" total={result.night.amount}
              note="PAH §9.0: STD (IST) + Sector Value → intersect with 00:00–06:00 IST"
              headers={["Date","Flight","Route","STD","Est. ATA","Night Mins","SV","Amount"]} rows={result.night.sectors}
              renderRow={(s,i) => (
                <tr key={i}><TC i={i}>{s.date}</TC><TC i={i}>{s.flight}</TC><TC i={i}>{s.from}→{s.to}</TC>
                  <TC i={i}>{s.std_ist}</TC><TC i={i}>{s.sta_ist}</TC><TC i={i}>{s.night_mins}m</TC>
                  <TC i={i}><Badge color="green">{s.sv_used}m</Badge></TC>
                  <TC i={i} right gold>{fmtINR(s.amount)}</TC></tr>
              )} />
          )}
          {result.layover.events.length > 0 && (
            <CollapsibleTable title="Domestic Layover Allowance" total={result.layover.amount}
              note="Qualifying: >10h 01m away from home base. Extra rate beyond 24h (rounded up to next hour)."
              headers={["Station","Date In","Date Out","Duration","Base","Extra","Total"]} rows={result.layover.events}
              renderRow={(e,i) => (
                <tr key={i}><TC i={i}><strong>{e.station}</strong></TC><TC i={i}>{e.date_in}</TC><TC i={i}>{e.date_out}</TC>
                  <TC i={i}>{e.duration_hrs}h</TC><TC i={i}>{fmtINR(e.base_amount)}</TC>
                  <TC i={i}>{e.extra_amount>0?fmtINR(e.extra_amount):"—"}</TC><TC i={i} right gold>{fmtINR(e.total)}</TC></tr>
              )} />
          )}
          {result.tailSwap.swaps.length > 0 && (
            <CollapsibleTable title={"Tail-Swap Allowance ("+result.tailSwap.count+")"} total={result.tailSwap.amount}
              note="Aircraft registration changes between consecutive sectors in same duty. DHT and DHF+DHF excluded."
              headers={["Date","Sectors","Stn","Reg Out","Reg In","Amount"]} rows={result.tailSwap.swaps}
              renderRow={(s,i) => (
                <tr key={i}><TC i={i}>{s.date}</TC><TC i={i}>{s.sector_pair}</TC>
                  <TC i={i}><strong>{s.station}</strong></TC><TC i={i}>{s.reg_out}</TC><TC i={i}>{s.reg_in}</TC>
                  <TC i={i} right gold>{fmtINR(s.amount)}</TC></tr>
              )} />
          )}
          {result.transit.halts.length > 0 && (
            <CollapsibleTable title="Transit Allowance" total={result.transit.amount}
              note="PAH §7.0: scheduled halt primary; actual if differs >15 mins. Min 90 mins, capped 4 hrs."
              headers={["Date","Station","Arrived","Departed","Halt","Billable","Basis","Amount"]} rows={result.transit.halts}
              renderRow={(h,i) => (
                <tr key={i}><TC i={i}>{h.date}</TC><TC i={i}><strong>{h.station}</strong></TC>
                  <TC i={i}>{h.arrived_ist}</TC><TC i={i}>{h.departed_ist}</TC><TC i={i}>{h.halt_mins}m</TC>
                  <TC i={i}>{h.billable_mins}m</TC>
                  <TC i={i}><Badge color={h.basis==="scheduled"?"green":"gold"}>{h.basis}</Badge></TC>
                  <TC i={i} right gold>{fmtINR(h.amount)}</TC></tr>
              )} />
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ADMIN SCREEN
═══════════════════════════════════════════════════════════════════ */
function AdminScreen({ rates }) {
  const [tab,   setTab]   = useState("users");
  const [users, setUsers] = useState([]);
  const [svMonth,    setSvMonth]    = useState("");
  const [svFile,     setSvFile]     = useState(null);
  const [svUploading,setSvUploading]= useState(false);
  const [svMsg,      setSvMsg]      = useState("");
  const [svHistory,  setSvHistory]  = useState([]);
  const svFileRef = useRef();

  const tabs = [
    { id:"users",  label:"Users" },
    { id:"sv",     label:"Sector Values" },
    { id:"rates",  label:"Current Rates" },
  ];

  useEffect(() => {
    if (!supabase) return;
    if (tab === "users") {
      supabase.from("profiles").select("*").order("created_at").then(({ data }) => { if (data) setUsers(data); });
    }
    if (tab === "sv") {
      supabase.from("sector_values").select("month,uploaded_at,row_count").order("uploaded_at", { ascending: false }).limit(10)
        .then(({ data }) => { if (data) setSvHistory(data); });
    }
  }, [tab]);

  const toggleUser = async (id, currentState) => {
    if (!supabase) return;
    await supabase.from("profiles").update({ is_active: !currentState }).eq("id", id);
    setUsers(prev => prev.map(u => u.id === id ? { ...u, is_active: !currentState } : u));
  };

  const uploadSV = async () => {
    if (!svFile || !svMonth) { setSvMsg("Select a file and enter the month (YYYY-MM)."); return; }
    setSvUploading(true); setSvMsg("");
    try {
      const { read, utils } = await import("xlsx");
      const buf = await svFile.arrayBuffer();
      const wb = read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = utils.sheet_to_json(ws);
      if (!rows.length) throw new Error("Excel file appears empty.");
      // Normalise column names
      const normRows = rows.map(r => {
        const out = {};
        for (const [k, v] of Object.entries(r)) {
          const key = k.trim().replace(/\s+/g,"_");
          out[key] = v;
        }
        return out;
      });
      if (!supabase) throw new Error("Supabase not configured.");
      await supabase.from("sector_values").upsert({
        month: svMonth,
        data: normRows,
        row_count: normRows.length,
        uploaded_at: new Date().toISOString(),
      }, { onConflict: "month" });
      setSvMsg(`✓ Uploaded ${normRows.length} rows for ${svMonth}.`);
      setSvFile(null);
      // Refresh history
      const { data } = await supabase.from("sector_values").select("month,uploaded_at,row_count").order("uploaded_at", { ascending: false }).limit(10);
      if (data) setSvHistory(data);
    } catch (e) {
      setSvMsg("Error: " + (e?.message || String(e)));
    }
    setSvUploading(false);
  };

  return (
    <div style={{ padding:"16px 16px 90px", maxWidth:680, margin:"0 auto" }}>
      <div style={{ background:"linear-gradient(120deg,"+C.navy+","+C.blue+")", borderRadius:18,
        padding:"20px", marginBottom:20, boxShadow:"0 4px 20px rgba(26,111,212,0.22)" }}>
        <div style={{ fontSize:11, color:"rgba(255,255,255,0.6)", letterSpacing:"0.12em", textTransform:"uppercase", marginBottom:4 }}>Admin Panel</div>
        <div style={{ fontSize:22, fontWeight:900, color:C.white }}>System Management</div>
      </div>

      <div style={{ display:"flex", gap:4, background:C.blueXLight, borderRadius:12, padding:4, marginBottom:20, border:"1.5px solid "+C.border }}>
        {tabs.map(({ id, label }) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ flex:1, padding:"9px 6px", borderRadius:9, fontFamily:"inherit", fontSize:12, fontWeight:700,
              cursor:"pointer", border:"none", transition:"all 0.15s",
              background:tab===id ? C.white : "transparent", color:tab===id ? C.blue : C.textMid,
              boxShadow:tab===id ? C.shadow : "none" }}>
            {label}
          </button>
        ))}
      </div>

      {tab === "users" && (
        <div>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
            <div style={{ fontSize:15, fontWeight:700, color:C.navy }}>Registered Users</div>
            <Badge color="green">{users.filter(u => u.is_active).length} active</Badge>
          </div>
          {users.length === 0 && <div style={{ textAlign:"center", padding:40, color:C.textLo }}>No users yet, or database not connected.</div>}
          {users.map(u => (
            <Card key={u.id} style={{ marginBottom:10, display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, flexWrap:"wrap" }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:14, fontWeight:700, color:C.navy, marginBottom:2 }}>{u.name}</div>
                <div style={{ fontSize:12, color:C.textMid }}>{u.email || "—"}</div>
                <div style={{ fontSize:11, color:C.textLo, marginTop:2 }}>ID: {u.emp_id} · {u.rank} · Base: {u.home_base}</div>
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
                <Badge color={u.is_active ? "green" : "red"}>{u.is_active ? "Active" : "Inactive"}</Badge>
                {!u.is_admin && (
                  <Btn onClick={() => toggleUser(u.id, u.is_active)} variant={u.is_active?"danger":"ghost"} small full={false}>
                    {u.is_active ? "Deactivate" : "Activate"}
                  </Btn>
                )}
                {u.is_admin && <Badge color="blue">Admin</Badge>}
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab === "sv" && (
        <div>
          <Card color="blue" style={{ marginBottom:16 }}>
            <div style={{ fontSize:13, fontWeight:700, color:C.navy, marginBottom:8 }}>Upload Sector Values (Excel)</div>
            <div style={{ fontSize:12, color:C.textMid, marginBottom:14, lineHeight:1.6 }}>
              Upload the SV Excel file once per month (~22nd). All users share this data.
              Expected columns: <code style={{ background:C.sky, padding:"1px 5px", borderRadius:4 }}>FLTNBR, DEP, ARR, Time_Slot, SectorValue</code>
            </div>
            <FInput label="Month (YYYY-MM)" value={svMonth} onChange={setSvMonth} placeholder="e.g. 2026-01" hint="The month these sector values apply to" />
            <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:14 }}>
              <input ref={svFileRef} type="file" accept=".xlsx,.xls" style={{ display:"none" }}
                onChange={e => { if (e.target.files[0]) setSvFile(e.target.files[0]); }} />
              <button onClick={() => svFileRef.current?.click()}
                style={{ background:C.white, border:"1.5px solid "+C.borderMid, borderRadius:10,
                  padding:"10px 16px", fontSize:13, fontWeight:700, color:C.blue, cursor:"pointer", fontFamily:"inherit" }}>
                Choose Excel file
              </button>
              {svFile && <span style={{ fontSize:12, color:C.blue }}>✓ {svFile.name}</span>}
            </div>
            <Btn onClick={uploadSV} disabled={svUploading || !svFile || !svMonth} icon="⬆">
              {svUploading ? "Uploading..." : "Upload SV data →"}
            </Btn>
            {svMsg && (
              <div style={{ marginTop:10, padding:"10px 14px", borderRadius:8, fontSize:12,
                background: svMsg.startsWith("✓") ? C.greenBg : C.redBg,
                color: svMsg.startsWith("✓") ? C.green : C.red,
                border: "1px solid " + (svMsg.startsWith("✓") ? C.green : "#fca5a5") }}>
                {svMsg}
              </div>
            )}
          </Card>

          {svHistory.length > 0 && (
            <Card>
              <div style={{ fontSize:13, fontWeight:700, color:C.navy, marginBottom:10 }}>Upload History</div>
              {svHistory.map((h, i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                  padding:"10px 0", borderBottom:i<svHistory.length-1?"1px solid "+C.border:"none" }}>
                  <div>
                    <div style={{ fontSize:13, fontWeight:700, color:C.navy }}>{h.month}</div>
                    <div style={{ fontSize:11, color:C.textLo }}>{h.row_count} rows · {new Date(h.uploaded_at).toLocaleDateString("en-IN")}</div>
                  </div>
                  <Badge color="green">Uploaded</Badge>
                </div>
              ))}
            </Card>
          )}
        </div>
      )}

      {tab === "rates" && (
        <div>
          <Card color="blue" style={{ marginBottom:14 }}>
            <div style={{ fontSize:11, color:C.blue, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Source</div>
            <div style={{ fontSize:14, fontWeight:700, color:C.navy }}>{rates.source}</div>
            <div style={{ fontSize:12, color:C.textMid, marginTop:2 }}>Effective: {rates.lastUpdated}</div>
          </Card>
          {[["Deadhead (per sched block hr)", rates.deadhead],
            ["Night Flying (per hr)", rates.night],
            ["Tail Swap (per swap)", rates.tailSwap],
            ["Transit (per hr)", rates.transit]
          ].map(([lbl, obj]) => (
            <Card key={lbl} style={{ marginBottom:10 }}>
              <div style={{ fontSize:11, color:C.blue, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:10 }}>{lbl}</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                {["Captain","First Officer","Cabin Crew"].map(r => (
                  <div key={r} style={{ textAlign:"center", padding:"10px 6px", background:C.sky, borderRadius:10 }}>
                    <div style={{ fontSize:10, color:C.textMid, marginBottom:5, fontWeight:600 }}>{r}</div>
                    <div style={{ fontSize:16, fontWeight:900, color:obj[r] ? C.navy : C.textLo }}>
                      {obj[r] ? fmtINR(obj[r]) : <span style={{ fontSize:12 }}>N/A</span>}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
          <div style={{ padding:"12px 16px", background:C.goldBg, border:"1.5px solid "+C.goldBorder,
            borderRadius:12, fontSize:12, color:C.goldText, lineHeight:1.6, marginTop:8 }}>
            <strong>To update rates:</strong> edit DEFAULT_RATES in the app source when a new IndiGo circular is issued.
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ROOT APP
═══════════════════════════════════════════════════════════════════ */
export default function App() {
  const [screen,      setScreen]      = useState("loading");
  const [user,        setUser]        = useState(null);
  const [tab,         setTab]         = useState("calc");
  const [rates]                       = useState(DEFAULT_RATES);
  const [pendingUser, setPendingUser] = useState(null);

  useEffect(() => {
    if (!supabase) { Promise.resolve().then(() => setScreen("landing")); return; }
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session) {
        const { data: profile } = await supabase.from("profiles").select("*").eq("id", session.user.id).single();
        if (profile && profile.is_active) {
          setUser({ ...profile, email: session.user.email });
          setTab(profile.is_admin ? "admin" : "calc");
          setScreen("app");
        } else {
          setScreen("login");
        }
      } else {
        setScreen("landing");
      }
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === "PASSWORD_RECOVERY") { setScreen("reset-password"); return; }
      if (event === "SIGNED_OUT" || !session) { setUser(null); setScreen("landing"); }
    });
    return () => subscription.unsubscribe();
  }, []);

  const onLogin = u => {
    setUser(u);
    setTab(u.is_admin ? "admin" : "calc");
    setScreen("app");
  };
  const onLogout = async () => {
    if (supabase) await supabase.auth.signOut();
    setUser(null); setScreen("landing");
  };
  const onActivate   = u => setPendingUser(u);
  const goCheckout   = u => { setPendingUser(u); setScreen("checkout"); };
  const onProfileSave = u => { setUser(u); setTab("calc"); };

  const nav = [
    { id:"calc",    icon:"🧮", label:"Calculator" },
    { id:"profile", icon:"👤", label:"Profile"    },
    ...(user?.is_admin ? [{ id:"admin", icon:"⚙", label:"Admin" }] : []),
  ];

  if (screen === "loading") return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center",
      background:"linear-gradient(160deg,"+C.skyMid+","+C.sky+")", fontFamily:"'Nunito','Segoe UI',sans-serif" }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ width:54, height:54, borderRadius:16, background:"linear-gradient(135deg,"+C.blue+","+C.navy+")",
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, margin:"0 auto 16px",
          boxShadow:"0 6px 20px rgba(26,111,212,0.3)" }}>✈</div>
        <div style={{ fontSize:14, color:C.textMid }}>Loading...</div>
      </div>
    </div>
  );

  if (screen === "landing")        return <LandingPage goLogin={() => setScreen("login")} goSignup={() => setScreen("signup")} />;
  if (screen === "login")          return <LoginScreen onLogin={onLogin} goSignup={() => setScreen("signup")} goForgot={() => setScreen("forgot")} goLanding={() => setScreen("landing")} />;
  if (screen === "signup")         return <SignupScreen goLogin={() => setScreen("login")} goLanding={() => setScreen("landing")} goCheckout={goCheckout} />;
  if (screen === "checkout")       return <CheckoutScreen pendingUser={pendingUser} goLogin={() => setScreen("login")} onActivate={onActivate} />;
  if (screen === "forgot")         return <ForgotScreen goLogin={() => setScreen("login")} />;
  if (screen === "reset-password") return <ResetPasswordScreen goLogin={() => setScreen("login")} />;

  return (
    <div style={{ minHeight:"100vh", background:C.sky, fontFamily:"'Nunito','Segoe UI',sans-serif", color:C.text }}>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap" rel="stylesheet" />

      <div style={{ background:C.white, borderBottom:"1px solid "+C.border, padding:"12px 16px",
        display:"flex", alignItems:"center", justifyContent:"space-between",
        position:"sticky", top:0, zIndex:20, boxShadow:"0 1px 8px rgba(26,111,212,0.07)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:36, height:36, borderRadius:11, background:"linear-gradient(135deg,"+C.blue+","+C.navy+")",
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, boxShadow:"0 2px 8px rgba(26,111,212,0.28)" }}>✈</div>
          <div>
            <div style={{ fontSize:16, fontWeight:900, color:C.navy, letterSpacing:"-0.02em", lineHeight:1 }}>{APP_NAME}</div>
            <div style={{ fontSize:9, color:C.blue, letterSpacing:"0.1em", textTransform:"uppercase", opacity:0.75 }}>{CONFIG.airline}</div>
          </div>
        </div>
        <button onClick={onLogout} style={{ background:C.blueXLight, border:"1px solid "+C.border,
          borderRadius:9, color:C.textMid, fontSize:12, padding:"7px 14px", cursor:"pointer", fontWeight:700 }}>
          Sign out
        </button>
      </div>

      <div style={{ animation:"fadeUp 0.25s ease" }}>
        {tab === "calc"    && <CalcScreen    user={user} rates={rates} onNeedProfile={() => setTab("profile")} />}
        {tab === "profile" && <ProfileScreen user={user} onSave={onProfileSave} />}
        {tab === "admin"   && <AdminScreen   rates={rates} />}
      </div>

      <div style={{ position:"fixed", bottom:0, left:0, right:0, background:C.white,
        borderTop:"1px solid "+C.border, display:"flex", zIndex:20,
        boxShadow:"0 -2px 16px rgba(26,111,212,0.08)",
        paddingBottom:"env(safe-area-inset-bottom,0px)" }}>
        {nav.map(({ id, icon, label }) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ flex:1, padding:"10px 8px 12px", background:"transparent", border:"none",
              color:tab===id ? C.blue : C.textLo, cursor:"pointer", transition:"all 0.15s",
              borderTop:"2.5px solid "+(tab===id ? C.blue : "transparent") }}>
            <div style={{ fontSize:22, marginBottom:2 }}>{icon}</div>
            <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.04em", textTransform:"uppercase" }}>{label}</div>
          </button>
        ))}
        <div style={{ flex:1, padding:"10px 8px 12px", display:"flex", flexDirection:"column",
          alignItems:"center", justifyContent:"center", borderTop:"2.5px solid transparent" }}>
          <div style={{ width:28, height:28, borderRadius:"50%",
            background:"linear-gradient(135deg,"+C.blue+","+C.navy+")",
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:11, fontWeight:900, color:C.white, marginBottom:2 }}>
            {user?.name?.split(" ").map(w => w[0]).slice(0, 2).join("")}
          </div>
          <div style={{ fontSize:9, fontWeight:700, color:C.textLo, letterSpacing:"0.04em", textTransform:"uppercase" }}>
            {user?.rank === "First Officer" || user?.rank === "Senior First Officer" ? "F/O"
              : user?.rank === "Captain" || user?.rank === "Senior Captain" ? "Capt"
              : user?.is_admin ? "Admin" : user?.rank?.split(" ")[0]}
          </div>
        </div>
      </div>
    </div>
  );
}
