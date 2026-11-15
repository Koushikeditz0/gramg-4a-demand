/* =====================================================================
   Admin panel — "⚖ WL Caste" tab (SQL v215).
   Report batches that K-Desk saved from View Wagelist → ⚖ WL Caste Breakup:
   list, download the Excel again (same official format as K-Desk), Undo.
   Kept in its own file so admin.js stays as it is.
   ===================================================================== */
(function () {
  'use strict';
  var SB = window.GramgSB;
  function $(id) { return document.getElementById(id); }
  if (!$('tab-wlcaste') || !SB) return;
  var XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  var wc = { gp: null, rows: [] };

  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function loading(text) { $('loadingText').textContent = text || 'Loading...'; $('loading').classList.toggle('show', !!text); }
  function status(msg, kind) { var s = $('status'); s.textContent = msg || ''; s.className = 'status' + (msg ? ' show ' + (kind || 'info') : ''); if (msg) window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function missing(e) { return e && (e.status === 404 || /admin_wl_caste_/.test(e.message || '')); }
  function errText(e) {
    if (missing(e)) return 'Run supabase/2026-11-15_wl_caste_reports_v215.sql in Supabase → SQL Editor first.';
    var map = { NOT_AUTHORIZED: 'You are not allowed to do this.', NETWORK: 'Could not reach the server. Check the internet connection.' };
    return map[e && e.code] || (e && e.message) || String(e);
  }
  function money(n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); }
  function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function fmtDate(s) { if (!s) return '—'; var d = new Date(s); return d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function shortWl(w) { return String(w || '').replace(/^\d+WL/i, 'WL'); }
  function copyGps(dstId) {
    var src = $('phGp'), dst = $(dstId), keep = dst.value;
    dst.innerHTML = src.innerHTML; dst.disabled = src.disabled;
    dst.value = keep || src.value; if (!dst.value) dst.value = src.value;
  }
  function gp() { return Number($('wcGp').value) || null; }
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = XLSX_URL; s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('Could not load the Excel library. Check the internet.')); }; document.head.appendChild(s);
    });
  }

  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () {
      var on = b.dataset.tab === 'wlcaste';
      $('tab-wlcaste').classList.toggle('hidden', !on);
      if (on) { copyGps('wcGp'); load(); }
    });
  });
  $('wcGp').addEventListener('change', load);
  $('wcRefresh').addEventListener('click', load);

  function load() {
    var g = gp(); if (!g) return;
    wc.gp = g; loading('Loading reports...');
    SB.rpc('admin_wl_caste_batches', { p_gp_id: g }).then(function (rows) {
      loading(''); if (wc.gp !== g) return;
      $('wcSetup').textContent = '';
      wc.rows = rows || []; render();
    }, function (e) {
      loading(''); wc.rows = []; render();
      if (missing(e)) { $('wcSetup').textContent = '⚠ ' + errText(e); return; }
      if (!e || !e.authLost) status(errText(e), 'err');
    });
  }
  function td(tr, text, label, cls) { var c = el('td', text, cls); c.setAttribute('data-label', label); tr.appendChild(c); return c; }
  function render() {
    var body = $('wcBody'); body.innerHTML = '';
    var tw = 0, ta = 0;
    wc.rows.forEach(function (b) { tw += Number(b.wl) || 0; ta += Number(b.amount) || 0; });
    $('wcStats').innerHTML = '';
    [['Reports', wc.rows.length], ['Wage lists reported', tw], ['Total', money(ta)]].forEach(function (x) {
      var d = el('div', null, 'stat'); d.appendChild(el('div', String(x[1]), 'n')); d.appendChild(el('div', x[0], 'l')); $('wcStats').appendChild(d);
    });
    if (!wc.rows.length) { var tr = el('tr'); var c = el('td', 'No report yet. Take one in K-Desk (View Wagelist → ⚖ WL Caste Breakup → Excel / Copy).', 'muted'); c.colSpan = 10; tr.appendChild(c); body.appendChild(tr); return; }
    wc.rows.forEach(function (b) {
      var tr = el('tr');
      td(tr, fmtDate(b.at) + (b.kind === 'copy' ? ' · Copy' : ' · Excel') + (b.iay ? ' · IAY' : ''), 'When');
      td(tr, String(b.wl), 'Wage lists');
      td(tr, b.first ? shortWl(b.first) + (b.last && b.last !== b.first ? ' – ' + shortWl(b.last) : '') : '—', 'From – To');
      td(tr, String(b.workers), 'Workers');
      td(tr, money(b.gen), 'General'); td(tr, money(b.sc), 'SC'); td(tr, money(b.st), 'ST');
      var nc = td(tr, Number(b.unknown) ? money(b.unknown) : '—', 'No caste'); if (Number(b.unknown)) nc.style.color = '#b91c1c';
      td(tr, money(b.amount), 'Total');
      var act = td(tr, null, '');
      var x = el('button', '⭳ Excel', 'btn-primary btn-small'); x.onclick = function () { excel(b); }; act.appendChild(x);
      var u = el('button', '↩ Undo', 'btn-light btn-small'); u.style.marginLeft = '6px'; u.onclick = function () { undo(b); }; act.appendChild(u);
      body.appendChild(tr);
    });
  }

  var HEAD1 = ['Sl. No.', 'Muster Roll Number', 'Wage List Date', 'General Category (40-2505-02-101-00-011-3102)', '', '', '', 'SC Category (40-2505-02-789-00-011-3102)', '', '', '', 'ST Category (40-2505-02-796-00-011-3102)', '', '', '', 'Remarks'];
  var HEAD2 = ['', '', '', 'Unskilled Wagelist No.', 'Amount of Unskilled Wage to be paid (in Rs.)', 'Semi-Skilled and Skilled Wagelist No.', 'Amount of Semi-Skilled and Skilled wage to be paid (in Rs.)',
    'Unskilled Wagelist No.', 'Amount of Unskilled Wage to be paid (in Rs.)', 'Semi-Skilled and Skilled Wagelist No.', 'Amount of Semi-Skilled and Skilled wage to be paid (in Rs.)',
    'Unskilled Wagelist No.', 'Amount of Unskilled to be paid (in Rs.)', 'Semi-Skilled and Skilled Wagelist No.', 'Amount of Semi-Skilled and Skilled wage to be paid (in Rs.)', ''];
  function excel(b) {
    loading('Preparing Excel...');
    Promise.all([SB.rpc('admin_wl_caste_rows', { p_batch_id: b.id }), loadXlsx()]).then(function (res) {
      loading('');
      var rows = res[0] || [], aoa = [HEAD1, HEAD2], sl = 0, tot = [0, 0, 0];
      var ck = [['Wage List No.', 'Wage List Date', 'Workers', 'Total', 'Total on page', 'Matches']];
      rows.forEach(function (w) {
        (w.mrs || []).forEach(function (m) {
          tot[0] += Number(m.g) || 0; tot[1] += Number(m.sc) || 0; tot[2] += Number(m.st) || 0;
          var uj = (m.uj || []).join(', ');
          aoa.push([++sl, m.mr, w.date || '', m.g ? w.wl : '—', r2(m.g), '—', 0, m.sc ? w.wl : '—', r2(m.sc), '—', 0, m.st ? w.wl : '—', r2(m.st), '—', 0, uj ? 'Unmatched Job Card: ' + uj : '']);
        });
        ck.push([w.wl, w.date || '', w.n, r2(w.amt), w.page == null ? '' : r2(w.page), w.page == null ? '?' : Math.round(w.page) === Math.round(w.amt) ? '✓' : '✗']);
      });
      aoa.push(['', 'Total', '', '', r2(tot[0]), '', 0, '', r2(tot[1]), '', 0, '', r2(tot[2]), '', 0, '']);
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 1, c: 0 } }, { s: { r: 0, c: 1 }, e: { r: 1, c: 1 } }, { s: { r: 0, c: 2 }, e: { r: 1, c: 2 } },
        { s: { r: 0, c: 3 }, e: { r: 0, c: 6 } }, { s: { r: 0, c: 7 }, e: { r: 0, c: 10 } }, { s: { r: 0, c: 11 }, e: { r: 0, c: 14 } }, { s: { r: 0, c: 15 }, e: { r: 1, c: 15 } }];
      ws['!cols'] = [6, 12, 11, 20, 14, 14, 14, 20, 14, 14, 14, 20, 14, 14, 14, 40].map(function (w) { return { wch: w }; });
      var cs = XLSX.utils.aoa_to_sheet(ck); cs['!cols'] = [22, 12, 8, 12, 14, 8].map(function (w) { return { wch: w }; });
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Caste Breakup');
      XLSX.utils.book_append_sheet(wb, cs, 'WL Check');
      var d = new Date(b.at), pad = function (n) { return String(n).padStart(2, '0'); };
      XLSX.writeFile(wb, 'WL-Caste-Breakup-' + shortWl(b.first) + '_' + shortWl(b.last) + '-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.xlsx');
    }, function (e) { loading(''); status(errText(e), 'err'); });
  }
  function undo(b) {
    if (!confirm('Undo this report (' + b.wl + ' wage lists)? K-Desk will treat these wage lists as new again.')) return;
    loading('Undoing...');
    SB.rpc('admin_wl_caste_undo', { p_batch_id: b.id }).then(function (r) {
      loading(''); status('Undone: ' + ((r && r.undone) || 0) + ' wage list(s) count as new again in K-Desk.', 'ok'); load();
    }, function (e) { loading(''); status(errText(e), 'err'); });
  }
})();
