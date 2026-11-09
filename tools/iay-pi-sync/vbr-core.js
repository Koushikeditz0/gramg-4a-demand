// VB-G RAM G portal reader — copied unchanged from the IAY Phase Report
// Tampermonkey script v1.4 (const VBR). Uses global fetch / DOMParser / URL,
// which iay-sync.js provides in Node. Keep in step with the userscript.
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

module.exports = VBR;
