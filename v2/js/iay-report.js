/* Public PBAY Muster Roll Summary (no login). Link: iay-report.html#k=<token>
   Reads iay_public_summary (SQL v194) — GP-wise counts only — and iay_public_pd (SQL v205) for PBA Mandays Status. */
(function () {
  'use strict';
  var CFG = window.GRAMG_CONFIG, IS = window.IaySummary;
  var $ = function (id) { return document.getElementById(id); };
  var token = (location.hash.match(/k=([0-9a-f]{32})/) || location.search.match(/k=([0-9a-f]{32})/) || [])[1] || '';
  var data = null, pd = null, GPK = 'gramg2.iayPub.gp';

  function fail(msg) { $('msg').innerHTML = ''; var d = document.createElement('div'); d.className = 'card err'; d.textContent = msg; $('msg').appendChild(d); }
  function load() {
    if (!token) { $('sub').textContent = ''; fail('This link is incomplete. Ask the VLE for the full public report link.'); return Promise.resolve(); }
    return fetch(CFG.SUPABASE_URL + '/rest/v1/rpc/iay_public_summary', {
      method: 'POST', cache: 'no-store',
      headers: { apikey: CFG.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token: token, p_past: +$('past').value, p_ahead: +$('ahead').value })
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok) throw new Error(j && /BAD_LINK/.test(j.message || '') ? 'This link has been stopped or is not valid. Ask the VLE for a new link.' : 'Could not load the report (' + r.status + '). Try again.');
        return j;
      });
    }).then(function (j) {
      data = j; $('msg').innerHTML = '';
      var s = $('gp'), keep = s.value || (function () { try { return localStorage.getItem(GPK) || ''; } catch (e) { return ''; } })();
      s.length = 1; j.gps.forEach(function (g) { s.add(new Option(g.gp_name, g.jc_prefix)); });
      s.value = j.gps.some(function (g) { return g.jc_prefix === keep; }) ? keep : '';
      render();
      return loadPd();
    }).catch(function (e) { fail(e.message === 'Failed to fetch' ? 'No internet connection. Try again.' : e.message); });
  }
  // ---------- PBA Mandays Status (SQL v205 iay_public_pd) — plain table, no links ----------
  function loadPd() {
    return rpc('iay_public_pd', { p_token: token }).then(function (j) { pd = j || []; renderPd(); })
      .catch(function () { $('pdTbl').innerHTML = '<tr><td style="text-align:left">Could not load the mandays status. It will try again at the next refresh.</td></tr>'; });
  }
  function renderPd() {
    if (!pd) return;
    var gp = $('gp').value, rows = pd.filter(function (g) { return !gp || g.jc_prefix === gp; });
    var nf = function (n) { return Number(n || 0).toLocaleString('en-IN'); };
    var pc = function (a, b) { return (b ? Math.round(a * 10000 / b) / 100 : 0).toFixed(2) + '%'; };
    var exp = function (g) { return (g.p1 + g.p2 + g.p3 + g.p4) * 14; };
    var cells = function (g, rem) {
      // Tampermonkey v1.8 format: per phase Expected PD (e-MR × 14) and Actual PD (mandays split MR by MR, ≤15 a filled MR)
      var c = [nf(g.works), nf(g.p1), pc(g.p1, g.works), nf(g.works - g.p1), nf(g.p1 * 14), nf(g.a1)];
      [2, 3, 4].forEach(function (k) { var n = g['p' + k]; c.push(nf(n), pc(n, g.p1), nf(n * 14), nf(g['a' + k])); });
      return c.concat([nf(g.days), nf(rem), nf(g.wl)]);
    };
    var esc = function (t) { return String(t).replace(/[&<>"]/g, function (x) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[x]; }); };
    var tr = function (name, c, cls) { return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><td class="g">' + esc(name) + '</td>' + c.map(function (v) { return '<td>' + v + '</td>'; }).join('') + '</tr>'; };
    var h = '<tr><th rowspan="2">Panchayat</th><th rowspan="2">Total no of Work</th><th colspan="5" class="ph">1st Phase</th><th colspan="4" class="ph">2nd Phase</th><th colspan="4" class="ph">3rd Phase</th><th colspan="4" class="ph">4th Phase</th>' +
            '<th rowspan="2">Actual PD generated as on date</th><th rowspan="2">Remaining PD to be generated</th><th rowspan="2">Wagelist</th></tr>' +
            '<tr><th>e-MR Generated</th><th>% of e-MR generation</th><th>e-MR not Generated</th><th>Expected PD</th><th class="ac">Actual PD</th>' +
            new Array(4).join('<th>e-MR Generated</th><th>% of e-MR generation</th><th>Expected PD</th><th class="ac">Actual PD</th>') + '</tr>';
    var t = { works: 0, p1: 0, p2: 0, p3: 0, p4: 0, a1: 0, a2: 0, a3: 0, a4: 0, days: 0, wl: 0 }, remT = 0;
    var body = rows.map(function (g) {
      var rem = Math.max(0, exp(g) - g.days); remT += rem;
      for (var k in t) t[k] += +g[k] || 0;
      return tr(g.gp_name, cells(g, rem));
    }).join('');
    if (rows.length > 1) body += tr('TOTAL', cells(t, remT), 'tot');   // remaining = sum of the GPs' remaining (as in the Tampermonkey report)
    $('pdTbl').innerHTML = h + (body || '<tr><td colspan="21" style="text-align:left">No IAY data yet.</td></tr>');
  }
  function render() {
    if (!data) return;
    var m = IS.model(data, $('gp').value || null);
    IS.renderTable($('tbl'), m, { onPick: openList, legendEl: $('legend') });
    $('sub').textContent = 'Today ' + m.t.split('-').reverse().join('/') + ' · page refreshed ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    // Last update = when the newest portal data reached the tracker; warn if some GPs are older
    var lb = $('lastBox'), f = IS.fresh(m.newest);
    lb.className = 'last ' + f;
    $('lastTxt').textContent = IS.when(m.newest) + ' (' + IS.ago(m.newest) + ')' +
      (m.oldest && m.oldest !== m.newest && IS.fresh(m.oldest) !== 'ok' ? ' · some GPs older: ' + IS.when(m.oldest) : '') +
      (f === 'old' ? ' — data may be out of date' : '');
  }
  // pending list behind a number
  var list = { rows: [], title: '' };
  function rpc(fn, args) {
    return fetch(CFG.SUPABASE_URL + '/rest/v1/rpc/' + fn, { method: 'POST', cache: 'no-store',
      headers: { apikey: CFG.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(args)
    }).then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { if (!r.ok) throw new Error(j && /BAD_LINK/.test(j.message || '') ? 'This link has been stopped.' : 'Could not load the list (' + r.status + ').'); return j; }); });
  }
  function openList(kind, jc, date, title) {
    $('listCard').classList.remove('hidden'); $('listTitle').textContent = title + ' — loading…'; $('listTbl').innerHTML = ''; $('listNote').textContent = '';
    $('listCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    rpc('iay_public_list', { p_token: token, p_jc_prefix: jc, p_kind: kind, p_date: date, p_past: +$('past').value }).then(function (rows) {
      list = { rows: rows || [], title: title };
      $('listTitle').textContent = title + ' (' + list.rows.length.toLocaleString('en-IN') + ')';
      $('listNote').textContent = list.rows.length > 500 ? 'Showing the first 500 here; the Excel has all ' + list.rows.length.toLocaleString('en-IN') + '.' : '';
      IS.renderList($('listTbl'), list.rows, 500);
    }).catch(function (e) { $('listTitle').textContent = title; $('listNote').textContent = e.message; });
  }
  $('listClose').onclick = function () { $('listCard').classList.add('hidden'); };
  $('listXlsx').onclick = function () { if (list.rows.length) IS.exportList(list.rows, list.title, 'IAY_' + list.title.replace(/[^A-Za-z0-9-]+/g, '_')).catch(function (e) { fail(e.message); }); };

  $('gp').onchange = function () { try { localStorage.setItem(GPK, $('gp').value); } catch (e) {} render(); renderPd(); };
  $('past').onchange = $('ahead').onchange = $('refresh').onclick = load;
  $('xlsx').onclick = function () {
    if (!data) return;
    var m = IS.model(data, $('gp').value || null), one = $('gp').value && m.rows[0] ? m.rows[0].name : '';
    IS.exportXlsx(m, null, { titlePrefix: one ? one + ' — ' : '', fileTag: one }).catch(function (e) { fail(e.message); });
  };
  setInterval(function () { if (!document.hidden) load(); }, 5 * 60 * 1000);
  setInterval(render, 60 * 1000);   // keep “x min ago” current
  document.addEventListener('visibilitychange', function () { if (!document.hidden && data) load(); });
  load();
})();
