/* =====================================================================
   Admin panel (SQL v226)
   1) "🆕 New on the portal" card on the Portal new / removed page:
      Job Cards / applicants that a K-Desk ABPS Sync found on the portal but
      that are not in Gram Setu yet. Admin ticks → Accept (become workers)
      or Ignore.
   2) Worker tiles on top of every Workers & Accounts page
      (total workers, Job Cards, new, on the portal, removed, ABPS, eKYC, no bank A/c).
   Own file so admin.js / admin-portalmissing.js stay as they are.
   ===================================================================== */
(function () {
  'use strict';
  var SB = window.GramgSB;
  function $(id) { return document.getElementById(id); }
  if (!SB || !$('wkStats')) return;
  var XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  var WK_TABS = { photos: 1, marks: 1, pmiss: 1 };   // pages of the Workers & Accounts group

  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function loading(text) { $('loadingText').textContent = text || 'Loading...'; $('loading').classList.toggle('show', !!text); }
  function status(msg, kind) { var s = $('status'); s.textContent = msg || ''; s.className = 'status' + (msg ? ' show ' + (kind || 'info') : ''); if (msg) window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function missing(e) { return e && (e.status === 404 || /admin_portal_new|admin_worker_stats/.test(e.message || '')); }
  var SETUP = 'Run supabase/2026-11-18_portal_new_workers_v226.sql in Supabase → SQL Editor first.';
  function errText(e) {
    if (missing(e)) return SETUP;
    var map = { NOT_AUTHORIZED: 'You are not allowed to do this.', NETWORK: 'Could not reach the server. Check the internet connection.' };
    return map[e && e.code] || (e && e.message) || String(e);
  }
  function bn(n) { return Number(n || 0).toLocaleString('en-IN'); }
  function fmtDate(s) { if (!s) return '—'; var d = new Date(s); return d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function fmtDay(s) { if (!s) return 'never'; return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); }
  function pct(a, b) { return b ? Math.round(a * 100 / b) + '%' : '—'; }
  function ask(msg, yes, kind) {
    return new Promise(function (res) {
      var box = $('askBox'), y = $('askYes'), n = $('askNo');
      $('askMsg').textContent = msg; y.textContent = yes || 'Yes'; y.className = kind === 'ok' ? 'btn-success' : 'btn-danger';
      function done(v) { box.classList.remove('show'); y.onclick = n.onclick = box.onclick = null; res(v); }
      y.onclick = function () { done(true); }; n.onclick = function () { done(false); };
      box.onclick = function (e) { if (e.target === box) done(false); };
      box.classList.add('show'); y.focus();
    });
  }
  function td(tr, text, label, cls) { var c = el('td', text, cls); c.setAttribute('data-label', label); tr.appendChild(c); return c; }
  function curTab() { return (location.hash || '').replace('#', '') || 'today'; }
  function goTab(t) { var b = document.querySelector('.tab[data-tab="' + t + '"]'); if (b) b.click(); }

  /* ============================ 2) worker tiles ============================ */
  var ws = { seq: 0, gp: null, t: 0 };
  function showStats() {
    var on = !!WK_TABS[curTab()], box = $('wkStats');
    box.classList.toggle('hidden', !on);
    if (!on) return;
    var g = Number(($('gGp') || {}).value) || null; if (!g) return;
    if (g === ws.gp && Date.now() - ws.t < 60000) return;   // fresh enough
    loadStats(g);
  }
  function loadStats(g) {
    g = g || Number(($('gGp') || {}).value) || null; if (!g) return;
    var seq = ++ws.seq; ws.gp = g; ws.t = Date.now();
    SB.rpc('admin_worker_stats', { p_gp_id: g }).then(function (d) {
      if (seq === ws.seq) renderStats(d || {});
    }, function (e) {
      if (seq !== ws.seq) return;
      ws.t = 0; var box = $('wkStats'); box.innerHTML = '';
      box.appendChild(el('div', missing(e) ? '⚠ Worker tiles: ' + SETUP : '', 'muted'));
    });
  }
  function renderStats(d) {
    var box = $('wkStats'); box.innerHTML = '';
    function tile(val, label, note, kind, tab) {
      var t = el('div', null, 'wkt ' + (kind || '') + (tab ? ' link' : ''));
      if (tab) { t.setAttribute('role', 'button'); t.tabIndex = 0; t.onclick = function () { goTab(tab); };
                 t.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goTab(tab); } }; }
      t.appendChild(el('b', val)); t.appendChild(el('span', label)); if (note) t.appendChild(el('small', note));
      box.appendChild(t);
    }
    var w = Number(d.workers) || 0;
    tile(bn(w), 'Workers (active)', bn(d.villages) + ' villages');
    tile(bn(d.job_cards), 'Job Cards (GRGC)', w ? (w / Math.max(1, d.job_cards)).toFixed(1) + ' workers / card' : '');
    tile(bn(d.new_30), 'Newly added', bn(d.new_cards_30) + ' new Job Card' + (d.new_cards_30 === 1 ? '' : 's') + ' · 30 days', d.new_30 ? 'good' : '');
    tile(bn(d.portal_new), 'New on portal', d.portal_new ? 'waiting · Accept' : 'nothing waiting', d.portal_new ? 'warn' : '', 'pmiss');
    tile(bn(d.removed), 'Removed on portal', bn(d.inactive) + ' inactive in all', '', 'pmiss');
    tile(pct(d.abps, w), 'ABPS ready', bn(d.abps) + ' workers', '');
    tile(pct(d.ekyc, w), 'eKYC done', bn(d.ekyc) + ' workers', '');
    tile(bn(d.no_account), 'No bank A/c', 'in Gram Setu', d.no_account ? 'warn' : 'good', 'photos');
    var s = el('div', null, 'wkt'); s.appendChild(el('b', fmtDay(d.last_sync))); s.appendChild(el('span', 'Last ABPS Sync'));
    s.appendChild(el('small', 'Excel import ' + fmtDay(d.last_import))); box.appendChild(s);
  }
  window.AdminWorkerStats = { reload: function () { loadStats(); } };
  // the shell changes pages without a hashchange event: check after every click / GP change
  document.addEventListener('click', function () { setTimeout(showStats, 0); });
  if ($('gGp')) {
    $('gGp').addEventListener('change', function () { ws.t = 0; setTimeout(showStats, 0); });
    if (window.MutationObserver) new MutationObserver(function () { setTimeout(showStats, 0); }).observe($('gGp'), { childList: true });
  }
  setTimeout(showStats, 0);

  /* ============================ 1) New on the portal ============================ */
  if (!$('pnBody')) return;
  var pn = { gp: null, view: 'new', rows: [], counts: {}, find: '', seq: 0 };

  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () { if (b.dataset.tab === 'pmiss') setTimeout(load, 0); });
  });
  $('pmGp').addEventListener('change', function () { setTimeout(load, 0); });
  $('pmRefresh').addEventListener('click', function () { load(); loadStats(); });
  $('pnView').addEventListener('change', function () { pn.view = this.value; load(); });
  $('pnFind').addEventListener('input', function () { pn.find = this.value.trim().toLowerCase(); render(); });
  $('pnAll').addEventListener('change', function () {
    var on = this.checked; document.querySelectorAll('#pnBody input[type=checkbox]').forEach(function (c) { c.checked = on; }); pickChanged();
  });
  $('pnAccept').addEventListener('click', function () { decide(pn.view === 'ignored' ? 'unignore' : 'accept'); });
  $('pnIgnore').addEventListener('click', function () { decide('ignore'); });
  $('pnXlsx').addEventListener('click', xlsx);

  function load() {
    var g = Number($('pmGp').value) || null; if (!g) return;
    var seq = ++pn.seq; pn.gp = g;
    SB.rpc('admin_portal_new', { p_gp_id: g, p_status: pn.view }).then(function (d) {
      if (seq !== pn.seq) return;
      $('pnSetup').textContent = '';
      pn.rows = (d && d.rows) || []; pn.counts = (d && d.counts) || {}; render();
    }, function (e) {
      if (seq !== pn.seq) return;
      pn.rows = []; pn.counts = {}; render();
      if (missing(e)) { $('pnSetup').textContent = '⚠ ' + SETUP; return; }
      if (!e || !e.authLost) status(errText(e), 'err');
    });
  }
  function shown() {
    var f = pn.find;
    return pn.rows.filter(function (w) {
      return !f || (w.job_card_no || '').toLowerCase().indexOf(f) >= 0 || (w.applicant_name || '').toLowerCase().indexOf(f) >= 0 ||
             String(w.village_no || '') === f.replace(/^0+/, '');
    });
  }
  function render() {
    var c = pn.counts || {}, rows = shown(), body = $('pnBody'); body.innerHTML = '';
    $('pnCount').textContent = bn(c['new']);
    $('pnView').options[0].textContent = 'Waiting (' + bn(c['new']) + ')';
    $('pnView').options[1].textContent = 'Ignored (' + bn(c.ignored) + ')';
    $('pnAll').checked = false;
    var b = $('pmBadge');   // badge on the page button: "!" for held syncs wins, else the count of new ones
    if (b && b.textContent !== '!') { b.textContent = c['new'] ? String(c['new']) : ''; b.classList.toggle('hidden', !c['new']); }
    if (!rows.length) {
      var tr0 = el('tr'), c0 = el('td', pn.rows.length ? 'No match.' :
        (pn.view === 'new' ? 'Nothing new. Every worker the last ABPS Sync read is already in Gram Setu.' : 'Nobody ignored.'), 'muted');
      c0.colSpan = 8; tr0.appendChild(c0); body.appendChild(tr0);
    }
    var max = 1500;
    rows.slice(0, max).forEach(function (w) {
      var tr = el('tr'), c1 = el('td'), cb = el('input'); cb.type = 'checkbox'; cb.value = w.id; cb.onchange = pickChanged;
      c1.appendChild(cb); tr.appendChild(c1);
      td(tr, String(w.village_no || ''), 'Village');
      var jc = td(tr, w.job_card_no, 'Job Card', 'mono');
      if (w.new_card) { var t = el('span', 'new card', 'pill on'); t.style.marginLeft = '6px'; jc.appendChild(t); }
      td(tr, String(w.applicant_no || ''), 'App'); td(tr, w.applicant_name || '', 'Name');
      td(tr, w.abps ? '✓' : '✗', 'ABPS'); td(tr, w.ekyc ? '✓' : '✗', 'eKYC'); td(tr, fmtDate(w.first_seen), 'First seen');
      body.appendChild(tr);
    });
    $('pnMore').textContent = rows.length > max ? 'Showing ' + bn(max) + ' of ' + bn(rows.length) + '. Tick-all ticks only these; Accept again for the rest, or search a village.' :
      (pn.rows.length >= 5000 ? 'Only the first 5,000 are loaded. Accept them, then Refresh for more.' : '');
    $('pnAccept').textContent = pn.view === 'ignored' ? '↩ Back to waiting' : '✓ Accept ticked';
    $('pnIgnore').classList.toggle('hidden', pn.view === 'ignored');
    pickChanged();
  }
  function picked() { return [].map.call(document.querySelectorAll('#pnBody input[type=checkbox]:checked'), function (c) { return Number(c.value); }); }
  function pickChanged() {
    var n = picked().length;
    $('pnAccept').disabled = $('pnIgnore').disabled = !n;
    if (n) $('pnAccept').textContent = (pn.view === 'ignored' ? '↩ Back to waiting' : '✓ Accept ticked') + ' (' + bn(n) + ')';
  }
  function decide(action) {
    var ids = picked(); if (!ids.length) return;
    var msg = action === 'accept'
      ? 'Add these ' + bn(ids.length) + ' worker(s) to Gram Setu? Supervisors can pick them from now on. Check a few on the portal first if the number looks big.'
      : action === 'ignore' ? 'Ignore ' + bn(ids.length) + ' row(s)? They are not added, and later syncs do not show them again.'
      : 'Put ' + bn(ids.length) + ' row(s) back in the waiting list?';
    ask(msg, action === 'accept' ? 'Accept' : action === 'ignore' ? 'Ignore' : 'Back to waiting', action === 'ignore' ? '' : 'ok').then(function (yes) {
      if (!yes) return;
      loading('Saving...');
      SB.rpc('admin_portal_new_decide', { p_gp_id: pn.gp, p_ids: ids, p_action: action }).then(function (r) {
        loading('');
        var n = bn(r && r.changed), already = Number(r && r.already_in) || 0;
        status(action === 'accept' ? n + ' worker(s) added to Gram Setu.' + (already ? ' ' + bn(already) + ' were already in (imported meanwhile).' : '')
          : action === 'ignore' ? n + ' row(s) ignored.' : n + ' row(s) back in waiting.', 'ok');
        load(); loadStats();
      }, function (e) { loading(''); status(errText(e), 'err'); });
    });
  }

  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = XLSX_URL; s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('Could not load the Excel library. Check the internet.')); }; document.head.appendChild(s);
    });
  }
  function xlsx() {
    var rows = shown();
    if (!rows.length) { status('Nobody to download.', 'info'); return; }
    loadXlsx().then(function () {
      var aoa = [['Village', 'Job Card', 'Applicant No', 'Name', 'New Job Card', 'ABPS', 'eKYC', 'First seen']];
      rows.forEach(function (w) { aoa.push([w.village_no, w.job_card_no, w.applicant_no, w.applicant_name, w.new_card ? 'Yes' : '', w.abps ? 'Yes' : 'No', w.ekyc ? 'Yes' : 'No', fmtDate(w.first_seen)]); });
      var wb = XLSX.utils.book_new(), sh = XLSX.utils.aoa_to_sheet(aoa);
      sh['!cols'] = [{ wch: 8 }, { wch: 26 }, { wch: 12 }, { wch: 30 }, { wch: 12 }, { wch: 7 }, { wch: 7 }, { wch: 18 }];
      XLSX.utils.book_append_sheet(wb, sh, pn.view === 'ignored' ? 'Ignored' : 'New on portal');
      var gpName = ($('pmGp').selectedOptions[0] || {}).text || 'GP';
      XLSX.writeFile(wb, 'New-on-portal-' + gpName.replace(/[^\w-]+/g, '_') + '.xlsx');
    }, function (e) { status(e.message, 'err'); });
  }
})();
