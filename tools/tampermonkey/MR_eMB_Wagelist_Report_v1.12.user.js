// ==UserScript==
// @name         VB-G RAM G — MR-wise e-MB & Wagelist Consolidated Report
// @namespace    koushik.gp.tools
// @version      1.12
// @description  MR-wise e-MB / Wagelist consolidated report (R4.2 + R4.4) with alerts and Excel export; v1.12 also sends MR stages to Gram Setu 💸 Pipeline
// @match        https://vbgramgrep.dord.gov.in/VBGRAMG/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      wbzybizfpdalpukfzefk.supabase.co
// @run-at       document-idle
// ==/UserScript==

(function () {   // own scope: safe next to other scripts
// ===== VB-G RAM G MR Consolidated Report — CORE (runs inside the portal) =====
const VBR = (() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const num = s => parseFloat(String(s || '').replace(/[, ₹]/g, '')) || 0;
  const abs = (h, base) => new URL(h, base).href;
  const toDate = s => { const m = (s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? new Date(+m[3], m[2] - 1, +m[1]) : null; };
  const codeOf = p => { const m = clean(p).match(/\(([^()]*\/[^()]*)\)\s*$/); return m ? m[1].trim() : ''; };
  const nameOf = p => clean(p).replace(/\(([^()]*\/[^()]*)\)\s*$/, '').trim();

  async function getHtml(url, tries = 4) {
    let err;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (r.ok) return await r.text();
        err = 'HTTP ' + r.status;
      } catch (e) { err = e.message; }
      await sleep(2000 * (i + 1));
    }
    throw new Error('Page failed to load (' + err + '): ' + url.slice(0, 90));
  }
  const getDoc = async u => new DOMParser().parseFromString(await getHtml(u), 'text/html');

  async function pool(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; await fn(items[k], k); }
    }));
  }

  const headTable = (doc, txt) => [...doc.querySelectorAll('table')].find(t =>
    t.rows.length && [...t.rows[0].cells].some(c => clean(c.textContent).includes(txt)));

  // R4.2 drill-down lists (Issued / Filled / Zero / Wagelist / MR covered)
  function readList(doc, base) {
    const t = headTable(doc, 'Project Name'); if (!t) return [];
    const hdr = [...t.rows[0].cells].map(c => clean(c.textContent));
    const ix = n => hdr.findIndex(h => h.includes(n));
    const iP = ix('Project Name'), iMR = ix('E-MR'), iWL = ix('WageList No'), iDT = ix('DateFrom'), iGD = ix('Generated Date');
    const out = [];
    for (const r of [...t.rows].slice(1)) {
      const c = [...r.cells]; if (c.length < hdr.length) continue;
      const p = clean(c[iP].textContent); if (!p) continue;
      const a = iMR >= 0 ? c[iMR].querySelector('a') : null;
      out.push({
        code: codeOf(p), name: nameOf(p),
        mr: iMR >= 0 ? clean(c[iMR].textContent) : '',
        wl: iWL >= 0 ? clean(c[iWL].textContent) : '',
        dates: iDT >= 0 ? clean(c[iDT].textContent) : '',
        gen: iGD >= 0 ? clean(c[iGD].textContent) : '',
        link: a ? abs(a.getAttribute('href'), base) : ''
      });
    }
    return out;
  }

  // R4.4 e-MB detail (activity-wise) -> summed per MR
  function readEmb(doc) {
    const M = new Map();
    const t = headTable(doc, 'Work Code'); if (!t) return M;
    const hdr = [...t.rows[0].cells].map(c => clean(c.textContent).toLowerCase());
    const f = p => hdr.findIndex(p);
    const I = {
      code: f(h => h.startsWith('work code')), name: f(h => h.startsWith('work name')),
      mr: f(h => h.startsWith('muster roll')), dmr: f(h => h.startsWith('date of mr')),
      me: f(h => h.startsWith('measurement entry')), ve: f(h => h.startsWith('verification date')),
      sk: f(h => h.startsWith('skilled')), ssk: f(h => h.startsWith('semi-skilled')),
      usk: f(h => h.startsWith('unskilled')), mat: f(h => h.startsWith('material')),
      tot: f(h => h.startsWith('total cost'))
    };
    for (const r of [...t.rows].slice(1)) {
      const c = [...r.cells]; if (c.length < hdr.length) continue;
      const code = clean(c[I.code].textContent); if (!code.includes('/')) continue;
      const mr = clean(c[I.mr].textContent), k = code + '|' + mr;
      if (!M.has(k)) M.set(k, { code, mr, name: clean(c[I.name].textContent), dmr: '', me: '', ve: '', sk: 0, ssk: 0, usk: 0, mat: 0, tot: 0, acts: 0 });
      const o = M.get(k), g = i => i >= 0 ? clean(c[i].textContent) : '';
      o.dmr ||= g(I.dmr); o.me ||= g(I.me); o.ve ||= g(I.ve);
      o.sk += num(g(I.sk)); o.ssk += num(g(I.ssk)); o.usk += num(g(I.usk)); o.mat += num(g(I.mat)); o.tot += num(g(I.tot));
      if (g(I.me)) o.acts++;
    }
    return M;
  }

  // GP-wise links from the two block-level pages
  async function readBlock(r42Url, r44Url) {
    const gps = {};
    const COLS = { 2: 'uskIssued', 3: 'uskFilled', 5: 'uskZero', 7: 'sskIssued', 8: 'sskFilled', 9: 'sskZero', 11: 'wl', 12: 'wlMr' };
    const d42 = await getDoc(r42Url);
    let block = clean((d42.querySelector('#ContentPlaceHolder1_lbl_head') || {}).textContent);
    for (const r of d42.querySelectorAll('tr')) {
      const c = [...r.cells];
      if (c.length !== 13 || !/^\d+$/.test(clean(c[0].textContent)) || !/[A-Za-z]/.test(c[1].textContent)) continue;
      const gp = clean(c[1].textContent);
      gps[gp] = { gp, sl: +clean(c[0].textContent), links: {}, emb: '', count: {} };
      for (const k in COLS) {
        gps[gp].count[COLS[k]] = num(c[k].textContent);
        const a = c[k].querySelector('a'); if (a) gps[gp].links[COLS[k]] = abs(a.getAttribute('href'), r42Url);
      }
    }
    const blk = s => ((s || '').match(/Block\s*:\s*(.+)$/i) || [])[1]?.trim().toUpperCase() || '';
    const b42 = blk(block);
    if (!b42) throw new Error('The saved R4.2 link is not a block-level page (no GP list). Open the block-level R4.2 page once and try again.');
    if (!Object.keys(gps).length) throw new Error('No GP found on the R4.2 page.');
    if (r44Url) {
      const d44 = await getDoc(r44Url);
      const b44 = blk(clean((d44.querySelector('#ContentPlaceHolder1_lbl_head') || {}).textContent));
      if (b44 !== b42) throw new Error(`The two reports belong to different blocks! R4.2 = ${b42 || '?'}, R4.4 = ${b44 || '?'}. Open the R4.2 and R4.4 (All, Month = ALL) pages of the SAME block once, then click Update again.`);
      let hit = 0;
      for (const a of d44.querySelectorAll('a[href*="MusterRolle_EMBStatus_dtl"]')) {
        const gp = clean(a.textContent);
        if (gps[gp]) { gps[gp].emb = abs(a.getAttribute('href'), r44Url); hit++; }
      }
      if (!hit) throw new Error('GP names in R4.4 do not match R4.2.');
    }
    return { block, gps: Object.values(gps).sort((a, b) => a.sl - b.sl) };
  }

  function stage(o, today) {
    const to = toDate((o.dates.split('--')[1]) || o.dates);
    o.days = to ? Math.round((today - to) / 864e5) : '';
    if (o.zero) return 'Zero Attendance';
    if (o.wlNo || o.wlDate) return 'Wagelist Generated';
    if (!o.filled && !o.meas) return (to && to >= today) ? 'MR Running' : 'MR Fill Pending';
    if (!o.meas) return 'e-MB Pending';
    if (!o.verif) return 'AE Verification Pending';
    return 'Wagelist Pending';
  }

  async function run({ r42Url, r44Url, only = null, log = console.log }) {
    log('Reading block pages…');
    const { block, gps } = await readBlock(r42Url, r44Url);
    const list = gps.filter(g => !only || only.includes(g.gp));
    if (only && !list.length) throw new Error('Selected GP not found in the R4.2 page: ' + only.join(', '));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const rows = [], check = [];
    let n = 0;
    for (const g of list) {
      n++; log(`(${n}/${list.length}) ${g.gp}: fetching reports…`);
      const lists = {};
      await pool(Object.entries(g.links), 4, async ([k, u]) => { lists[k] = readList(await getDoc(u), u); });
      const emb = g.emb ? readEmb(await getDoc(g.emb)) : new Map();
      const M = new Map();
      const get = (code, mr, name) => {
        const k = code + '|' + mr;
        if (!M.has(k)) M.set(k, { gp: g.gp, code, name: name || '', mr, type: '', dates: '', filled: false, zero: false, wlDate: '', wlNo: '', meas: '', verif: '', tot: 0, usk: 0, mat: 0, skl: 0 });
        const o = M.get(k); if (!o.name && name) o.name = name; return o;
      };
      for (const [k, t] of [['uskIssued', 'USK'], ['sskIssued', 'SSK']]) for (const x of lists[k] || []) { const o = get(x.code, x.mr, x.name); o.type ||= t; o.dates ||= x.dates; }
      for (const [k, t] of [['uskFilled', 'USK'], ['sskFilled', 'SSK']]) for (const x of lists[k] || []) { const o = get(x.code, x.mr, x.name); o.filled = true; o.type ||= t; o.dates ||= x.dates; }
      for (const [k, t] of [['uskZero', 'USK'], ['sskZero', 'SSK']]) for (const x of lists[k] || []) { const o = get(x.code, x.mr, x.name); o.zero = true; o.type ||= t; o.dates ||= x.dates; }
      for (const e of emb.values()) {
        const o = get(e.code, e.mr, e.name);
        o.meas = e.me; o.verif = e.ve; o.tot = e.tot; o.usk = e.usk; o.mat = e.mat; o.skl = e.sk + e.ssk;
        o.dates ||= e.dmr;
      }
      // Wagelist No.: match by project + date; if ambiguous, read it from the Muster Roll page
      const wlBy = new Map();
      for (const w of lists.wl || []) { const k = w.code + '|' + w.gen; if (!wlBy.has(k)) wlBy.set(k, new Set()); wlBy.get(k).add(w.wl); }
      const need = [];
      for (const x of lists.wlMr || []) {
        const o = get(x.code, x.mr, x.name);
        if (!o.wlDate.includes(x.gen)) o.wlDate = o.wlDate ? o.wlDate + ', ' + x.gen : x.gen;
        const c = [...(wlBy.get(x.code + '|' + x.gen) || [])];
        if (c.length === 1 && !o.wlNo.includes(c[0])) o.wlNo = o.wlNo ? o.wlNo + ', ' + c[0] : c[0];
        else if (c.length !== 1 && x.link) need.push([o, x.link]);
      }
      if (need.length) {
        log(`${g.gp}: looking up Wagelist No. for ${need.length} MR(s) from muster rolls…`);
        await pool(need, 3, async ([o, u]) => {
          try {
            const d = await getDoc(u);
            const s = [...new Set((d.body.textContent.match(/\d{10}WL\d+/g) || []))];
            o.wlNo = s.join(', ') || o.wlNo;
          } catch (e) { o.wlNo ||= '(not found)'; }
        });
      }
      const gr = [...M.values()].sort((a, b) => a.code.localeCompare(b.code) || (+a.mr - +b.mr));
      for (const o of gr) o.stage = stage(o, today);
      rows.push(...gr);
      check.push({
        gp: g.gp, portal: g.count,
        got: {
          uskIssued: (lists.uskIssued || []).length, uskFilled: (lists.uskFilled || []).length, uskZero: (lists.uskZero || []).length,
          sskIssued: (lists.sskIssued || []).length, wl: (lists.wl || []).length, wlMr: (lists.wlMr || []).length
        }
      });
    }
    log(`Done — ${rows.length} MRs.`);
    const at = new Date().toLocaleString('en-IN');
    const gpAt = {}; for (const g of list) gpAt[g.gp] = at;
    return { block, at, rows, check, order: gps.map(g => g.gp), gpAt, partial: !!only };
  }

  // ================= IAY: R6.12 Dynamic Report (work-wise mandays + beneficiary JCN) =================
  // Table header uses colspan (Wages/Material) → expand to one name per data column
  function parseR612(doc) {
    const t = [...doc.querySelectorAll('table')].find(x => x.rows.length > 2 && /Work Code/.test(x.rows[0].textContent) && /Mandays/.test(x.rows[0].textContent));
    if (!t) return null;
    const cols = [], sub = [...t.rows[1].cells].map(c => clean(c.textContent)); let si = 0;
    for (const c of t.rows[0].cells) { const n = +(c.getAttribute('colspan') || 1), h = clean(c.textContent); if (n === 1) cols.push(h); else for (let k = 0; k < n; k++) cols.push(h + ' [' + (sub[si++] || k) + ']'); }
    const ix = s => cols.findIndex(h => h.toLowerCase().startsWith(s));
    const I = { gp: ix('panchayat name'), st: ix('work status'), code: ix('work code'), wn: ix('work name'), fy: ix('work start fin'), tm: ix('total mandays'), cm: ix('mandays generated'), start: ix('work started'), done: ix('work physically'), jcn: ix('individual beneficiary jcn') };
    const by = {};
    for (const r of t.rows) {
      const c = [...r.cells]; if (c.length !== cols.length) continue;
      const code = clean(c[I.code].textContent); if (!code.includes('/')) continue;
      const g = clean(c[I.gp].textContent).toUpperCase(), v = i => i >= 0 ? clean(c[i].textContent) : '';
      (by[g] ||= {})[code] = { st: v(I.st), wn: v(I.wn), fy: v(I.fy), tm: num(v(I.tm)), cm: num(v(I.cm)), start: v(I.start), done: v(I.done), jcn: v(I.jcn) };
    }
    const upd = (doc.querySelector('[id$="Shedule_updated_date"]') || {}).textContent || '';
    return { by, upd: clean(upd).replace(/^.*?:\s*/, '') };
  }
  // Replays the page's own dropdown postbacks: District → Block → GP → Category(IF) → Work type → Submit
  async function readR612(formUrl, { dist, blk, gp }) {
    let d = await getDoc(formUrl);
    const sel = (doc, id) => doc.querySelector('select[id$="' + id + '"]');
    const pick = (s, text, re) => { const o = [...s.options]; return (o.find(x => clean(x.text).toUpperCase() === String(text || '').toUpperCase()) || (re && o.find(x => re.test(x.value + ' ' + x.text))) || {}).value; };
    async function post(doc, ch, target, extra) {
      const f = doc.querySelector('form'), o = {};
      for (const el of f.querySelectorAll('input[type=hidden],select')) { if (!el.name) continue; if (el.tagName === 'SELECT') { const s = el.querySelector('option[selected]') || el.options[0]; o[el.name] = s ? s.value : ''; } else o[el.name] = el.value; }
      Object.assign(o, ch, extra || {}); o.__EVENTTARGET = target || ''; o.__EVENTARGUMENT = '';
      const r = await fetch(abs(f.getAttribute('action') || formUrl, formUrl), { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });
      if (!r.ok) throw new Error('R6.12 HTTP ' + r.status);
      return new DOMParser().parseFromString(await r.text(), 'text/html');
    }
    for (const [id, text, re] of [['ddl_dist', dist], ['ddl_blk', blk], ['ddl_pan', gp], ['Ddlworkcategory', 'Individual Assets', /^IF\b/]]) {
      const s = sel(d, id); if (!s) throw new Error('R6.12 page changed (' + id + ' not found)');
      const v = pick(s, text, re); if (!v) throw new Error('R6.12: "' + text + '" not found in ' + id);
      if ((s.querySelector('option[selected]') || {}).value === v) continue;
      d = await post(d, { [s.name]: v }, s.name);
    }
    const ps = sel(d, 'ddlprostatus'), ch = {};
    const v = [...ps.options].map(o => o.value).find(x => /State Scheme House for Individual-West Bengal/i.test(x)) || [...ps.options].map(o => o.value).find(x => /State Scheme House/i.test(x));
    if (!v) throw new Error('R6.12: "State Scheme House" work type not found');
    ch[ps.name] = v;
    for (const id of ['ddlFin_year', 'Ddlwork_status', 'ddlexpnana', 'ddlexpnest', 'filter']) { const s = sel(d, id); if (s && [...s.options].some(o => o.value === 'ALL')) ch[s.name] = 'ALL'; }
    const btn = d.querySelector('input[type=submit][id$="Button1"]');
    d = await post(d, ch, '', btn ? { [btn.name]: btn.value } : {});
    const res = parseR612(d); if (!res) throw new Error('R6.12 returned no table');
    return res;
  }
  // ================= IAY: Employment Provided ("Consolidate Report of Payment to Worker") =================
  function parseEmp(doc) {
    const t = [...doc.querySelectorAll('table')].find(x => x.rows.length && /Applicant Name/.test(x.rows[0].textContent)); if (!t) return null;
    const hdr = [...t.rows[0].cells].map(c => clean(c.textContent).toLowerCase()), ix = s => hdr.findIndex(h => h.startsWith(s));
    const I = { v: ix('village'), jc: ix('job card'), n: ix('applicant'), f: ix('father'), w: ix('work name'), d: ix('no of days'), a: ix('amount') };
    const works = {};
    for (const r of t.rows) {
      const c = [...r.cells]; if (c.length < hdr.length || !/^\d+$/.test(clean(c[0].textContent))) continue;
      const m = clean(c[I.w].textContent).match(/^\((\S+?)\)/); if (!m || !/\/IAY\//i.test(m[1])) continue;
      (works[m[1]] ||= []).push({ vill: clean(c[I.v].textContent), jc: clean(c[I.jc].textContent), name: clean(c[I.n].textContent), father: clean(c[I.f].textContent), days: num(c[I.d].textContent), amt: num(c[I.a].textContent) });
    }
    const L = id => clean((doc.querySelector('[id$="' + id + '"]') || {}).textContent);
    return { gp: L('Lbpanch').toUpperCase(), block: L('Lblblock').toUpperCase(), fy: L('Lblfinyear'), works };
  }
  async function readEmp(url) { return parseEmp(await getDoc(url)); }
  return { run, readBlock, readR612, parseR612, readEmp, parseEmp };
})();

// ===================== UI (Tampermonkey) =====================
(function () {
  'use strict';
  // Mobile browsers / userscript managers without GM_* → fall back to localStorage
  // Storage: Tampermonkey GM_* if available, otherwise this script's own localStorage keys ('vbr_…')
  const _gm = typeof GM_setValue === 'function' && typeof GM_getValue === 'function';
  const gmGet = (k, d) => { if (_gm) return GM_getValue(k, d); try { const v = localStorage.getItem('vbr_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
  const gmSet = (k, v) => { if (_gm) return GM_setValue(k, v); localStorage.setItem('vbr_' + k, JSON.stringify(v)); };
  const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
  const DEF_R42 = 'https://vbgramgrep.dord.gov.in/VBGRAMG/state_html/emuster_wagelist_rpt.aspx?payload=mra54Uu8laNZI34hvKIE-5k_pP7-31RidT7GTSwxm5FexhzWpJwNSljk1nFferYIEf8WqSw4Y69WQXYK5BVpw8VgrYWJr7gURgRmgevWMYaYGGAbFun9s8-iSkLHsYCdSnxjhAFeYqwNXrJ6pd4Dt7DxZD-CzAvp8i1zU7O16I4TUVVCk2sEkPtOmxKTrk1At2WlCodZpjscMXEikGcntgh8iV0_2MA8Gt3C3Hm-AxkyPqSdrlVOezkkX7RLxoYztm8EAYF39mWGn-GOxfzO2w';
  const DEF_R44 = 'https://vbgramgrep.dord.gov.in/VBGRAMG/MusterRolle_EMBStatus.aspx?payload=9qDQUZsAUOG5iiARC7AliJth0w2VNI65QaU_Irysay8iLyB8s064fVzwaCEM2nnFdgg7IHFXTnbwlopZuuxt4qpxZ1fwphYX-Ww6G7uvBfYHlAuN_RB1tPxTpzzBTesGvBQ1qcuXFmSCC7QPAMHrtXWSv4lHuGHc-4LjbEm61I_nAnnB17M2VipwzI3oabgNrQsx-LpMzJfhzU734I0A4NDiFK8YpGdmFJDB86D2CBp5wz6uC_jflCMQwcTDJgXv4Kj2TclJAJJ_i5mArIINyu5VtnkIdQtlf6CPhXHpzA6le7H438pBZd46A0oVqyLxeV1yf2pfx7c61aCqbe8-xg';

  // Auto-save the link only when this is a BLOCK-level R4.2 / R4.4 page (one that lists the GPs)
  const p = location.pathname;
  const head = ((document.getElementById('ContentPlaceHolder1_lbl_head') || {}).textContent || '').replace(/\s+/g, ' ');
  const blockName = ((head.match(/Block\s*:\s*(.+)$/i) || [])[1] || '').trim().toUpperCase();
  if (blockName && /emuster_wagelist_rpt\.aspx$/i.test(p) && document.querySelector('a[href*="emuster_wage_rep1"]')) {
    gmSet('r42', location.href); gmSet('b42', blockName);
  }
  if (blockName && /MusterRolle_EMBStatus\.aspx$/i.test(p) && document.querySelector('a[href*="MusterRolle_EMBStatus_dtl"]')) {
    gmSet('r44', location.href); gmSet('b44', blockName);
  }
  const R42 = () => gmGet('r42', DEF_R42), R44 = () => gmGet('r44', DEF_R44);
  const MYGP = () => gmGet('myGP', 'PETLA');   // '' = whole block
  const B42 = () => gmGet('b42', 'DINHATA-I'), B44 = () => gmGet('b44', 'DINHATA-I');
  // ===================== v1.12: send MR-wise data to Gram Setu (Admin → 💸 Pipeline) =====================
  // Same sync key as the IAY Phase Report script / IAY Tracker (starts with iay_). Only work name, MR no., dates,
  // filled / e-MB / verification / wagelist and amounts are sent — no worker names.
  const GS_URL = 'https://wbzybizfpdalpukfzefk.supabase.co/rest/v1/rpc/mr_report_sync';
  const GS_PUB = 'sb_publishable_fCY9paYMNTyepXdI7YRhkw_2u85P7bn';   // public key (same as the Gram Setu website)
  const GSKEY = () => String(gmGet('gsKey', '') || '').trim();
  const gsPrefix = code => { const m = String(code || '').match(/^32(\d{2})(\d{3})(\d{3})/); return m ? `WB-${m[1]}-${m[2]}-${m[3]}` : ''; };
  async function gsSend(rows, gps, log) {
    const key = GSKEY(); if (!key) return;
    if (!/^iay_[0-9a-f]{48}$/.test(key)) { log('☁ Gram Setu: sync key looks wrong (it starts with iay_) — not sent.'); return; }
    for (const gp of gps) {
      const mine = rows.filter(o => o.gp === gp && o.code && o.mr);
      const pc = {}; for (const o of mine) { const x = gsPrefix(o.code); if (x) pc[x] = (pc[x] || 0) + 1; }
      const prefix = Object.keys(pc).sort((a, b) => pc[b] - pc[a])[0]; if (!prefix) continue;
      const body = mine.filter(o => gsPrefix(o.code) === prefix).map(o => {
        const d = String(o.dates || '').split('--');
        return { code: o.code, name: o.name || '', mr: String(o.mr), type: o.type || '', from: (d[0] || '').trim(), to: (d[1] || d[0] || '').trim(),
          filled: !!o.filled, zero: !!o.zero, meas: o.meas || '', verif: o.verif || '', tot: +(o.tot || 0).toFixed(2), usk: +(o.usk || 0).toFixed(2), mat: +(o.mat || 0).toFixed(2),
          wl_date: o.wlDate || '', wl_no: o.wlNo || '' };
      });
      try {
        const r = await fetch(GS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: GS_PUB },
          body: JSON.stringify({ p_key: key, p_jc_prefix: prefix, p_gp_name: gp, p_rows: body, p_source: 'Tampermonkey MR report' }) });
        const j = await r.json().catch(() => null);
        if (r.status === 404) { log('☁ Gram Setu: v220 SQL is not run yet — not sent.'); return; }
        if (!r.ok) { log('☁ ' + gp + ': Gram Setu error — ' + ((j && (j.message || j.hint)) || 'HTTP ' + r.status)); if (/BAD_KEY/.test(j && j.message)) return; continue; }
        log(j && j.skipped ? '☁ ' + gp + ': ' + j.skipped : '☁ ' + gp + ': sent to Gram Setu Pipeline (' + ((j && j.mrs) || 0) + ' MR)');
      } catch (e) { log('☁ ' + gp + ': Gram Setu not reached (' + e.message + ')'); }
    }
  }

  const COLS = ['S No.', 'GP', 'Project Name with code', 'E-MR No.', 'Type of MR (USK/SSK)', 'DateFrom--DateTo',
    'MR Filled or not', 'is MR has Zero Attendance',
    'Measurement Entry Date', 'Verification Date', 'Total Cost(₹)', 'Unskilled(₹)', 'Material(₹)', 'Wage list Generated Date', 'WageList No.',
    'Current Stage', 'Days since MR end', 'Work Category'];
  const cat = o => o.code.split('/').slice(1, -1).join('/');          // e.g. IF/IAY, DP/VB, LD/VB
  const isIAY = o => /\/IAY\//i.test(o.code);
  const toRow = (o, i) => [i + 1, o.gp, o.name + '(' + o.code + ')', isNaN(+o.mr) ? o.mr : +o.mr, o.type, o.dates,
    o.filled ? 'Yes' : 'No', o.zero ? 'Yes' : 'No',
    o.meas, o.verif, +o.tot.toFixed(2), +o.usk.toFixed(2), +o.mat.toFixed(2), o.wlDate, o.wlNo, o.stage, o.days, cat(o)];

  const STAGES = ['Fill Today', 'MR Fill Pending', 'Ends Tomorrow', 'Wagelist Generated', 'Wagelist Pending', 'AE Verification Pending', 'e-MB Pending', 'Zero Attendance', 'MR Running'];
  const ALERT_STAGES = ['Fill Today', 'MR Fill Pending', 'Ends Tomorrow'];
  const COLORS = { 'Wagelist Generated': '#d4edda', 'Wagelist Pending': '#fff3cd', 'AE Verification Pending': '#ffe5b4', 'e-MB Pending': '#f8d7da', 'Zero Attendance': '#e2e3e5', 'MR Running': '#d1ecf1', 'MR Fill Pending': '#ffc9c9', 'Fill Today': '#ff8f8f' };
  const SCHEMES = { noiay: 'Without IAY', iay: 'Only IAY', all: 'All Schemes' };
  const fixStage = o => { if (o.stage === 'MR চলছে (Running)') o.stage = 'MR Running'; return o; };   // old cached data
  // ---------- Live stage: recalculated with TODAY's date every time (saved data may be from yesterday) ----------
  const endOf = o => { const p = String(o.dates || '').split('--'); const m = (p[1] || p[0] || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? new Date(+m[3], m[2] - 1, +m[1]) : null; };
  const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const notFilled = o => !o.filled && !o.zero && !o.meas && !o.wlDate && !o.wlNo;
  function liveStage(o) {
    const e = endOf(o), t = today0(); if (!e) return o;
    o.days = Math.round((t - e) / 864e5);
    if (notFilled(o)) o.stage = e > t ? 'MR Running' : (+e === +t ? 'Fill Today' : 'MR Fill Pending');
    return o;
  }
  const endsTomorrow = o => o.stage === 'MR Running' && Math.round((endOf(o) - today0()) / 864e5) === 1;
  const stageIs = (o, s) => s === 'Ends Tomorrow' ? endsTomorrow(o) : o.stage === s;
  const worked = o => o.filled || o.zero || o.meas || o.wlDate;
  const byScheme = (rows, sc) => rows.filter(o => sc === 'all' || (sc === 'iay' ? isIAY(o) : !isIAY(o)));

  function summary(rows) {
    const by = {};
    for (const o of rows) {
      const s = by[o.gp] ||= { gp: o.gp, at: (RES && RES.gpAt && RES.gpAt[o.gp]) || (RES && RES.at) || '', issued: 0, ftd: 0, fod: 0, filled: 0, zero: 0, emb: 0, ver: 0, wl: 0, embP: 0, verP: 0, wlP: 0, amt: 0, vamt: 0 };
      s.issued++; if (o.filled) s.filled++; if (o.zero) s.zero++; if (o.stage === 'Fill Today') s.ftd++; if (o.stage === 'MR Fill Pending') s.fod++;
      if (o.meas) { s.emb++; s.amt += o.tot; } if (o.verif) { s.ver++; s.vamt += o.tot; }
      if (o.wlNo || o.wlDate) s.wl++;
      if (o.stage === 'e-MB Pending') s.embP++; if (o.stage === 'AE Verification Pending') s.verP++; if (o.stage === 'Wagelist Pending') s.wlP++;
    }
    return Object.values(by);
  }
  const SUMH = ['GP', 'Last Updated', 'Total MRs', '⚠ Fill Today', 'Fill Overdue', 'MR Filled', 'Zero Attendance', 'e-MB Done', 'AE Verified', 'Wagelist Generated', 'e-MB Pending', 'Verification Pending', 'Wagelist Pending', 'e-MB Total (₹)', 'Verified (₹)'];
  const sumRow = s => [s.gp, s.at || '', s.issued, s.ftd, s.fod, s.filled, s.zero, s.emb, s.ver, s.wl, s.embP, s.verP, s.wlP, Math.round(s.amt), Math.round(s.vamt)];
  // ---------- Sorting (click a column heading) ----------
  const SORT = { mr: { col: -1, dir: 1 }, sum: { col: -1, dir: 1 } };
  const sortKey = v => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return v;
    const d = String(v).match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})/);            // dd/mm/yyyy (first date of a range)
    if (d) return +(d[3] + d[2] + d[1]);
    const n = String(v).replace(/,/g, '');
    if (/^-?\d+(\.\d+)?$/.test(n)) return +n;
    return String(v).toLowerCase();
  };
  const cmp = (a, b, dir) => {
    const x = sortKey(a), y = sortKey(b);
    if (x === null && y === null) return 0; if (x === null) return 1; if (y === null) return -1;   // blanks always last
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
    return String(x).localeCompare(String(y), 'en', { numeric: true }) * dir;
  };
  const sortRows = (arr, getRow, st) => st.col < 0 ? arr : arr.map((o, i) => [o, i]).sort((a, b) => cmp(getRow(a[0], a[1])[st.col], getRow(b[0], b[1])[st.col], st.dir) || a[1] - b[1]).map(x => x[0]);
  const arrow = (st, i) => st.col === i ? (st.dir === 1 ? ' ▲' : ' ▼') : ' <span style="opacity:.35">⇅</span>';
  const thead = (heads, st, kind) => `<tr>${heads.map((h, i) => `<th data-sort="${kind}" data-col="${i}" style="cursor:pointer;user-select:none" title="Click to sort ascending / descending">${h}${arrow(st, i)}</th>`).join('')}</tr>`;
  const sortedMR = list => sortRows(list, (o, i) => toRow(o, i), SORT.mr);
  const sumTotal = sm => sm.reduce((a, s) => { for (const k in s) if (k !== 'gp' && k !== 'at') a[k] = (a[k] || 0) + s[k]; return a; }, { gp: 'TOTAL', at: '' });

  // ---------- Filters (one place, used by screen AND Excel) ----------
  const NUMCOLS = [10, 11, 12, 16];
  function filtered(res, f) {
    return byScheme(res.rows, f.sc).filter(o => (!f.gp || o.gp === f.gp) && (!f.stg || stageIs(o, f.stg)) && (!f.hide || ALERT_STAGES.includes(f.stg) || worked(o)) &&
      (!f.q || (o.mr + ' ' + o.code + ' ' + o.name + ' ' + o.wlNo).toLowerCase().includes(f.q)));
  }
  function mrTotal(list) {
    const t = { n: list.length, tot: 0, usk: 0, mat: 0, filled: 0, zero: 0, meas: 0, verif: 0, wl: 0 };
    for (const o of list) { t.tot += o.tot; t.usk += o.usk; t.mat += o.mat; if (o.filled) t.filled++; if (o.zero) t.zero++; if (o.meas) t.meas++; if (o.verif) t.verif++; if (o.wlNo || o.wlDate) t.wl++; }
    return t;
  }
  // TOTAL row laid out under the same 18 columns as COLS
  const totRow = t => ['TOTAL', '', t.n + ' MRs', '', '', '', t.filled + ' Yes', t.zero + ' Yes', t.meas + ' done', t.verif + ' done', +t.tot.toFixed(2), +t.usk.toFixed(2), +t.mat.toFixed(2), t.wl + ' WL', '', '', '', ''];
  const inr = v => (+v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const filterText = f => ['Scheme: ' + SCHEMES[f.sc], 'GP: ' + (f.gp || 'All GPs'), 'Stage: ' + (f.stg || 'All'), f.hide ? 'Worked MRs only' : 'All MRs', f.q ? 'Search: ' + f.q : ''].filter(Boolean).join('  |  ');

  // mode 'view' = exactly what is on screen; mode 'full' = every GP (scheme + worked filter kept), one sheet per GP
  async function needXlsx() {
    if (typeof XLSX !== 'undefined') return true;
    await new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); }).catch(() => {});
    if (typeof XLSX === 'undefined') { alert('Excel library could not load. Check internet and try again.'); return false; }
    return true;
  }
  async function exportXlsx(res, f, mode) {
    if (!(await needXlsx())) return;
    const ff = mode === 'full' ? { ...f, gp: '', stg: '', q: '' } : f;
    const rows = sortedMR(filtered(res, ff));
    if (!rows.length) return alert('No MRs match the current filters.');
    const wb = XLSX.utils.book_new();
    const sm = summary(rows);
    const ws0 = XLSX.utils.aoa_to_sheet([[res.block], [filterText(ff)], ['Last updated: ' + res.at], [], SUMH, ...sortRows(sm, sumRow, SORT.sum).map(sumRow), sumRow(sumTotal(sm))]);
    ws0['!cols'] = SUMH.map((h, i) => ({ wch: i === 0 ? 20 : i === 1 ? 22 : 14 }));
    XLSX.utils.book_append_sheet(wb, ws0, 'Summary');
    const mk = list => {
      const ws = XLSX.utils.aoa_to_sheet([COLS, ...list.map(toRow), totRow(mrTotal(list))]);
      ws['!cols'] = [6, 16, 60, 8, 8, 22, 9, 9, 12, 12, 12, 12, 12, 14, 22, 22, 8, 10].map(w => ({ wch: w }));
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: list.length, c: COLS.length - 1 } }) };   // TOTAL row stays outside the filter
      return ws;
    };
    const gps = [...new Set(rows.map(o => o.gp))];
    XLSX.utils.book_append_sheet(wb, mk(rows), gps.length === 1 ? gps[0].replace(/[\\\/?*\[\]:]/g, '').slice(0, 31) : 'All MR');
    if (gps.length > 1) for (const g of gps) XLSX.utils.book_append_sheet(wb, mk(rows.filter(o => o.gp === g)), g.replace(/[\\\/?*\[\]:]/g, '').slice(0, 31));
    const d = new Date(), ds = `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;
    const tag = [SCHEMES[ff.sc], ff.gp || (mode === 'full' ? 'Full' : 'AllGP'), ff.stg, ff.hide ? 'Worked' : ''].filter(Boolean).join('_').replace(/[^A-Za-z0-9_-]+/g, '_');
    XLSX.writeFile(wb, `MR_eMB_Wagelist_${tag}_${ds}.xlsx`);
  }

  // ---------- Panel ----------
  const css = `#vbr-btn{position:fixed;right:18px;bottom:18px;z-index:99999;background:#224aaa;color:#fff;border:0;border-radius:24px;padding:10px 16px;font:600 14px sans-serif;box-shadow:0 2px 8px #0004;cursor:pointer}
#vbr-pan{position:fixed;inset:12px;z-index:99998;background:#fff;border-radius:10px;box-shadow:0 4px 30px #0006;display:none;flex-direction:column;font:13px sans-serif;color:#222;overflow:hidden}
#vbr-top{flex:0 0 auto;position:relative;z-index:5;background:#fff;box-shadow:0 2px 6px #0002}
#vbr-pan header{display:flex;gap:8px;align-items:center;padding:8px 14px;background:#224aaa;color:#fff;flex-wrap:wrap}
#vbr-pan header b{font-size:15px;margin-right:auto}
#vbr-pan button{background:#fff;color:#224aaa;border:1px solid #fff;border-radius:6px;padding:5px 10px;cursor:pointer;font-weight:600}
#vbr-pan button:disabled{opacity:.6;cursor:wait}
#vbr-pan .bar{display:flex;gap:8px;padding:6px 14px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #ddd}
#vbr-pan select,#vbr-pan input[type=text]{padding:4px 6px;border:1px solid #aaa;border-radius:5px}
#vbr-pan #vbr-sc,#vbr-pan #vbr-gp{font-weight:bold;border:2px solid #224aaa}
#vbr-cfg{font-size:12px;background:#f4f7ff}
#vbr-alert{display:none;gap:6px;flex-wrap:wrap;align-items:center;padding:6px 14px;background:#fff0f0;border-bottom:2px solid #d00}
#vbr-alert a{cursor:pointer;border-radius:6px;padding:3px 9px;font-weight:bold;text-decoration:none;font-size:12px}
#vbr-alert .a1{background:#d00;color:#fff;animation:vbrblink 1.2s infinite}#vbr-alert .a2{background:#f6a;color:#600}#vbr-alert .a3{background:#ffe08a;color:#640}
#vbr-alert .gp{background:#fff;border:1px solid #d00;color:#a00;font-weight:600}
@keyframes vbrblink{50%{opacity:.55}}
#vbr-badge{background:#d00;color:#fff;border-radius:10px;padding:1px 7px;margin-left:6px;font-size:12px}
#vbr-toast{position:fixed;top:12px;right:12px;z-index:100000;background:#fff;border:2px solid #d00;border-left:8px solid #d00;border-radius:8px;box-shadow:0 4px 18px #0005;padding:10px 14px;font:13px sans-serif;color:#222;max-width:380px}
#vbr-toast button{margin:6px 6px 0 0;border:1px solid #224aaa;background:#224aaa;color:#fff;border-radius:5px;padding:4px 9px;cursor:pointer}
#vbr-toast button.l{background:#fff;color:#224aaa}
@media (max-width:760px){
#vbr-btn{right:10px;bottom:10px;padding:8px 12px;font-size:13px}
#vbr-pan{inset:0;border-radius:0;font-size:12px}
#vbr-pan header{padding:6px 8px;gap:5px}
#vbr-pan header b{font-size:13px;width:100%}
#vbr-pan header button{padding:5px 7px;font-size:12px}
#vbr-pan header .t{display:none}
#vbr-pan .bar{padding:5px 8px;gap:5px}
#vbr-pan .bar select,#vbr-pan .bar input[type=text]{max-width:46vw;font-size:12px}
#vbr-pan.mini #vbr-cfg,#vbr-pan.mini .bar.flt,#vbr-pan.mini #vbr-tot,#vbr-pan.mini #vbr-log{display:none}
#vbr-alert{padding:5px 8px}#vbr-alert .gp{display:none}
#vbr-body{padding:0 4px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
#vbr-body table{width:max-content;min-width:100%}
#vbr-body th,#vbr-body td{font-size:11px;padding:3px 4px}
#vbr-body td{white-space:nowrap}
#vbr-body td.pn{white-space:normal;min-width:220px;max-width:260px}
#vbr-toast{top:auto;bottom:58px;left:8px;right:8px;max-width:none;padding:7px 10px;font-size:12px}
}
#vbr-mini{display:none}
@media (max-width:760px){#vbr-mini{display:inline-block}}
#vbr-tot{display:flex;gap:6px;flex-wrap:wrap;padding:6px 14px;border-bottom:1px solid #ddd;background:#fafbff}
#vbr-tot span{background:#eef2ff;border:1px solid #c9d4f5;border-radius:6px;padding:3px 8px;font-size:12px}
#vbr-tot span b{font-size:13px}
#vbr-log{padding:3px 14px;color:#555;font-size:12px;height:20px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:pointer;border-bottom:1px solid #eee}
#vbr-log.open{height:auto;max-height:110px;overflow:auto;white-space:normal}
#vbr-body{overflow:auto;flex:1 1 auto;min-height:0;padding:0 14px}
#vbr-body table{border-collapse:separate;border-spacing:0;width:100%}
#vbr-body th{position:sticky;top:0;z-index:3;background:#82b4ff;padding:5px;border:1px solid #bbb;font-size:12px;text-align:left}
#vbr-body td{padding:4px 5px;border:1px solid #ddd;font-size:12px}
#vbr-body td.n{text-align:right}
#vbr-body tr.tot td{position:sticky;bottom:0;z-index:2;font-weight:bold;background:#dfe6ff;border-top:2px solid #224aaa}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const btn = Object.assign(document.createElement('button'), { id: 'vbr-btn', textContent: '📊 MR Report' });
  document.body.appendChild(btn);
  const pan = document.createElement('div'); pan.id = 'vbr-pan';
  pan.innerHTML = `<div id="vbr-top"><header><b>MR-wise e-MB / Wagelist Consolidated Report</b>
    <button id="vbr-run">🔄 Update</button><button id="vbr-xl" title="Downloads exactly the rows shown on screen, with TOTAL">⬇ Excel<span class="t"> (This view)</span></button><button id="vbr-xlf" title="All GPs (Scheme and 'Worked only' filters kept), one sheet per GP, each with TOTAL">⬇ <span class="t">Excel (</span>Full<span class="t"> report)</span></button><button id="vbr-reset" title="Reset links to DINHATA-I">↺<span class="t"> Reset to DINHATA-I</span></button><button id="vbr-mini" title="Show / hide filters">☰ Filters</button><button id="vbr-close">✕</button></header>
    <div class="bar" id="vbr-cfg"></div>
    <div class="bar flt">GP: <select id="vbr-gp"><option value="">All GPs (Summary)</option></select>
    Scheme: <select id="vbr-sc">${Object.entries(SCHEMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
    Stage: <select id="vbr-st"><option value="">All</option>${STAGES.map(s => `<option>${s}</option>`).join('')}</select>
    <label><input type="checkbox" id="vbr-hide" checked> Show worked MRs only</label>
    <label title="While any portal tab is open, My GP (or the whole block if no My GP) is re-checked automatically"><input type="checkbox" id="vbr-auto"> Auto-update every <select id="vbr-automin"><option>30</option><option>60</option><option>120</option></select> min</label>
    Search: <input type="text" id="vbr-q" placeholder="MR No / Work code / Name"></div>
    <div id="vbr-alert"></div><div id="vbr-tot"></div>
    <div id="vbr-log" title="Click to expand / collapse the log"></div></div>
    <div id="vbr-body"><p style="padding:20px">Select a GP (or “All GPs”) and click “🔄 Update”.</p></div>`;
  document.body.appendChild(pan);
  const $ = id => pan.querySelector('#' + id);
  let RES = null;
  try { RES = JSON.parse(gmGet('lastRes', 'null')); if (RES) RES.rows.forEach(o => liveStage(fixStage(o))); } catch (e) { }
  $('vbr-sc').value = gmGet('scheme', 'noiay');
  const log = m => { $('vbr-log').innerHTML = m + '<br>' + $('vbr-log').innerHTML; };
  $('vbr-log').onclick = () => $('vbr-log').classList.toggle('open');
  const F = () => ({ sc: $('vbr-sc').value, gp: $('vbr-gp').value, stg: $('vbr-st').value, hide: $('vbr-hide').checked, q: $('vbr-q').value.trim().toLowerCase() });
  const runLabel = () => { $('vbr-run').textContent = '🔄 ' + (isMobile() ? '' : 'Update ') + ($('vbr-gp').value || 'Whole Block'); };

  // ONE GP list: used both for viewing and for updating
  async function fillGP(forceReload) {
    const s = $('vbr-gp'), keep = s.value;
    let names = RES ? (RES.order || [...new Set(RES.rows.map(o => o.gp))]) : [];
    const blockChanged = RES && !String(RES.block).toUpperCase().includes(B42());
    if (forceReload || !names.length || blockChanged || (RES && !RES.order)) {
      try { log('Loading GP list…'); names = (await VBR.readBlock(R42(), R44())).gps.map(g => g.gp); if (RES && !blockChanged) RES.order = names; log('GP list loaded (' + names.length + ' GPs).'); } catch (e) { log('❌ ' + e.message); }
    }
    s.length = 1; for (const g of names) s.add(new Option(g, g));
    if (!s.dataset.init) { s.dataset.init = 1; s.value = names.includes(MYGP()) ? MYGP() : ''; }   // first open → My GP
    else s.value = names.includes(keep) ? keep : '';
    fillMy(names); runLabel();
  }

  // ---------- ALERTS ----------
  function alertData() {
    if (!RES) return null;
    RES.rows.forEach(liveStage);
    const sc = gmGet('scheme', 'noiay'), my = RES.rows.some(o => o.gp === MYGP()) ? MYGP() : '';
    const base = byScheme(RES.rows, sc).filter(o => !my || o.gp === my);
    const by = (pred) => { const m = {}; let n = 0; for (const o of base) if (pred(o)) { n++; m[o.gp] = (m[o.gp] || 0) + 1; } return { n, m }; };
    const ts = my ? [(RES.gpTs || {})[my] || 0] : Object.values(RES.gpTs || {}); const oldest = ts.length ? Math.min(...ts) : 0;
    return { my, sc, today: by(o => o.stage === 'Fill Today'), over: by(o => o.stage === 'MR Fill Pending'), tom: by(endsTomorrow), oldest };
  }
  const ago = ts => { if (!ts) return 'unknown'; const m = Math.round((Date.now() - ts) / 6e4); return m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' hr ago' : Math.round(m / 1440) + ' day(s) ago'; };
  function renderAlert() {
    const a = alertData(), box = $('vbr-alert'); if (!a) return;
    const stale = !a.oldest || (Date.now() - a.oldest) > 2 * 3600e3 || new Date(a.oldest).toDateString() !== new Date().toDateString();
    if (!a.today.n && !a.over.n && !a.tom.n && !stale) { box.style.display = 'none'; return; }
    const gpChips = (m, stg) => Object.entries(m).map(([g, n]) => `<a class="gp" data-stg="${stg}" data-gp="${g}">${g}: ${n}</a>`).join('');
    box.innerHTML = `<b style="color:#d00">⚠ ALERT — ${a.my || 'Whole Block'} (${SCHEMES[a.sc]}):</b>` +
      (a.today.n ? `<a class="a1" data-stg="Fill Today" data-gp="">🔴 Fill TODAY: ${a.today.n} MR</a>${gpChips(a.today.m, 'Fill Today')}` : '<span style="color:#080">✅ Nothing to fill today</span>') +
      (a.over.n ? `<a class="a2" data-stg="MR Fill Pending" data-gp="">Overdue (not filled): ${a.over.n}</a>` : '') +
      (a.tom.n ? `<a class="a3" data-stg="Ends Tomorrow" data-gp="">🟡 Ends tomorrow: ${a.tom.n}</a>` : '') +
      `<span style="margin-left:auto;color:${stale ? '#d00' : '#666'};font-size:12px">${stale ? '⚠ ' : ''}Data checked ${ago(a.oldest)}${stale ? ' — click Update for latest' : ''}</span>`;
    box.style.display = 'flex';
    box.querySelectorAll('a[data-stg]').forEach(x => x.onclick = () => { $('vbr-gp').value = x.dataset.gp; $('vbr-st').value = x.dataset.stg; render(); });
  }
  function updateBadge() {
    const a = alertData(); let b = btn.querySelector('#vbr-badge');
    if (a && a.today.n) { if (!b) { b = document.createElement('span'); b.id = 'vbr-badge'; btn.appendChild(b); } b.textContent = '🔴 ' + a.today.n + ' fill today'; }
    else if (b) b.remove();
  }
  // pop-up on any portal page when MRs end today and are not filled (can be hidden for the rest of the day)
  function showToast() {
    const a = alertData(); if (!a || !a.today.n) return;
    const key = new Date().toDateString(); if (gmGet('toastOff', '') === key || !gmGet('popup', true)) return;
    document.getElementById('vbr-toast')?.remove();
    const t = document.createElement('div'); t.id = 'vbr-toast';
    t.innerHTML = `<b style="color:#d00;font-size:${isMobile() ? 13 : 14}px">⚠ ${a.today.n} MR end TODAY — fill them today</b><br>` +
      Object.entries(a.today.m).map(([g, n]) => `${g}: <b>${n}</b>`).join(', ') +
      `<br><small style="color:#666">${a.my || 'Whole Block'} · ${SCHEMES[a.sc]} · data checked ${ago(a.oldest)}</small><br>` +
      `<button id="vbr-t-open">Show list</button><button class="l" id="vbr-t-off">Hide today</button><button class="l" id="vbr-t-x">✕</button>`;
    document.body.appendChild(t);
    t.querySelector('#vbr-t-open').onclick = () => { t.remove(); btn.click(); $('vbr-gp').value = a.my; $('vbr-st').value = 'Fill Today'; render(); };
    t.querySelector('#vbr-t-off').onclick = () => { gmSet('toastOff', key); t.remove(); };
    t.querySelector('#vbr-t-x').onclick = () => t.remove();
    setTimeout(() => t.remove(), isMobile() ? 10000 : 30000);   // goes away by itself; badge on the button stays
  }

  function totBar(list, isSummary) {
    const t = mrTotal(list);
    const it = (k, v) => `<span>${k}: <b>${v}</b></span>`;
    $('vbr-tot').innerHTML = (isSummary ? '<span style="background:#224aaa;color:#fff">BLOCK TOTAL</span>' : `<span style="background:#224aaa;color:#fff">${$('vbr-gp').value || 'All GPs'} TOTAL</span>`) +
      it('MRs', inr(t.n)) + it('MR Filled', inr(t.filled)) + it('Zero Att.', inr(t.zero)) + it('e-MB Done', inr(t.meas)) + it('AE Verified', inr(t.verif)) +
      it('Wagelist Generated', inr(t.wl)) + it('Total Cost ₹', inr(t.tot)) + it('Unskilled ₹', inr(t.usk)) + it('Material ₹', inr(t.mat)) +
      `<span style="background:none;border:0;color:#666">${RES.block} | Last updated: ${RES.at}</span>`;
  }

  function render() {
    runLabel();
    if (!RES) return;
    RES.rows.forEach(liveStage); renderAlert();
    const f = F();
    if (f.gp && !RES.rows.some(o => o.gp === f.gp)) {
      $('vbr-tot').innerHTML = ''; $('vbr-body').innerHTML = `<p style="padding:20px">No data saved yet for <b>${f.gp}</b>. Click “🔄 Update ${f.gp}”.</p>`; return;
    }
    if (!f.gp && !f.stg && !f.q) {
      const base = byScheme(RES.rows, f.sc);
      totBar(base, true);
      const sm = summary(base);
      const tr = (s, cls) => `<tr class="${cls}">${sumRow(s).map((v, i) => `<td class="${i > 1 ? 'n' : ''}" ${i === 1 ? 'style="font-size:11px;color:#555"' : ''}>${i > 1 ? v.toLocaleString('en-IN') : i === 1 ? v : (cls ? v : `<a href="#" data-gp="${v}">${v}</a>`)}</td>`).join('')}</tr>`;
      $('vbr-body').innerHTML = `<table>${thead(SUMH, SORT.sum, 'sum')}${sortRows(sm, sumRow, SORT.sum).map(s => tr(s, '')).join('')}${sm.length ? tr(sumTotal(sm), 'tot') : ''}</table><p style="color:#666;font-size:12px">Summary — ${SCHEMES[f.sc]}. Click a GP name to see its MRs.</p>`;
      $('vbr-body').querySelectorAll('a[data-gp]').forEach(a => a.onclick = e => { e.preventDefault(); $('vbr-gp').value = a.dataset.gp; render(); });
      return;
    }
    const list = filtered(RES, f);
    totBar(list, false);
    const all = sortedMR(list), shown = all.slice(0, 1500);
    $('vbr-body').innerHTML = `<table>${thead(COLS, SORT.mr, 'mr')}${shown.map((o, i) => `<tr style="background:${COLORS[o.stage] || '#fff'}">${toRow(o, i).map((v, j) => `<td class="${NUMCOLS.includes(j) ? 'n' : j === 2 ? 'pn' : ''}">${v ?? ''}</td>`).join('')}</tr>`).join('')}` +
      `<tr class="tot">${totRow(mrTotal(list)).map((v, j) => `<td class="${NUMCOLS.includes(j) ? 'n' : ''}">${typeof v === 'number' ? inr(v) : v}</td>`).join('')}</tr></table>` +
      (all.length > 1500 ? `<p style="color:#a00">Showing first 1,500 of ${inr(all.length)} rows (TOTAL is for all ${inr(all.length)}). Excel has every row.</p>` : '');
  }
  $('vbr-body').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]'); if (!th) return;
    const s = SORT[th.dataset.sort], c = +th.dataset.col;
    if (s.col === c) s.dir = -s.dir; else { s.col = c; s.dir = 1; }
    render();
  });
  $('vbr-sc').onchange = () => { gmSet('scheme', $('vbr-sc').value); render(); };
  ['vbr-gp', 'vbr-st', 'vbr-hide'].forEach(id => $(id).onchange = render); $('vbr-q').oninput = render;
  function fillMy(names) {
    const s = $('vbr-my'); if (!s) return;
    s.length = 0; s.add(new Option('— Whole Block —', ''));
    for (const g of new Set([...(names || []), MYGP()].filter(Boolean))) s.add(new Option(g, g));
    s.value = MYGP();
    s.onchange = () => { gmSet('myGP', s.value); $('vbr-gp').value = s.value; log('⭐ My GP set to ' + (s.value || 'Whole Block') + '.'); render(); updateBadge(); };
  }
  function bindKey() { const k = $('vbr-gskey'); if (!k) return; k.value = GSKEY(); k.onchange = () => { gmSet('gsKey', k.value.trim()); log(k.value.trim() ? '☁ Gram Setu key saved — MR stages will be sent after each Update.' : '☁ Gram Setu key removed — nothing will be sent.'); }; }
  function bindPop() { const c = $('vbr-pop'); bindKey(); if (!c) return; c.checked = gmGet('popup', true); c.onchange = () => { gmSet('popup', c.checked); if (!c.checked) document.getElementById('vbr-toast')?.remove(); log('Pop-up alert ' + (c.checked ? 'ON' : 'OFF') + ' (badge on the button always shows).'); }; }
  function showCfg() {
    const ok = B42() === B44();
    $('vbr-cfg').innerHTML = `⭐ <b>My GP (default):</b> <select id="vbr-my" title="Opens with this GP; alerts and auto-update use only this GP"></select> &nbsp; <label title="Show the red pop-up when a portal page opens"><input type="checkbox" id="vbr-pop"> Pop-up alert</label> &nbsp;|&nbsp; ☁ <b>Gram Setu key:</b> <input id="vbr-gskey" type="password" placeholder="iay_… (blank = don’t send)" style="width:150px" title="Same sync key as the IAY Tracker. After each Update the MR-wise stages (no worker names) go to Gram Setu → Admin → 💸 Pipeline"> &nbsp;|&nbsp; Saved links → R4.2: <b>${B42()}</b> &nbsp;|&nbsp; R4.4: <b>${B44()}</b> &nbsp; ${ok ? '✅ Same block' : '<span style="color:#c00;font-weight:bold">⚠ Different blocks — open the R4.2 and R4.4 pages of the same block, or click “↺ Reset to DINHATA-I”</span>'}`;
  }
  $('vbr-reset').onclick = () => { gmSet('r42', DEF_R42); gmSet('r44', DEF_R44); gmSet('b42', 'DINHATA-I'); gmSet('b44', 'DINHATA-I'); showCfg(); bindPop(); fillGP(true); log('DINHATA-I links restored. Now click “🔄 Update”.'); };
  $('vbr-auto').checked = gmGet('auto', false); $('vbr-automin').value = String(gmGet('autoMin', 60));
  $('vbr-auto').onchange = () => { gmSet('auto', $('vbr-auto').checked); log($('vbr-auto').checked ? 'Auto-update ON (keep one portal tab open).' : 'Auto-update OFF.'); };
  $('vbr-automin').onchange = () => gmSet('autoMin', +$('vbr-automin').value);
  setInterval(() => {
    if (!gmGet('auto', false) || $('vbr-run').disabled) return;
    const a = alertData(), every = gmGet('autoMin', 60) * 6e4;
    if (a && a.oldest && Date.now() - a.oldest < every) return;
    if (Date.now() - gmGet('autoLock', 0) < 10 * 6e4) return;   // another portal tab is already updating
    gmSet('autoLock', Date.now());
    const keep = $('vbr-gp').value; $('vbr-gp').value = (a && a.my) || '';
    log('⏱ Auto-update started (' + ((a && a.my) || 'Whole Block') + ')…'); $('vbr-run').click();
    const w = setInterval(() => { if (!$('vbr-run').disabled) { clearInterval(w); $('vbr-gp').value = keep; render(); showToast(); } }, 2000);
  }, 60e3);
  $('vbr-mini').onclick = () => pan.classList.toggle('mini');
  let lastY = 0;
  $('vbr-body').addEventListener('scroll', () => {
    if (!isMobile()) return; const y = $('vbr-body').scrollTop;
    if (y > lastY + 10 && y > 60) pan.classList.add('mini'); else if (y < 20) pan.classList.remove('mini');
    lastY = y;
  });
  window.addEventListener('resize', () => { if (pan.style.display === 'flex') render(); });
  updateBadge(); setTimeout(showToast, 800);
  btn.onclick = () => { document.getElementById('vbr-toast')?.remove(); pan.style.display = 'flex'; btn.style.display = 'none'; showCfg(); bindPop(); fillGP(); render(); };
  $('vbr-close').onclick = () => { pan.style.display = 'none'; btn.style.display = ''; };
  $('vbr-xl').onclick = () => RES ? exportXlsx(RES, F(), 'view') : alert('Please click Update first.');
  $('vbr-xlf').onclick = () => RES ? exportXlsx(RES, F(), 'full') : alert('Please click Update first.');
  $('vbr-run').onclick = async () => {
    $('vbr-run').disabled = true; $('vbr-log').innerHTML = '';
    try {
      const one = $('vbr-gp').value;
      const NEW = await VBR.run({ r42Url: R42(), r44Url: R44(), only: one ? [one] : null, log });
      if (one && RES && RES.block === NEW.block) {
        // merge: replace only this GP's rows, keep the other GPs as they were
        const order = NEW.order;
        if (!RES.gpAt) { RES.gpAt = {}; for (const o of RES.rows) RES.gpAt[o.gp] = RES.at; }   // report saved by older version
        RES.rows = RES.rows.filter(o => o.gp !== one).concat(NEW.rows)
          .sort((a, b) => order.indexOf(a.gp) - order.indexOf(b.gp));
        RES.gpAt = Object.assign(RES.gpAt || {}, NEW.gpAt); RES.order = order; RES.gpTs = Object.assign(RES.gpTs || {}, { [one]: Date.now() });
        RES.at = NEW.at + ' (' + one + ' only)';
        log(`✅ ${one} updated (${NEW.rows.length} MRs). Other GPs kept from earlier update.`);
      } else {
        if (one && RES && RES.block !== NEW.block) log('ℹ Saved report was for a different block — showing only ' + one + '. Select “All GPs” and Update to fill the rest.');
        if (one && !RES) log('ℹ No earlier report saved — showing only ' + one + '. Select “All GPs” and Update once to fill the rest.');
        RES = NEW; if (!NEW.partial) RES.gpAt = NEW.gpAt; RES.gpTs = {}; for (const g of Object.keys(NEW.gpAt || {})) RES.gpTs[g] = Date.now();
      }
      RES.rows.forEach(liveStage);
      gmSet('lastRes', JSON.stringify(RES)); updateBadge();
      await fillGP(); $('vbr-gp').value = one; render();
      await gsSend(NEW.rows, one ? [one] : (NEW.order || [...new Set(NEW.rows.map(o => o.gp))]), log);   // v1.12: Gram Setu 💸 Pipeline
    } catch (e) { log('❌ ' + e.message); $('vbr-log').classList.add('open'); }
    $('vbr-run').disabled = false; runLabel();
  };
})();

})();