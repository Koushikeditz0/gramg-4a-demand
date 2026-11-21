/* =====================================================================
   Admin panel — Account copy page: "🏦 Waiting for K-Desk" (SQL v235).
   Verified accounts that K-Desk Bank A/c Update loads on the portal.
   The Admin can take done ones off the queue (portal_status 'removed')
   so K-Desk does not load them again, or put them back (Undo).
   Kept in its own file so admin.js stays as it is.
   ===================================================================== */
(function () {
  'use strict';
  var SB = window.GramgSB;
  function $(id) { return document.getElementById(id); }
  if (!$('bqCard') || !SB) return;

  var bq = { rows: [], sel: new Set(), seq: 0 };
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function status(msg, kind) { var s = $('status'); s.textContent = msg || ''; s.className = 'status' + (msg ? ' show ' + (kind || 'info') : ''); if (msg) window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function loading(text) { $('loadingText').textContent = text || 'Loading...'; $('loading').classList.toggle('show', !!text); }
  function vno(v) { return v == null ? '' : String(v).padStart(3, '0'); }
  function fmtDay(s) { return s ? new Date(s).toLocaleDateString('en-GB') : '—'; }
  function gp() { return Number($('phGp').value) || null; }
  var SETUP = 'Run supabase/2026-11-21_kdesk_bank_remove_v235.sql in Supabase → SQL Editor to use this.';
  function missing(e) { return e && (e.status === 404 || /admin_kdesk_bank/.test(e.message || '')); }
  function errText(e) {
    if (missing(e)) return SETUP;
    var map = { NOT_AUTHORIZED: 'You are not allowed to do this.', BAD_INPUT: 'The input is not valid.', NETWORK: 'Could not reach the server. Check the internet connection.' };
    return map[e && e.code] || (e && e.hint) || (e && e.message) || String(e);
  }

  function load() {
    var g = gp(); if (!g) return;
    var my = ++bq.seq;
    SB.rpc('admin_kdesk_bank_queue', { p_gp_id: g, p_removed: $('bqShowRemoved').checked }).then(function (rows) {
      if (my !== bq.seq) return;
      $('bqSetup').textContent = '';
      bq.rows = rows || []; render();
    }, function (e) {
      if (e.authLost || my !== bq.seq) return;
      bq.rows = []; render();
      if (missing(e)) { $('bqSetup').textContent = '⚠ ' + SETUP; return; }
      status(errText(e), 'err');
    });
  }
  function live(r) { return r.portal_status !== 'removed'; }
  function render() {
    var body = $('bqBody'); body.innerHTML = '';
    var ids = {}; bq.rows.forEach(function (r) { if (live(r)) ids[r.id] = 1; });
    bq.sel.forEach(function (id) { if (!ids[id]) bq.sel.delete(id); });
    var n = bq.rows.filter(live).length, fail = bq.rows.filter(function (r) { return r.portal_status === 'fail'; }).length;
    $('bqCount').textContent = n + ' waiting for K-Desk' + (fail ? ' · ' + fail + ' failed on the portal' : '');
    $('bqRemove').disabled = !bq.sel.size;
    $('bqAll').checked = n > 0 && bq.rows.filter(live).every(function (r) { return bq.sel.has(r.id); });
    if (!bq.rows.length) { var tr0 = el('tr'), td0 = el('td', 'Nothing waiting for K-Desk.', 'muted'); td0.colSpan = 8; tr0.appendChild(td0); body.appendChild(tr0); return; }
    bq.rows.forEach(function (r) {
      var tr = el('tr'), td = el('td');
      if (live(r)) {
        var cb = el('input'); cb.type = 'checkbox'; cb.checked = bq.sel.has(r.id);
        cb.onchange = function () { if (cb.checked) bq.sel.add(r.id); else bq.sel.delete(r.id); render(); };
        td.appendChild(cb);
      }
      tr.appendChild(td);
      [['Village', vno(r.village_no)], ['Job Card', (r.job_card_no || '') + ' · App ' + (r.applicant_no || '')], ['Name', (r.applicant_name || '') + (r.holder_name && r.holder_name !== r.applicant_name ? ' (passbook: ' + r.holder_name + ')' : '')],
       ['Account', (r.account_no || '') + ' · ' + (r.ifsc || '')], ['Verified', fmtDay(r.verified_at)]].forEach(function (p) {
        var c = el('td', p[1]); c.setAttribute('data-label', p[0]); if (p[0] === 'Account') c.className = 'mono'; tr.appendChild(c);
      });
      var st = el('td'); st.setAttribute('data-label', 'Portal');
      if (r.portal_status === 'fail') st.appendChild(el('span', 'Failed · ' + (r.portal_note || ''), 'pill off'));
      else if (r.portal_status === 'removed') st.appendChild(el('span', '🗑 Removed ' + fmtDay(r.portal_at), 'pill neutral'));
      else st.appendChild(el('span', 'Pending', 'pill neutral'));
      tr.appendChild(st);
      var act = el('td'); act.setAttribute('data-label', '');
      var b = el('button', live(r) ? '🗑' : '↩ Undo', 'btn-light btn-small'); b.type = 'button';
      b.title = live(r) ? 'Remove from K-Desk (done on the portal)' : 'Put back for K-Desk';
      b.onclick = function () { save([r.id], live(r)); };
      act.appendChild(b); tr.appendChild(act);
      body.appendChild(tr);
    });
  }
  function save(ids, remove) {
    loading(remove ? 'Removing...' : 'Putting back...');
    SB.rpc('admin_kdesk_bank_remove', { p_ids: ids, p_remove: remove }).then(function (n) {
      bq.sel.clear();
      status('✔ ' + n + ' account(s) ' + (remove ? 'removed from K-Desk.' : 'put back for K-Desk.'), 'ok');
      load();
    }, function (e) { if (!e.authLost) status(errText(e), 'err'); }).then(function () { loading(''); });
  }
  $('bqRemove').addEventListener('click', function () { if (bq.sel.size) save(Array.from(bq.sel), true); });
  $('bqAll').addEventListener('change', function () {
    var on = this.checked; bq.rows.filter(live).forEach(function (r) { if (on) bq.sel.add(r.id); else bq.sel.delete(r.id); }); render();
  });
  $('bqShowRemoved').addEventListener('change', load);
  $('phGp').addEventListener('change', function () { bq.sel.clear(); load(); });
  var rf = $('phRefresh'); if (rf) rf.addEventListener('click', load);
  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () { if (b.dataset.tab === 'photos') load(); });
  });
  // the photo list reloads after ✔ Verify: reload this table with it
  if (window.MutationObserver) {
    var t = 0;
    new MutationObserver(function () { clearTimeout(t); t = setTimeout(load, 300); }).observe($('phCards'), { childList: true });
  }
  window.AdminBankQueue = { reload: load };
})();
