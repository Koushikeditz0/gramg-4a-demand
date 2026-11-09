/* =====================================================================
   IAY day-wise MR Summary — shared by the IAY Tracker (admin) and the
   public report page. Builds the table and the styled Excel.
   Input: result of iay_mr_summary / iay_public_summary (SQL v193/v194).
   ===================================================================== */
(function () {
  'use strict';
  var XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';   // SheetJS + cell styles
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function nf(n) { return Number(n || 0).toLocaleString('en-IN'); }
  function addDays(iso, n) { var p = iso.split('-'); return new Date(Date.UTC(+p[0], p[1] - 1, +p[2] + n)).toISOString().slice(0, 10); }
  function dShort(iso) { var p = iso.split('-'); return p[2] + '/' + p[1] + '/' + p[0].slice(2); }
  function dmy(iso) { if (!iso) return ''; var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : String(iso); }
  function when(ts) { if (!ts) return '—'; var d = new Date(ts); return d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function ago(ts) {
    if (!ts) return '';
    var m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60); if (h < 24) return h + ' h ' + (m % 60) + ' min ago';
    return Math.floor(h / 24) + ' day(s) ago';
  }
  function fresh(ts) { if (!ts) return 'old'; var h = (Date.now() - new Date(ts).getTime()) / 36e5; return h <= 2 ? 'ok' : h <= 6 ? 'warn' : 'old'; }
  function hm(ts) { if (!ts) return '—'; var d = new Date(ts); return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ', ' + d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }); }
  function safeName(s) { return String(s || '').replace(/[\\\/?*\[\]:]/g, '').slice(0, 31) || 'Sheet1'; }

  var loadingXlsx = null;
  function needXlsx() {
    if (window.XLSX && window.XLSX.version) return Promise.resolve();
    if (!loadingXlsx) loadingXlsx = new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = XLSX_URL; s.onload = res;
      s.onerror = function () { loadingXlsx = null; rej(new Error('Excel library did not load. Check the internet.')); };
      document.head.appendChild(s);
    });
    return loadingXlsx;
  }

  // prefix: only this GP (null = all GPs in the data)
  function model(sum, prefix) {
    var t = sum.today, past = [], fut = [], d, cell = {};
    for (d = sum.from; d <= t; d = addDays(d, 1)) past.push(d);
    for (d = addDays(t, 1); d <= sum.to; d = addDays(d, 1)) fut.push(d);
    sum.cells.forEach(function (c) { cell[c.jc_prefix + '|' + c.date] = c; });
    var gps = sum.gps.filter(function (g) { return !prefix || g.jc_prefix === prefix; });
    var rows = gps.map(function (g) {
      var o = { jc: g.jc_prefix, name: g.gp_name, at: g.report_at, older: g.older || 0, wl: g.wl || 0, past: [], fut: [], up: 0, pend: g.older || 0 };
      past.forEach(function (x) { var c = cell[g.jc_prefix + '|' + x] || { total: 0, filled: 0 }; o.past.push({ t: c.total, f: c.filled, p: c.total - c.filled }); o.pend += c.total - c.filled; });
      fut.forEach(function (x) { var c = cell[g.jc_prefix + '|' + x]; var n = c ? c.total : 0; o.fut.push(n); o.up += n; });
      return o;
    });
    // zone: red = MRs from earlier days pending (>10%, or any from before the chosen days);
    //       yellow = a little earlier pending (<=10%) or only TODAY's MRs still to fill; green = nothing pending
    var zones = { red: 0, yellow: 0, green: 0 };
    rows.forEach(function (o) {
      var ended = o.older, pend = o.older, todayPend = 0;
      past.forEach(function (x, i) { if (x < t) { ended += o.past[i].t; pend += o.past[i].p; } else if (x === t) todayPend += o.past[i].p; });
      o.zone = pend === 0 ? (todayPend ? 'yellow' : 'green') : (o.older > 0 || pend / Math.max(ended, 1) > 0.10) ? 'red' : 'yellow';
      zones[o.zone]++;
    });
    var tot = { jc: prefix || null, name: rows.length > 1 ? 'BLOCK TOTAL' : 'TOTAL', older: 0, wl: 0, past: past.map(function () { return { t: 0, f: 0, p: 0 }; }), fut: fut.map(function () { return 0; }), up: 0, pend: 0 };
    rows.forEach(function (o) {
      o.past.forEach(function (c, i) { tot.past[i].t += c.t; tot.past[i].f += c.f; tot.past[i].p += c.p; });
      o.fut.forEach(function (n, i) { tot.fut[i] += n; }); tot.up += o.up; tot.pend += o.pend; tot.older += o.older; tot.wl += o.wl;
    });
    var label = function (x) { return dShort(x) + ' (' + (x === t ? 'Today' : x === addDays(t, -1) ? 'Yesterday' : WD[new Date(x + 'T00:00:00').getDay()]) + ')'; };
    var reps = gps.map(function (g) { return g.report_at; }).filter(Boolean).sort();
    var before = past.length ? past[0].slice(8, 10) + '/' + past[0].slice(5, 7) : '';
    return { sum: sum, t: t, before: before, zones: zones, prefix: prefix || null, past: past, fut: fut, rows: rows, tot: tot, label: label, oldest: reps[0], newest: reps[reps.length - 1] };
  }

  // opts.onPick(kind, jc_prefix|null, date|null, title) makes the pending numbers clickable
  function renderTable(table, m, opts) {
    opts = opts || {};
    var pick = function (td, n, kind, o, date, title) {
      if (!opts.onPick || !n) return td;
      td.textContent = ''; var a = el('a', nf(n), 'c'); a.href = '#';
      a.onclick = function (e) { e.preventDefault(); opts.onPick(kind, o.jc, date, (o === m.tot ? (m.rows.length > 1 ? 'All GPs' : o.name) : o.name) + ' — ' + title); };
      td.appendChild(a); return td;
    };
    table.innerHTML = '';
    if (!m.rows.length) { var tr0 = el('tr'), td0 = el('td', 'No data yet.'); tr0.appendChild(td0); table.appendChild(tr0); return; }
    var th = el('thead'), r1 = el('tr'), r2 = el('tr');
    var g = el('th', 'GP'); g.rowSpan = 2; r1.appendChild(g);
    var ol = el('th', 'Earlier pending (before ' + m.before + ')'); ol.rowSpan = 2; r1.appendChild(ol);
    m.past.forEach(function (x) { var c = el('th', m.label(x) + (x === m.t ? ' — ending' : ' — ended')); c.colSpan = 3; r1.appendChild(c); ['Total', 'Filled', 'Pending'].forEach(function (k) { r2.appendChild(el('th', k)); }); });
    if (m.fut.length) { var f = el('th', 'Next ' + m.fut.length + ' days — MRs ending (running)'); f.colSpan = m.fut.length + 1; r1.appendChild(f); m.fut.forEach(function (x) { r2.appendChild(el('th', m.label(x))); }); r2.appendChild(el('th', 'Upcoming total')); }
    var tp = el('th', 'Total pending'); tp.rowSpan = 2; r1.appendChild(tp);
    var wl = el('th', 'WL pending (filled, no wagelist)'); wl.rowSpan = 2; r1.appendChild(wl);
    var lu = el('th', 'Last update'); lu.rowSpan = 2; r1.appendChild(lu);
    th.appendChild(r1); th.appendChild(r2); table.appendChild(th);
    var body = el('tbody');
    m.rows.concat(m.rows.length > 1 ? [m.tot] : []).forEach(function (o) {
      var tr = el('tr', null, o === m.tot ? 'tot' : '');
      var gtd = el('td', (o.zone ? ZDOT[o.zone] + ' ' : '') + o.name, 'g' + (o.zone ? ' z-' + o.zone : '')); tr.appendChild(gtd);
      tr.appendChild(pick(el('td', nf(o.older), 'p'), o.older, 'older', o, null, 'pending from before ' + m.before));
      o.past.forEach(function (c, i) { var d = m.past[i]; tr.appendChild(el('td', nf(c.t))); tr.appendChild(el('td', nf(c.f), 'f')); tr.appendChild(pick(el('td', nf(c.p), 'p'), c.p, 'day', o, d, 'pending MRs that ended ' + dShort(d))); });
      if (m.fut.length) { o.fut.forEach(function (n) { tr.appendChild(el('td', nf(n))); }); tr.appendChild(el('td', nf(o.up))); }
      tr.appendChild(pick(el('td', nf(o.pend), 'p'), o.pend, 'all', o, null, 'all pending MRs'));
      tr.appendChild(pick(el('td', nf(o.wl), 'w'), o.wl, 'wl', o, null, 'filled, wagelist pending'));
      var u = o === m.tot ? el('td', '') : el('td', hm(o.at), 'u ' + fresh(o.at));
      if (o !== m.tot) u.title = ago(o.at);
      tr.appendChild(u);
      body.appendChild(tr);
    });
    table.appendChild(body);
    if (opts.legendEl) opts.legendEl.textContent = m.rows.length > 1
      ? '🔴 ' + m.zones.red + ' GP · 🟡 ' + m.zones.yellow + ' GP · 🟢 ' + m.zones.green + ' GP'
      : '';
  }
  var ZDOT = { red: '🔴', yellow: '🟡', green: '🟢' };

  // ---------- MR list (pending / WL) ----------
  var LH = ['GP', 'Work Code', 'Reg No.', 'Beneficiary', 'Job Card', 'Village', 'MR No', 'Phase', 'MR Start', 'MR End', 'Status'];
  var lrow = function (x) { return [x.gp, x.work_code, x.reg_no || '', x.name || '', x.jcn || '', x.village || '', x.mr_no, x.seq, dmy(x.start), dmy(x.end), x.status || '']; };
  function renderList(table, rows, max) {
    table.innerHTML = ''; max = max || 500;
    var th = el('thead'), hr = el('tr'); hr.appendChild(el('th', '#')); LH.forEach(function (h) { hr.appendChild(el('th', h)); }); th.appendChild(hr); table.appendChild(th);
    var b = el('tbody');
    rows.slice(0, max).forEach(function (x, i) {
      var tr = el('tr'); tr.appendChild(el('td', String(i + 1)));
      lrow(x).forEach(function (v, j) { tr.appendChild(el('td', v == null ? '' : String(v), j === 1 || j === 4 ? 'mono' : '')); });
      b.appendChild(tr);
    });
    if (!rows.length) { var tr0 = el('tr'), td0 = el('td', 'Nothing pending ✅'); td0.colSpan = LH.length + 1; tr0.appendChild(td0); b.appendChild(tr0); }
    table.appendChild(b);
  }
  function exportList(rows, title, file) {
    return needXlsx().then(function () {
      var X = window.XLSX, ws = X.utils.aoa_to_sheet([[title], [], LH].concat(rows.map(lrow)));
      ws['!cols'] = [16, 28, 14, 26, 24, 16, 9, 7, 11, 11, 13].map(function (w) { return { wch: w }; });
      ws['!autofilter'] = { ref: X.utils.encode_range({ s: { r: 2, c: 0 }, e: { r: Math.max(rows.length + 2, 3), c: LH.length - 1 } }) };
      var B = { style: 'thin', color: { rgb: 'BFBFBF' } };
      for (var i = 0; i < LH.length; i++) ws[X.utils.encode_cell({ r: 2, c: i })].s = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '1F4E79' } }, border: { top: B, bottom: B, left: B, right: B } };
      ws.A1.s = { font: { bold: true, sz: 13 } };
      var wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, 'MR List');
      X.writeFile(wb, safeName(file || 'IAY_MR_List').replace(/\s+/g, '_') + '.xlsx');
    });
  }

  function headRows(m) {
    var h1 = ['GP', 'Earlier pending (before ' + m.before + ')'], h2 = ['', ''];
    m.past.forEach(function (x) { h1.push(m.label(x) + (x === m.t ? ' — MRs ending' : ' — MRs ended'), '', ''); h2.push('Total', 'Filled', 'Pending'); });
    if (m.fut.length) { h1.push('Next ' + m.fut.length + ' days — MRs ending per day (running)'); for (var i = 1; i <= m.fut.length; i++) h1.push(''); m.fut.forEach(function (x) { h2.push(m.label(x)); }); h2.push('Upcoming total'); }
    h1.push('Total pending (earlier + ' + m.past.map(function (x) { return x.slice(8, 10) + '/' + x.slice(5, 7); }).join(' + ') + ')', 'WL pending (filled, no wagelist)'); h2.push('', '');
    return [h1, h2];
  }
  function rowOf(o) {
    var a = [o.name, o.older];
    o.past.forEach(function (c) { a.push(c.t, c.f, c.p); });
    if (o.fut.length) { o.fut.forEach(function (n) { a.push(n); }); a.push(o.up); }
    a.push(o.pend, o.wl); return a;
  }

  // mrRows: MR rows for "Pending List" / "MR Details" sheets, or null for the summary sheet only
  function exportXlsx(m, mrRows, opts) {
    opts = opts || {};
    return needXlsx().then(function () {
      var X = window.XLSX, hd = headRows(m), nc = hd[0].length, sum = m.sum;
      var title = (opts.titlePrefix || '') + 'PBAY Muster Roll Summary — ' + dShort(sum.from) + ' to ' + dShort(sum.to) + ' (Next ' + m.fut.length + ' Days)';
      var aoa = [[title],
        ['Source: IAY Tracker (portal data of ' + when(m.oldest) + (m.newest && m.newest !== m.oldest ? ' – ' + when(m.newest) : '') + '). "Filled" = portal status Filled or WL Generated.'], [],
        hd[0], hd[1]];
      m.rows.forEach(function (o) { aoa.push(rowOf(o)); });
      if (m.rows.length > 1) aoa.push(rowOf(m.tot));
      var noteAt = aoa.length + 1;
      aoa.push([], ['Note:'], ['• "Pending" = MR period has ended but status on the portal is still Not Filled / Fill Today.'],
        ['• "Upcoming" = MR is still Running and ends on that date; it must be filled after it ends.'],
        ['• "Earlier pending" = MRs that ended before ' + m.before + ' and are still not filled. "WL pending" = MR filled but wagelist not generated yet.']);
      if (mrRows) aoa.push(['• Beneficiary-wise lists: "MR Details" (all MRs, filterable) and "Pending List" (pending MRs only).']);
      var ws = X.utils.aoa_to_sheet(aoa);
      var merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: nc - 1 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: nc - 1 } }, { s: { r: 3, c: 0 }, e: { r: 4, c: 0 } },
                    { s: { r: 3, c: 1 }, e: { r: 4, c: 1 } }, { s: { r: 3, c: nc - 2 }, e: { r: 4, c: nc - 2 } }, { s: { r: 3, c: nc - 1 }, e: { r: 4, c: nc - 1 } }];
      var col = 2; m.past.forEach(function () { merges.push({ s: { r: 3, c: col }, e: { r: 3, c: col + 2 } }); col += 3; });
      if (m.fut.length) merges.push({ s: { r: 3, c: col }, e: { r: 3, c: col + m.fut.length } });
      ws['!merges'] = merges;
      ws['!cols'] = [{ wch: 20 }].concat(Array.from({ length: nc - 1 }, function (x, i) { return { wch: i === 0 || i >= nc - 3 ? 14 : 11 }; }));
      ws['!rows'] = [{ hpt: 22 }, {}, {}, { hpt: 34 }, { hpt: 30 }];
      var B = { style: 'thin', color: { rgb: 'BFBFBF' } }, border = { top: B, bottom: B, left: B, right: B };
      var head = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '1F4E79' } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border: border };
      var setS = function (r, c, st) { var a = X.utils.encode_cell({ r: r, c: c }); if (!ws[a]) ws[a] = { t: 's', v: '' }; ws[a].s = st; };
      setS(0, 0, { font: { bold: true, sz: 14 } }); setS(1, 0, { font: { italic: true, color: { rgb: '595959' } } });
      for (var c = 0; c < nc; c++) { setS(3, c, head); setS(4, c, head); }
      var last = 4 + m.rows.length + (m.rows.length > 1 ? 1 : 0);
      for (var r = 5; r <= last; r++) {
        var isTot = m.rows.length > 1 && r === last;
        for (c = 0; c < nc; c++) {
          var k = c >= 2 && c <= m.past.length * 3 + 1 ? (c - 2) % 3 : -1;
          var fill = isTot ? 'D9D9D9' : c === nc - 1 ? 'FFEB9C' : (c === nc - 2 || c === 1) ? 'FFC7CE' : k === 1 ? 'C6EFCE' : k === 2 ? 'FFC7CE' : null;
          var st = { border: border, alignment: { horizontal: c ? 'center' : 'left' }, font: { bold: isTot || c === 0 } };
          if (fill) st.fill = { fgColor: { rgb: fill } };
          setS(r, c, st);
        }
      }
      setS(noteAt, 0, { font: { bold: true } });
      var wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, 'Summary');
      if (mrRows) {
        var H = ['GP', 'Work Code', 'Reg No.', 'Beneficiary', 'Job Card', 'Village', 'MR No', 'Phase', 'MR Start', 'MR End', 'Status'];
        var line = function (x) { return [x.gp, x.work_code, x.reg_no || '', x.name || '', x.jcn || '', x.village || '', x.mr_no, x.seq, dmy(x.start), dmy(x.end), x.status || '']; };
        var mk = function (list, name) {
          var s2 = X.utils.aoa_to_sheet([H].concat(list.map(line)));
          s2['!cols'] = [16, 28, 14, 26, 24, 16, 9, 7, 11, 11, 13].map(function (w) { return { wch: w }; });
          s2['!autofilter'] = { ref: X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(list.length, 1), c: H.length - 1 } }) };
          for (var i = 0; i < H.length; i++) s2[X.utils.encode_cell({ r: 0, c: i })].s = head;
          X.utils.book_append_sheet(wb, s2, name);
        };
        mk((opts.extraPending || []).concat(mrRows.filter(function (x) { return x.end <= m.t && x.status !== 'Filled' && x.status !== 'WL Generated'; })), 'Pending List');
        mk(mrRows, 'MR Details');
      }
      X.writeFile(wb, 'PBAY_MR_Summary_' + (opts.fileTag ? safeName(opts.fileTag) + '_' : '') + dShort(sum.from).replace(/\//g, '-') + '_to_' + dShort(sum.to).replace(/\//g, '-') + '.xlsx');
    });
  }

  window.IaySummary = { renderList: renderList, exportList: exportList, model: model, renderTable: renderTable, exportXlsx: exportXlsx, needXlsx: needXlsx, when: when, ago: ago, fresh: fresh };
})();
