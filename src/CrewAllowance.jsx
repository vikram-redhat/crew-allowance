import { useState, useRef, useCallback, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";

/* ═══════════════════════════════════════════════════════════════════
   SUPABASE CLIENT
   Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local
═══════════════════════════════════════════════════════════════════ */
const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL      || "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const supabase = SUPABASE_URL
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

const sbWarn = () => console.warn("Supabase not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY");

/* ═══════════════════════════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════════════════════════ */
const APP_NAME   = "Crew Allowance";
const RANKS      = ["Captain", "First Officer", "Cabin Crew"];
const PRICE_INR  = 299;
const PRICE_LABEL= "₹299";

const DISCOUNT_CODES = {
  "CREW2026": { pct: 100, label: "100% off — Free"   },
  "LAUNCH50": { pct: 50,  label: "50% off — ₹149/mo" },
  "INDIGO10": { pct: 10,  label: "10% off — ₹269/mo" },
};

const DEFAULT_RATES = {
  lastUpdated: "1 January 2026",
  source: "IndiGo Revised Cockpit Crew Allowances",
  deadhead:  { Captain: 4000, "First Officer": 2000, "Cabin Crew": null },
  night:     { Captain: 2000, "First Officer": 1000, "Cabin Crew": null },
  layover:   { Captain: { base: 3000, beyondRate: 150 }, "First Officer": { base: 1500, beyondRate: 75 }, "Cabin Crew": null },
  tailSwap:  { Captain: 1500, "First Officer": 750,  "Cabin Crew": null },
  transit:   { Captain: 1000, "First Officer": 500,  "Cabin Crew": null },
  layoverMinHours: 10.0167,
};

/* ═══════════════════════════════════════════════════════════════════
   SAMPLE CSV DATA
═══════════════════════════════════════════════════════════════════ */
const SAMPLE_LOGBOOK = `Date,Flight_No,Dep_Airport,Dep_Time_UTC,Arr_Airport,Arr_Time_UTC,Aircraft_Type,Aircraft_Reg,Block_Time,Operated_As,Home_Base
01/01/26,6327,DEL,02:55,DED,03:42,320,VTIKS,00:47,PIC,DEL
01/01/26,2312,DED,04:25,DEL,05:18,320,VTIKS,00:53,PIC,DEL
01/01/26,2230,DEL,07:16,KNU,08:27,320,VTIJG,01:11,PIC,DEL
01/01/26,2158,KNU,09:01,DEL,10:20,320,VTIJG,01:19,PIC,DEL
05/01/26,6836,DEL,01:24,CCU,03:27,321,VTNCK,02:03,PIC,DEL
05/01/26,5077,CCU,04:16,DEL,06:36,321,VTNCK,02:20,PIC,DEL
06/01/26,6843,DEL,06:37,UDR,07:54,321,VTICX,01:17,PIC,DEL
06/01/26,6844,UDR,08:28,DEL,09:41,321,VTICX,01:13,PIC,DEL
06/01/26,6845,DEL,11:00,STV,12:42,321,VTICX,01:42,PIC,DEL
06/01/26,6846,STV,13:11,DEL,14:42,321,VTICX,01:31,PIC,DEL
07/01/26,519,DEL,18:11,BOM,20:23,321,VTNCJ,02:12,DHF,DEL
07/01/26,6045,BOM,21:24,DEL,23:19,321,VTNCJ,01:55,PIC,DEL
11/01/26,2052,DEL,06:36,HYD,08:45,321,VTICH,02:09,PIC,DEL
11/01/26,2073,HYD,10:23,TRZ,12:00,320,VTIFQ,01:37,PIC,DEL
12/01/26,770,TRZ,23:57,DEL,02:49,320,VTIXN,02:52,PIC,DEL
15/01/26,5037,DEL,23:02,JAI,23:45,321,VTIMJ,00:43,PIC,DEL
16/01/26,752,JAI,00:22,HYD,02:18,321,VTIMJ,01:56,PIC,DEL
17/01/26,424,HYD,00:19,DEL,02:21,321,VTNHB,02:02,PIC,DEL
17/01/26,6328,DEL,04:41,BOM,07:26,321,VTNCD,02:45,PIC,DEL
17/01/26,615,BOM,08:31,DEL,10:39,321,VTNCD,02:08,PIC,DEL
19/01/26,6731,DEL,08:55,RDP,10:49,321,VTIUP,01:54,PIC,DEL
19/01/26,6732,RDP,11:17,DEL,13:43,321,VTIUP,02:26,PIC,DEL
19/01/26,6733,DEL,14:48,AMD,16:26,320,VTIIV,01:38,PIC,DEL
19/01/26,6794,AMD,18:07,BOM,19:53,320,VTISY,01:46,PIC,DEL
20/01/26,359,BOM,11:02,DEL,13:06,321,VTNCJ,02:04,DHF,DEL
23/01/26,6762,DEL,07:50,IXJ,09:19,321,VTIBH,01:29,PIC,DEL
23/01/26,2044,IXJ,10:44,DEL,12:31,321,VTIBH,01:47,PIC,DEL
24/01/26,6188,DEL,07:34,BLR,10:13,321,VTNCD,02:39,DHF,DEL
24/01/26,451,BLR,11:55,LKO,14:30,320,VTISU,02:35,PIC,DEL
24/01/26,6354,LKO,15:30,BLR,18:04,320,VTIPF,02:34,PIC,DEL
25/01/26,6034,BLR,12:30,DEL,15:24,321,VTNCJ,02:54,DHF,DEL
26/01/26,2145,DEL,10:51,CCJ,13:48,321,VTIMH,02:57,PIC,DEL
26/01/26,2773,CCJ,14:24,DEL,17:26,321,VTIMH,03:02,DHF,DEL
27/01/26,759,DEL,12:02,IXC,12:58,321,VTILL,00:56,PIC,DEL
27/01/26,760,IXC,13:38,DEL,14:50,321,VTILL,01:12,PIC,DEL
27/01/26,761,DEL,15:29,BBI,17:45,321,VTILL,02:16,PIC,DEL
27/01/26,806,BBI,18:13,DEL,20:35,321,VTILL,02:22,PIC,DEL
30/01/26,1103,DEL,07:11,DAC,09:25,321,VTIRV,02:14,PIC,DEL
30/01/26,1104,DAC,10:24,DEL,13:13,321,VTIRV,02:49,PIC,DEL
31/01/26,6711,DEL,09:53,CCU,11:56,321,VTNCY,02:03,PIC,DEL
31/01/26,6721,CCU,12:39,DEL,15:07,321,VTNCY,02:28,PIC,DEL
31/01/26,6722,DEL,15:54,CCU,18:04,321,VTNCY,02:10,PIC,DEL`;

const SAMPLE_SCHEDULE = `Date,Flight_No,Duty_Code,STD_Local,STA_Local,From_Airport,To_Airport,Aircraft_Type
01/01/2026,6327,,08:25,09:12,DEL,DED,320
01/01/2026,2312,,09:55,10:48,DED,DEL,320
01/01/2026,2230,,12:46,13:57,DEL,KNU,320
01/01/2026,2158,,14:31,15:50,KNU,DEL,320
05/01/2026,6836,,06:54,08:57,DEL,CCU,321
05/01/2026,5077,,09:46,12:06,CCU,DEL,321
06/01/2026,6843,,12:07,13:24,DEL,UDR,321
06/01/2026,6844,,13:58,15:11,UDR,DEL,321
06/01/2026,6845,,16:30,18:12,DEL,STV,321
06/01/2026,6846,,18:41,20:12,STV,DEL,321
07/01/2026,519,DHF,23:41,01:53,DEL,BOM,321
07/01/2026,6045,,02:54,04:49,BOM,DEL,321
11/01/2026,2052,,12:06,14:15,DEL,HYD,321
11/01/2026,2073,,15:53,17:30,HYD,TRZ,320
12/01/2026,770,,05:27,08:19,TRZ,DEL,320
15/01/2026,5037,,04:32,05:15,DEL,JAI,321
16/01/2026,752,,05:52,07:48,JAI,HYD,321
17/01/2026,424,,05:49,07:51,HYD,DEL,321
17/01/2026,6328,,10:11,12:56,DEL,BOM,321
17/01/2026,615,,14:01,16:09,BOM,DEL,321
19/01/2026,6731,,14:25,16:19,DEL,RDP,321
19/01/2026,6732,,16:47,19:13,RDP,DEL,321
19/01/2026,6733,,20:18,21:56,DEL,AMD,320
19/01/2026,6794,,23:37,01:23,AMD,BOM,320
20/01/2026,359,DHF,16:32,18:36,BOM,DEL,321
23/01/2026,6762,,13:20,14:49,DEL,IXJ,321
23/01/2026,2044,,16:14,18:01,IXJ,DEL,321
24/01/2026,6188,DHF,13:04,15:43,DEL,BLR,321
24/01/2026,451,,17:25,20:00,BLR,LKO,320
24/01/2026,6354,,21:00,23:34,LKO,BLR,320
25/01/2026,6034,DHF,18:00,20:54,BLR,DEL,321
26/01/2026,2145,,16:21,19:18,DEL,CCJ,321
26/01/2026,2773,DHF,19:54,22:56,CCJ,DEL,321
27/01/2026,759,,17:32,18:28,DEL,IXC,321
27/01/2026,760,,19:08,20:20,IXC,DEL,321
27/01/2026,761,,20:59,23:15,DEL,BBI,321
27/01/2026,806,,23:43,02:05,BBI,DEL,321
30/01/2026,1103,,12:41,15:25,DEL,DAC,321
30/01/2026,1104,,16:24,18:43,DAC,DEL,321
31/01/2026,6711,,13:09,15:26,DEL,CCU,321
31/01/2026,6721,,16:09,18:37,CCU,DEL,321
31/01/2026,6722,,19:24,21:34,DEL,CCU,321`;

/* ═══════════════════════════════════════════════════════════════════
   CALCULATION ENGINE
═══════════════════════════════════════════════════════════════════ */
const parseCSV = t => { const l=t.trim().split(/\r?\n/); const h=l[0].split(",").map(x=>x.trim().replace(/^"|"$/g,"")); return l.slice(1).filter(x=>x.trim()).map(r=>{const v=r.split(",").map(x=>x.trim().replace(/^"|"$/g,""));return Object.fromEntries(h.map((k,i)=>[k,v[i]??""]));}); };
const t2m = t => { if(!t||!t.includes(":"))return 0; const[h,m]=t.split(":").map(Number); return h*60+(m||0); };
const toIST = u => (u+330+2880)%1440;
const fmtHM = m => { const h=Math.floor(Math.abs(m)/60),mn=Math.round(Math.abs(m)%60); return h+"h "+mn.toString().padStart(2,"0")+"m"; };
const fmtIST = u => { const i=toIST(t2m(u)); return String(Math.floor(i/60)).padStart(2,"0")+":"+String(i%60).padStart(2,"0"); };
const fmtINR = n => "₹"+(Math.round(n||0)).toLocaleString("en-IN");
const parseDate = s => { if(!s)return null; const[d,mo,y]=s.split("/").map(Number); return new Date(y<100?2000+y:y,mo-1,d); };
const nightMins = (dep,arr) => { let dI=toIST(t2m(dep)),aI=toIST(t2m(arr)); if(aI<=dI)aI+=1440; return [[0,360],[1440,1800]].reduce((a,[ws,we])=>a+Math.max(0,Math.min(aI,we)-Math.max(dI,ws)),0); };

const runCalc = (logCSV, schedCSV, rank, rates) => {
  const log=parseCSV(logCSV).sort((a,b)=>{const da=parseDate(a.Date),db=parseDate(b.Date);return da-db||t2m(a.Dep_Time_UTC)-t2m(b.Dep_Time_UTC);});
  const sched=parseCSV(schedCSV);
  const homeBase=log[0]?.Home_Base||"DEL";
  const isDH=r=>["DHF","DHT"].includes(r.Operated_As);
  const R=rates;
  const dhR=R.deadhead[rank],nR=R.night[rank],tsR=R.tailSwap[rank],trR=R.transit[rank],lvR=R.layover[rank];
  const res={pilot:{rank,homeBase},period:"",deadhead:{sectors:[],total_mins:0,amount:0},night:{sectors:[],total_mins:0,amount:0},layover:{events:[],amount:0},tailSwap:{swaps:[],count:0,amount:0},transit:{halts:[],amount:0},total:0};
  const dates=log.map(r=>parseDate(r.Date)).filter(Boolean);
  if(dates.length){const mn=new Date(Math.min(...dates));res.period=mn.toLocaleDateString("en-IN",{month:"long",year:"numeric"});}
  log.filter(isDH).forEach(s=>{const sc=sched.find(r=>r.Flight_No===s.Flight_No);let bm;if(sc){let d=t2m(sc.STA_Local)-t2m(sc.STD_Local);if(d<0)d+=1440;bm=d;}else{bm=t2m(s.Block_Time);}if(!dhR||!bm)return;const amt=(bm/60)*dhR;res.deadhead.sectors.push({date:s.Date,flight:s.Flight_No,from:s.Dep_Airport,to:s.Arr_Airport,scheduled_block_mins:bm,amount:amt});res.deadhead.total_mins+=bm;res.deadhead.amount+=amt;});
  log.filter(s=>!isDH(s)).forEach(s=>{const nm=nightMins(s.Dep_Time_UTC,s.Arr_Time_UTC);if(nm>0&&nR){const amt=(nm/60)*nR;res.night.sectors.push({date:s.Date,flight:s.Flight_No,from:s.Dep_Airport,to:s.Arr_Airport,dep_ist:fmtIST(s.Dep_Time_UTC),arr_ist:fmtIST(s.Arr_Time_UTC),night_mins:Math.round(nm),amount:amt});res.night.total_mins+=nm;res.night.amount+=amt;}});
  for(let i=0;i<log.length-1;i++){const a=log[i],b=log[i+1];if(isDH(a)&&isDH(b))continue;if(a.Arr_Airport!==b.Dep_Airport)continue;if(parseDate(a.Date)?.getTime()!==parseDate(b.Date)?.getTime())continue;if(a.Aircraft_Reg===b.Aircraft_Reg||!tsR)continue;res.tailSwap.swaps.push({date:a.Date,sector_pair:a.Flight_No+"->"+b.Flight_No,reg_out:a.Aircraft_Reg,reg_in:b.Aircraft_Reg,is_dh_involved:isDH(a)||isDH(b),amount:tsR});res.tailSwap.amount+=tsR;}
  res.tailSwap.count=res.tailSwap.swaps.length;
  for(let i=0;i<log.length-1;i++){const a=log[i],b=log[i+1];if(a.Arr_Airport!==b.Dep_Airport||a.Arr_Airport===homeBase)continue;if(parseDate(a.Date)?.getTime()!==parseDate(b.Date)?.getTime())continue;let gap=t2m(b.Dep_Time_UTC)-t2m(a.Arr_Time_UTC);if(gap<0)gap+=1440;if(gap<=90||gap>240||!trR)continue;const bill=Math.min(gap,240),amt=(bill/60)*trR;res.transit.halts.push({date:a.Date,station:a.Arr_Airport,arrived_ist:fmtIST(a.Arr_Time_UTC),departed_ist:fmtIST(b.Dep_Time_UTC),halt_mins:Math.round(gap),billable_mins:Math.round(bill),amount:amt});res.transit.amount+=amt;}
  const opLog=log.filter(s=>!isDH(s));
  for(let i=0;i<opLog.length-1;i++){const a=opLog[i],b=opLog[i+1];if(a.Arr_Airport===homeBase||b.Dep_Airport!==a.Arr_Airport)continue;const dA=parseDate(a.Date),dB=parseDate(b.Date);if(!dA||!dB||dA.getTime()===dB.getTime())continue;const gapHrs=(Math.round((dB-dA)/86400000)*1440+t2m(b.Dep_Time_UTC)-t2m(a.Arr_Time_UTC))/60;if(gapHrs<R.layoverMinHours||!lvR)continue;const baseAmt=lvR.base,extraAmt=Math.max(0,(gapHrs-24)*lvR.beyondRate);res.layover.events.push({station:a.Arr_Airport,date_in:a.Date,date_out:b.Date,check_in_ist:fmtIST(a.Arr_Time_UTC),check_out_ist:fmtIST(b.Dep_Time_UTC),duration_hrs:Math.round(gapHrs*100)/100,base_amount:baseAmt,extra_amount:extraAmt,total:baseAmt+extraAmt});res.layover.amount+=baseAmt+extraAmt;}
  res.total=res.deadhead.amount+res.night.amount+res.layover.amount+res.tailSwap.amount+res.transit.amount;
  return res;
};

const dlCSV = (res, pilot) => {
  const rows=[],add=(...r)=>rows.push(r.join(","));
  add("Crew Allowance Statement - "+res.period);
  add("Pilot: "+pilot.name,"ID: "+pilot.empId,"Rank: "+pilot.rank);
  add();add("DEADHEAD");add("Date","Flight","From","To","Sched Block (mins)","Amount (INR)");
  res.deadhead.sectors.forEach(s=>add(s.date,s.flight,s.from,s.to,s.scheduled_block_mins,Math.round(s.amount)));
  add("TOTAL","","","","",Math.round(res.deadhead.amount));add();
  add("NIGHT FLYING (0000-0600 IST)");add("Date","Flight","From","To","Dep IST","Arr IST","Night Mins","Amount (INR)");
  res.night.sectors.forEach(s=>add(s.date,s.flight,s.from,s.to,s.dep_ist,s.arr_ist,s.night_mins,Math.round(s.amount)));
  add("TOTAL","","","","","","",Math.round(res.night.amount));add();
  add("LAYOVER");add("Station","Date In","Date Out","Check-In","Check-Out","Hrs","Base","Extra","Total (INR)");
  res.layover.events.forEach(e=>add(e.station,e.date_in,e.date_out,e.check_in_ist,e.check_out_ist,e.duration_hrs,Math.round(e.base_amount),Math.round(e.extra_amount),Math.round(e.total)));
  add("TOTAL","","","","","","","",Math.round(res.layover.amount));add();
  add("TAIL-SWAP");add("Date","Sectors","Reg Out","Reg In","DH?","Amount (INR)");
  res.tailSwap.swaps.forEach(s=>add(s.date,s.sector_pair,s.reg_out,s.reg_in,s.is_dh_involved?"Yes":"No",Math.round(s.amount)));
  add("TOTAL","","","","",Math.round(res.tailSwap.amount));add();
  add("TRANSIT");add("Date","Station","Arrived","Departed","Halt","Billable","Amount (INR)");
  res.transit.halts.forEach(h=>add(h.date,h.station,h.arrived_ist,h.departed_ist,h.halt_mins,h.billable_mins,Math.round(h.amount)));
  add("TOTAL","","","","","",Math.round(res.transit.amount));add();
  add("GRAND TOTAL INR",Math.round(res.total));
  const blob=new Blob([rows.join("\n")],{type:"text/csv;charset=utf-8;"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);
  a.download="CrewAllowance_"+pilot.empId+"_"+res.period?.replace(/\s/g,"_")+".csv";a.click();
};

const dlTemplate = (csv, name) => {
  const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;a.click();
};

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
   SHARED UI
═══════════════════════════════════════════════════════════════════ */
function FInput({ label, type="text", value, onChange, placeholder, autoComplete, hint, readOnly }) {
  const [f, setF] = useState(false);
  return (
    <div style={{ marginBottom: 16 }}>
      {label && <label style={{ display:"block", fontSize:12, fontWeight:700, color:C.navy, marginBottom:5 }}>{label}</label>}
      <input
        type={type} value={value}
        onChange={e => onChange && onChange(e.target.value)}
        placeholder={placeholder} autoComplete={autoComplete} readOnly={readOnly}
        onFocus={() => setF(true)} onBlur={() => setF(false)}
        style={{ width:"100%", background: readOnly ? "#f8fafc" : C.white,
          border: "1.5px solid "+(f ? C.blue : C.border), borderRadius:10,
          padding:"12px 14px", color:C.text, fontFamily:"inherit", fontSize:15,
          outline:"none", transition:"all 0.15s", boxSizing:"border-box",
          boxShadow: f ? "0 0 0 3px "+C.blueLight : "none" }}
      />
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
      style={{ ...s, width: full?"100%":"auto", padding: small?"8px 14px":"13px 20px",
        borderRadius:10, fontFamily:"inherit", fontSize: small?12:14, fontWeight:700,
        letterSpacing:"0.02em", cursor: disabled?"not-allowed":"pointer",
        transition:"all 0.15s", display:"inline-flex", alignItems:"center",
        justifyContent:"center", gap:6, boxSizing:"border-box" }}>
      {icon && <span>{icon}</span>}{children}
    </button>
  );
}

function Card({ children, style, color }) {
  const b = color==="gold" ? C.goldBorder : color==="blue" ? C.blue : color==="green" ? C.green : C.border;
  const bg = color==="gold" ? C.goldBg : color==="blue" ? C.blueXLight : color==="green" ? C.greenBg : C.white;
  return <div style={{ background:bg, border:"1.5px solid "+b, borderRadius:14, padding:"16px", boxShadow:C.shadow, ...style }}>{children}</div>;
}

function Badge({ children, color="blue" }) {
  const m = { blue:{bg:C.blueLight,c:C.blue}, green:{bg:C.greenBg,c:C.green}, red:{bg:C.redBg,c:C.red}, gold:{bg:C.goldBg,c:C.goldText} };
  const t = m[color] || m.blue;
  return <span style={{ display:"inline-block", padding:"2px 9px", borderRadius:20, fontSize:11, fontWeight:700, background:t.bg, color:t.c }}>{children}</span>;
}

function DropZone({ label, icon, hint, file, onChange }) {
  const [drag, setDrag] = useState(false);
  const ref = useRef();
  const handle = useCallback(f => {
    if (!f) return;
    const r = new FileReader();
    r.onload = e => onChange(f, e.target.result);
    r.readAsText(f);
  }, [onChange]);
  const onDrop = useCallback(e => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files[0]); }, [handle]);
  return (
    <div onClick={() => ref.current.click()}
      onDragOver={e => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)} onDrop={onDrop}
      style={{ background: file ? C.blueXLight : drag ? C.blueLight : C.sky,
        border: "2px dashed "+(file ? C.blueMid : drag ? C.blue : C.borderMid),
        borderRadius:14, padding:"18px 12px", cursor:"pointer", transition:"all 0.2s", textAlign:"center" }}>
      <div style={{ fontSize:28, marginBottom:6 }}>{icon}</div>
      <div style={{ fontSize:13, fontWeight:700, color:C.navy, marginBottom:3 }}>{label}</div>
      <div style={{ fontSize:11, color:C.textMid, marginBottom:6 }}>{hint}</div>
      {file
        ? <div style={{ fontSize:11, color:C.blue, fontWeight:600 }}>✓ {file.name}</div>
        : <div style={{ fontSize:11, color:C.textLo }}>Click or drag CSV here</div>}
      <input ref={ref} type="file" accept=".csv,text/csv" style={{ display:"none" }}
        onChange={e => { if (e.target.files[0]) handle(e.target.files[0]); }} />
    </div>
  );
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
          <span style={{ color:C.textLo, transition:"transform 0.2s", display:"inline-block", transform: open?"rotate(180deg)":"none" }}>▾</span>
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
    <td style={{ padding:"9px 10px", background: i%2===0 ? C.white : "#f8fbff",
      borderBottom:"1px solid "+C.border, color: gold ? C.goldText : C.text,
      fontWeight: gold ? 700 : 400, textAlign: right ? "right" : "left", whiteSpace:"nowrap" }}>
      {children}
    </td>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   AUTH SHELL
═══════════════════════════════════════════════════════════════════ */
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
        <div style={{ fontSize:11, color:C.blue, letterSpacing:"0.12em", textTransform:"uppercase", marginTop:2, opacity:0.75 }}>IndiGo · Eff. Jan 2026</div>
      </div>
      <div style={{ width:"100%", maxWidth: wide ? 520 : 420, background:C.white, borderRadius:22,
        boxShadow:"0 12px 48px rgba(26,111,212,0.14)", padding:"28px 24px", border:"1px solid "+C.border }}>
        <h2 style={{ margin:"0 0 4px", fontSize:20, color:C.navy, fontWeight:900, letterSpacing:"-0.01em" }}>{title}</h2>
        {sub && <p style={{ margin:"0 0 20px", fontSize:13, color:C.textMid }}>{sub}</p>}
        {children}
      </div>
      <div style={{ marginTop:24, display:"flex", gap:6, alignItems:"center", opacity:0.3 }}>
        {Array.from({ length:9 }).map((_, i) => (
          <div key={i} style={{ width: i%3===1 ? 28 : 16, height:4, borderRadius:2, background:C.blue }} />
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   LANDING PAGE
═══════════════════════════════════════════════════════════════════ */
function LandingPage({ goLogin, goSignup }) {
  const steps = [
    { icon:"📥", title:"Export from AIMS", body:"Download your monthly Pilot Logbook Report and Personal Crew Schedule as CSV files from IndiGo's AIMS system. Takes under a minute." },
    { icon:"📤", title:"Upload to Crew Allowance", body:"Drop both CSVs into the app. No manual entry, no formatting — just the raw exports your AIMS system already produces." },
    { icon:"⚡", title:"Instant calculation", body:"Our engine applies all IndiGo allowance rules automatically: Deadhead, Night Flying, Layover, Tail-Swap, and Transit — every rupee, every rule." },
    { icon:"📊", title:"Download your breakdown", body:"Get a complete itemised CSV breakdown, ready to compare against your payslip or share with your crew rep if there's a discrepancy." },
  ];
  const allowances = [
    { name:"Deadhead",    icon:"🛫", desc:"Per scheduled block hour when positioned as non-operating crew", captain:"₹4,000/hr",  fo:"₹2,000/hr"  },
    { name:"Night Flying",icon:"🌙", desc:"For each hour flown between 0000–0600 IST",                   captain:"₹2,000/hr",  fo:"₹1,000/hr"  },
    { name:"Layover",     icon:"🏨", desc:"For stays away from home base exceeding 10h 01m",             captain:"₹3,000 base",fo:"₹1,500 base" },
    { name:"Tail-Swap",   icon:"✈️", desc:"When aircraft registration changes between sectors in same duty", captain:"₹1,500/swap",fo:"₹750/swap"  },
    { name:"Transit",     icon:"⏱", desc:"Pro-rata for domestic halts beyond 90 mins, up to 4 hrs",     captain:"₹1,000/hr",  fo:"₹500/hr"    },
  ];
  return (
    <div style={{ background:C.white, fontFamily:"'Nunito','Segoe UI',sans-serif", color:C.text }}>
      {/* NAV */}
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

      {/* HERO */}
      <div style={{ background:"linear-gradient(160deg,"+C.navy+" 0%,"+C.blue+" 60%,"+C.blueMid+" 100%)",
        padding:"60px 20px 80px", textAlign:"center", position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", top:-60, right:-60, width:300, height:300, borderRadius:"50%", background:"rgba(255,255,255,0.04)" }} />
        <div style={{ position:"absolute", bottom:-80, left:-40, width:240, height:240, borderRadius:"50%", background:"rgba(255,255,255,0.03)" }} />
        <div style={{ position:"relative", maxWidth:640, margin:"0 auto" }}>
          <div style={{ display:"inline-block", background:"rgba(255,255,255,0.12)", borderRadius:20,
            padding:"4px 14px", fontSize:12, color:"rgba(255,255,255,0.9)", fontWeight:700,
            letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:20 }}>For IndiGo Cockpit & Cabin Crew</div>
          <h1 style={{ fontSize:"clamp(28px,6vw,48px)", fontWeight:900, color:C.white,
            lineHeight:1.1, letterSpacing:"-0.02em", margin:"0 0 18px" }}>
            Know exactly what<br />allowances you're owed
          </h1>
          <p style={{ fontSize:"clamp(14px,2.5vw,18px)", color:"rgba(255,255,255,0.75)",
            maxWidth:480, margin:"0 auto 32px", lineHeight:1.6 }}>
            Upload your AIMS exports. Get an instant, itemised breakdown of every allowance for the month — Deadhead, Night Flying, Layover, Tail-Swap, and Transit.
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

      {/* STATS */}
      <div style={{ background:C.sky, borderTop:"1px solid "+C.border, borderBottom:"1px solid "+C.border,
        padding:"20px", display:"flex", justifyContent:"center", gap:"clamp(20px,4vw,60px)", flexWrap:"wrap" }}>
        {[["5","Allowance types"],["Jan 2026","Rules in effect"],["100%","In-browser"],["CSV","AIMS compatible"]].map(([n,l]) => (
          <div key={l} style={{ textAlign:"center" }}>
            <div style={{ fontSize:22, fontWeight:900, color:C.blue }}>{n}</div>
            <div style={{ fontSize:12, color:C.textMid, marginTop:2 }}>{l}</div>
          </div>
        ))}
      </div>

      {/* HOW IT WORKS */}
      <div style={{ maxWidth:700, margin:"0 auto", padding:"60px 20px" }}>
        <div style={{ textAlign:"center", marginBottom:40 }}>
          <div style={{ fontSize:12, fontWeight:700, color:C.blue, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:8 }}>How it works</div>
          <h2 style={{ fontSize:"clamp(22px,4vw,32px)", fontWeight:900, color:C.navy, letterSpacing:"-0.01em" }}>
            From AIMS export to full breakdown<br />in under 60 seconds
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

      {/* ALLOWANCES */}
      <div style={{ background:C.sky, padding:"60px 20px" }}>
        <div style={{ maxWidth:700, margin:"0 auto" }}>
          <div style={{ textAlign:"center", marginBottom:32 }}>
            <div style={{ fontSize:12, fontWeight:700, color:C.blue, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:8 }}>What we calculate</div>
            <h2 style={{ fontSize:"clamp(22px,4vw,30px)", fontWeight:900, color:C.navy, letterSpacing:"-0.01em" }}>All five IndiGo allowances covered</h2>
            <p style={{ fontSize:13, color:C.textMid, marginTop:8 }}>Rates effective 1 January 2026 per the IndiGo Revised Cockpit Crew Allowances circular</p>
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

      {/* PRICING */}
      <div style={{ maxWidth:480, margin:"0 auto", padding:"60px 20px", textAlign:"center" }}>
        <div style={{ fontSize:12, fontWeight:700, color:C.blue, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:8 }}>Pricing</div>
        <h2 style={{ fontSize:"clamp(22px,4vw,30px)", fontWeight:900, color:C.navy, letterSpacing:"-0.01em", marginBottom:24 }}>Simple, affordable, monthly</h2>
        <div style={{ background:C.white, borderRadius:20, padding:"32px 28px",
          border:"2px solid "+C.blue, boxShadow:C.shadowMd, marginBottom:20 }}>
          <div style={{ fontSize:13, fontWeight:700, color:C.blue, marginBottom:8, textTransform:"uppercase", letterSpacing:"0.06em" }}>Monthly Subscription</div>
          <div style={{ fontSize:48, fontWeight:900, color:C.navy, letterSpacing:"-0.02em" }}>
            ₹299<span style={{ fontSize:16, fontWeight:600, color:C.textMid }}>/month</span>
          </div>
          <div style={{ fontSize:13, color:C.textMid, margin:"12px 0 24px" }}>Per crew member · Cancel anytime</div>
          <div style={{ display:"grid", gap:8, marginBottom:24, textAlign:"left" }}>
            {["All 5 allowance types","Captains, F/O & Cabin Crew","Instant in-browser calculation","CSV breakdown download","Rates kept up-to-date"].map(f => (
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
          <div style={{ marginTop:12, fontSize:12, color:C.textLo }}>Have a discount code? You'll enter it at checkout.</div>
        </div>
      </div>

      {/* FOOTER CTA */}
      <div style={{ background:"linear-gradient(135deg,"+C.navy+","+C.blue+")", padding:"50px 20px", textAlign:"center" }}>
        <h2 style={{ fontSize:"clamp(20px,4vw,28px)", fontWeight:900, color:C.white, letterSpacing:"-0.01em", marginBottom:12 }}>
          Ready to know what you're owed?
        </h2>
        <p style={{ fontSize:14, color:"rgba(255,255,255,0.7)", marginBottom:28, maxWidth:400, margin:"0 auto 28px" }}>
          Join IndiGo crew members who use Crew Allowance to verify their monthly pay.
        </p>
        <button onClick={goSignup} style={{ background:C.white, border:"none", borderRadius:12,
          color:C.blue, fontSize:15, padding:"14px 32px", cursor:"pointer", fontWeight:800,
          fontFamily:"inherit", boxShadow:"0 4px 20px rgba(0,0,0,0.2)" }}>
          Create your account →
        </button>
        <div style={{ marginTop:28, fontSize:11, color:"rgba(255,255,255,0.4)", letterSpacing:"0.06em" }}>
          © 2026 Crew Allowance · For IndiGo crew members
        </div>
        <div style={{ marginTop:12, display:"flex", gap:20, justifyContent:"center" }}>
          <a href="/privacy.html" style={{ fontSize:12, color:"rgba(255,255,255,0.45)", textDecoration:"none" }}>Privacy Policy</a>
          <a href="/terms.html"   style={{ fontSize:12, color:"rgba(255,255,255,0.45)", textDecoration:"none" }}>Terms of Service</a>
          <a href="mailto:support@crewallowance.in" style={{ fontSize:12, color:"rgba(255,255,255,0.45)", textDecoration:"none" }}>Contact</a>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   LOGIN
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
    // Fetch profile
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

/* ═══════════════════════════════════════════════════════════════════
   SIGNUP
═══════════════════════════════════════════════════════════════════ */
function SignupScreen({ goLogin, goLanding, goCheckout }) {
  const [name,    setName]    = useState("");
  const [email,   setEmail]   = useState("");
  const [empId,   setEmpId]   = useState("");
  const [rank,    setRank]    = useState("Captain");
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
    // Insert profile row
    await supabase.from("profiles").insert({
      id: data.user.id, name, emp_id: empId, rank, is_admin: false, is_active: false,
    });
    setBusy(false);
    goCheckout({ id: data.user.id, name, email, emp_id: empId, empId, rank });
  };

  return (
    <AuthShell title="Create account" sub="IndiGo crew only · Takes 60 seconds">
      <FInput label="Full name" value={name} onChange={setName} placeholder="Your full name as it appears on your ID" />
      <FInput label="IndiGo email address" type="email" value={email} onChange={setEmail} placeholder="Your official IndiGo email address" />
      <FInput label="Employee ID" value={empId} onChange={setEmpId} placeholder="Your IndiGo employee number" />
      <FSelect label="Rank" value={rank} onChange={setRank} options={RANKS} />
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

/* ═══════════════════════════════════════════════════════════════════
   CHECKOUT
═══════════════════════════════════════════════════════════════════ */
function CheckoutScreen({ pendingUser, goLogin, onActivate }) {
  const [code,    setCode]    = useState("");
  const [discount,setDiscount]= useState(null);
  const [codeErr, setCodeErr] = useState("");
  const [cardNum, setCardNum] = useState("");
  const [expiry,  setExpiry]  = useState("");
  const [cvc,     setCvc]     = useState("");
  const [name,    setName]    = useState(pendingUser?.name || "");
  const [loading, setLoading] = useState(false);
  const [done,    setDone]    = useState(false);
  const [payErr,  setPayErr]  = useState("");

  useEffect(() => {
    if (!window.Stripe && !document.querySelector("#stripe-js")) {
      const s = document.createElement("script");
      s.id = "stripe-js"; s.src = "https://js.stripe.com/v3/";
      document.head.appendChild(s);
    }
  }, []);

  const applyCode = () => {
    const upper = code.trim().toUpperCase();
    const d = DISCOUNT_CODES[upper];
    if (d) { setDiscount({ ...d, code: upper }); setCodeErr(""); }
    else   { setCodeErr("Invalid discount code."); setDiscount(null); }
  };

  const finalPrice = discount ? Math.round(PRICE_INR * (1 - discount.pct / 100)) : PRICE_INR;
  const isFree = finalPrice === 0;

  const handlePay = async () => {
    if (!isFree && (!cardNum || !expiry || !cvc)) { setPayErr("Please fill in all card details."); return; }
    setLoading(true); setPayErr("");
    await new Promise(r => setTimeout(r, isFree ? 600 : 1400));
    // Activate the user in Supabase
    if (supabase && pendingUser?.id) {
      await supabase.from("profiles").update({ is_active: true }).eq("id", pendingUser.id);
    }
    onActivate(pendingUser);
    setLoading(false); setDone(true);
  };

  const formatCard   = v => v.replace(/\D/g,"").slice(0,16).replace(/(.{4})/g,"$1 ").trim();
  const formatExpiry = v => { const d=v.replace(/\D/g,"").slice(0,4); return d.length>2 ? d.slice(0,2)+"/"+d.slice(2) : d; };

  if (done) return (
    <AuthShell title="You're all set! 🎉" sub="">
      <div style={{ textAlign:"center", padding:"8px 0 18px" }}>
        <div style={{ width:60, height:60, borderRadius:"50%", background:C.greenBg,
          border:"2px solid "+C.green, display:"flex", alignItems:"center", justifyContent:"center",
          fontSize:28, margin:"0 auto 16px" }}>✓</div>
        <p style={{ color:C.textMid, fontSize:14, lineHeight:1.6, marginBottom:20 }}>
          {isFree ? "Your free account is activated and ready to use." : "Payment confirmed. Your account is now active."}
          <br />Welcome to Crew Allowance, {pendingUser?.name?.split(" ")[0]}!
        </p>
      </div>
      <Btn onClick={goLogin}>Sign in to your account →</Btn>
    </AuthShell>
  );

  return (
    <AuthShell title="Complete your subscription" sub={PRICE_LABEL+"/month · Cancel anytime"} wide>
      {/* Order summary */}
      <div style={{ background:C.blueXLight, border:"1.5px solid "+C.border, borderRadius:12, padding:"14px 16px", marginBottom:20 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom: discount ? 8 : 0 }}>
          <span style={{ fontSize:13, color:C.textMid }}>Crew Allowance — Monthly</span>
          <span style={{ fontSize:14, fontWeight:700, color:C.navy }}>{PRICE_LABEL}/mo</span>
        </div>
        {discount && (
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", paddingTop:8, borderTop:"1px solid "+C.border }}>
            <span style={{ fontSize:12, color:C.green, fontWeight:700 }}>Discount ({discount.code}) — {discount.pct}% off</span>
            <span style={{ fontSize:13, fontWeight:700, color:C.green }}>−₹{PRICE_INR - finalPrice}</span>
          </div>
        )}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", paddingTop:8, borderTop:"1px solid "+C.borderMid, marginTop: discount ? 8 : 0 }}>
          <span style={{ fontSize:14, fontWeight:800, color:C.navy }}>Total today</span>
          <span style={{ fontSize:18, fontWeight:900, color: isFree ? C.green : C.navy }}>{isFree ? "Free" : fmtINR(finalPrice)}</span>
        </div>
      </div>

      {/* Discount code */}
      <div style={{ marginBottom:20 }}>
        <label style={{ display:"block", fontSize:12, fontWeight:700, color:C.navy, marginBottom:5 }}>Discount Code</label>
        <div style={{ display:"flex", gap:8 }}>
          <input value={code} onChange={e => setCode(e.target.value.toUpperCase())}
            placeholder="Enter code if you have one"
            onKeyDown={e => e.key === "Enter" && applyCode()}
            style={{ flex:1, background:C.white, border:"1.5px solid "+(codeErr ? C.red : discount ? C.green : C.border),
              borderRadius:10, padding:"11px 14px", color:C.text, fontFamily:"inherit", fontSize:14, outline:"none", letterSpacing:"0.06em" }} />
          <button onClick={applyCode} style={{ background:"linear-gradient(135deg,"+C.blue+","+C.blueMid+")",
            border:"none", borderRadius:10, color:C.white, fontSize:13, padding:"11px 18px",
            cursor:"pointer", fontWeight:700, fontFamily:"inherit", whiteSpace:"nowrap" }}>Apply</button>
        </div>
        {codeErr  && <div style={{ fontSize:11, color:C.red,   marginTop:4 }}>{codeErr}</div>}
        {discount && <div style={{ fontSize:11, color:C.green, marginTop:4, fontWeight:700 }}>✓ {discount.label} applied</div>}
      </div>

      {/* Card fields */}
      {!isFree && (
        <div style={{ marginBottom:4 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14 }}>
            <div style={{ flex:1, height:1, background:C.border }} />
            <span style={{ fontSize:11, color:C.textLo, whiteSpace:"nowrap" }}>Payment details</span>
            <div style={{ flex:1, height:1, background:C.border }} />
          </div>
          <div style={{ background:C.blueXLight, border:"1.5px solid "+C.border, borderRadius:10, padding:"12px 14px", marginBottom:12, fontSize:11, color:C.textMid }}>
            🔒 Card processed securely via <strong>Stripe</strong>. Crew Allowance never stores card details.
            <div style={{ marginTop:6, padding:"6px 10px", background:C.goldBg, border:"1px solid "+C.goldBorder, borderRadius:6, color:C.goldText }}>
              ⚠ <strong>Backend required for live payments.</strong> See README for the 20-line <code>/api/create-payment-intent</code> endpoint.
            </div>
          </div>
          <FInput label="Name on card" value={name} onChange={setName} placeholder="Name as it appears on your card" />
          <div style={{ marginBottom:12 }}>
            <label style={{ display:"block", fontSize:12, fontWeight:700, color:C.navy, marginBottom:5 }}>Card number</label>
            <input value={cardNum} onChange={e => setCardNum(formatCard(e.target.value))} placeholder="16-digit card number"
              style={{ width:"100%", background:C.white, border:"1.5px solid "+C.border, borderRadius:10,
                padding:"12px 14px", color:C.text, fontFamily:"inherit", fontSize:15, outline:"none", boxSizing:"border-box", letterSpacing:"0.06em" }} />
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:4 }}>
            <div>
              <label style={{ display:"block", fontSize:12, fontWeight:700, color:C.navy, marginBottom:5 }}>Expiry</label>
              <input value={expiry} onChange={e => setExpiry(formatExpiry(e.target.value))} placeholder="MM / YY"
                style={{ width:"100%", background:C.white, border:"1.5px solid "+C.border, borderRadius:10,
                  padding:"12px 14px", color:C.text, fontFamily:"inherit", fontSize:15, outline:"none", boxSizing:"border-box" }} />
            </div>
            <div>
              <label style={{ display:"block", fontSize:12, fontWeight:700, color:C.navy, marginBottom:5 }}>CVC</label>
              <input value={cvc} onChange={e => setCvc(e.target.value.replace(/\D/g,"").slice(0,4))} placeholder="3 or 4 digits"
                style={{ width:"100%", background:C.white, border:"1.5px solid "+C.border, borderRadius:10,
                  padding:"12px 14px", color:C.text, fontFamily:"inherit", fontSize:15, outline:"none", boxSizing:"border-box" }} />
            </div>
          </div>
        </div>
      )}

      {payErr && <div style={{ padding:"10px 14px", background:C.redBg, border:"1px solid #fca5a5", borderRadius:8, color:C.red, fontSize:12, marginBottom:14 }}>{payErr}</div>}

      <Btn onClick={handlePay} variant={isFree ? "gold" : "primary"} disabled={loading} icon={loading ? "⟳" : isFree ? "✨" : "🔒"}>
        {loading ? (isFree ? "Activating..." : "Processing...") : (isFree ? "Activate free account →" : "Pay "+fmtINR(finalPrice)+" & activate →")}
      </Btn>
      <div style={{ marginTop:12, textAlign:"center" }}>
        <button onClick={goLogin} style={{ background:"none", border:"none", color:C.textLo, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>
          Already have an account? Sign in
        </button>
      </div>
    </AuthShell>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   FORGOT PASSWORD  (fully functional via Supabase)
═══════════════════════════════════════════════════════════════════ */
function ForgotScreen({ goLogin }) {
  const [email, setEmail] = useState("");
  const [sent,  setSent]  = useState(false);
  const [busy,  setBusy]  = useState(false);
  const [err,   setErr]   = useState("");

  const send = async () => {
    if (!email) { setErr("Please enter your email address."); return; }
    setBusy(true); setErr("");
    if (supabase) {
      await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: "https://crewallowance.in",
      });
    }
    setBusy(false); setSent(true);
  };

  return (
    <AuthShell title="Reset password" sub="We'll send a link to your inbox">
      {!sent ? (
        <>
          <FInput label="Your registered email address" type="email" value={email} onChange={setEmail} placeholder="The email address on your account" />
          {err && <div style={{ padding:"10px 14px", background:C.redBg, borderRadius:8, color:C.red, fontSize:12, marginBottom:14 }}>{err}</div>}
          <Btn onClick={send} disabled={busy}>{busy ? "Sending..." : "Send Reset Link"}</Btn>
          <div style={{ marginTop:12, textAlign:"center" }}>
            <button onClick={goLogin} style={{ background:"none", border:"none", color:C.blue, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>← Back to sign in</button>
          </div>
        </>
      ) : (
        <>
          <div style={{ textAlign:"center", padding:"8px 0 18px" }}>
            <div style={{ fontSize:44, marginBottom:12 }}>📧</div>
            <p style={{ color:C.textMid, fontSize:14 }}>
              If an account exists for <strong>{email}</strong>, a password reset link has been sent. Check your inbox.
            </p>
          </div>
          <Btn onClick={goLogin} variant="ghost">← Back to Sign In</Btn>
        </>
      )}
    </AuthShell>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   CALCULATOR SCREEN
═══════════════════════════════════════════════════════════════════ */
function CalcScreen({ user, rates }) {
  const [logFile,   setLogFile]   = useState(null);
  const [schedFile, setSchedFile] = useState(null);
  const [logCSV,    setLogCSV]    = useState("");
  const [schedCSV,  setSchedCSV]  = useState("");
  const [result,    setResult]    = useState(null);
  const [err,       setErr]       = useState("");
  const [calcRank,  setCalcRank]  = useState("Captain");

  const eRank = user.is_admin ? calcRank : user.rank;

  const loadDemo = () => {
    setLogFile({ name:"Demo_Logbook_Jan2026.csv" });
    setSchedFile({ name:"Demo_Schedule_Jan2026.csv" });
    setLogCSV(SAMPLE_LOGBOOK); setSchedCSV(SAMPLE_SCHEDULE);
    setResult(null); setErr("");
  };

  const calculate = () => {
    setErr(""); setResult(null);
    try { setResult(runCalc(logCSV, schedCSV, eRank, rates)); }
    catch (e) { setErr("Could not parse CSVs — check column format. " + e.message); }
  };

  const ready = logCSV && schedCSV;

  return (
    <div style={{ padding:"16px 16px 90px", maxWidth:680, margin:"0 auto" }}>
      {/* Hero */}
      <div style={{ background:"linear-gradient(120deg,"+C.blue+","+C.navy+")", borderRadius:18,
        padding:"20px", marginBottom:20, boxShadow:"0 4px 20px rgba(26,111,212,0.22)" }}>
        <div style={{ fontSize:11, color:"rgba(255,255,255,0.65)", letterSpacing:"0.12em", textTransform:"uppercase", marginBottom:4 }}>
          {user.is_admin ? "Admin · Test Calculator" : (user.rank + " · " + user.emp_id)}
        </div>
        <div style={{ fontSize:22, fontWeight:900, color:C.white, letterSpacing:"-0.01em" }}>
          {user.is_admin ? "Calculator" : "Hi, " + user.name.split(" ")[0] + " 👋"}
        </div>
        <div style={{ fontSize:13, color:"rgba(255,255,255,0.6)", marginTop:3 }}>Upload your CSVs to calculate monthly allowances</div>
      </div>

      {/* Admin rank picker */}
      {user.is_admin && (
        <Card color="gold" style={{ marginBottom:16 }}>
          <div style={{ fontSize:11, fontWeight:700, color:C.goldText, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:10 }}>⚙ Calculate as Rank</div>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            {RANKS.map(r => (
              <button key={r} onClick={() => { setCalcRank(r); setResult(null); }}
                style={{ padding:"8px 16px", borderRadius:9, fontFamily:"inherit", fontSize:13, fontWeight:700,
                  cursor:"pointer", border:"1.5px solid "+(calcRank===r ? C.goldText : C.borderMid),
                  background: calcRank===r ? C.white : "transparent",
                  color: calcRank===r ? C.goldText : C.textMid, transition:"all 0.15s" }}>
                {r}
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* Templates */}
      <Card style={{ marginBottom:16 }}>
        <div style={{ fontSize:14, fontWeight:700, color:C.navy, marginBottom:4 }}>Templates & Demo Data</div>
        <div style={{ fontSize:12, color:C.textMid, marginBottom:12 }}>Download the CSV column format your AIMS export needs, or load demo data to test.</div>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
          <Btn onClick={() => dlTemplate(SAMPLE_LOGBOOK,  "Logbook_Template.csv")}  variant="ghost" small full={false} icon="↓">Logbook CSV</Btn>
          <Btn onClick={() => dlTemplate(SAMPLE_SCHEDULE, "Schedule_Template.csv")} variant="ghost" small full={false} icon="↓">Schedule CSV</Btn>
          <Btn onClick={loadDemo} small full={false} icon="⬦">Load Demo Data</Btn>
        </div>
      </Card>

      {/* Upload */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:16 }}>
        <DropZone label="Logbook CSV"  icon="📓" hint="Pilot Logbook Report"  file={logFile}   onChange={(f,csv) => { setLogFile(f);   setLogCSV(csv);   }} />
        <DropZone label="Schedule CSV" icon="📋" hint="Crew Schedule"         file={schedFile} onChange={(f,csv) => { setSchedFile(f); setSchedCSV(csv); }} />
      </div>

      <Btn onClick={calculate} disabled={!ready} icon="▶">Calculate — {eRank}</Btn>

      {err && <div style={{ marginTop:12, padding:"12px 14px", background:C.redBg, border:"1px solid #fca5a5", borderRadius:10, color:C.red, fontSize:12 }}>{err}</div>}

      {result && (
        <div style={{ marginTop:24 }}>
          <div style={{ background:"linear-gradient(135deg,"+C.goldText+" 0%,#8a5500 100%)", borderRadius:18,
            padding:"22px 20px", marginBottom:20, boxShadow:"0 6px 24px rgba(180,112,0,0.28)",
            display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div>
              <div style={{ fontSize:11, color:"rgba(255,255,255,0.7)", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:4 }}>Total Allowance</div>
              <div style={{ fontSize:12, color:"rgba(255,255,255,0.65)" }}>{result.period} · {eRank}</div>
            </div>
            <div style={{ fontSize:32, fontWeight:900, color:C.white }}>{fmtINR(result.total)}</div>
          </div>

          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:20 }}>
            {[["Deadhead",result.deadhead.amount,result.deadhead.sectors.length+" sectors"],
              ["Night Flying",result.night.amount,fmtHM(result.night.total_mins)],
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
            <Btn onClick={() => dlCSV(result, { ...user, empId: user.emp_id })} variant="ghost" icon="↓">Download Full Breakdown (CSV)</Btn>
          </div>

          {result.deadhead.sectors.length > 0 && (
            <CollapsibleTable title="Deadhead Allowance" total={result.deadhead.amount}
              note={"Rate: "+fmtINR(rates.deadhead[eRank])+"/hr · Scheduled block hours used"}
              headers={["Date","Flight","Route","Sched Block","Amount"]} rows={result.deadhead.sectors}
              renderRow={(s,i) => (<tr key={i}><TC i={i}>{s.date}</TC><TC i={i}>{s.flight}</TC><TC i={i}>{s.from}→{s.to}</TC><TC i={i}>{fmtHM(s.scheduled_block_mins)}</TC><TC i={i} right gold>{fmtINR(s.amount)}</TC></tr>)} />
          )}
          {result.night.sectors.length > 0 && (
            <CollapsibleTable title="Night Flying Allowance" total={result.night.amount}
              note="Night = 0000–0600 IST. UTC logbook times converted +5:30."
              headers={["Date","Flight","Route","Dep IST","Arr IST","Night","Amount"]} rows={result.night.sectors}
              renderRow={(s,i) => (<tr key={i}><TC i={i}>{s.date}</TC><TC i={i}>{s.flight}</TC><TC i={i}>{s.from}→{s.to}</TC><TC i={i}>{s.dep_ist}</TC><TC i={i}>{s.arr_ist}</TC><TC i={i}>{s.night_mins}m</TC><TC i={i} right gold>{fmtINR(s.amount)}</TC></tr>)} />
          )}
          {result.layover.events.length > 0 && (
            <CollapsibleTable title="Domestic Layover Allowance" total={result.layover.amount}
              note="Qualifying: >10h 01m away from home base. Extra rate beyond 24h."
              headers={["Station","Date In","Date Out","Duration","Base","Extra","Total"]} rows={result.layover.events}
              renderRow={(e,i) => (<tr key={i}><TC i={i}><strong>{e.station}</strong></TC><TC i={i}>{e.date_in}</TC><TC i={i}>{e.date_out}</TC><TC i={i}>{e.duration_hrs}h</TC><TC i={i}>{fmtINR(e.base_amount)}</TC><TC i={i}>{e.extra_amount>0?fmtINR(e.extra_amount):"—"}</TC><TC i={i} right gold>{fmtINR(e.total)}</TC></tr>)} />
          )}
          {result.tailSwap.swaps.length > 0 && (
            <CollapsibleTable title={"Tail-Swap Allowance ("+result.tailSwap.count+")"} total={result.tailSwap.amount}
              note="Operating↔DH qualify. DH→DH excluded."
              headers={["Date","Sectors","Reg Out","Reg In","DH?","Amount"]} rows={result.tailSwap.swaps}
              renderRow={(s,i) => (<tr key={i}><TC i={i}>{s.date}</TC><TC i={i}>{s.sector_pair}</TC><TC i={i}>{s.reg_out}</TC><TC i={i}>{s.reg_in}</TC><TC i={i}>{s.is_dh_involved?<Badge color="gold">Yes</Badge>:"No"}</TC><TC i={i} right gold>{fmtINR(s.amount)}</TC></tr>)} />
          )}
          {result.transit.halts.length > 0 && (
            <CollapsibleTable title="Transit Allowance" total={result.transit.amount}
              note="Pro-rata from 90 min, capped at 4 hrs. Home base excluded."
              headers={["Date","Station","Arrived","Departed","Halt","Billable","Amount"]} rows={result.transit.halts}
              renderRow={(h,i) => (<tr key={i}><TC i={i}>{h.date}</TC><TC i={i}><strong>{h.station}</strong></TC><TC i={i}>{h.arrived_ist}</TC><TC i={i}>{h.departed_ist}</TC><TC i={i}>{h.halt_mins}m</TC><TC i={i}>{h.billable_mins}m</TC><TC i={i} right gold>{fmtINR(h.amount)}</TC></tr>)} />
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ADMIN SCREEN
═══════════════════════════════════════════════════════════════════ */
const RATES_SYSTEM_PROMPT = 'Extract IndiGo crew allowance rates from the PDF. Return ONLY valid JSON with no markdown:\n{"lastUpdated":"string","source":"string","deadhead":{"Captain":number,"First Officer":number,"Cabin Crew":null},"night":{"Captain":number,"First Officer":number,"Cabin Crew":null},"layover":{"Captain":{"base":number,"beyondRate":number},"First Officer":{"base":number,"beyondRate":number},"Cabin Crew":null},"tailSwap":{"Captain":number,"First Officer":number,"Cabin Crew":null},"transit":{"Captain":number,"First Officer":number,"Cabin Crew":null},"layoverMinHours":number}';

function AdminScreen({ rates, onUpdateRates }) {
  const [tab,      setTab]      = useState("users");
  const [users,    setUsers]    = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [pdfFile,  setPdfFile]  = useState(null);
  const [ratesMsg, setRatesMsg] = useState("");
  const pdfRef = useRef();

  // Load users from Supabase
  useEffect(() => {
    if (!supabase) return;
    supabase.from("profiles").select("*").order("created_at").then(({ data }) => {
      if (data) setUsers(data);
    });
  }, [tab]);

  const toggleUser = async (id, currentState) => {
    if (!supabase) return;
    await supabase.from("profiles").update({ is_active: !currentState }).eq("id", id);
    setUsers(prev => prev.map(u => u.id === id ? { ...u, is_active: !currentState } : u));
  };

  const uploadRates = async () => {
    if (!pdfFile) return;
    setLoading(true); setRatesMsg("");
    try {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(",")[1]);
        r.onerror = rej;
        r.readAsDataURL(pdfFile);
      });
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 1500,
          system: RATES_SYSTEM_PROMPT,
          messages: [{ role: "user", content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
            { type: "text", text: "Extract the allowance rates. Return only the JSON object." }
          ]}]
        })
      });
      const data = await resp.json();
      const txt  = data.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
      onUpdateRates(JSON.parse(txt.replace(/```json|```/g, "").trim()));
      setRatesMsg("success");
    } catch (e) {
      setRatesMsg("err:" + e.message);
    } finally {
      setLoading(false);
    }
  };

  const tabs = [{ id:"users", label:"Users" }, { id:"rates", label:"Rates" }, { id:"upload", label:"Upload PDF" }];

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
              background: tab===id ? C.white : "transparent",
              color: tab===id ? C.blue : C.textMid,
              boxShadow: tab===id ? C.shadow : "none" }}>
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
                <div style={{ fontSize:11, color:C.textLo, marginTop:2 }}>ID: {u.emp_id} · {u.rank}</div>
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
                <Badge color={u.is_active ? "green" : "red"}>{u.is_active ? "Active" : "Inactive"}</Badge>
                {!u.is_admin && (
                  <Btn onClick={() => toggleUser(u.id, u.is_active)} variant={u.is_active ? "danger" : "ghost"} small full={false}>
                    {u.is_active ? "Deactivate" : "Activate"}
                  </Btn>
                )}
                {u.is_admin && <Badge color="blue">Admin</Badge>}
              </div>
            </Card>
          ))}
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
                {RANKS.map(r => (
                  <div key={r} style={{ textAlign:"center", padding:"10px 6px", background:C.sky, borderRadius:10 }}>
                    <div style={{ fontSize:10, color:C.textMid, marginBottom:5, fontWeight:600 }}>{r}</div>
                    <div style={{ fontSize:16, fontWeight:900, color: obj[r] ? C.navy : C.textLo }}>
                      {obj[r] ? fmtINR(obj[r]) : <span style={{ fontSize:12 }}>TBD</span>}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab === "upload" && (
        <div>
          <Card style={{ marginBottom:16 }}>
            <div style={{ fontSize:15, fontWeight:700, color:C.navy, marginBottom:6 }}>Upload Allowance Circular PDF</div>
            <p style={{ fontSize:13, color:C.textMid, marginBottom:16, lineHeight:1.6 }}>
              Upload the official IndiGo allowance circular. Claude will extract all rate tables and update the system automatically.
            </p>
            <div onClick={() => pdfRef.current.click()}
              style={{ background: pdfFile ? C.blueXLight : C.sky,
                border: "2px dashed "+(pdfFile ? C.blue : C.borderMid),
                borderRadius:12, padding:"28px", cursor:"pointer", textAlign:"center", marginBottom:14 }}>
              <div style={{ fontSize:36, marginBottom:8 }}>📄</div>
              <div style={{ fontSize:13, fontWeight:700, color:C.navy, marginBottom:4 }}>{pdfFile ? pdfFile.name : "Select PDF file"}</div>
              <div style={{ fontSize:11, color: pdfFile ? C.blue : C.textLo }}>{pdfFile ? "Click to change" : "Click to browse · PDF format"}</div>
              <input ref={pdfRef} type="file" accept=".pdf,application/pdf" style={{ display:"none" }}
                onChange={e => { if (e.target.files[0]) { setPdfFile(e.target.files[0]); setRatesMsg(""); } }} />
            </div>
            <Btn onClick={uploadRates} disabled={!pdfFile || loading} icon={loading ? "⟳" : "✨"}>
              {loading ? "Extracting rates via Claude..." : "Extract & Update Rates"}
            </Btn>
            {ratesMsg === "success" && (
              <div style={{ marginTop:12, padding:"12px 14px", background:C.greenBg, border:"1px solid #6ee7b7", borderRadius:8, color:C.green, fontSize:13, fontWeight:600 }}>✓ Rates updated successfully.</div>
            )}
            {ratesMsg.startsWith("err") && (
              <div style={{ marginTop:12, padding:"12px 14px", background:C.redBg, border:"1px solid #fca5a5", borderRadius:8, color:C.red, fontSize:12 }}>✗ {ratesMsg.replace("err:", "")}</div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   RESET PASSWORD SCREEN
═══════════════════════════════════════════════════════════════════ */
function ResetPasswordScreen({ goLogin }) {
  const [pass,    setPass]    = useState("");
  const [confirm, setConfirm] = useState("");
  const [err,     setErr]     = useState("");
  const [busy,    setBusy]    = useState(false);
  const [done,    setDone]    = useState(false);

  const submit = async () => {
    if (!pass || !confirm)    { setErr("Please fill in both fields.");           return; }
    if (pass !== confirm)     { setErr("Passwords do not match.");               return; }
    if (pass.length < 8)      { setErr("Password must be at least 8 characters."); return; }
    setBusy(true); setErr("");
    const { error } = await supabase.auth.updateUser({ password: pass });
    if (error) { setErr(error.message); setBusy(false); return; }
    // Sign out so user does a clean login with new password
    await supabase.auth.signOut();
    setBusy(false); setDone(true);
  };

  if (done) return (
    <AuthShell title="Password updated ✓" sub="">
      <div style={{ textAlign:"center", padding:"8px 0 18px" }}>
        <div style={{ width:60, height:60, borderRadius:"50%", background:C.greenBg,
          border:"2px solid "+C.green, display:"flex", alignItems:"center", justifyContent:"center",
          fontSize:28, margin:"0 auto 16px" }}>✓</div>
        <p style={{ color:C.textMid, fontSize:14, lineHeight:1.6, marginBottom:20 }}>
          Your password has been updated successfully. Sign in with your new password to continue.
        </p>
      </div>
      <Btn onClick={goLogin}>Sign in →</Btn>
    </AuthShell>
  );

  return (
    <AuthShell title="Set new password" sub="Choose a strong password for your account">
      <FInput
        label="New password" type="password" value={pass} onChange={setPass}
        placeholder="Minimum 8 characters" />
      <FInput
        label="Confirm new password" type="password" value={confirm} onChange={setConfirm}
        placeholder="Repeat your new password" />
      {err && (
        <div style={{ padding:"10px 14px", background:C.redBg, border:"1px solid #fca5a5",
          borderRadius:8, color:C.red, fontSize:12, marginBottom:14 }}>{err}</div>
      )}
      <Btn onClick={submit} disabled={busy}>
        {busy ? "Updating password..." : "Update password →"}
      </Btn>
    </AuthShell>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ROOT APP  — session persistence via Supabase
═══════════════════════════════════════════════════════════════════ */
export default function App() {
  const [screen,      setScreen]      = useState("loading");
  const [user,        setUser]        = useState(null);
  const [tab,         setTab]         = useState("calc");
  const [rates,       setRates]       = useState(DEFAULT_RATES);
  const [pendingUser, setPendingUser] = useState(null);

  // Restore session on mount
  useEffect(() => {
    if (!supabase) { setScreen("landing"); return; }

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session) {
        const { data: profile } = await supabase
          .from("profiles").select("*").eq("id", session.user.id).single();
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
      // Supabase fires this when the user arrives via a password-reset link
      if (event === "PASSWORD_RECOVERY") {
        setScreen("reset-password");
        return;
      }
      if (event === "SIGNED_OUT" || !session) {
        setUser(null); setScreen("landing");
      }
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

  const onActivate = u => setPendingUser(u); // user activates after payment

  const goCheckout = u => { setPendingUser(u); setScreen("checkout"); };

  const nav = [
    { id:"calc",  icon:"🧮", label:"Calculator" },
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
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');
        * { box-sizing: border-box; margin: 0; }
        button { font-family: inherit; }
        ::-webkit-scrollbar { width:5px; height:5px; }
        ::-webkit-scrollbar-track { background: ${C.sky}; }
        ::-webkit-scrollbar-thumb { background: ${C.borderMid}; border-radius:3px; }
        select option { background: white; }
        @keyframes fadeUp { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:none } }
      `}</style>

      {/* Top bar */}
      <div style={{ background:C.white, borderBottom:"1px solid "+C.border, padding:"12px 16px",
        display:"flex", alignItems:"center", justifyContent:"space-between",
        position:"sticky", top:0, zIndex:20, boxShadow:"0 1px 8px rgba(26,111,212,0.07)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:36, height:36, borderRadius:11,
            background:"linear-gradient(135deg,"+C.blue+","+C.navy+")",
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:18, boxShadow:"0 2px 8px rgba(26,111,212,0.28)" }}>✈</div>
          <div>
            <div style={{ fontSize:16, fontWeight:900, color:C.navy, letterSpacing:"-0.02em", lineHeight:1 }}>{APP_NAME}</div>
            <div style={{ fontSize:9, color:C.blue, letterSpacing:"0.1em", textTransform:"uppercase", opacity:0.75 }}>IndiGo</div>
          </div>
        </div>
        <button onClick={onLogout} style={{ background:C.blueXLight, border:"1px solid "+C.border,
          borderRadius:9, color:C.textMid, fontSize:12, padding:"7px 14px", cursor:"pointer", fontWeight:700 }}>
          Sign out
        </button>
      </div>

      <div style={{ animation:"fadeUp 0.25s ease" }}>
        {tab === "calc"  && <CalcScreen  user={user} rates={rates} />}
        {tab === "admin" && <AdminScreen rates={rates} onUpdateRates={setRates} />}
      </div>

      {/* Bottom nav */}
      <div style={{ position:"fixed", bottom:0, left:0, right:0, background:C.white,
        borderTop:"1px solid "+C.border, display:"flex", zIndex:20,
        boxShadow:"0 -2px 16px rgba(26,111,212,0.08)",
        paddingBottom:"env(safe-area-inset-bottom,0px)" }}>
        {nav.map(({ id, icon, label }) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ flex:1, padding:"10px 8px 12px", background:"transparent", border:"none",
              color: tab===id ? C.blue : C.textLo, cursor:"pointer", transition:"all 0.15s",
              borderTop: "2.5px solid "+(tab===id ? C.blue : "transparent") }}>
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
            {user?.rank === "First Officer" ? "F/O" : user?.rank === "Captain" ? "Capt" : user?.is_admin ? "Admin" : user?.rank?.split(" ")[0]}
          </div>
        </div>
      </div>
    </div>
  );
}
