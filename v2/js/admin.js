/* =====================================================================
   G RAM-G 4A v2 — Admin panel (Super Admin only).
   All permissions are enforced by the database (private.require_super_admin);
   this page only drives the workflow.
   ===================================================================== */
(function () {
  'use strict';
  var SB = window.GramgSB, MAP = window.GramgImportMap;
  var XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  var STAGE_CHUNK = 1000;
  var $ = function (id) { return document.getElementById(id); };
  var state = { gps: [], jobId: null, problems: [], counts: null, busy: false };

  // ---------- small UI helpers ----------
  function status(msg, kind) {
    var el = $('status'); el.textContent = msg || ''; el.className = 'status' + (msg ? ' show ' + (kind || 'info') : '');
    if (msg) window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function loading(text) { $('loadingText').textContent = text || 'Loading...'; $('loading').classList.toggle('show', !!text); }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function fmtDate(s) { if (!s) return '—'; var d = new Date(s); return d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function bn(n) { return Number(n || 0).toLocaleString('en-IN'); }
  function errText(e) {
    var map = {
      NOT_AUTHORIZED: 'এই কাজের অনুমতি নেই।', IMPORT_NOT_OPEN: 'এই import আর খোলা নেই। আবার file দিয়ে শুরু করুন।',
      IMPORT_NOT_READY: 'আগে Preview করুন।', NOT_LATEST_IMPORT: 'শুধু সবচেয়ে শেষ import ফেরানো যায়।',
      IMPORT_NOT_COMMITTED: 'এই import আগেই ফেরানো বা বাতিল হয়েছে।', FILE_TOO_LARGE: 'File অনেক বড় (১ লক্ষ row-এর বেশি)।',
      NETWORK: 'Server-এর সঙ্গে যোগাযোগ হয়নি। Internet দেখুন।'
    };
    return map[e.code] || (e.hint ? e.hint : 'Error: ' + (e.message || e));
  }

  SB.onAuthLost = function () { location.replace('./index.html'); };

  // ---------- boot ----------
  function boot() {
    if (!SB.hasSession()) { location.replace('./index.html'); return; }
    loading('Admin panel খুলছে...');
    SB.rpc('register_session', { p_user_agent: String(navigator.userAgent).slice(0, 300) })
      .then(function () { return SB.rpc('get_my_context'); })
      .then(function (ctx) {
        if (ctx.role !== 'super_admin') { location.replace('./index.html'); return; }
        $('who').textContent = ctx.full_name || ctx.username;
        return loadGps().then(loadHistory).then(loadUsers);
      })
      .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  }

  function loadGps() {
    return SB.rpc('admin_list_gps').then(function (gps) {
      state.gps = gps || [];
      [$('gpSelect'), $('linkGp')].forEach(function (sel) {
        var keep = sel.value; sel.innerHTML = '';
        state.gps.forEach(function (g) { var o = el('option', g.name + ' (' + g.jc_prefix + ')'); o.value = g.id; sel.appendChild(o); });
        if (keep) sel.value = keep;
      });
      showGpStats();
    });
  }
  function showGpStats() {
    var g = state.gps.filter(function (x) { return String(x.id) === $('gpSelect').value; })[0];
    $('gpStats').textContent = g ? 'এখন database-এ: ' + bn(g.workers) + ' জন worker (' + bn(g.active_workers) + ' active), ' + bn(g.accounts) + ' জনের account' : '';
  }

  // ---------- tabs ----------
  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('active', x === b); });
      ['import', 'history', 'users'].forEach(function (t) { $('tab-' + t).classList.toggle('hidden', t !== b.dataset.tab); });
      if (b.dataset.tab === 'history') loadHistory();
      if (b.dataset.tab === 'users') loadUsers();
    });
  });

  // ---------- file reading ----------
  var xlsxLoading = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    if (!xlsxLoading) xlsxLoading = new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = XLSX_URL; s.onload = res;
      s.onerror = function () { xlsxLoading = null; rej(new Error('Excel library load হয়নি। Internet দেখুন।')); };
      document.head.appendChild(s);
    });
    return xlsxLoading;
  }
  function readFile(file) {
    var isCsv = /\.csv$/i.test(file.name);
    return loadXlsx().then(function () {
      return isCsv ? file.text() : file.arrayBuffer();
    }).then(function (data) {
      // CSV is read as plain text so long account numbers never turn into numbers
      var wb = isCsv ? XLSX.read(String(data).replace(/^﻿/, ''), { type: 'string', raw: true })
                     : XLSX.read(data, { type: 'array', cellText: true, cellDates: false });
      for (var s = 0; s < wb.SheetNames.length; s++) {
        var aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[s]], { header: 1, raw: false, defval: '' });
        for (var h = 0; h < Math.min(10, aoa.length); h++) {        // header may not be on row 1
          var m = MAP.mapHeaders(aoa[h]);
          if (!m.missing.length) return { sheet: wb.SheetNames[s], headerRow: h, aoa: aoa, mapping: m };
        }
      }
      throw new Error('File-এ "Job Card No" আর "Applicant No" column পাওয়া যায়নি।');
    });
  }
  function sha256(file) {
    if (!window.crypto || !crypto.subtle) return Promise.resolve(null);
    return file.arrayBuffer().then(function (b) { return crypto.subtle.digest('SHA-256', b); }).then(function (h) {
      return Array.prototype.map.call(new Uint8Array(h), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    }).catch(function () { return null; });
  }
  function progress(frac, text) {
    $('progress').classList.toggle('hidden', frac == null);
    $('progress').firstElementChild.style.width = Math.round((frac || 0) * 100) + '%';
    $('progressText').textContent = text || '';
  }

  // ---------- preview ----------
  $('fileInput').addEventListener('change', function () { $('previewBtn').disabled = !this.files.length; $('previewCard').classList.add('hidden'); });
  $('gpSelect').addEventListener('change', showGpStats);

  $('previewBtn').addEventListener('click', function () {
    var file = $('fileInput').files[0];
    if (!file || state.busy) return;
    state.busy = true; $('previewBtn').disabled = true; status('');
    $('previewCard').classList.add('hidden');
    var parsed, rows;
    progress(0.02, 'File পড়া হচ্ছে...');
    readFile(file).then(function (p) {
      parsed = p;
      rows = MAP.toRaw(p.aoa.slice(p.headerRow + 1), p.mapping.map, p.headerRow + 2);
      if (!rows.length) throw new Error('File-এ কোনো data row নেই।');
      return sha256(file);
    }).then(function (hash) {
      return SB.rpc('admin_create_import', { p_gp_id: Number($('gpSelect').value), p_file_name: file.name,
                                             p_file_sha256: hash, p_deactivate_missing: $('deactivateMissing').checked });
    }).then(function (jobId) {
      state.jobId = jobId;
      var i = 0;
      function next() {
        if (i >= rows.length) return Promise.resolve();
        var part = rows.slice(i, i + STAGE_CHUNK);
        return SB.rpc('admin_stage_rows', { p_job_id: jobId, p_rows: part }, { retry: true }).then(function () {
          i += part.length;
          progress(0.05 + 0.75 * i / rows.length, bn(i) + ' / ' + bn(rows.length) + ' row পাঠানো হয়েছে...');
          return next();
        });
      }
      return next();
    }).then(function () {
      progress(0.85, 'যাচাই হচ্ছে (নতুন / পরিবর্তিত / duplicate)...');
      return SB.rpc('admin_classify_import', { p_job_id: state.jobId });
    }).then(function (res) {
      progress(null);
      state.counts = res.counts; state.problems = res.problems || [];
      renderPreview(parsed, res.counts, state.problems);
    }).catch(function (e) {
      progress(null);
      if (!e.authLost) status(e.code ? errText(e) : (e.message || String(e)), 'err');
    }).then(function () { state.busy = false; $('previewBtn').disabled = !$('fileInput').files.length; });
  });

  function renderPreview(parsed, c, problems) {
    var info = $('mappingInfo'); info.innerHTML = '';
    info.appendChild(el('div', 'Sheet: ' + parsed.sheet + ' · Header row: ' + (parsed.headerRow + 1)));
    var chips = el('div', null, 'chips');
    parsed.mapping.found.forEach(function (k) { chips.appendChild(el('span', '✓ ' + MAP.LABELS[k], 'chip')); });
    parsed.mapping.ignored.forEach(function (h) { chips.appendChild(el('span', h, 'chip ign')); });
    info.appendChild(chips);
    if (parsed.mapping.ignored.length) info.appendChild(el('div', parsed.mapping.ignored.length + 'টা column নেওয়া হয়নি (কাটা দাগ দেওয়া)।'));

    var S = $('stats'); S.innerHTML = '';
    function stat(n, label, cls) { var d = el('div', null, 'stat ' + (cls || '')); d.appendChild(el('div', bn(n), 'n')); d.appendChild(el('div', label, 'l')); S.appendChild(d); }
    stat(c.total_rows, 'File-এ মোট row');
    stat(c.workers_in_file, 'আলাদা worker');
    stat(c.new, 'নতুন worker', 'good');
    stat(c.updated, 'তথ্য পরিবর্তিত', c.updated ? 'warn' : '');
    stat(c.unchanged, 'অপরিবর্তিত');
    stat(c.with_account, 'Account সহ');
    stat(c.merged_repeats, 'একই worker-এর পুনরাবৃত্ত row (মেলানো হয়েছে)');
    stat(c.conflicting_repeats + c.invalid, 'বাদ পড়বে (ভুল/অমিল)', (c.conflicting_repeats + c.invalid) ? 'bad' : '');
    stat(c.account_warnings, 'Account বাদ (ভুল Account/IFSC)', c.account_warnings ? 'warn' : '');
    stat(c.missing_from_file, c.deactivate_missing ? 'File-এ নেই → inactive হবে' : 'File-এ নেই (কিছু হবে না)', c.deactivate_missing && c.missing_from_file ? 'bad' : '');

    var tb = $('problems'); tb.innerHTML = '';
    problems.forEach(function (p) {
      var tr = document.createElement('tr');
      tr.appendChild(el('td', p.row_no)); tr.appendChild(el('td', p.job_card_no || ''));
      tr.appendChild(el('td', p.applicant_no || ''));
      tr.appendChild(el('td', p.error || p.warning || ''));
      if (p.error) tr.style.color = '#991b1b';
      tb.appendChild(tr);
    });
    $('problemsBox').classList.toggle('hidden', !problems.length);
    $('commitBtn').disabled = !(c.new + c.updated + (c.deactivate_missing ? c.missing_from_file : 0));
    $('commitBtn').textContent = $('commitBtn').disabled ? 'কোনো পরিবর্তন নেই' : '✅ Confirm Import';
    $('previewCard').classList.remove('hidden');
    $('previewCard').scrollIntoView({ behavior: 'smooth' });
  }

  $('problemsCsvBtn').addEventListener('click', function () {
    var esc = function (v) { v = String(v == null ? '' : v); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
    var lines = ['Row,Job Card No,Applicant No,Problem'].concat(state.problems.map(function (p) {
      return [p.row_no, p.job_card_no, p.applicant_no, p.error || p.warning].map(esc).join(',');
    }));
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'import_problems_' + state.jobId + '.csv';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  });

  $('commitBtn').addEventListener('click', function () {
    var c = state.counts; if (!c || state.busy) return;
    var msg = 'Import নিশ্চিত করবেন?\n\nনতুন: ' + bn(c.new) + '\nপরিবর্তিত: ' + bn(c.updated) +
              (c.deactivate_missing ? '\nInactive হবে: ' + bn(c.missing_from_file) : '') +
              '\nবাদ পড়বে: ' + bn(c.invalid + c.conflicting_repeats) + '\n\nভুল হলে Import History থেকে ফেরানো যাবে।';
    if (!confirm(msg)) return;
    state.busy = true; loading('Import হচ্ছে... (বন্ধ করবেন না)');
    SB.rpc('admin_commit_import', { p_job_id: state.jobId }).then(function (r) {
      status('✅ Import সম্পন্ন: নতুন ' + bn(r.new) + ', পরিবর্তিত ' + bn(r.updated) + ', account ' + bn(r.accounts) +
             (r.deactivated ? ', inactive ' + bn(r.deactivated) : '') + '।', 'ok');
      $('previewCard').classList.add('hidden'); $('fileInput').value = ''; $('previewBtn').disabled = true; state.jobId = null;
      return loadGps().then(loadHistory);
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { state.busy = false; loading(''); });
  });

  $('cancelBtn').addEventListener('click', function () {
    if (!state.jobId) return;
    SB.rpc('admin_cancel_import', { p_job_id: state.jobId }).catch(function () {});
    state.jobId = null; $('previewCard').classList.add('hidden'); status('Import বাতিল করা হয়েছে। কিছু পরিবর্তন হয়নি।', 'info');
  });

  // ---------- history ----------
  function loadHistory() {
    var gp = Number($('gpSelect').value); if (!gp) return Promise.resolve();
    return SB.rpc('admin_import_history', { p_gp_id: gp }).then(function (rows) {
      var tb = $('history'); tb.innerHTML = '';
      var label = { committed: 'সম্পন্ন', staged: 'Preview-তে', rolled_back: 'ফেরানো হয়েছে', failed: 'ব্যর্থ' };
      if (!rows.length) { var tr0 = document.createElement('tr'); var td0 = el('td', 'এখনো কোনো import হয়নি।'); td0.colSpan = 9; tr0.appendChild(td0); tb.appendChild(tr0); }
      rows.forEach(function (j) {
        var c = j.counts || {}, tr = document.createElement('tr');
        [fmtDate(j.committed_at || j.created_at), j.file_name].forEach(function (v) { tr.appendChild(el('td', v)); });
        var st = el('td'); st.appendChild(el('span', label[j.status] || j.status, 'pill ' + (j.status === 'committed' ? 'on' : 'neutral'))); tr.appendChild(st);
        [c.committed_new, c.committed_updated, c.committed_accounts, c.committed_deactivated].forEach(function (v) { tr.appendChild(el('td', v == null ? '—' : bn(v))); });
        tr.appendChild(el('td', j.created_by || ''));
        var act = el('td');
        if (j.can_rollback) {
          var b = el('button', '↩ Rollback', 'btn-danger btn-small');
          b.addEventListener('click', function () {
            if (!confirm('এই import ফেরাবেন? এর আগের অবস্থায় data ফিরে যাবে।')) return;
            loading('Rollback হচ্ছে...');
            SB.rpc('admin_rollback_import', { p_job_id: j.id }).then(function (r) {
              status('↩ Rollback সম্পন্ন: ' + bn(r.restored) + ' জনের তথ্য ফেরানো, ' + bn(r.deleted_new) + ' জন নতুন worker মোছা' +
                     (r.deactivated_new_in_lists ? ', ' + bn(r.deactivated_new_in_lists) + ' জন (list-এ থাকায়) inactive' : '') + '।', 'ok');
              return loadGps().then(loadHistory);
            }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); }).then(function () { loading(''); });
          });
          act.appendChild(b);
        }
        tr.appendChild(act);
        tb.appendChild(tr);
      });
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
  }

  // ---------- users ----------
  function loadUsers() {
    return SB.rpc('admin_list_users').then(function (users) {
      var tb = $('users'); tb.innerHTML = '';
      users.forEach(function (u) {
        var tr = document.createElement('tr');
        tr.appendChild(el('td', u.username)); tr.appendChild(el('td', u.full_name));
        tr.appendChild(el('td', u.role === 'super_admin' ? 'Super Admin' : (u.gp_name || '')));
        var st = el('td'); st.appendChild(el('span', u.active ? 'চালু' : 'বন্ধ', 'pill ' + (u.active ? 'on' : 'off'))); tr.appendChild(st);
        tr.appendChild(el('td', String(u.active_devices)));
        tr.appendChild(el('td', fmtDate(u.last_seen)));
        var act = el('td');
        if (u.role !== 'super_admin') {
          var t = el('button', u.active ? 'বন্ধ করুন' : 'চালু করুন', (u.active ? 'btn-danger' : 'btn-success') + ' btn-small');
          t.addEventListener('click', function () {
            if (u.active && !confirm(u.username + '-এর account বন্ধ করবেন? সব device থেকে সঙ্গে সঙ্গে logout হবে।')) return;
            SB.rpc('admin_set_user_active', { p_user_id: u.user_id, p_active: !u.active })
              .then(function () { status(u.username + ' ' + (u.active ? 'বন্ধ' : 'চালু') + ' করা হয়েছে।', 'ok'); return loadUsers(); })
              .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
          });
          act.appendChild(t);
          if (u.active_devices > 0) {
            var lo = el('button', 'সব device logout', 'btn-light btn-small'); lo.style.marginLeft = '4px';
            lo.addEventListener('click', function () {
              SB.rpc('admin_logout_user_everywhere', { p_user_id: u.user_id })
                .then(function (r) { status(u.username + ': ' + r.sessions_revoked + 'টা device logout করা হয়েছে।', 'ok'); return loadUsers(); })
                .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
            });
            act.appendChild(lo);
          }
        }
        tr.appendChild(act);
        tb.appendChild(tr);
      });
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
  }

  $('refreshUnlinked').addEventListener('click', function () {
    SB.rpc('admin_unlinked_auth_users').then(function (list) {
      var sel = $('linkUser'); sel.innerHTML = '';
      if (!list.length) { $('unlinkedBox').textContent = 'Profile ছাড়া কোনো নতুন user নেই। আগে Supabase-এ user তৈরি করুন।'; $('linkForm').classList.add('hidden'); return; }
      $('unlinkedBox').textContent = list.length + ' জন নতুন user পাওয়া গেছে।';
      list.forEach(function (u) { var o = el('option', u.email); o.value = u.user_id; o.dataset.email = u.email; sel.appendChild(o); });
      $('linkForm').classList.remove('hidden'); fillUsername();
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
  });
  function fillUsername() {
    var o = $('linkUser').selectedOptions[0]; var email = o ? o.dataset.email : '';
    var m = /^([a-z0-9_.-]{3,32})@users\.gramg\.invalid$/i.exec(email || '');
    $('linkUsername').value = m ? m[1].toLowerCase() : '';
    $('linkBtn').disabled = !m;
    $('unlinkedBox').textContent = m ? '' : 'এই email-এর format ঠিক নয়: হতে হবে username@users.gramg.invalid';
  }
  $('linkUser').addEventListener('change', fillUsername);
  $('linkRole').addEventListener('change', function () { $('linkGp').disabled = this.value !== 'gp_user'; });
  $('linkBtn').addEventListener('click', function () {
    var name = $('linkName').value.trim();
    if (!name) { status('পুরো নাম লিখুন।', 'err'); return; }
    SB.rpc('admin_link_profile', { p_user_id: $('linkUser').value, p_username: $('linkUsername').value, p_full_name: name,
                                    p_role: $('linkRole').value, p_gp_id: Number($('linkGp').value) })
      .then(function () {
        status('✅ ' + $('linkUsername').value + '-এর profile যোগ হয়েছে। এখন সে Login করতে পারবে।', 'ok');
        $('linkName').value = ''; $('linkForm').classList.add('hidden'); $('unlinkedBox').textContent = '';
        return loadUsers();
      }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
  });

  $('logoutBtn').addEventListener('click', function () {
    SB.signOut().then(function () { location.replace('./index.html'); });
  });

  boot();
})();
