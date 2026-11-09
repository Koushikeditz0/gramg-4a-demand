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
      var o = { name: g.gp_name, at: g.report_at, past: [], fut: [], up: 0, pend: 0 };
      past.forEach(function (x) { var c = cell[g.jc_prefix + '|' + x] || { total: 0, filled: 0 }; o.past.push({ t: c.total, f: c.filled, p: c.total - c.filled }); o.pend += c.total - c.filled; });
      fut.forEach(function (x) { var c = cell[g.jc_prefix + '|' + x]; var n = c ? c.total : 0; o.fut.push(n); o.up += n; });
      return o;
    });
    var tot = { name: rows.length > 1 ? 'BLOCK TOTAL' : 'TOTAL', past: past.map(function () { return { t: 0, f: 0, p: 0 }; }), fut: fut.map(function () { return 0; }), up: 0, pend: 0 };
    rows.forEach(function (o) {
      o.past.forEach(function (c, i) { tot.past[i].t += c.t; tot.past[i].f += c.f; tot.past[i].p += c.p; });
      o.fut.forEach(function (n, i) { tot.fut[i] += n; }); tot.up += o.up; tot.pend += o.pend;
    });
    var label = function (x) { return dShort(x) + ' (' + (x === t ? 'Today' : x === addDays(t, -1) ? 'Yesterday' : WD[new Date(x + 'T00:00:00').getDay()]) + ')'; };
    var reps = gps.map(function (g) { return g.report_at; }).filter(Boolean).sort();
    return { sum: sum, t: t, past: past, fut: fut, rows: rows, tot: tot, label: label, oldest: reps[0], newest: reps[reps.length - 1] };
  }

  function renderTable(table, m) {
    table.innerHTML = '';
    if (!m.rows.length) { var tr0 = el('tr'), td0 = el('td', 'No data yet.'); tr0.appendChild(td0); table.appendChild(tr0); return; }
    var th = el('thead'), r1 = el('tr'), r2 = el('tr');
    var g = el('th', 'GP'); g.rowSpan = 2; r1.appendChild(g);
    m.past.forEach(function (x) { var c = el('th', m.label(x) + (x === m.t ? ' — ending' : ' — ended')); c.colSpan = 3; r1.appendChild(c); ['Total', 'Filled', 'Pending'].forEach(function (k) { r2.appendChild(el('th', k)); }); });
    if (m.fut.length) { var f = el('th', 'Next ' + m.fut.length + ' days — MRs ending (running)'); f.colSpan = m.fut.length + 1; r1.appendChild(f); m.fut.forEach(function (x) { r2.appendChild(el('th', m.label(x))); }); r2.appendChild(el('th', 'Upcoming total')); }
    var tp = el('th', 'Total pending'); tp.rowSpan = 2; r1.appendChild(tp);
    var lu = el('th', 'Last update'); lu.rowSpan = 2; r1.appendChild(lu);
    th.appendChild(r1); th.appendChild(r2); table.appendChild(th);
    var body = el('tbody');
    m.rows.concat(m.rows.length > 1 ? [m.tot] : []).forEach(function (o) {
      var tr = el('tr', null, o === m.tot ? 'tot' : ''); tr.appendChild(el('td', o.name, 'g'));
      o.past.forEach(function (c) { tr.appendChild(el('td', nf(c.t))); tr.appendChild(el('td', nf(c.f), 'f')); tr.appendChild(el('td', nf(c.p), 'p')); });
      if (m.fut.length) { o.fut.forEach(function (n) { tr.appendChild(el('td', nf(n))); }); tr.appendChild(el('td', nf(o.up))); }
      tr.appendChild(el('td', nf(o.pend), 'p'));
      var u = o === m.tot ? el('td', '') : el('td', hm(o.at), 'u ' + fresh(o.at));
      if (o !== m.tot) u.title = ago(o.at);
      tr.appendChild(u);
      body.appendChild(tr);
    });
    table.appendChild(body);
  }

  function headRows(m) {
    var h1 = ['GP'], h2 = [''];
    m.past.forEach(function (x) { h1.push(m.label(x) + (x === m.t ? ' — MRs ending' : ' — MRs ended'), '', ''); h2.push('Total', 'Filled', 'Pending'); });
    if (m.fut.length) { h1.push('Next ' + m.fut.length + ' days — MRs ending per day (running)'); for (var i = 1; i <= m.fut.length; i++) h1.push(''); m.fut.forEach(function (x) { h2.push(m.label(x)); }); h2.push('Upcoming total'); }
    h1.push('Total pending (' + m.past.map(function (x) { return x.slice(8, 10) + '/' + x.slice(5, 7); }).join(' + ') + ')'); h2.push('');
    return [h1, h2];
  }
  function rowOf(o) {
    var a = [o.name];
    o.past.forEach(function (c) { a.push(c.t, c.f, c.p); });
    if (o.fut.length) { o.fut.forEach(function (n) { a.push(n); }); a.push(o.up); }
    a.push(o.pend); return a;
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
        ['• "Upcoming" = MR is still Running and ends on that date; it must be filled after it ends.']);
      if (mrRows) aoa.push(['• Beneficiary-wise lists: "MR Details" (all MRs, filterable) and "Pending List" (pending MRs only).']);
      var ws = X.utils.aoa_to_sheet(aoa);
      var merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: nc - 1 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: nc - 1 } }, { s: { r: 3, c: 0 }, e: { r: 4, c: 0 } }, { s: { r: 3, c: nc - 1 }, e: { r: 4, c: nc - 1 } }];
      var col = 1; m.past.forEach(function () { merges.push({ s: { r: 3, c: col }, e: { r: 3, c: col + 2 } }); col += 3; });
      if (m.fut.length) merges.push({ s: { r: 3, c: col }, e: { r: 3, c: col + m.fut.length } });
      ws['!merges'] = merges;
      ws['!cols'] = [{ wch: 20 }].concat(Array.from({ length: nc - 1 }, function () { return { wch: 11 }; }));
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
          var k = c >= 1 && c <= m.past.length * 3 ? (c - 1) % 3 : -1;
          var fill = isTot ? 'D9D9D9' : c === nc - 1 ? 'FFC7CE' : k === 1 ? 'C6EFCE' : k === 2 ? 'FFC7CE' : null;
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
        mk(mrRows.filter(function (x) { return x.end <= m.t && x.status !== 'Filled' && x.status !== 'WL Generated'; }), 'Pending List');
        mk(mrRows, 'MR Details');
      }
      X.writeFile(wb, 'PBAY_MR_Summary_' + (opts.fileTag ? safeName(opts.fileTag) + '_' : '') + dShort(sum.from).replace(/\//g, '-') + '_to_' + dShort(sum.to).replace(/\//g, '-') + '.xlsx');
    });
  }

  window.IaySummary = { model: model, renderTable: renderTable, exportXlsx: exportXlsx, needXlsx: needXlsx, when: when, ago: ago, fresh: fresh };
})();
