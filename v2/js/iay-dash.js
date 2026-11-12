/* =====================================================================
   G RAM-G 4A v2 — IAY Dashboard card on the admin panel's first page (SQL v200 iay_dashboard).
   What it shows is decided by the database: a GP Admin always gets only their own GP,
   the Super Admin gets the whole block or the GP picked here / in the GP Admin view.
   admin.js calls IayDash.load({ gps: [{ id, name, jc_prefix }], fixedGpId, role }).
   ===================================================================== */
(function () {
  'use strict';
  var SB = window.GramgSB;
  var $ = function (id) { return document.getElementById(id); };
  var RATE_KEY = 'gramg2.iayRate', GP_KEY = 'gramg2.iayDashGp', BRK_KEY = 'gramg2.iayBrkOpen';
  var ctx = { gps: [], fixed: null, role: null }, last = null, busy = false;

  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function nf(n) { return Number(n || 0).toLocaleString('en-IN'); }
  function pct(a, b) { return b ? Math.round(1000 * a / b) / 10 : 0; }
  function when(ts) { if (!ts) return '—'; var d = new Date(ts); return d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function rate() { try { var v = parseFloat(localStorage.getItem(RATE_KEY)); return v > 0 ? v : 0; } catch (e) { return 0; } }
  function prefixOf(id) { var g = ctx.gps.filter(function (x) { return x.id === id; })[0]; return g ? g.jc_prefix : null; }

  function visible() { var t = $('tab-iay'); return !!t && !t.classList.contains('hidden'); }
  // admin.js: called whenever the view (GP Admin view / GP list) changes; fetches only while the IAY tab is open
  function load(o) {
    if (o) { ctx.gps = o.gps || []; ctx.fixed = o.fixedGpId || null; ctx.role = o.role; ctx.dirty = true; }
    if (!visible()) return Promise.resolve();
    return show();
  }
  function show() {
    var card = $('iayDash'); if (!card) return Promise.resolve();
    if (!ctx.dirty && last) return Promise.resolve();
    ctx.dirty = false;
    var sel = $('idGp');
    // GP picker: GP Admin / GP Admin view = fixed; Super Admin = block or any GP
    sel.innerHTML = '';
    if (!ctx.fixed) { var o0 = el('option', 'All GPs (Block)'); o0.value = ''; sel.appendChild(o0); }
    ctx.gps.filter(function (g) { return !ctx.fixed || g.id === ctx.fixed; }).forEach(function (g) { var op = el('option', g.name); op.value = g.jc_prefix; sel.appendChild(op); });
    var keep = ''; try { keep = localStorage.getItem(GP_KEY) || ''; } catch (e) {}
    sel.value = ctx.fixed ? prefixOf(ctx.fixed) || '' : ([].some.call(sel.options, function (x) { return x.value === keep; }) ? keep : '');
    sel.disabled = !!ctx.fixed;
    $('idRate').value = rate() || '';
    return refresh();
  }
  function refresh() { return Promise.all([fetch(), loadWorks()]); }
  function fetch() {
    if (busy) return Promise.resolve(); busy = true;
    $('idLine').textContent = 'Loading…';
    return SB.rpc('iay_dashboard', { p_jc_prefix: $('idGp').value || null }, { retry: true, timeout: 60000 }).then(function (d) {
      last = d; render(); mbRender();
    }).catch(function (e) {
      $('idLine').textContent = /iay_dashboard|PGRST202/.test((e.code || '') + (e.message || '')) ? 'IAY dashboard is not installed on the server yet (SQL v200).' : 'Could not load: ' + (e.message || e.code);
    }).then(function () { busy = false; });
  }

  function kpi(box, n, label, cls, sub) {
    var d = el('div', null, 'idk ' + (cls || ''));
    d.appendChild(el('div', n, 'n')); d.appendChild(el('div', label, 'l'));
    if (sub) d.appendChild(el('div', sub, 's'));
    box.appendChild(d);
  }
  function bar(parts) {   // [[value, color, title]]
    var tot = parts.reduce(function (s, p) { return s + p[0]; }, 0), b = el('div', null, 'idbar');
    parts.forEach(function (p) { if (!p[0]) return; var s = el('span'); s.style.width = (100 * p[0] / tot) + '%'; s.style.background = p[1]; s.title = p[2] + ': ' + nf(p[0]); b.appendChild(s); });
    return b;
  }

  function render() {
    var d = last; if (!d) return;
    var works = +d.works || 0, target = works * 90, doneMd = (+d.mr_done || 0) * 15, p = pct(doneMd, target);
    var stale = !d.report_oldest || new Date(d.report_oldest).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) !== d.today;
    var line = $('idLine'); line.innerHTML = '';
    line.appendChild(document.createTextNode('Data: ' + when(d.report_newest) + (d.prefix ? '' : ' (oldest GP ' + when(d.report_oldest) + ')')));
    if (stale) { var w = el('b', '  ⚠ not today\'s report'); w.style.color = '#b91c1c'; line.appendChild(w); }

    // 1. 90-day progress
    var k = $('idKpi'); k.innerHTML = '';
    kpi(k, nf(works), 'IAY works', '', nf(d.ongoing) + ' ongoing · ' + nf(d.approved) + ' approved');
    kpi(k, p + '%', '90-day progress', 'blue', '≈ ' + nf(doneMd) + ' / ' + nf(target) + ' days');
    kpi(k, nf(d.mr_pend), 'MRs to fill (ended)', d.mr_pend ? 'red' : 'green', nf(d.mr_run) + ' running now');
    kpi(k, nf(d.mr_gap), 'MR gap — new MR needed', d.mr_gap ? 'red' : 'green');
    kpi(k, nf(d.done6), '6 MRs (90 days) done', 'green');
    var pb = $('idProg'); pb.innerHTML = '';
    var pr = el('div', null, 'idbar'), ps = el('span'); ps.style.width = Math.min(100, p) + '%'; ps.style.background = '#16a34a'; pr.appendChild(ps); pb.appendChild(pr);

    // works by MRs done
    var dist = d.dist || [], dl = $('idDist'); dl.innerHTML = '';
    var mx = Math.max.apply(null, dist.concat([1]));
    dist.forEach(function (n, i) {
      var r = el('div', null, 'iddr');
      r.appendChild(el('span', i === 0 ? 'No MR' : i + ' MR' + (i > 1 ? 's' : ''), 'k'));
      var b = el('span', null, 'b'), f = el('i'); f.style.width = (100 * n / mx) + '%'; f.style.background = i === 6 ? '#16a34a' : i === 0 ? '#94a3b8' : '#6366f1'; b.appendChild(f); r.appendChild(b);
      r.appendChild(el('span', nf(n) + (works ? ' · ' + pct(n, works) + '%' : ''), 'v'));
      dl.appendChild(r);
    });

    // 2. wagelist & money
    var wl = $('idWl'); wl.innerHTML = '';
    wl.appendChild(bar([[+d.mr_wl, '#16a34a', 'WL generated'], [+d.mr_wait, '#f59e0b', 'Filled, WL pending'], [+d.mr_pend, '#ef4444', 'Not filled'], [+d.mr_run, '#93c5fd', 'Running']]));
    var lg = el('div', null, 'idlg');
    [['#16a34a', 'WL generated', d.mr_wl], ['#f59e0b', 'Filled, WL pending', d.mr_wait], ['#ef4444', 'Ended, not filled', d.mr_pend], ['#93c5fd', 'Running', d.mr_run]].forEach(function (x) {
      var s = el('span'); var dot = el('i'); dot.style.background = x[0]; s.appendChild(dot); s.appendChild(document.createTextNode(x[1] + ' ' + nf(x[2]))); lg.appendChild(s);
    });
    wl.appendChild(lg);
    var r = rate(), mw = el('div', null, 'muted');
    mw.innerHTML = r
      ? 'Approx. wages (MRs × 15 days × ₹' + r + '): WL generated <b>₹' + nf(d.mr_wl * 15 * r) + '</b> · waiting for WL <b>₹' + nf(d.mr_wait * 15 * r) + '</b> · whole target <b>₹' + nf(target * r) + '</b>'
      : 'Enter the wage rate (₹/day) to see approximate amounts.';
    wl.appendChild(mw);

    // 3. MB & K-Desk jobs
    var mb = $('idMb'); mb.innerHTML = '';
    if (d.mb) {
      var cap = (d.mb.last_mb - d.mb.first_mb + 1) * Math.floor(d.mb.pages_per_mb / d.mb.pages_per_work);
      mb.appendChild(el('div', 'MB ' + d.mb.first_mb + '–' + d.mb.last_mb + ': ' + nf(d.mb.slots) + ' of ' + nf(cap) + ' work slots used · last MB used ' + (d.mb.last_used || '—') +
        (d.mb.waiting ? ' · ' + nf(d.mb.waiting) + ' new ongoing works get pages at the next payment job' : ''), 'idtx'));
      mb.appendChild(bar([[+d.mb.slots, '#7a3b00', 'Used'], [Math.max(0, cap - d.mb.slots), '#e2e8f0', 'Free']]));
    } else mb.appendChild(el('div', d.prefix ? 'MB books not set for this GP.' : 'Pick one GP to see its MB books.', 'idtx'));
    var j = d.jobs || {}, bk = j.by_kind || {};
    mb.appendChild(el('div', 'K-Desk jobs: ' + nf(j.open) + ' open' + (j.queued ? ' (' + nf(j.queued) + ' not picked up yet)' : '') +
      ' · today done ' + nf(j.today_ok) + (j.today_err ? ', errors ' + nf(j.today_err) : '') +
      (j.today_ok ? ' (demand ' + nf(bk.demand) + ', attendance ' + nf(bk.attend) + ', payment ' + nf(bk.pay) + ')' : ''), 'muted'));

    // 4. breakdown: village-wise for one GP, GP-wise for the block
    $('idBrkTitle').textContent = d.prefix ? 'Village-wise' : 'GP-wise';
    var tb = $('idBrk'); tb.innerHTML = '';
    (d.breakdown || []).forEach(function (b) {
      var tr = el('tr');
      var nm = el('td', b.name === '—' ? 'No village (approved, no MR yet)' : b.name, 'g');
      if (b.jc) { nm.style.cursor = 'pointer'; nm.style.color = '#1d4ed8'; nm.title = 'Open this GP'; nm.onclick = function () { $('idGp').value = b.jc; save(); refresh(); }; }
      tr.appendChild(nm);
      [b.works, b.avg_mrs, b.pend, b.gap, b.wl_wait, b.wl_done, b.done6].forEach(function (v, i) {
        var td = el('td', i === 1 ? String(v) : nf(v), 'n');
        if ((i === 2 || i === 3) && +v) td.className = 'n bad';
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    if (!(d.breakdown || []).length) { var t0 = el('tr'), c0 = el('td', 'No IAY data yet — upload / sync the Phase Report in the IAY Tracker.'); c0.colSpan = 8; t0.appendChild(c0); tb.appendChild(t0); }
  }

  /* ---------------------- All IAY works (SQL v201 iay_works_full) ---------------------- */
  var wv = { rows: [], prefix: null, page: 0, shown: [] }, PAGE = 100;
  var XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  function dm(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? m[3] + '/' + m[2] : ''; }
  function dmy(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  var DONE = { 'Filled': 1, 'WL Generated': 1, 'Zero': 1 };
  function phCls(x, today) {
    if (x.s === 'WL Generated') return 'wl';
    if (DONE[x.s]) return 'ok';
    if (x.t && x.t <= today) return 'due';
    if (x.s === 'Not Started' || (x.f && x.f > today)) return 'fut';
    return 'run';
  }
  function phases(r) {   // phase number → MR (by seq; else by order)
    var out = [];
    (r.mrs || []).forEach(function (x, i) { var q = +x.q || i + 1; if (q >= 1 && q <= 6 && !out[q - 1]) out[q - 1] = x; });
    return out;
  }
  function flags(r, today) {
    var f = { pend: 0, run: 0, wlw: 0, wl: 0 };
    (r.mrs || []).forEach(function (x) {
      if (x.s === 'WL Generated') f.wl = 1; else if (x.s === 'Filled') f.wlw = 1;
      else if (!DONE[x.s] && x.t && x.t <= today) f.pend = 1;
      else if (x.s === 'Running') f.run = 1;
    });
    return f;
  }
  function loadWorks(force) {
    var p = $('idGp').value || null, body = $('iwBody');
    if (!p) {
      wv.rows = []; wv.prefix = null; body.innerHTML = '';
      $('iwInfo').textContent = 'Pick one GP above to see every work (the whole block is too large for one table).';
      $('iwPager').classList.add('hidden'); return Promise.resolve();
    }
    if (!force && wv.prefix === p && wv.rows.length) { drawWorks(); return Promise.resolve(); }
    $('iwInfo').textContent = 'Loading all works…'; body.innerHTML = '';
    return SB.rpc('iay_works_full', { p_jc_prefix: p }, { retry: true, timeout: 90000 }).then(function (rows) {
      wv.rows = rows || []; wv.prefix = p; wv.page = 0;
      var vs = {}, sel = $('iwVill'), keep = sel.value; wv.rows.forEach(function (r) { vs[r.vill] = 1; });
      sel.innerHTML = '<option value="">All villages</option>';
      Object.keys(vs).sort().forEach(function (v) { var o = el('option', v === '—' ? 'No village (approved)' : v); o.value = v; sel.appendChild(o); });
      if (vs[keep]) sel.value = keep;
      drawWorks();
    }).catch(function (e) {
      $('iwInfo').textContent = /iay_works_full|PGRST202/.test((e.code || '') + (e.message || '')) ? 'Works table is not installed on the server yet (SQL v201).' : 'Could not load: ' + (e.message || e.code);
    });
  }
  function filtered() {
    var today = (last && last.today) || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    var q = String($('iwQ').value || '').trim().toLowerCase(), v = $('iwVill').value, st = $('iwSt').value;
    return wv.rows.filter(function (r) {
      if (v && r.vill !== v) return false;
      if (st) {
        var f = flags(r, today);
        if (st === 'pend' && !f.pend) return false;
        if (st === 'run' && !f.run) return false;
        if (st === 'wlw' && !f.wlw) return false;
        if (st === 'wl' && !f.wl) return false;
        if (st === 'gap' && !(r.next && r.next <= today && r.left > 0)) return false;
        if (st === 'nomr' && (r.mrs || []).length) return false;
        if (st === 'done6' && !(r.n >= 6)) return false;
        if (st === 'nomb' && r.mb) return false;
      }
      if (q) {
        var hay = [r.jcn, r.name, r.wc, r.reg].join(' ').toLowerCase();
        if (hay.indexOf(q) < 0 && !(r.mrs || []).some(function (x) { return String(x.no) === q; })) return false;
      }
      return true;
    });
  }
  function drawWorks() {
    var today = (last && last.today) || '', list = filtered(), body = $('iwBody');
    wv.shown = list;
    var pages = Math.max(1, Math.ceil(list.length / PAGE)); if (wv.page >= pages) wv.page = pages - 1;
    var part = list.slice(wv.page * PAGE, wv.page * PAGE + PAGE);
    $('iwInfo').textContent = nf(list.length) + ' of ' + nf(wv.rows.length) + ' works' + (list.length > PAGE ? ' · showing ' + nf(wv.page * PAGE + 1) + '–' + nf(wv.page * PAGE + part.length) : '');
    $('iwPager').classList.toggle('hidden', pages < 2);
    $('iwPage').textContent = 'Page ' + (wv.page + 1) + ' / ' + pages;
    $('iwPrev').disabled = wv.page === 0; $('iwNext').disabled = wv.page >= pages - 1;
    body.innerHTML = '';
    var frag = document.createDocumentFragment();
    part.forEach(function (r, i) {
      var tr = el('tr');
      tr.appendChild(el('td', String(wv.page * PAGE + i + 1), 'n'));
      var c = el('td'); c.appendChild(el('div', r.jcn || '', 'jc')); c.appendChild(el('div', r.name || '', 'nm')); tr.appendChild(c);
      tr.appendChild(el('td', r.vill === '—' ? '' : r.vill));
      var w = el('td'); w.appendChild(el('div', r.wc, 'jc')); w.appendChild(el('div', r.st || '', 'muted')); tr.appendChild(w);
      tr.appendChild(el('td', r.mb ? r.mb + ' · p' + r.pg + '–' + (r.pg + 9) : (r.st === 'Ongoing' ? 'not yet' : '')));
      tr.appendChild(el('td', String(r.n || 0) + '/6', 'n'));
      var ph = phases(r);
      for (var k = 0; k < 6; k++) {
        var td = el('td'), x = ph[k];
        if (!x) { td.appendChild(el('div', '—', 'ph none')); }
        else {
          var d = el('div', null, 'ph ' + phCls(x, today));
          d.appendChild(el('b', 'MR ' + x.no));
          d.appendChild(el('small', dm(x.f) + '–' + dm(x.t)));
          d.appendChild(el('small', (x.s || '?') + (r.mb ? ' · p' + (r.pg + k) : '')));
          td.appendChild(d);
        }
        tr.appendChild(td);
      }
      var wl = el('td');
      if (r.wlno || r.wl) { wl.appendChild(el('div', r.wlno || '', 'jc')); wl.appendChild(el('small', [r.wl, dmy(r.wld)].filter(Boolean).join(' · '))); }
      tr.appendChild(wl);
      tr.appendChild(el('td', r.left > 0 ? dmy(r.next) : (r.n >= 6 ? '✅ done' : '')));
      frag.appendChild(tr);
    });
    body.appendChild(frag);
    if (!part.length) { var t0 = el('tr'), c0 = el('td', wv.rows.length ? 'Nothing matches.' : 'No works.'); c0.colSpan = 14; t0.appendChild(c0); body.appendChild(t0); }
  }
  function needXlsx() {
    if (window.XLSX) return Promise.resolve();
    return new Promise(function (res, rej) { var sc = document.createElement('script'); sc.src = XLSX_URL; sc.onload = res; sc.onerror = function () { rej(new Error('Excel library did not load')); }; document.head.appendChild(sc); });
  }
  function worksXlsx() {
    var list = wv.shown || []; if (!list.length) return;
    needXlsx().then(function () {
      var H = ['#', 'Village', 'Job Card', 'Beneficiary', 'Reg No', 'Work Code', 'Work Status', 'MB No', 'MB Pages', 'MRs done'];
      for (var k = 1; k <= 6; k++) H.push('P' + k + ' MR No', 'P' + k + ' From', 'P' + k + ' To', 'P' + k + ' Status', 'P' + k + ' MB Page');
      H.push('Wagelist', 'WageList No', 'WL Date', 'Next MR from');
      var aoa = [H];
      list.forEach(function (r, i) {
        var row = [i + 1, r.vill === '—' ? '' : r.vill, r.jcn, r.name, r.reg, r.wc, r.st, r.mb || '', r.mb ? r.pg + '–' + (r.pg + 9) : '', r.n || 0];
        var ph = phases(r);
        for (var k = 0; k < 6; k++) { var x = ph[k]; row.push(x ? x.no : '', x ? dmy(x.f) : '', x ? dmy(x.t) : '', x ? x.s || '' : '', x && r.mb ? r.pg + k : ''); }
        row.push(r.wl || '', r.wlno || '', dmy(r.wld), r.left > 0 ? dmy(r.next) : '');
        aoa.push(row);
      });
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = H.map(function (h) { return { wch: /Work Code|Job Card|Beneficiary|WageList No/.test(h) ? 24 : /Status/.test(h) ? 12 : 10 }; });
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: H.length - 1 } }) };
      ws['!freeze'] = { xSplit: 4, ySplit: 1 };
      var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'IAY works');
      var g = $('idGp').selectedOptions[0];
      XLSX.writeFile(wb, 'IAY_All_Works_' + String(g ? g.textContent : 'GP').replace(/[^A-Za-z0-9]+/g, '_') + '_' + ((last && last.today) || 'today') + '.xlsx');
    }).catch(function (e) { $('iwInfo').textContent = e.message; });
  }

  /* ---------------------- MB books (SQL v204): range or Excel ---------------------- */
  var mbp = null, mbUp = null, mbGp = null;
  var MBERR = {
    MB_ALREADY_ALLOTTED: 'Pages are already given out — only the Last MB can change now. (Reset first if the range was typed wrong.)',
    LAST_MB_IN_USE: 'Last MB is lower than an MB already in use.',
    NOT_ENOUGH_BOOKS: 'Not enough books for all works — increase Last MB.',
    MB_IN_USE: 'Cannot reset: some works with these MB pages already have filled MRs.',
    MB_RANGE_FIRST: 'Save the range in Option 1 first.',
    FIX_ERRORS_FIRST: 'Fix the rows with errors in the Excel and upload again.',
    BAD_INPUT: 'Check the numbers (Last MB ≥ First MB, pages per MB ≥ pages per work).',
    PICK_ONE_GP: 'Pick one GP above.'
  };
  function mbErr(e) { var c = e && (e.code || e.message); return MBERR[c] || (e && (e.message || e.code)) || String(e); }
  function mbOut(id, html) { $(id).innerHTML = html; }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function mbRender() {
    var d = last, p = $('idGp').value;
    $('mbCard').classList.toggle('hidden', !p);
    if (!p || !d) return;
    var m = d.mb;
    if (m) {
      var cap = (m.last_mb - m.first_mb + 1) * Math.floor(m.pages_per_mb / m.pages_per_work);
      $('mbState').textContent = 'MB ' + m.first_mb + '–' + m.last_mb + ' · ' + m.pages_per_mb + ' pages a book · ' + m.pages_per_work + ' pages a work · ' +
        nf(m.slots) + ' of ' + nf(cap) + ' work slots used · last MB used ' + (m.last_used || '—') + (m.waiting ? ' · ' + nf(m.waiting) + ' works waiting for pages' : '');
      $('mbFirst').value = m.first_mb; $('mbLast').value = m.last_mb; $('mbPpm').value = m.pages_per_mb; $('mbPpw').value = m.pages_per_work;
    } else {
      $('mbState').textContent = 'MB books are not set for this GP yet — open below and use Option 1 (range) or Option 2 (Excel).';
      $('mbBox').open = true;
      if (mbGp !== p) { $('mbFirst').value = ''; $('mbLast').value = ''; $('mbPpm').value = 200; $('mbPpw').value = 10; }
    }
    var fixed = !!(m && m.slots);
    $('mbFirst').disabled = $('mbPpm').disabled = $('mbPpw').disabled = fixed;
    $('mbSave').disabled = true; mbp = null;
    if (mbGp !== p) { mbGp = p; mbUp = null; mbOut('mbPrevOut', ''); mbOut('mbUpOut', ''); $('mbApply').classList.add('hidden'); }   // keep messages after a save
  }
  function mbArgs() {
    return { p_jc_prefix: $('idGp').value, p_first_mb: +$('mbFirst').value || null, p_last_mb: +$('mbLast').value || null,
             p_pages_per_mb: +$('mbPpm').value || 200, p_pages_per_work: +$('mbPpw').value || 10 };
  }
  function mbPreview() {
    var a = mbArgs(); $('mbSave').disabled = true;
    if (!a.p_first_mb || !a.p_last_mb) { mbOut('mbPrevOut', '<span class="bad">Enter First MB and Last MB.</span>'); return; }
    mbOut('mbPrevOut', 'Checking…');
    SB.rpc('iay_mb_preview', a).then(function (r) {
      mbp = r;
      var h = 'Range MB ' + r.first_mb + '–' + r.last_mb + ': ' + nf(r.capacity) + ' work slots (' + r.works_per_mb + ' works a book).<br>';
      if (r.allotted) h += nf(r.allotted) + ' works already have pages. ';
      if (r.new) h += '<b>' + nf(r.new) + ' works will get pages</b>: first MB ' + r.first_new.mb + ' p' + r.first_new.pg + ', last about MB ' + r.last_new.mb + ' p' + r.last_new.pg + '. ';
      else h += 'No work is waiting for pages. ';
      if (r.waiting_no_mr) h += nf(r.waiting_no_mr) + ' approved works without an MR get pages later, when their MR is made. ';
      h += r.fits ? '<span class="ok">Fits — ' + nf(r.free_after) + ' slots left.</span>' : '<span class="bad">Does not fit — increase Last MB.</span>';
      mbOut('mbPrevOut', h);
      $('mbSave').disabled = !r.fits;
    }).catch(function (e) { mbOut('mbPrevOut', '<span class="bad">' + esc(mbErr(e)) + '</span>'); });
  }
  function mbSave() {
    if (!mbp || !window.confirm('Save MB ' + mbp.first_mb + '–' + mbp.last_mb + ' and give pages to ' + nf(mbp.new) + ' works?')) return;
    $('mbSave').disabled = true; mbOut('mbPrevOut', 'Saving…');
    SB.rpc('iay_mb_setup', mbArgs()).then(function (r) {
      mbOut('mbPrevOut', '<span class="ok">✅ Saved. ' + nf(r.new_slots) + ' works got pages; ' + nf(r.slots) + ' in all, last MB used ' + (r.last_mb_used || '—') + '.</span>');
      ctx.dirty = true; last = null; wv.prefix = null; refresh();
    }).catch(function (e) { mbOut('mbPrevOut', '<span class="bad">' + esc(mbErr(e)) + '</span>'); });
  }
  function mbTemplate() {
    var go = function () {
      needXlsx().then(function () {
        var H = ['Work Code', 'Job Card', 'Beneficiary', 'Village', 'Work Status', 'MRs', 'MB No', 'Page From'];
        var aoa = [H].concat(wv.rows.map(function (r) { return [r.wc, r.jcn, r.name, r.vill === '—' ? '' : r.vill, r.st, (r.mrs || []).length, r.mb || '', r.mb ? r.pg : '']; }));
        var ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 28 }, { wch: 24 }, { wch: 26 }, { wch: 14 }, { wch: 11 }, { wch: 6 }, { wch: 9 }, { wch: 10 }];
        var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'MB');
        var g = $('idGp').selectedOptions[0];
        XLSX.writeFile(wb, 'IAY_MB_Template_' + String(g ? g.textContent : 'GP').replace(/[^A-Za-z0-9]+/g, '_') + '.xlsx');
      }).catch(function (e) { mbOut('mbUpOut', '<span class="bad">' + esc(e.message) + '</span>'); });
    };
    if (wv.prefix === $('idGp').value && wv.rows.length) go(); else loadWorks(true).then(go);
  }
  function mbFile(f) {
    mbUp = null; $('mbApply').classList.add('hidden'); mbOut('mbUpOut', 'Reading ' + esc(f.name) + '…');
    needXlsx().then(function () { return f.arrayBuffer(); }).then(function (buf) {
      var wb = XLSX.read(buf, { type: 'array' }), ws = wb.Sheets[wb.SheetNames[0]];
      var a = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
      var hi = -1, cw = -1, cm = -1, cp = -1;
      for (var i = 0; i < Math.min(a.length, 15) && hi < 0; i++) {
        a[i].forEach(function (h, j) {
          var t = String(h).trim().toLowerCase();
          if (cw < 0 && /work\s*code/.test(t)) cw = j;
          else if (cm < 0 && /^mb(\s*(no|number|book))?\.?$/.test(t)) cm = j;
          else if (cp < 0 && /^(mb\s*)?page(\s*(from|no|start))?\.?$/.test(t)) cp = j;
        });
        if (cw >= 0 && cm >= 0 && cp >= 0) hi = i; else { cw = cm = cp = -1; }
      }
      if (hi < 0) throw new Error('Columns “Work Code”, “MB No” and “Page From” not found. Use the template.');
      var rows = [];
      for (var k = hi + 1; k < a.length; k++) {
        var wc = String(a[k][cw] || '').trim(), mb = String(a[k][cm] || '').trim(), pg = String(a[k][cp] || '').trim();
        if (!wc || (!mb && !pg)) continue;            // blank MB → left for automatic pages
        rows.push({ wc: wc, mb: mb, pg: pg });
      }
      if (!rows.length) throw new Error('No row has an MB No / Page From.');
      mbUp = rows;
      return SB.rpc('iay_mb_upload', { p_jc_prefix: $('idGp').value, p_rows: rows, p_apply: false }, { timeout: 90000 });
    }).then(function (r) {
      if (!r) return;
      var h = nf(r.rows) + ' rows with MB in the file: <span class="ok">' + nf(r.ok) + ' OK</span>' + (r.unchanged ? ' (' + nf(r.unchanged) + ' same as now)' : '') +
              (r.errors ? ' · <span class="bad">' + nf(r.errors) + ' with errors</span>' : '') +
              (r.not_in_file ? ' · ' + nf(r.not_in_file) + ' works not in the file will get the next free pages' : '') + '.';
      if (r.errors) {
        h += '<div class="table-wrap" style="max-height:220px;"><table><thead><tr><th>Excel row</th><th>Work Code</th><th>MB</th><th>Page</th><th>Problem</th></tr></thead><tbody>' +
          r.error_rows.map(function (x) { return '<tr><td>' + x.row + '</td><td>' + esc(x.wc) + '</td><td>' + esc(x.mb) + '</td><td>' + esc(x.pg) + '</td><td class="bad">' + esc(x.err) + '</td></tr>'; }).join('') +
          '</tbody></table></div>' + (r.errors > r.error_rows.length ? 'First ' + r.error_rows.length + ' shown. ' : '') + 'Fix these and upload again.';
      }
      mbOut('mbUpOut', h);
      $('mbApply').classList.toggle('hidden', !!r.errors || !r.ok);
    }).catch(function (e) { mbOut('mbUpOut', '<span class="bad">' + esc(mbErr(e)) + '</span>'); });
  }
  function mbApply() {
    if (!mbUp || !window.confirm('Write these MB numbers for ' + nf(mbUp.length) + ' works?')) return;
    $('mbApply').classList.add('hidden'); mbOut('mbUpOut', 'Saving…');
    SB.rpc('iay_mb_upload', { p_jc_prefix: $('idGp').value, p_rows: mbUp, p_apply: true }, { timeout: 90000 }).then(function (r) {
      mbOut('mbUpOut', '<span class="ok">✅ Saved ' + nf(r.ok) + ' works from the Excel' + (r.auto_after ? '; ' + nf(r.auto_after) + ' more got the next free pages' : '') + '.</span>');
      mbUp = null; ctx.dirty = true; last = null; wv.prefix = null; refresh();
    }).catch(function (e) { mbOut('mbUpOut', '<span class="bad">' + esc(mbErr(e)) + '</span>'); });
  }
  function mbReset() {
    var g = $('idGp').selectedOptions[0];
    if (!window.confirm('Remove ALL MB numbers of ' + (g ? g.textContent : 'this GP') + ' and start again?\n\nThis is refused if any of these works already has a filled MR.')) return;
    SB.rpc('iay_mb_reset', { p_jc_prefix: $('idGp').value }).then(function (r) {
      mbOut('mbPrevOut', '<span class="ok">Reset — ' + nf(r.removed) + ' allotments removed. Enter the range again.</span>');
      ctx.dirty = true; last = null; wv.prefix = null; refresh();
    }).catch(function (e) { mbOut('mbPrevOut', '<span class="bad">' + esc(mbErr(e)) + '</span>'); });
  }
  function save() { try { if (!ctx.fixed) localStorage.setItem(GP_KEY, $('idGp').value); } catch (e) {} }

  document.addEventListener('DOMContentLoaded', function () {
    if (!$('iayDash')) return;
    $('idGp').addEventListener('change', function () { save(); refresh(); });
    $('idRefresh').addEventListener('click', function () { refresh(); });
    try { if (localStorage.getItem(BRK_KEY) === '0') $('idBrkBox').open = false; } catch (e) {}
    $('idBrkBox').addEventListener('toggle', function () { try { localStorage.setItem(BRK_KEY, this.open ? '1' : '0'); } catch (e) {} });
    $('iwReload').addEventListener('click', function () { loadWorks(true); });
    $('mbPreview').addEventListener('click', mbPreview);
    $('mbSave').addEventListener('click', mbSave);
    ['mbFirst', 'mbLast', 'mbPpm', 'mbPpw'].forEach(function (id) { $(id).addEventListener('input', function () { $('mbSave').disabled = true; mbp = null; }); });
    $('mbTpl').addEventListener('click', mbTemplate);
    $('mbFile').addEventListener('change', function () { var f = this.files[0]; this.value = ''; if (f) mbFile(f); });
    $('mbApply').addEventListener('click', mbApply);
    $('mbReset').addEventListener('click', mbReset);
    $('iwXlsx').addEventListener('click', worksXlsx);
    var qt = null;
    $('iwQ').addEventListener('input', function () { clearTimeout(qt); qt = setTimeout(function () { wv.page = 0; drawWorks(); }, 250); });
    $('iwVill').addEventListener('change', function () { wv.page = 0; drawWorks(); });
    $('iwSt').addEventListener('change', function () { wv.page = 0; drawWorks(); });
    $('iwPrev').addEventListener('click', function () { if (wv.page > 0) { wv.page--; drawWorks(); } });
    $('iwNext').addEventListener('click', function () { wv.page++; drawWorks(); });
    $('idRate').addEventListener('change', function () {
      var v = parseFloat(this.value); try { if (v > 0) localStorage.setItem(RATE_KEY, String(v)); else localStorage.removeItem(RATE_KEY); } catch (e) {}
      render();
    });
    $('idOpen').addEventListener('click', function () {
      // the Tracker remembers the Super Admin's GP under its own key
      try { if (!ctx.fixed) localStorage.setItem('gramg2.iay.gp', $('idGp').value); } catch (e) {}
    });
  });
  window.IayDash = { load: load, show: show };
})();
