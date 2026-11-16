/* =====================================================================
   Admin panel — "🚫 Portal removed" tab (SQL v221).
   Workers that a complete K-Desk ABPS Sync no longer found on the portal
   (Job Card or applicant deleted) are made inactive (soft). Here the Admin
   sees them, restores wrong ones, and decides syncs that were held by the
   safety limits. Kept in its own file so admin.js stays as it is.
   ===================================================================== */
(function () {
  'use strict';
  var SB = window.GramgSB;
  function $(id) { return document.getElementById(id); }
  if (!$('tab-pmiss') || !SB) return;
  var XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  var pm = { gp: null, data: null, find: '' };

  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function loading(text) { $('loadingText').textContent = text || 'Loading...'; $('loading').classList.toggle('show', !!text); }
  function status(msg, kind) { var s = $('status'); s.textContent = msg || ''; s.className = 'status' + (msg ? ' show ' + (kind || 'info') : ''); if (msg) window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function missing(e) { return e && (e.status === 404 || /admin_portal_/.test(e.message || '')); }
  function errText(e) {
    if (missing(e)) return 'Run supabase/2026-11-16_portal_missing_v221.sql in Supabase → SQL Editor first.';
    var map = { NOT_AUTHORIZED: 'You are not allowed to do this.', NOT_HELD: 'This sync was already decided. Refresh.',
                NETWORK: 'Could not reach the server. Check the internet connection.' };
    return map[e && e.code] || (e && e.message) || String(e);
  }
  function bn(n) { return Number(n || 0).toLocaleString('en-IN'); }
  function fmtDate(s) { if (!s) return '—'; var d = new Date(s); return d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
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
  function copyGps(dstId) {
    var src = $('phGp'), dst = $(dstId), keep = dst.value;
    dst.innerHTML = src.innerHTML; dst.disabled = src.disabled;
    dst.value = keep || src.value; if (!dst.value) dst.value = src.value;
  }
  function gp() { return Number($('pmGp').value) || null; }
  function td(tr, text, label, cls) { var c = el('td', text, cls); c.setAttribute('data-label', label); tr.appendChild(c); return c; }
  function badge(d) {
    var n = (d && d.held || []).length;
    $('pmBadge').textContent = n ? '!' : ''; $('pmBadge').classList.toggle('hidden', !n);
  }

  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () {
      var on = b.dataset.tab === 'pmiss';
      $('tab-pmiss').classList.toggle('hidden', !on);
      if (on) { copyGps('pmGp'); load(); }
    });
  });
  $('pmGp').addEventListener('change', load);
  $('pmRefresh').addEventListener('click', load);
  $('pmFind').addEventListener('input', function () { pm.find = this.value.trim().toLowerCase(); renderRemoved(); });
  $('pmAll').addEventListener('change', function () {
    var on = this.checked; document.querySelectorAll('#pmBody input[type=checkbox]').forEach(function (c) { c.checked = on; }); pickChanged();
  });
  $('pmRestore').addEventListener('click', restore);
  $('pmXlsx').addEventListener('click', xlsx);

  function load() {
    var g = gp(); if (!g) return;
    pm.gp = g; loading('Loading...');
    SB.rpc('admin_portal_missing', { p_gp_id: g }).then(function (d) {
      loading(''); if (pm.gp !== g) return;
      $('pmSetup').textContent = '';
      pm.data = d || { runs: [], held: [], removed: [], kept: [] }; render(); badge(pm.data);
    }, function (e) {
      loading(''); pm.data = { runs: [], held: [], removed: [], kept: [] }; render();
      if (missing(e)) { $('pmSetup').textContent = '⚠ ' + errText(e); return; }
      if (!e || !e.authLost) status(errText(e), 'err');
    });
  }
  function render() { renderHeld(); renderRemoved(); renderKept(); renderRuns(); }

  function workerTable(rows, withPick) {
    var wrap = el('div', null, 'table-wrap stack'); wrap.style.marginTop = '6px';
    var t = el('table'), th = el('thead'), hr = el('tr');
    ['Village', 'Job Card', 'App', 'Name'].forEach(function (h) { hr.appendChild(el('th', h)); });
    th.appendChild(hr); t.appendChild(th);
    var body = el('tbody');
    rows.forEach(function (w) {
      var tr = el('tr');
      td(tr, String(w.village_no || ''), 'Village'); td(tr, w.job_card_no, 'Job Card', 'mono');
      td(tr, String(w.applicant_no || ''), 'App'); td(tr, w.applicant_name || '', 'Name');
      body.appendChild(tr);
    });
    t.appendChild(body); wrap.appendChild(t); return wrap;
  }

  function renderHeld() {
    var box = $('pmHeld'); box.innerHTML = '';
    (pm.data.held || []).forEach(function (h) {
      var c = el('div'); c.style.cssText = 'margin-top:10px;padding:10px;border:1px solid #fcd34d;background:#fffbeb;border-radius:10px;';
      c.appendChild(el('b', '⚠ Held sync · ' + fmtDate(h.started_at)));
      c.appendChild(el('div', (h.note || '') + ' These ' + bn(h.workers.length) + ' active workers were not on the portal list:', 'muted'));
      c.appendChild(el('div', 'Check a few on the portal first. If the portal is right, Apply; if the sync looks broken (slow portal, wrong GP), Ignore.', 'muted'));
      var row = el('div', null, 'row'); row.style.marginTop = '6px';
      var ap = el('button', '🚫 Make all ' + bn(h.workers.length) + ' inactive', 'btn-danger btn-small');
      var ig = el('button', 'Ignore this sync', 'btn-light btn-small');
      ap.onclick = function () { decide(h, 'apply'); }; ig.onclick = function () { decide(h, 'ignore'); };
      row.appendChild(ap); row.appendChild(ig); c.appendChild(row);
      if (h.workers.length) c.appendChild(workerTable(h.workers.slice(0, 500)));
      if (h.workers.length > 500) c.appendChild(el('div', '… and ' + bn(h.workers.length - 500) + ' more.', 'muted'));
      box.appendChild(c);
    });
  }
  function decide(h, action) {
    var msg = action === 'apply'
      ? 'Make these ' + h.workers.length + ' workers inactive? Supervisors will no longer see them. You can restore them later.'
      : 'Ignore this sync? Nobody is changed.';
    ask(msg, action === 'apply' ? 'Make inactive' : 'Ignore', action === 'apply' ? '' : 'ok').then(function (yes) {
      if (!yes) return;
      loading('Saving...');
      SB.rpc('admin_portal_missing_decide', { p_run: h.run_id, p_action: action, p_ids: null }).then(function (r) {
        loading(''); status(action === 'apply' ? bn(r && r.deactivated) + ' workers made inactive.' : 'Sync ignored.', 'ok'); load();
      }, function (e) { loading(''); status(errText(e), 'err'); });
    });
  }

  function shown() {
    var f = pm.find;
    return (pm.data.removed || []).filter(function (w) {
      return !f || (w.job_card_no || '').toLowerCase().indexOf(f) >= 0 || (w.applicant_name || '').toLowerCase().indexOf(f) >= 0;
    });
  }
  function renderRemoved() {
    var all = pm.data.removed || [], rows = shown(), body = $('pmBody'); body.innerHTML = '';
    $('pmCount').textContent = bn(all.length); $('pmAll').checked = false;
    if (!rows.length) {
      var tr = el('tr'), c = el('td', all.length ? 'No match.' : 'Nobody yet.', 'muted'); c.colSpan = 6; tr.appendChild(c); body.appendChild(tr);
    }
    rows.forEach(function (w) {
      var tr = el('tr'), c0 = el('td'), cb = el('input'); cb.type = 'checkbox'; cb.value = w.id; cb.onchange = pickChanged;
      c0.appendChild(cb); tr.appendChild(c0);
      td(tr, String(w.village_no || ''), 'Village'); td(tr, w.job_card_no, 'Job Card', 'mono');
      td(tr, String(w.applicant_no || ''), 'App'); td(tr, w.applicant_name || '', 'Name'); td(tr, fmtDate(w.inactive_at), 'Inactive since');
      body.appendChild(tr);
    });
    pickChanged();
  }
  function picked() { return [].map.call(document.querySelectorAll('#pmBody input[type=checkbox]:checked'), function (c) { return Number(c.value); }); }
  function pickChanged() { var n = picked().length; $('pmRestore').disabled = !n; $('pmRestore').textContent = '↩ Restore ticked' + (n ? ' (' + n + ')' : ''); }

  function restore() {
    var ids = picked(); if (!ids.length) return;
    ask('Restore ' + ids.length + ' worker(s)? They become active again and later syncs will not make them inactive.', 'Restore', 'ok').then(function (yes) {
      if (!yes) return;
      loading('Saving...');
      SB.rpc('admin_portal_restore', { p_gp_id: pm.gp, p_ids: ids, p_keep: true }).then(function (r) {
        loading(''); status(bn(r && r.changed) + ' worker(s) restored.', 'ok'); load();
      }, function (e) { loading(''); status(errText(e), 'err'); });
    });
  }

  function renderKept() {
    var box = $('pmKept'); box.innerHTML = '';
    var kept = pm.data.kept || []; if (!kept.length) return;
    var h = el('h3', 'Kept by hand (' + bn(kept.length) + ')'); h.style.margin = '14px 0 4px'; box.appendChild(h);
    box.appendChild(el('div', 'Restored earlier, so syncs leave them active. Press Remove keep if they really are gone from the portal.', 'muted'));
    var wrap = el('div', null, 'table-wrap stack'); wrap.style.marginTop = '6px';
    var t = el('table'), body = el('tbody');
    kept.forEach(function (w) {
      var tr = el('tr');
      td(tr, String(w.village_no || ''), 'Village'); td(tr, w.job_card_no, 'Job Card', 'mono');
      td(tr, String(w.applicant_no || ''), 'App'); td(tr, w.applicant_name || '', 'Name');
      var c = el('td'); c.setAttribute('data-label', '');
      var b = el('button', 'Remove keep', 'btn-light btn-small');
      b.onclick = function () {
        loading('Saving...');
        SB.rpc('admin_portal_restore', { p_gp_id: pm.gp, p_ids: [w.id], p_keep: false }).then(function () {
          loading(''); status('Keep removed. The next complete sync decides.', 'ok'); load();
        }, function (e) { loading(''); status(errText(e), 'err'); });
      };
      c.appendChild(b); tr.appendChild(c); body.appendChild(tr);
    });
    t.appendChild(body); wrap.appendChild(t); box.appendChild(wrap);
  }

  var RESULT = {
    running: ['Running / not finished', 'neutral'], partial: ['Not complete: nothing changed', 'neutral'],
    nothing: ['Nobody missing', 'on'], applied: ['Done', 'on'], held: ['Held: check above', 'off'],
    held_applied: ['Held → applied by Admin', 'on'], ignored: ['Held → ignored', 'neutral']
  };
  function renderRuns() {
    var body = $('pmRuns'); body.innerHTML = '';
    var runs = pm.data.runs || [];
    if (!runs.length) {
      var tr0 = el('tr'), c0 = el('td', 'No sync yet. Run ABPS Sync in K-Desk v1.23.0 or newer (logged in to Gram Setu).', 'muted'); c0.colSpan = 8; tr0.appendChild(c0); body.appendChild(tr0);
    }
    runs.forEach(function (r) {
      var tr = el('tr');
      td(tr, fmtDate(r.started_at), 'When'); td(tr, bn(r.rows_in), 'Rows from portal');
      td(tr, bn(r.matched), 'Matched'); td(tr, r.villages ? bn(r.villages) : '—', 'Villages');
      td(tr, r.missing == null ? '—' : bn(r.missing), 'Missing'); td(tr, bn(r.deactivated), 'Made inactive');
      td(tr, bn(r.restored), 'Came back');
      var c = td(tr, '', 'Result'), m = RESULT[r.status] || [r.status, 'neutral'];
      c.appendChild(el('span', m[0], 'pill ' + m[1]));
      if (r.note) c.title = r.note;
      body.appendChild(tr);
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
    var rows = (pm.data && pm.data.removed) || [];
    if (!rows.length) { status('Nobody to download.', 'info'); return; }
    loadXlsx().then(function () {
      var aoa = [['Village', 'Job Card', 'Applicant No', 'Name', 'Inactive since']];
      rows.forEach(function (w) { aoa.push([w.village_no, w.job_card_no, w.applicant_no, w.applicant_name, fmtDate(w.inactive_at)]); });
      var wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 8 }, { wch: 26 }, { wch: 12 }, { wch: 30 }, { wch: 18 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Deleted on portal');
      var gpName = ($('pmGp').selectedOptions[0] || {}).text || 'GP';
      XLSX.writeFile(wb, 'Portal-removed-' + gpName.replace(/[^\w-]+/g, '_') + '.xlsx');
    }, function (e) { status(e.message, 'err'); });
  }
})();
