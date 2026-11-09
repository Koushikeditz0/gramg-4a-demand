/* Public PBAY Muster Roll Summary (no login). Link: iay-report.html#k=<token>
   Reads iay_public_summary (SQL v194) — GP-wise counts only. */
(function () {
  'use strict';
  var CFG = window.GRAMG_CONFIG, IS = window.IaySummary;
  var $ = function (id) { return document.getElementById(id); };
  var token = (location.hash.match(/k=([0-9a-f]{32})/) || location.search.match(/k=([0-9a-f]{32})/) || [])[1] || '';
  var data = null, GPK = 'gramg2.iayPub.gp';

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
    }).catch(function (e) { fail(e.message === 'Failed to fetch' ? 'No internet connection. Try again.' : e.message); });
  }
  function render() {
    if (!data) return;
    var m = IS.model(data, $('gp').value || null);
    IS.renderTable($('tbl'), m);
    $('sub').textContent = 'Today ' + m.t.split('-').reverse().join('/') + ' · page refreshed ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    // Last update = when the newest portal data reached the tracker; warn if some GPs are older
    var lb = $('lastBox'), f = IS.fresh(m.newest);
    lb.className = 'last ' + f;
    $('lastTxt').textContent = IS.when(m.newest) + ' (' + IS.ago(m.newest) + ')' +
      (m.oldest && m.oldest !== m.newest && IS.fresh(m.oldest) !== 'ok' ? ' · some GPs older: ' + IS.when(m.oldest) : '') +
      (f === 'old' ? ' — data may be out of date' : '');
  }
  $('gp').onchange = function () { try { localStorage.setItem(GPK, $('gp').value); } catch (e) {} render(); };
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
