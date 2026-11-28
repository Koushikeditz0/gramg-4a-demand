/* =====================================================================
   Admin panel — "🗑 Expired / Migrant" tab (SQL v214).
   Supervisors mark workers who died / moved away. (The Aadhaar collection
   tab was removed in v223 — Koushik dropped Aadhaar collection.) All checks are in the database (admin_* functions
   use private.require_admin_gp: a GP Admin only reaches their own GP).
   Kept in its own file so admin.js stays as it is.
   ===================================================================== */
(function () {
  'use strict';
  var SB = window.GramgSB;
  function $(id) { return document.getElementById(id); }
  if (!$('tab-marks') || !SB) return;
  var XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

  var mk = { filter: 'new', rows: [], sel: new Set() };
  var MK_REASON = { dead: '✝ Expired', migrant: '🧳 Permanently Migrant', duplicate: '⧉ Duplicate' };
  var MK_ST = { new: 'New', accepted: 'Accepted', sent_delete: 'Sent for delete', returned: 'Returned', deleted: 'Deleted' };

  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function loading(text) { $('loadingText').textContent = text || 'Loading...'; $('loading').classList.toggle('show', !!text); }
  function status(msg, kind) { var s = $('status'); s.textContent = msg || ''; s.className = 'status' + (msg ? ' show ' + (kind || 'info') : ''); if (msg) window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function missing(e) { return e && (e.status === 404 || /admin_(aadhaar|marks)_/.test(e.message || '')); }
  var SETUP = 'Run supabase/2026-11-14_aadhaar_collection_v214.sql (marks part) in Supabase → SQL Editor first.';
  function errText(e) {
    if (missing(e)) return SETUP;
    var map = { NOT_AUTHORIZED: 'You are not allowed to do this.', COMMENT_NEEDED: 'Write a comment for the supervisor.',
                BAD_INPUT: 'The input is not valid.', NETWORK: 'Could not reach the server. Check the internet connection.' };
    return map[e && e.code] || (e && e.hint) || (e && e.message) || String(e);
  }
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
  // comment with quick picks; resolves to the text or null (cancel)
  function askComment(title, sub, picks, start) {
    return new Promise(function (res) {
      var m = $('cmModal'), t = $('cmText'), chips = $('cmChips');
      $('cmTitle').textContent = title; $('cmSub').textContent = sub || ''; t.value = start || '';
      chips.innerHTML = '';
      (picks || []).forEach(function (p) {
        var b = el('button', p, 'btn-light btn-small'); b.type = 'button'; b.style.fontSize = '11.5px';
        b.onclick = function () { t.value = p; t.focus(); }; chips.appendChild(b);
      });
      function done(v) { m.classList.remove('show'); $('cmYes').onclick = $('cmNo').onclick = $('cmClose').onclick = null; res(v); }
      $('cmYes').onclick = function () { var v = t.value.trim(); if (!v) { t.focus(); return; } done(v); };
      $('cmNo').onclick = $('cmClose').onclick = function () { done(null); };
      m.classList.add('show'); t.focus();
    });
  }
  function fmtDate(s) { if (!s) return '—'; var d = new Date(s); return d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function vno(v) { return v == null ? '' : String(v).padStart(3, '0'); }
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = XLSX_URL; s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('Could not load the Excel library. Check the internet.')); }; document.head.appendChild(s);
    });
  }
  function saveXlsx(name, sheets) {
    return loadXlsx().then(function () {
      var wb = XLSX.utils.book_new();
      sheets.forEach(function (sh) { var ws = XLSX.utils.aoa_to_sheet(sh.rows); if (sh.cols) ws['!cols'] = sh.cols; XLSX.utils.book_append_sheet(wb, ws, sh.name); });
      XLSX.writeFile(wb, name);
    });
  }
  // GP choices = the same as the Account copy tab (admin.js fills them, limited to a GP Admin's own GP)
  function copyGps(dstId) {
    var src = $('phGp'), dst = $(dstId), keep = dst.value;
    dst.innerHTML = src.innerHTML; dst.disabled = src.disabled;
    dst.value = keep || src.value; if (!dst.value) dst.value = src.value;
  }
  function gpOf(id) { return Number($(id).value) || null; }

  // ---------- tabs: admin.js toggles its own tabs; these show/hide themselves ----------
  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () {
      var t = b.dataset.tab;
      $('tab-marks').classList.toggle('hidden', t !== 'marks');
      if (t === 'marks') { copyGps('mkGp'); loadMk(); }
    });
  });

  // ================= Expired / Migrant =================
  $('mkGp').addEventListener('change', loadMk);
  $('mkRefresh').addEventListener('click', loadMk);
  document.querySelectorAll('#mkFilters button').forEach(function (b) {
    b.addEventListener('click', function () { mk.filter = b.dataset.f; loadMk(); });
  });
  $('mkAll').addEventListener('change', function () {
    var on = this.checked; mk.sel.clear(); if (on) mk.rows.forEach(function (r) { mk.sel.add(r.id); }); renderMk();
  });
  function picked() { return mk.rows.filter(function (r) { return mk.sel.has(r.id); }); }
  function mkSet(st, note) {
    var ids = picked().map(function (r) { return r.id; }); if (!ids.length) return;
    loading('Saving...');
    SB.rpc('admin_marks_set', { p_ids: ids, p_status: st, p_note: note || null })
      .then(function (r) { status((r && r.changed || 0) + ' worker(s): ' + MK_ST[st] + '.', 'ok'); }, function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); loadMk(); });
  }
  $('mkAccept').addEventListener('click', function () { mkSet('accepted'); });
  $('mkReturn').addEventListener('click', function () {
    askComment('↩ Return to the supervisor', picked().length + ' worker(s) — the mark is lifted and the supervisor sees your comment.',
      ['The worker is alive and working', 'Still lives in the village', 'Wrong worker marked'], '').then(function (c) { if (c) mkSet('returned', c); });
  });
  $('mkSent').addEventListener('click', function () {
    ask(picked().length + ' worker(s) sent for delete on the portal?', '📤 Sent for delete', 'ok').then(function (y) { if (y) mkSet('sent_delete'); });
  });
  $('mkDeleted').addEventListener('click', function () {
    ask(picked().length + ' worker(s) deleted on the portal?', '🗑 Deleted', 'ok').then(function (y) { if (y) mkSet('deleted'); });
  });
  $('mkXlsx').addEventListener('click', function () {
    var rows = picked(); if (!rows.length) return;
    var gpName = ((($('mkGp').selectedOptions[0] || {}).textContent) || '').replace(/\s*\(.*\)\s*$/, '');
    var aoa = [['SL', 'GP', 'Village', 'Job Card No', 'Applicant No', 'Applicant Name', 'Reason', 'When', 'Note', 'Marked by', 'Marked on', 'Status']];
    rows.forEach(function (r, i) {
      aoa.push([i + 1, gpName, vno(r.village_no), r.job_card_no, r.applicant_no, r.applicant_name,
                (MK_REASON[r.reason] || r.reason).replace(/^\S+\s/, ''), r.when || '', r.note || '', r.marked_by || '',
                r.marked_at ? new Date(r.marked_at).toLocaleDateString('en-GB') : '', MK_ST[r.status] || r.status]);
    });
    saveXlsx('Delete_proposal_' + new Date().toISOString().slice(0, 10) + '.xlsx',
      [{ name: 'Delete', rows: aoa, cols: [{ wch: 4 }, { wch: 16 }, { wch: 7 }, { wch: 26 }, { wch: 6 }, { wch: 26 }, { wch: 20 }, { wch: 12 }, { wch: 30 }, { wch: 16 }, { wch: 11 }, { wch: 14 }] }])
      .then(function () { status('Excel downloaded. After you send it on the portal press "📤 Sent for delete".', 'ok'); }, function (e) { status(e.message || String(e), 'err'); });
  });
  function loadMk() {
    var gp = gpOf('mkGp'); if (!gp) return;
    loading('Loading marks...');
    SB.rpc('admin_marks_list', { p_gp_id: gp, p_filter: mk.filter }).then(function (r) {
      $('mkSetup').textContent = '';
      mk.rows = (r && r.rows) || []; mk.sel.clear(); $('mkAll').checked = false;
      var n = ((r && r.counts) || {}).new || 0; $('mkBadge').textContent = n ? String(n) : ''; $('mkBadge').classList.toggle('hidden', !n);
      renderMk(r && r.counts);
    }, function (e) {
      if (e.authLost) return;
      if (missing(e)) { $('mkSetup').textContent = SETUP; mk.rows = []; renderMk(); return; }
      status(errText(e), 'err');
    }).then(function () { loading(''); });
  }
  function renderMk(counts) {
    document.querySelectorAll('#mkFilters button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.f === mk.filter);
      if (counts && b.dataset.f !== 'all') { b.textContent = MK_ST[b.dataset.f]; var ci = document.createElement('i'); ci.textContent = counts[b.dataset.f] || 0; b.appendChild(ci); }
    });
    var body = $('mkBody'); body.innerHTML = '';
    function btns() { var none = !mk.sel.size; ['mkAccept', 'mkReturn', 'mkXlsx', 'mkSent', 'mkDeleted'].forEach(function (id) { $(id).disabled = none; }); }
    btns();
    if (!mk.rows.length) { var tr0 = el('tr'); var td0 = el('td', 'Nothing here.', 'muted'); td0.colSpan = 6; tr0.appendChild(td0); body.appendChild(tr0); return; }
    mk.rows.forEach(function (r) {
      var tr = el('tr'), td = el('td'), cb = el('input'); cb.type = 'checkbox'; cb.checked = mk.sel.has(r.id);
      cb.onchange = function () { if (cb.checked) mk.sel.add(r.id); else mk.sel.delete(r.id); btns(); };
      td.appendChild(cb); tr.appendChild(td);
      var wk = el('td'); wk.appendChild(el('div', (r.applicant_name || '') + (r.applicant_no != null ? ' (' + r.applicant_no + ')' : ''), 'sr-nm'));
      wk.appendChild(el('div', vno(r.village_no) + ' · ' + (r.job_card_no || ''), 'sr-wm')); tr.appendChild(wk);
      [MK_REASON[r.reason] || r.reason, [r.when, r.note].filter(Boolean).join(' · '), (r.marked_by || '') + ' · ' + fmtDate(r.marked_at)].forEach(function (v) { tr.appendChild(el('td', v == null ? '' : String(v))); });
      var st = el('td'); st.appendChild(el('span', MK_ST[r.status] || r.status, 'pill ' + (r.status === 'returned' ? 'off' : r.status === 'new' ? 'neutral' : 'on')));
      if (r.admin_note) st.appendChild(el('div', r.admin_note, 'muted'));
      tr.appendChild(st);
      body.appendChild(tr);
    });
  }
})();
