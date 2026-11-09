// =====================================================================
// IAY Pi Sync — reads the VB-G RAM G public reports (no login) on a
// schedule and sends every GP to the IAY Tracker with the sync key.
// Same logic as the IAY Phase Report Tampermonkey script (v1.5).
// Runs on the Raspberry Pi in Docker; see README.md.
// =====================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// ---------------- settings (environment) ----------------
const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const DEF_R42 = 'https://vbgramgrep.dord.gov.in/VBGRAMG/state_html/emuster_wagelist_rpt.aspx?payload=mra54Uu8laNZI34hvKIE-5k_pP7-31RidT7GTSwxm5FexhzWpJwNSljk1nFferYIEf8WqSw4Y69WQXYK5BVpw8VgrYWJr7gURgRmgevWMYaYGGAbFun9s8-iSkLHsYCdSnxjhAFeYqwNXrJ6pd4Dt7DxZD-CzAvp8i1zU7O16I4TUVVCk2sEkPtOmxKTrk1At2WlCodZpjscMXEikGcntgh8iV0_2MA8Gt3C3Hm-AxkyPqSdrlVOezkkX7RLxoYztm8EAYF39mWGn-GOxfzO2w';
const DEF_R44 = 'https://vbgramgrep.dord.gov.in/VBGRAMG/MusterRolle_EMBStatus.aspx?payload=9qDQUZsAUOG5iiARC7AliJth0w2VNI65QaU_Irysay8iLyB8s064fVzwaCEM2nnFdgg7IHFXTnbwlopZuuxt4qpxZ1fwphYX-Ww6G7uvBfYHlAuN_RB1tPxTpzzBTesGvBQ1qcuXFmSCC7QPAMHrtXWSv4lHuGHc-4LjbEm61I_nAnnB17M2VipwzI3oabgNrQsx-LpMzJfhzU734I0A4NDiFK8YpGdmFJDB86D2CBp5wz6uC_jflCMQwcTDJgXv4Kj2TclJAJJ_i5mArIINyu5VtnkIdQtlf6CPhXHpzA6le7H438pBZd46A0oVqyLxeV1yf2pfx7c61aCqbe8-xg';
const DEF_R612 = 'https://vbgramgrep.dord.gov.in/VBGRAMG/dynamic_work_details.aspx?page=S&lflag=eng&state_name=WEST+BENGAL&state_code=32&fin_year=2026-2027&source=national&Digest=Om3Z2J84Nryldk761ZlDmg';
const CFG = {
  key: env('SYNC_KEY'),
  every: Math.max(15, +env('INTERVAL_MIN', '60') || 60),          // minutes between runs (min 15)
  hours: env('ACTIVE_HOURS', '6-23'),                              // run only between these hours (IST)
  gps: env('GPS').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),   // empty = whole block
  r42: env('R42_URL') || DEF_R42,
  r44: env('R44_URL') || DEF_R44,
  r612: env('R612_URL') || DEF_R612,
  emp: (() => { try { return JSON.parse(env('EMP_URLS', '{}')); } catch (e) { console.error('EMP_URLS is not valid JSON — ignored'); return {}; } })(),
  ua: env('USER_AGENT', 'Mozilla/5.0 (X11; Linux aarch64) GRAMG-IAY-Sync/1.0'),
  once: process.argv.includes('--once'),
  dry: process.argv.includes('--dry-run'),
  dataDir: env('DATA_DIR', '/data')
};
const TRK_URL = 'https://wbzybizfpdalpukfzefk.supabase.co/rest/v1/rpc/iay_sync_gp';
const TRK_PUB = 'sb_publishable_fCY9paYMNTyepXdI7YRhkw_2u85P7bn';   // public key (same as the website)

const log = (...a) => console.log(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), '|', ...a);

// ---------------- browser-like globals for the portal reader ----------------
const win = new JSDOM('').window;
global.DOMParser = win.DOMParser;
const nodeFetch = global.fetch;
const jar = new Map();                                   // host -> Map(name -> value)
global.fetch = async (url, opts = {}) => {
  const u = new URL(url), cj = jar.get(u.host) || new Map();
  const headers = Object.assign({ 'User-Agent': CFG.ua, Accept: 'text/html,application/xhtml+xml,*/*' }, opts.headers || {});
  if (cj.size) headers.Cookie = [...cj].map(([k, v]) => k + '=' + v).join('; ');
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 120000);
  try {
    const r = await nodeFetch(url, { method: opts.method || 'GET', headers, body: opts.body, redirect: 'follow', signal: ctl.signal });
    const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    if (sc.length) { for (const c of sc) { const m = c.match(/^([^=;]+)=([^;]*)/); if (m) cj.set(m[1].trim(), m[2]); } jar.set(u.host, cj); }
    return r;
  } finally { clearTimeout(t); }
};
const VBR = require('./vbr-core.js');

// ---------------- same work/phase logic as the userscript ----------------
const TGT = 90;
const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const isIAY = o => /\/IAY\//i.test(o.code);
const regNo = s => (String(s || '').match(/REG\.?\s*NO\.?\s*([A-Z0-9]+)/i) || [])[1] || '';
const endOf = o => { const p = String(o.dates || '').split('--'); const m = (p[1] || p[0] || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? new Date(+m[3], m[2] - 1, +m[1]) : null; };
const startOf = o => { const m = String(o.dates || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? new Date(+m[3], m[2] - 1, +m[1]) : null; };
const notFilled = o => !o.filled && !o.zero && !o.meas && !o.wlDate && !o.wlNo;
function liveStage(o) {
  const e = endOf(o), t = today0(); if (!e) return o;
  if (notFilled(o)) o.stage = e > t ? 'MR Running' : (+e === +t ? 'Fill Today' : 'MR Fill Pending');
  return o;
}
function phStatus(o) {
  if (o.zero) return 'Zero';
  if (o.wlDate || o.wlNo) return 'WL Generated';
  if (o.filled || o.meas) return 'Filled';
  const s0 = startOf(o); if (s0 && s0 > today0()) return 'Not Started';
  liveStage(o); return o.stage === 'Fill Today' ? 'Fill Today' : o.stage === 'MR Running' ? 'Running' : 'Not Filled';
}
function iayWorks(gp, rows, meta, emp) {
  const W = {};
  for (const o of rows) if (o.gp === gp && isIAY(o)) (W[o.code] ||= { code: o.code, wn: o.name, mrs: [] }).mrs.push(o);
  for (const c in meta) W[c] ||= { code: c, wn: meta[c].wn, mrs: [] };
  const pc = {}; for (const c of Object.keys(W)) { const x = c.split('/')[0]; pc[x] = (pc[x] || 0) + 1; }
  const gpCode = Object.keys(pc).sort((a, b) => pc[b] - pc[a])[0];
  for (const c in emp) if (!gpCode || c.split('/')[0] === gpCode) W[c] ||= { code: c, wn: '', mrs: [] };
  return Object.values(W).map(w => {
    const m = meta[w.code] || {}, ws = emp[w.code] || [];
    const b = ws.find(x => x.jc && x.jc === m.jcn) || ws[0] || {};
    w.wn = w.wn || m.wn || ''; w.reg = regNo(w.wn);
    w.ben = b.name || ''; w.vill = b.vill || ''; w.jc = m.jcn || b.jc || '';
    w.others = ws.filter(x => x !== b).map(x => x.name).join(', ');
    w.st = m.st || '';
    w.days = Math.max(m.tm || 0, ws.reduce((s, x) => s + (x.days || 0), 0));
    w.ph = w.mrs.slice().sort((a, b) => (startOf(a) - startOf(b)) || (+a.mr - +b.mr)).map(o => ({ mr: o.mr, dates: o.dates, s: phStatus(o), wl: o.wlNo || '', wd: o.wlDate || '' }));
    const wlp = w.ph.filter(x => x.wl || x.wd), done = w.ph.filter(x => x.s === 'Filled' || x.s === 'WL Generated').length;
    w.wlTxt = done ? `${wlp.length} of ${done}` : '';
    w.wlNo = [...new Set(wlp.flatMap(x => String(x.wl).split(/,\s*/)).filter(Boolean))].join(', ');
    w.wlDate = [...new Set(wlp.flatMap(x => String(x.wd).split(/,\s*/)).filter(Boolean))].join(', ');
    return w;
  });
}
const isoD = s => { const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
const gpPrefix = code => { const m = String(code || '').match(/^32(\d{2})(\d{3})(\d{3})/); return m ? `WB-${m[1]}-${m[2]}-${m[3]}` : ''; };
function payload(list) {
  const pc = {};
  for (const w of list) { const p = gpPrefix(w.code); if (p) pc[p] = (pc[p] || 0) + 1; }
  const prefix = Object.keys(pc).sort((a, b) => pc[b] - pc[a])[0] || '';
  const ws = list.filter(w => gpPrefix(w.code) === prefix);
  return {
    prefix,
    works: ws.map(w => ({ work_code: w.code, reg_no: w.reg || '', ben_name: (w.ben || '') + (w.others ? ' (+' + w.others + ')' : ''), jcn: w.jc || '',
      village: w.vill || '', work_status: w.st || '', mandays: String(w.days || 0), wl_info: w.wlTxt || '', wl_no: w.wlNo || '', wl_date: isoD(w.wlDate) })),
    mrs: ws.flatMap(w => w.ph.map((p, i) => { const d = String(p.dates || '').split('--'); return { work_code: w.code, mr_no: String(p.mr), seq: String(i + 1), start_date: isoD(d[0]), end_date: isoD(d[1] || d[0]), status: p.s }; }))
  };
}
async function send(gp, p) {
  const r = await nodeFetch(TRK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: TRK_PUB },
    body: JSON.stringify({ p_key: CFG.key, p_jc_prefix: p.prefix, p_gp_name: gp, p_works: p.works, p_mrs: p.mrs, p_source: 'Raspberry Pi sync' }) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  if (!r.ok) throw new Error((j && (j.message || j.hint)) || ('HTTP ' + r.status));
  return j;
}

// ---------------- one full run ----------------
const status = { lastStart: null, lastEnd: null, ok: [], failed: [], error: null };
function saveStatus() { try { fs.mkdirSync(CFG.dataDir, { recursive: true }); fs.writeFileSync(path.join(CFG.dataDir, 'status.json'), JSON.stringify(status, null, 2)); } catch (e) {} }

async function runOnce() {
  status.lastStart = new Date().toISOString(); status.ok = []; status.failed = []; status.error = null;
  log('▶ Reading portal reports' + (CFG.gps.length ? ' for ' + CFG.gps.join(', ') : ' (whole block)') + '…');
  const res = await VBR.run({ r42Url: CFG.r42, r44Url: CFG.r44, only: CFG.gps.length ? CFG.gps : null, log: m => log('  ' + m) });
  res.rows.forEach(liveStage);
  const blk = (String(res.block).match(/Block\s*:\s*(.+)$/i) || [])[1] || '';
  const dist = (String(res.block).match(/District\s*:\s*(.+?)\s+Block/i) || [])[1] || 'COOCHBEHAR';
  const gps = CFG.gps.length ? CFG.gps : res.order;
  for (const gp of gps) {
    try {
      let meta = {}, emp = {};
      try { const r = await VBR.readR612(CFG.r612, { dist: dist.trim(), blk: blk.trim(), gp }); meta = r.by[gp] || r.by[gp.toUpperCase()] || {}; }
      catch (e) { log(`  ⚠ ${gp}: R6.12 not read (${e.message}) — mandays / Job Cards from last time are kept`); }
      if (CFG.emp[gp]) { try { const e = await VBR.readEmp(CFG.emp[gp]); if (e && e.works) emp = e.works; } catch (e) { log(`  ⚠ ${gp}: names not read (${e.message})`); } }
      const p = payload(iayWorks(gp, res.rows, meta, emp));
      if (!p.prefix || !p.works.length) { log(`  – ${gp}: no IAY works`); continue; }
      if (CFG.dry) { log(`  (dry run) ${gp}: ${p.works.length} works, ${p.mrs.length} MR`); status.ok.push(gp); continue; }
      const r = await send(gp, p);
      log(`  📡 ${gp}: Tracker updated (${r.works} works, ${r.mrs} MR)`); status.ok.push(gp);
    } catch (e) {
      log(`  ❌ ${gp}: ${e.message}`); status.failed.push({ gp, error: e.message });
      if (/BAD_KEY/.test(e.message)) throw new Error('Sync key is not valid — make a new key in the IAY Tracker and put it in .env');
    }
  }
  status.lastEnd = new Date().toISOString();
  log(`✔ Done — ${status.ok.length} GP sent, ${status.failed.length} failed.`);
}

function inHours() {
  const m = CFG.hours.match(/^(\d{1,2})-(\d{1,2})$/); if (!m) return true;
  const h = +new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false });
  return h >= +m[1] && h <= +m[2];
}
async function loop() {
  if (!CFG.key && !CFG.dry) { log('❌ SYNC_KEY is missing. Put the key from IAY Tracker → “Tampermonkey live sync” in .env'); process.exit(1); }
  if (!/^iay_[0-9a-f]{48}$/.test(CFG.key) && !CFG.dry) { log('❌ SYNC_KEY does not look right (it starts with iay_).'); process.exit(1); }
  log(`IAY Pi Sync started — every ${CFG.every} min, hours ${CFG.hours} IST, ${CFG.gps.length ? CFG.gps.join(', ') : 'whole block'}${CFG.dry ? ' (dry run)' : ''}`);
  for (;;) {
    if (CFG.once || inHours()) {
      try { await runOnce(); } catch (e) { status.error = e.message; log('❌ Run failed: ' + e.message); if (/Sync key/.test(e.message)) { saveStatus(); process.exit(1); } }
      saveStatus();
    } else log('… outside active hours, waiting');
    if (CFG.once) break;
    await new Promise(r => setTimeout(r, CFG.every * 60000));
  }
}
if (require.main === module) loop();
module.exports = { iayWorks, payload, phStatus, liveStage };
