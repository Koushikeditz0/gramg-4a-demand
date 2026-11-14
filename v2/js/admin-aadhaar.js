/* =====================================================================
   Admin panel — "🪪 Aadhaar" and "🗑 Expired / Migrant" tabs (SQL v214).
   Supervisors send Aadhaar (card photo + number + Name as per Aadhaar) for
   workers whose Aadhaar is not seeded / not authenticated, and mark workers
   who died / moved away. All checks are in the database (admin_* functions
   use private.require_admin_gp: a GP Admin only reaches their own GP).
   Kept in its own file so admin.js stays as it is.
   ===================================================================== */
(function () {
  'use strict';
  var SB = window.GramgSB;
  function $(id) { return document.getElementById(id); }
  if (!$('tab-aadhaar') || !SB) return;
  var XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

  var aa = { filter: 'sent', rows: [], sel: new Set(), cur: null, imgUrl: null, cleaned: {} };
  var mk = { filter: 'new', rows: [], sel: new Set() };
  var REASONS = ['100-PI: name / number does not match Aadhaar', 'Gender in Aadhaar ≠ Job Card (fix on D1 page)',
                 'Photo not clear — take again', 'Old Aadhaar card — bring a freshly downloaded one',
                 'Aadhaar number wrong', 'Name as per Aadhaar spelt wrong'];
  var MK_REASON = { dead: '✝ Expired', migrant: '🧳 Permanently Migrant', duplicate: '⧉ Duplicate' };
  var MK_ST = { new: 'New', accepted: 'Accepted', sent_delete: 'Sent for delete', returned: 'Returned', deleted: 'Deleted' };
  var AA_ST = { sent: 'New', verified: 'Verified', returned: 'Returned', updated: 'Done on portal', closed: 'Closed', comment: 'Comment', fail: 'Portal failed' };

  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function loading(text) { $('loadingText').textContent = text || 'Loading...'; $('loading').classList.toggle('show', !!text); }
  function status(msg, kind) { var s = $('status'); s.textContent = msg || ''; s.className = 'status' + (msg ? ' show ' + (kind || 'info') : ''); if (msg) window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function missing(e) { return e && (e.status === 404 || /admin_(aadhaar|marks)_/.test(e.message || '')); }
  var SETUP = 'Run supabase/2026-11-14_aadhaar_collection_v214.sql in Supabase → SQL Editor first.';
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
  function spaced(n) { return String(n || '').replace(/(\d{4})(?=\d)/g, '$1 '); }
  function sexText(g) { return g === 'M' ? 'Male' : g === 'F' ? 'Female' : g === 'T' ? 'Other' : '—'; }
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
      $('tab-aadhaar').classList.toggle('hidden', t !== 'aadhaar');
      $('tab-marks').classList.toggle('hidden', t !== 'marks');
      if (t === 'aadhaar') { copyGps('aaGp'); loadAa(true); }
      if (t === 'marks') { copyGps('mkGp'); loadMk(); }
    });
  });

  // ================= Aadhaar =================
  $('aaGp').addEventListener('change', function () { loadAa(true); });
  $('aaRefresh').addEventListener('click', function () { loadAa(true); });
  document.querySelectorAll('#aaFilters button').forEach(function (b) {
    b.addEventListener('click', function () { aa.filter = b.dataset.f; loadAa(false); });
  });
  $('aaAll').addEventListener('change', function () {
    var on = this.checked; aa.sel.clear();
    if (on) aa.rows.forEach(function (r) { if (r.status === 'sent' || r.status === 'verified') aa.sel.add(r.id); });
    renderAa();
  });
  $('aaBulkVerify').addEventListener('click', function () {
    var ids = aa.rows.filter(function (r) { return aa.sel.has(r.id) && r.status === 'sent' && r.aadhaar_no; }).map(function (r) { return r.id; });
    if (!ids.length) { status('Tick New rows that still have the number.', 'err'); return; }
    ask('Verify ' + ids.length + ' Aadhaar? They become ready for K-Desk to enter on the portal.', '✔ Verify', 'ok').then(function (y) { if (y) setAa(ids, 'verified', null); });
  });
  $('aaBulkDone').addEventListener('click', function () {
    var ids = Array.from(aa.sel);
    if (!ids.length) return;
    ask(ids.length + ' Aadhaar entered on the portal yourself? The number is wiped and the photo deleted; the supervisors see "Portal-এ update হয়েছে".', '✅ Portal done', 'ok')
      .then(function (y) { if (y) setAa(ids, 'updated', null); });
  });
  $('aaXlsx').addEventListener('click', function () {
    if (!aa.rows.length) { status('Nothing to download.', 'err'); return; }
    var rows = [['Village', 'Job Card No', 'App', 'Applicant Name', 'Name as per Aadhaar', 'Gender', 'Aadhaar (last 4)', 'Status', 'Comment', 'Sent by', 'Sent at']];
    aa.rows.forEach(function (r) {
      rows.push([vno(r.village_no), r.job_card_no, r.applicant_no, r.applicant_name, r.name_as_aadhaar || '', sexText(r.gender),
                 r.last4 ? 'XXXX XXXX ' + r.last4 : '', AA_ST[r.status] || r.status, r.comment || '', r.sent_by || '', fmtDate(r.sent_at)]);
    });
    saveXlsx('Aadhaar_' + aa.filter + '_' + new Date().toISOString().slice(0, 10) + '.xlsx',
      [{ name: 'Aadhaar', rows: rows, cols: [{ wch: 7 }, { wch: 26 }, { wch: 5 }, { wch: 26 }, { wch: 26 }, { wch: 8 }, { wch: 16 }, { wch: 14 }, { wch: 40 }, { wch: 16 }, { wch: 17 }] }])
      .catch(function (e) { status(e.message || String(e), 'err'); });
  });

  // delete photos that are done / returned / old (R2 through the photo Worker)
  function cleanup(gp) {
    return SB.rpc('admin_aadhaar_cleanup', { p_gp_id: gp }).then(function (rows) {
      rows = rows || [];
      if (!rows.length) return 0;
      var chunks = [];
      for (var i = 0; i < rows.length; i += 100) chunks.push(rows.slice(i, i + 100));
      return chunks.reduce(function (p, c) {
        return p.then(function () {
          return SB.photos.remove(c.map(function (r) { return r.path; }))
            .then(function () { return SB.rpc('admin_aadhaar_purged', { p_ids: c.map(function (r) { return r.id; }) }); });
        });
      }, Promise.resolve()).then(function () { return rows.length; });
    });
  }
  function loadAa(clean) {
    var gp = gpOf('aaGp'); if (!gp) return;
    loading('Loading Aadhaar...');
    (clean ? cleanup(gp).catch(function (e) { if (missing(e)) throw e; }) : Promise.resolve())
      .then(function () { return SB.rpc('admin_aadhaar_list', { p_gp_id: gp, p_filter: aa.filter }); })
      .then(function (r) {
        $('aaSetup').textContent = '';
        aa.rows = (r && r.rows) || []; aa.sel.clear(); $('aaAll').checked = false;
        renderStats(r || {}); renderAa();
      }, function (e) {
        if (e.authLost) return;
        if (missing(e)) { $('aaSetup').textContent = SETUP; aa.rows = []; renderAa(); return; }
        status(errText(e), 'err');
      }).then(function () { loading(''); });
  }
  function renderStats(r) {
    var c = r.counts || {}, box = $('aaStats'); box.innerHTML = '';
    [[r.need, 'Need Aadhaar (all)'], [r.need_seeded, 'Seeded, Auth not done'], [c.sent, 'New from supervisors'],
     [c.verified, 'Verified (for portal)'], [c.fail, 'Portal failed'], [c.updated, 'Done on portal']].forEach(function (x) {
      var s = el('div', null, 'stat'); s.appendChild(el('div', String(x[0] || 0), 'n')); s.appendChild(el('div', x[1], 'l')); box.appendChild(s);
    });
    var n = c.sent || 0; $('aaBadge').textContent = n ? String(n) : ''; $('aaBadge').classList.toggle('hidden', !n);
  }
  function renderAa() {
    document.querySelectorAll('#aaFilters button').forEach(function (b) { b.classList.toggle('active', b.dataset.f === aa.filter); });
    var box = $('aaCards'); box.innerHTML = '';
    $('aaBulkVerify').disabled = $('aaBulkDone').disabled = !aa.sel.size;
    if (!aa.rows.length) { box.appendChild(el('div', 'Nothing here.', 'muted')); return; }
    aa.rows.forEach(function (r) {
      var c = el('div', null, 'phcard');
      var top = el('div', null, 'row'); top.style.justifyContent = 'space-between'; top.style.flexWrap = 'nowrap';
      var nm = el('label', null, 'check'); nm.style.margin = '0';
      var cb = el('input'); cb.type = 'checkbox'; cb.checked = aa.sel.has(r.id);
      cb.disabled = r.status === 'updated' || r.status === 'closed' || r.status === 'returned';
      cb.onchange = function () { if (cb.checked) aa.sel.add(r.id); else aa.sel.delete(r.id); $('aaBulkVerify').disabled = $('aaBulkDone').disabled = !aa.sel.size; };
      nm.appendChild(cb); nm.appendChild(el('span', r.applicant_name || '', 'nm'));
      top.appendChild(nm);
      top.appendChild(el('span', r.status === 'verified' && r.portal_status === 'fail' ? 'Portal failed' : (AA_ST[r.status] || r.status),
        'pill ' + (r.status === 'updated' ? 'on' : r.status === 'returned' || r.portal_status === 'fail' ? 'off' : 'neutral')));
      c.appendChild(top);
      c.appendChild(el('div', 'Village ' + vno(r.village_no) + '  ·  ' + r.job_card_no + '  ·  App ' + r.applicant_no, 'mono'));
      c.appendChild(el('div', (r.seeded ? 'Seeded, Authentication not done' : 'Aadhaar not seeded') + (r.auth ? ' (now Auth Yes)' : ''), 'muted'));
      if (r.name_as_aadhaar || r.last4) {
        var same = String(r.name_as_aadhaar || '').replace(/[^A-Z]/g, '') === String(r.applicant_name || '').toUpperCase().replace(/[^A-Z]/g, '');
        c.appendChild(el('div', 'Aadhaar: ' + (r.aadhaar_no ? spaced(r.aadhaar_no) : 'XXXX XXXX ' + (r.last4 || '')) + '  ·  ' + sexText(r.gender), 'acc mono sent'));
        c.appendChild(el('div', 'Name as per Aadhaar: ' + (r.name_as_aadhaar || '—') + (same ? '' : '  ≠ job card name'), 'acc' + (same ? '' : ' mono')));
      }
      if (r.comment) c.appendChild(el('div', '💬 ' + r.comment, r.status === 'returned' || r.portal_status === 'fail' ? 'acc' : 'muted'));
      c.appendChild(el('div', '🪪 ' + (r.sent_by || '') + '  ·  ' + fmtDate(r.sent_at) + (r.consent ? '  ·  consent ✓' : ''), 'muted'));
      var row = el('div', null, 'row');
      if (r.photo_path) { var v = el('button', '👁 View', 'btn-primary btn-small'); v.onclick = function () { openAa(r); }; row.appendChild(v); }
      if (r.status === 'sent' && r.aadhaar_no) { var ok = el('button', '✔ Verify', 'btn-success btn-small'); ok.onclick = function () { setAa([r.id], 'verified', null); }; row.appendChild(ok); }
      if (r.status === 'sent' || r.status === 'verified') {
        var rt = el('button', '↩ Return', 'btn-danger btn-small'); rt.onclick = function () { returnAa(r); }; row.appendChild(rt);
        var dn = el('button', '✅ Portal done', 'btn-light btn-small'); dn.onclick = function () { doneAa(r); }; row.appendChild(dn);
      }
      if (r.status !== 'closed' && r.status !== 'updated') {
        var cm = el('button', '💬 Comment', 'btn-light btn-small'); cm.onclick = function () { commentAa(r); }; row.appendChild(cm);
      }
      c.appendChild(row);
      box.appendChild(c);
    });
  }
  function setAa(ids, st, comment) {
    loading('Saving...');
    return SB.rpc('admin_aadhaar_set', { p_ids: ids, p_status: st, p_comment: comment })
      .then(function (r) {
        status((r && r.changed || 0) + ' Aadhaar ' + (st === 'verified' ? 'verified — K-Desk can enter them on the portal.' : st === 'returned' ? 'returned to the supervisor.' :
               st === 'updated' ? 'marked done on the portal.' : st === 'comment' ? 'comment saved.' : 'updated.'), 'ok');
        if (aa.cur && ids.indexOf(aa.cur.id) >= 0) closeAa();
      }, function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); return loadAa(st !== 'verified'); });
  }
  function returnAa(r) {
    askComment('↩ Return to the supervisor', r.applicant_name + ' · ' + r.job_card_no + ' — the supervisor sees this comment and sends again. The number is wiped and the photo deleted.',
      REASONS, r.portal_status === 'fail' ? r.portal_note || '' : '').then(function (c) { if (c) setAa([r.id], 'returned', c); });
  }
  function commentAa(r) {
    askComment('💬 Comment', r.applicant_name + ' · ' + r.job_card_no + ' — saved with the request (status stays the same).', REASONS, r.comment || '')
      .then(function (c) { if (c) setAa([r.id], 'comment', c); });
  }
  function doneAa(r) {
    ask('Entered the Aadhaar of ' + (r.applicant_name || '') + ' on the portal yourself?\nThe number is wiped, the photo deleted and the supervisor sees "Portal-এ update হয়েছে".', '✅ Portal done', 'ok')
      .then(function (y) { if (y) setAa([r.id], 'updated', null); });
  }
  function openAa(r) {
    aa.cur = r;
    $('aavTitle').textContent = r.applicant_name || 'Aadhaar';
    $('aavSub').textContent = r.job_card_no + ' · App ' + r.applicant_no + ' · Village ' + vno(r.village_no) + ' · sent ' + fmtDate(r.sent_at) + ' by ' + (r.sent_by || '');
    var info = $('aavInfo'); info.innerHTML = '';
    info.appendChild(el('div', 'Aadhaar No: ' + (r.aadhaar_no ? spaced(r.aadhaar_no) : 'XXXX XXXX ' + (r.last4 || '') + ' (wiped)')));
    info.appendChild(el('div', 'Name as per Aadhaar: ' + (r.name_as_aadhaar || '—') + '   ·   Job card name: ' + (r.applicant_name || '')));
    info.appendChild(el('div', 'Gender (Aadhaar): ' + sexText(r.gender) + '   ·   Consent: ' + (r.consent ? 'yes' : 'no')));
    if (r.comment) info.appendChild(el('div', '💬 ' + r.comment));
    $('aavHist').textContent = (r.history || []).map(function (h) { return fmtDate(h.at) + '  ' + (AA_ST[h.s] || h.s) + (h.by ? ' · ' + h.by : '') + (h.c ? ' · ' + h.c : ''); }).join('\n');
    var btns = $('aavBtns'); btns.innerHTML = '';
    if (r.status === 'sent' && r.aadhaar_no) { var ok = el('button', '✔ Verify', 'btn-success btn-small'); ok.onclick = function () { setAa([r.id], 'verified', null); }; btns.appendChild(ok); }
    if (r.status === 'sent' || r.status === 'verified') {
      var rt = el('button', '↩ Return', 'btn-danger btn-small'); rt.onclick = function () { returnAa(r); }; btns.appendChild(rt);
      var dn = el('button', '✅ Portal done', 'btn-light btn-small'); dn.onclick = function () { doneAa(r); }; btns.appendChild(dn);
    }
    $('aavImg').removeAttribute('src');
    $('aavModal').classList.add('show');
    SB.photos.blob(r.photo_path).then(function (b) {
      if (aa.cur !== r) return;
      if (aa.imgUrl) URL.revokeObjectURL(aa.imgUrl);
      aa.imgUrl = URL.createObjectURL(b); $('aavImg').src = aa.imgUrl;
    }, function (e) { if (!e.authLost) status('Could not open the photo: ' + (e.message || e), 'err'); });
  }
  function closeAa() {
    $('aavModal').classList.remove('show'); $('aavImg').removeAttribute('src'); aa.cur = null;
    if (aa.imgUrl) { URL.revokeObjectURL(aa.imgUrl); aa.imgUrl = null; }
  }
  $('aavClose').addEventListener('click', closeAa);

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
      if (counts && b.dataset.f !== 'all') b.textContent = MK_ST[b.dataset.f] + ' (' + (counts[b.dataset.f] || 0) + ')';
    });
    var body = $('mkBody'); body.innerHTML = '';
    function btns() { var none = !mk.sel.size; ['mkAccept', 'mkReturn', 'mkXlsx', 'mkSent', 'mkDeleted'].forEach(function (id) { $(id).disabled = none; }); }
    btns();
    if (!mk.rows.length) { var tr0 = el('tr'); var td0 = el('td', 'Nothing here.', 'muted'); td0.colSpan = 9; tr0.appendChild(td0); body.appendChild(tr0); return; }
    mk.rows.forEach(function (r) {
      var tr = el('tr'), td = el('td'), cb = el('input'); cb.type = 'checkbox'; cb.checked = mk.sel.has(r.id);
      cb.onchange = function () { if (cb.checked) mk.sel.add(r.id); else mk.sel.delete(r.id); btns(); };
      td.appendChild(cb); tr.appendChild(td);
      [vno(r.village_no), r.job_card_no, r.applicant_no, r.applicant_name, MK_REASON[r.reason] || r.reason,
       [r.when, r.note].filter(Boolean).join(' · '), (r.marked_by || '') + ' · ' + fmtDate(r.marked_at)].forEach(function (v) { tr.appendChild(el('td', v == null ? '' : String(v))); });
      var st = el('td'); st.appendChild(el('span', MK_ST[r.status] || r.status, 'pill ' + (r.status === 'returned' ? 'off' : r.status === 'new' ? 'neutral' : 'on')));
      if (r.admin_note) st.appendChild(el('div', r.admin_note, 'muted'));
      tr.appendChild(st);
      body.appendChild(tr);
    });
  }
})();
