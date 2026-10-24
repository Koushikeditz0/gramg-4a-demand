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
      NETWORK: 'Server-এর সঙ্গে যোগাযোগ হয়নি। Internet দেখুন।',
      LIST_NOT_FOUND: 'List পাওয়া যায়নি (হয়তো নতুন দফা শুরু হয়েছে)। Refresh করুন।',
      LIST_NOT_LOCKED: 'নতুন দফা শুরু করার আগে list Lock করুন।',
      LIST_LOCKED: 'List lock করা আছে।',
      BAD_PREFIX: 'Job Card prefix ঠিক নয়। যেমন: WB-08-005-014 (প্রথম ১৩ অক্ষর)।',
      GP_EXISTS: 'এই prefix-এর GP আগে থেকেই আছে।',
      NEED_WORK_NAME: 'Work Name লিখুন।',
      BAD_USERNAME: 'Username ঠিক নয়: ৩–৩২ অক্ষর, শুধু ছোট হাতের ইংরেজি অক্ষর, সংখ্যা, _ . -',
      BAD_NAME: 'পুরো নাম লিখুন (১০০ অক্ষরের মধ্যে)।', BAD_GP: 'GP বেছে নিন।',
      PIN_FORMAT: 'PIN ৬ থেকে ১২ সংখ্যার হতে হবে, শুধু অঙ্ক।',
      WEAK_PIN: 'PIN খুব সহজ (যেমন 111111 বা 123456)। অন্য PIN দিন।',
      USERNAME_TAKEN: 'এই username আগে থেকেই আছে। অন্য username দিন।',
      USER_NOT_FOUND: 'User পাওয়া যায়নি।', ONLY_SUPERVISORS: 'এখান থেকে শুধু supervisor-এর PIN বদলানো যায়।',
      AUTH_ERROR: 'Supabase Auth-এ সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।',
      SERVER_NOT_CONFIGURED: 'Edge Function-এর সেটিং ঠিক নেই (key পাওয়া যায়নি)।',
      FUNCTION_JWT_SETTING: 'Edge Function-এ "Verify JWT" চালু আছে। Supabase → Edge Functions → admin-users → সেটিং থেকে সেটা বন্ধ করুন (নির্দেশিকা দেখুন)।',
      FUNCTION_UNREACHABLE: 'Edge Function-এ পৌঁছানো যায়নি। Internet দেখুন; তারপর দেখুন "admin-users" deploy হয়েছে আর "Verify JWT" বন্ধ আছে কি না।',
      FUNCTION_NOT_DEPLOYED: '"admin-users" Edge Function এখনো deploy করা হয়নি। নির্দেশিকা দেখে deploy করুন, অথবা পুরনো পদ্ধতি ব্যবহার করুন।'
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
        return loadGps().then(loadDashboard).then(loadHistory).then(loadUsers);
      })
      .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  }

  function loadGps() {
    return SB.rpc('admin_list_gps').then(function (gps) {
      state.gps = gps || [];
      [$('gpSelect'), $('linkGp'), $('dashGp'), $('nuGp')].forEach(function (sel) {
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
      ['dash', 'import', 'history', 'users'].forEach(function (t) { $('tab-' + t).classList.toggle('hidden', t !== b.dataset.tab); });
      if (b.dataset.tab === 'dash') loadDashboard();
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
      return SB.rpc('admin_classify_import', { p_job_id: state.jobId }, { timeout: 180000 });
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
    SB.rpc('admin_commit_import', { p_job_id: state.jobId }, { timeout: 180000 }).then(function (r) {
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
            SB.rpc('admin_rollback_import', { p_job_id: j.id }, { timeout: 180000 }).then(function (r) {
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
        tr.appendChild(el('td', u.role === 'super_admin' ? 'Super Admin' : (u.gp_name || '') + (u.role === 'kdesk' ? ' · 🖥 K-Desk login' : '')));
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
          var pb = el('button', '🔑 PIN', 'btn-light btn-small'); pb.style.marginLeft = '4px';
          pb.addEventListener('click', function () { openPinModal(u); });
          act.appendChild(pb);
          // K-Desk Suite login: may only read this GP's submitted lists and lock them (database: kdesk_*).
          var kb = el('button', u.role === 'kdesk' ? '↩ Supervisor করুন' : '🖥 K-Desk login করুন', 'btn-light btn-small'); kb.style.marginLeft = '4px';
          kb.addEventListener('click', function () {
            var to = u.role === 'kdesk' ? 'gp_user' : 'kdesk';
            var q = to === 'kdesk'
              ? u.username + '-কে K-Desk login বানাবেন? এটা দিয়ে আর ফোনের app-এ list বানানো যাবে না, শুধু K-Desk extension জমা পড়া list আনতে আর lock করতে পারবে। সব device থেকে logout হবে।'
              : u.username + '-কে আবার Supervisor বানাবেন? K-Desk আর এটা দিয়ে list আনতে পারবে না।';
            if (!confirm(q)) return;
            SB.rpc('admin_set_user_role', { p_user_id: u.user_id, p_role: to })
              .then(function () { status(u.username + (to === 'kdesk' ? ' এখন K-Desk login।' : ' এখন Supervisor।'), 'ok'); return loadUsers(); })
              .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
          });
          act.appendChild(kb);
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

  // ---------- dashboard (one card per supervisor, one sub-card per list/work) ----------
  var dash = { users: [], rows: [], dups: [], filter: 'all', picked: new Set(), loading: false };
  var STATE_BN = { draft: 'খসড়া', submitted: 'জমা দিয়েছে', locked: 'Lock করা', empty: 'list নেই' };
  function rowState(r) { return !r.list_id ? 'empty' : r.submit_state; }
  function vno(v) { return String(v).padStart(3, '0'); }
  function reqSup(n) { return Math.max(1, Math.floor((Number(n) || 0) / 20)); }

  function loadDashboard() {
    var gp = Number($('dashGp').value);
    if (!gp || dash.loading) return Promise.resolve();
    dash.loading = true;
    return Promise.all([
      SB.rpc('admin_dashboard', { p_gp_id: gp }, { retry: true }),
      SB.rpc('admin_list_duplicates', { p_gp_id: gp }, { retry: true })
    ]).then(function (res) {
      dash.users = res[0] || []; dash.dups = res[1] || [];
      dash.rows = [];
      dash.users.forEach(function (u) {
        (u.lists || []).forEach(function (l) {
          var r = Object.assign({}, l); r.user_id = u.user_id; r.username = u.username; r.full_name = u.full_name; r.user_active = u.active;
          dash.rows.push(r);
        });
      });
      var ids = new Set(dash.rows.map(function (r) { return r.list_id; }));
      dash.picked.forEach(function (id) { if (!ids.has(id)) dash.picked.delete(id); });
      renderDashboard();
      $('dashUpdated').textContent = 'শেষ update: ' + fmtDate(new Date().toISOString());
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { dash.loading = false; });
  }

  function renderDashboard() {
    var S = $('dashStats'); S.innerHTML = '';
    var c = { submitted: 0, draft: 0, locked: 0, short: 0 };
    dash.rows.forEach(function (r) { c[r.submit_state]++; if ((r.supervisors || []).length < reqSup(r.workers)) c.short++; });
    var noList = dash.users.filter(function (u) { return !(u.lists || []).length; }).length;
    function stat(n, label, cls) { var d = el('div', null, 'stat ' + (cls || '')); d.appendChild(el('div', bn(n), 'n')); d.appendChild(el('div', label, 'l')); S.appendChild(d); }
    stat(dash.users.length, 'মোট supervisor'); stat(dash.rows.length, 'চলতি list (কাজ)');
    stat(c.submitted, 'জমা দিয়েছে', 'good'); stat(c.draft, 'খসড়া (জমা দেয়নি)', 'warn'); stat(c.locked, 'Lock করা');
    stat(noList, 'list নেই'); stat(c.short, 'Supervisor-এর নাম কম', c.short ? 'bad' : '');
    if (dash.dups.length) stat(dash.dups.length, 'দুই list-এ একই worker (পুরনো)', 'bad');

    var D = $('dupBox'); D.innerHTML = '';
    D.classList.toggle('hidden', !dash.dups.length);
    if (dash.dups.length) {
      var det = el('details', null, 'dups'); det.appendChild(el('summary', '⚠ ' + dash.dups.length + ' জন worker একাধিক list-এ আছেন (নতুন নিয়মের আগের) — দেখুন'));
      var wrap = el('div', null, 'table-wrap'); wrap.style.marginTop = '6px';
      var t = el('table'); var th = el('tr');
      ['Job Card No', 'App', 'নাম', 'কার কার list-এ'].forEach(function (h) { th.appendChild(el('th', h)); });
      var thead = el('thead'); thead.appendChild(th); t.appendChild(thead);
      var tb = el('tbody');
      dash.dups.forEach(function (d) {
        var tr = el('tr');
        [d.job_card_no, d.applicant_no, d.applicant_name, (d.usernames || []).join(', ')].forEach(function (v) { tr.appendChild(el('td', String(v))); });
        tb.appendChild(tr);
      });
      t.appendChild(tb); wrap.appendChild(t); det.appendChild(wrap); D.appendChild(det);
    }

    document.querySelectorAll('#dashFilters button').forEach(function (b) { b.classList.toggle('active', b.dataset.f === dash.filter); });
    var C = $('dashCards'); C.innerHTML = '';
    var shown = 0;
    dash.users.forEach(function (u) {
      var lists = (u.lists || []).filter(function (l) { return dash.filter === 'all' || l.submit_state === dash.filter; });
      if (dash.filter === 'empty' ? (u.lists || []).length : (dash.filter !== 'all' && !lists.length)) return;
      C.appendChild(userCard(u, lists)); shown++;
    });
    if (!shown) C.appendChild(el('div', dash.users.length ? 'এই ভাগে কিছু নেই।' : 'এই GP-তে এখনো কোনো supervisor নেই। Users tab থেকে যোগ করুন।', 'card muted'));
    updateExportSummary();
  }

  function userCard(u, lists) {
    var card = el('div', null, 'ucard');
    var top = el('div', null, 'top');
    var who = el('div'); who.appendChild(el('div', u.full_name || u.username, 'nm')); who.appendChild(el('div', '@' + u.username + (u.active ? '' : ' · বন্ধ'), 'un'));
    var pills = el('div'); pills.style.textAlign = 'right';
    pills.appendChild(el('span', (u.lists || []).length + 'টা list', 'pill neutral'));
    if (!u.active) { pills.appendChild(document.createTextNode(' ')); pills.appendChild(el('span', 'User বন্ধ', 'pill off')); }
    top.appendChild(who); top.appendChild(pills); card.appendChild(top);
    card.appendChild(el('div', 'Device: ' + u.active_devices + ' চালু · শেষ login ' + fmtDate(u.last_seen), 'meta'));
    if (!(u.lists || []).length) card.appendChild(el('div', 'কোনো চলতি list নেই।', 'muted'));
    lists.forEach(function (l) {
      var r = dash.rows.filter(function (x) { return x.list_id === l.list_id; })[0];
      card.appendChild(listCard(r));
    });
    var acts = el('div', null, 'acts');
    function act(label, cls, fn) { var b = el('button', label, cls + ' btn-small'); b.addEventListener('click', fn); acts.appendChild(b); return b; }
    act('🔑 PIN', 'btn-light', function () { openPinModal(u); });
    act(u.active ? 'User বন্ধ' : 'User চালু', u.active ? 'btn-danger' : 'btn-success', function () {
      if (u.active && !confirm(u.username + '-এর account বন্ধ করবেন? সব device থেকে সঙ্গে সঙ্গে logout হবে।')) return;
      SB.rpc('admin_set_user_active', { p_user_id: u.user_id, p_active: !u.active })
        .then(function () { status(u.username + ' ' + (u.active ? 'বন্ধ' : 'চালু') + ' করা হয়েছে।', 'ok'); return loadDashboard(); })
        .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
    });
    card.appendChild(acts);
    return card;
  }

  function listCard(r) {
    var st = r.submit_state, n = Number(r.workers || 0), sups = r.supervisors || [], need = reqSup(n);
    var box = el('div', null, 'lcard' + (dash.picked.has(r.list_id) ? ' sel' : ''));
    box.dataset.list = r.list_id;
    var head = el('div', null, 'lhead');
    head.appendChild(el('div', r.work_name || '(Work Name নেই)', 'lname'));
    head.appendChild(el('span', STATE_BN[st], 'pill ' + st));
    box.appendChild(head);
    var meta = el('div', null, 'meta');
    function line(label, value, cls) { var d = el('div', null, cls || ''); d.appendChild(el('b', label + ': ')); d.appendChild(document.createTextNode(value)); meta.appendChild(d); }
    line('Worker', bn(n) + ' জন' + (r.villages && r.villages.length ? ' · গ্রাম ' + r.villages.map(vno).join(', ') : ''));
    line('Supervisor', (sups.length ? sups.join(', ') : '—') + (sups.length < need ? '  ⚠ ' + need + ' জন লাগবে' : ''), sups.length < need ? 'warnline' : '');
    if (r.submitted_at) line('জমা', fmtDate(r.submitted_at));
    if (r.exported_at) line('Export', fmtDate(r.exported_at) + (r.export_count > 1 ? ' (' + r.export_count + ' বার)' : ''));
    box.appendChild(meta);
    if (n > 0) {
      var pick = el('label', null, 'pick'); var cb = document.createElement('input'); cb.type = 'checkbox';
      cb.checked = dash.picked.has(r.list_id); cb.dataset.list = r.list_id;
      cb.addEventListener('change', function () {
        if (cb.checked) dash.picked.add(r.list_id); else dash.picked.delete(r.list_id);
        box.classList.toggle('sel', cb.checked); updateExportSummary();
      });
      pick.appendChild(cb); pick.appendChild(document.createTextNode('K-Desk export-এ নিন')); box.appendChild(pick);
    }
    var acts = el('div', null, 'acts');
    function act(label, cls, fn) { var b = el('button', label, cls + ' btn-small'); b.addEventListener('click', fn); acts.appendChild(b); return b; }
    act('👁 দেখুন', 'btn-primary', function () { openPreview(r); });
    if ((st === 'submitted' || st === 'draft') && n > 0) act('🔒 Lock', 'btn-light', function () { listAction(r, 'lock'); });
    if (st === 'submitted' || st === 'locked') act('↩ ফেরত দিন', 'btn-light', function () {
      if (confirm('"' + r.work_name + '" (' + r.username + ') আবার খসড়া করবেন? Supervisor তখন বদলাতে পারবেন।')) listAction(r, 'reopen');
    });
    if (st === 'locked') act('✔ কাজ শেষ', 'btn-success', function () {
      if (confirm('"' + r.work_name + '" (' + r.username + ') — কাজ শেষ?\nList বন্ধ হবে (history-তে থাকবে), আর এর ' + n + ' জন worker আবার নতুন কাজে বাছাইযোগ্য হবেন।')) listAction(r, 'complete');
    });
    if (Number(r.submissions)) act('🕘 আগের জমা (' + r.submissions + ')', 'btn-light', function () { openSubmissions(r); });
    box.appendChild(acts);
    return box;
  }

  function listAction(r, action) {
    loading('অপেক্ষা করুন...');
    return SB.rpc('admin_set_list_state', { p_list_id: r.list_id, p_action: action })
      .then(function () {
        var msg = { lock: 'lock করা হয়েছে।', reopen: 'আবার খসড়া করা হয়েছে।', complete: 'কাজ শেষ — list বন্ধ হয়েছে, worker-রা আবার বাছাইযোগ্য।' }[action];
        status('"' + r.work_name + '" (' + r.username + '): ' + msg, 'ok');
        if (action === 'complete') dash.picked.delete(r.list_id);
        return loadDashboard();
      }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  }

  function pickedRows() { return dash.rows.filter(function (r) { return dash.picked.has(r.list_id); }); }
  function updateExportSummary() {
    var rows = pickedRows(), n = 0, notSub = 0;
    rows.forEach(function (r) { n += Number(r.workers || 0); if (r.submit_state === 'draft') notSub++; });
    var works = {}; rows.forEach(function (r) { works[(r.work_name || '').toLowerCase()] = true; });
    $('expSummary').textContent = rows.length
      ? rows.length + 'টা list বাছা হয়েছে (' + rows.map(function (r) { return (r.work_name || '—') + ' / ' + r.username; }).join(', ') + '), মোট ' + bn(n) + ' জন worker।' +
        (notSub ? ' ⚠ ' + notSub + 'টা list এখনো জমা দেওয়া হয়নি।' : '') +
        (Object.keys(works).length > 1 ? ' ⚠ আলাদা আলাদা কাজের list একসঙ্গে বাছা হয়েছে — একটা file-এ একটাই Work code থাকবে।' : '')
      : 'কোনো list বাছা হয়নি।';
    $('expBtn').disabled = !rows.length;
  }

  $('dashGp').addEventListener('change', function () { dash.picked.clear(); loadDashboard(); });
  $('dashRefresh').addEventListener('click', loadDashboard);
  document.querySelectorAll('#dashFilters button').forEach(function (b) {
    b.addEventListener('click', function () { dash.filter = b.dataset.f; renderDashboard(); });
  });
  $('pickSubmitted').addEventListener('click', function () {
    dash.rows.forEach(function (r) { if (Number(r.workers) && r.submit_state === 'submitted') dash.picked.add(r.list_id); });
    renderDashboard();
  });
  $('pickNone').addEventListener('click', function () { dash.picked.clear(); renderDashboard(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !$('tab-dash').classList.contains('hidden')) loadDashboard();
  });
  (function () { var d = new Date(); $('expFrom').value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();

  // ---------- submitted copies ----------
  function openSubmissions(r) {
    loading('আগের জমা খুলছে...');
    SB.rpc('admin_list_submissions', { p_list_id: r.list_id }).then(function (subs) {
      $('subTitle').textContent = 'আগের জমা — ' + (r.work_name || '') + ' (@' + r.username + ')';
      var box = $('subBody'); box.innerHTML = '';
      (subs || []).forEach(function (s, i) {
        var det = el('details'); if (i === 0) det.open = true;
        det.appendChild(el('summary', fmtDate(s.submitted_at) + ' · ' + bn(s.worker_count) + ' জন · ' + (s.work_name || '') +
          ((s.supervisors || []).length ? ' · Supervisor: ' + s.supervisors.join(', ') : '')));
        var wrap = el('div', null, 'table-wrap'); wrap.style.margin = '6px 0 10px';
        var t = el('table'), thead = el('thead'), th = el('tr');
        ['SL', 'Job Card No', 'App', 'নাম'].forEach(function (h) { th.appendChild(el('th', h)); });
        thead.appendChild(th); t.appendChild(thead);
        var tb = el('tbody');
        (s.workers || []).forEach(function (w, k) {
          var tr = el('tr');
          [k + 1, w.job_card_no, w.applicant_no, w.applicant_name].forEach(function (v, ci) { var td = el('td', String(v)); if (ci === 1) td.className = 'mono nw'; tr.appendChild(td); });
          tb.appendChild(tr);
        });
        t.appendChild(tb); wrap.appendChild(t); det.appendChild(wrap); box.appendChild(det);
      });
      if (!(subs || []).length) box.appendChild(el('div', 'কোনো জমা নেই।', 'muted'));
      $('subModal').classList.add('show');
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  }
  $('subClose').addEventListener('click', function () { $('subModal').classList.remove('show'); });

  // ---------- eKYC / ABPS report ----------
  $('ekycBtn').addEventListener('click', function () {
    var gp = Number($('dashGp').value); if (!gp) return;
    loading('হিসাব হচ্ছে...');
    SB.rpc('admin_ekyc_report', { p_gp_id: gp }, { retry: true }).then(function (rep) {
      dash.ekyc = rep;
      var tb = $('ekBody'); tb.innerHTML = '';
      var tot = { workers: 0, eligible: 0, no_ekyc: 0, no_abps: 0, no_both: 0 };
      (rep.villages || []).forEach(function (v) {
        var tr = el('tr');
        [vno(v.village_no), bn(v.workers), bn(v.eligible), bn(v.no_ekyc), bn(v.no_abps), bn(v.no_both)].forEach(function (x) { tr.appendChild(el('td', x)); });
        tb.appendChild(tr);
        Object.keys(tot).forEach(function (k) { tot[k] += Number(v[k]) || 0; });
      });
      var tr = el('tr', null, 'flag-warn');
      ['মোট', bn(tot.workers), bn(tot.eligible), bn(tot.no_ekyc), bn(tot.no_abps), bn(tot.no_both)].forEach(function (x) { var td = el('td', x); td.style.fontWeight = '800'; tr.appendChild(td); });
      tb.appendChild(tr);
      $('ekSub').textContent = bn((rep.missing || []).length) + ' জন active worker-এর eKYC বা ABPS নেই (তাঁরা list-এ বাছা যান না)।';
      $('ekModal').classList.add('show');
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  });
  $('ekClose').addEventListener('click', function () { $('ekModal').classList.remove('show'); });
  $('ekExcel').addEventListener('click', function () {
    var rep = dash.ekyc; if (!rep) return;
    var g = state.gps.filter(function (x) { return String(x.id) === $('dashGp').value; })[0] || { name: 'GP' };
    loadXlsx().then(function () {
      var wb = XLSX.utils.book_new();
      var va = [['Village', 'মোট worker', 'eKYC+ABPS আছে', 'eKYC নেই', 'ABPS নেই', 'দুটোই নেই']];
      (rep.villages || []).forEach(function (v) { va.push([vno(v.village_no), v.workers, v.eligible, v.no_ekyc, v.no_abps, v.no_both]); });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(va), 'গ্রাম অনুযায়ী');
      var ma = [['Village', 'Job Card No', 'Applicant No', 'Applicant Name', 'eKYC', 'ABPS', 'Aadhaar Seeded', 'Authentication Done']];
      (rep.missing || []).forEach(function (w) { ma.push([vno(w.village_no), w.job_card_no, String(w.applicant_no), w.applicant_name, yn(w.ekyc), yn(w.abps), yn(w.aadhaar_seeded), yn(w.authentication_done)]); });
      var ws = XLSX.utils.aoa_to_sheet(ma); ws['!cols'] = [{ wch: 7 }, { wch: 26 }, { wch: 8 }, { wch: 30 }, { wch: 6 }, { wch: 6 }, { wch: 10 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, ws, 'eKYC-ABPS নেই');
      XLSX.writeFile(wb, 'eKYC_ABPS_' + g.name.replace(/[^A-Za-z0-9_-]+/g, '_') + '_' + new Date().toISOString().slice(0, 10) + '.xlsx');
    }).catch(function (e) { status(errText(e), 'err'); });
  });

  // ---------- K-Desk export ----------
  function ddmmyyyy(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  // Pure function (also used by tests): API rows -> K-Desk sheet rows + report.
  function buildKdeskRows(apiRows, from, days, workCode) {
    var seen = new Set(), out = [], skipped = [], dupes = 0;
    apiRows.forEach(function (r) {
      if (seen.has(r.worker_id)) { dupes++; return; }
      seen.add(r.worker_id);
      if (!r.worker_active || !r.eligible) { skipped.push(r); return; }
      out.push(r);
    });
    out.sort(function (a, b) {
      return a.village_no - b.village_no || a.household_no - b.household_no ||
             (a.job_card_no < b.job_card_no ? -1 : a.job_card_no > b.job_card_no ? 1 : 0) || a.applicant_no - b.applicant_no;
    });
    var aoa = [['#', 'Reg', 'Applicant', 'From', 'Days', 'Work code']];
    out.forEach(function (r, i) { aoa.push([i + 1, r.job_card_no, r.applicant_name, from, days, workCode]); });
    return { aoa: aoa, count: out.length, skipped: skipped, dupes: dupes };
  }
  window.GramgKdesk = { buildKdeskRows: buildKdeskRows, ddmmyyyy: ddmmyyyy };

  $('expBtn').addEventListener('click', function () {
    var rows = pickedRows();
    var from = ddmmyyyy($('expFrom').value), days = parseInt($('expDays').value, 10), work = $('expWork').value.trim();
    if (!rows.length) { status('আগে list বাছুন।', 'err'); return; }
    if (!from) { status('From (Work date) দিন।', 'err'); return; }
    if (!(days >= 1 && days <= 366)) { status('Days ঠিক দিন (১ থেকে ৩৬৬)।', 'err'); return; }
    if (!work) { status('Work code দিন।', 'err'); return; }
    var notSub = rows.filter(function (r) { return r.submit_state === 'draft'; });
    if (notSub.length && !confirm(notSub.map(function (r) { return r.username; }).join(', ') + ' এখনো list জমা দেননি। তবুও export করবেন?')) return;
    var doLock = $('expLock').checked;
    loading('K-Desk file তৈরি হচ্ছে...');
    var report;
    loadXlsx().then(function () {
      return SB.rpc('admin_export_lists', { p_list_ids: rows.map(function (r) { return r.list_id; }) });
    }).then(function (apiRows) {
      report = buildKdeskRows(apiRows || [], from, days, work);
      if (!report.count) throw { hint: 'Export করার মতো কোনো worker নেই।' };
      var ws = XLSX.utils.aoa_to_sheet(report.aoa);
      ws['!cols'] = [{ wch: 6 }, { wch: 26 }, { wch: 30 }, { wch: 12 }, { wch: 6 }, { wch: 22 }];
      var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Demand');
      var safe = work.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
      XLSX.writeFile(wb, 'KDesk_Demand_' + safe + '_' + from.replace(/\//g, '-') + '.xlsx');
      if (!doLock) return null;
      return rows.filter(function (r) { return r.submit_state !== 'locked'; }).reduce(function (p, r) {
        return p.then(function () { return SB.rpc('admin_set_list_state', { p_list_id: r.list_id, p_action: 'lock' }); });
      }, Promise.resolve());
    }).then(function () {
      var msg = '✅ K-Desk file তৈরি হয়েছে: ' + bn(report.count) + ' জন worker।';
      if (report.dupes) msg += ' ' + report.dupes + ' জন একাধিক list-এ ছিল, file-এ একবারই রাখা হয়েছে।';
      if (report.skipped.length) msg += ' ⚠ ' + report.skipped.length + ' জন বাদ গেছে (এখন inactive বা eKYC/ABPS নেই): ' +
        report.skipped.slice(0, 10).map(function (r) { return r.job_card_no + ' ' + r.applicant_name; }).join('; ') + (report.skipped.length > 10 ? ' …' : '');
      if (doLock) msg += ' List-গুলো lock করা হয়েছে।';
      status(msg, report.skipped.length ? 'info' : 'ok');
      return loadDashboard();
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  });

  // ---------- PIN helpers ----------
  function weakPin(p) {
    if (!/^[0-9]{6,12}$/.test(p)) return 'PIN_FORMAT';
    if (/^(\d)\1+$/.test(p) || '01234567890123456789'.indexOf(p) >= 0 || '98765432109876543210'.indexOf(p) >= 0) return 'WEAK_PIN';
    return null;
  }
  function randomPin() {
    var p;
    do {
      var a = new Uint32Array(8); crypto.getRandomValues(a);
      p = Array.prototype.map.call(a, function (x) { return String(x % 10); }).join('');
    } while (weakPin(p) || p[0] === '0');
    return p;
  }
  function onlyDigits(inp) { inp.addEventListener('input', function () { var v = inp.value.replace(/\D/g, ''); if (v !== inp.value) inp.value = v; }); }
  onlyDigits($('nuPin')); onlyDigits($('pinNew'));
  $('nuPinGen').addEventListener('click', function () { $('nuPin').value = randomPin(); });
  $('pinGen').addEventListener('click', function () { $('pinNew').value = randomPin(); });
  $('nuUsername').addEventListener('input', function () { var v = this.value.toLowerCase().replace(/\s+/g, ''); if (v !== this.value) this.value = v; });

  // ---------- create supervisor (Edge Function) ----------
  $('nuBtn').addEventListener('click', function () {
    var name = $('nuName').value.trim(), un = $('nuUsername').value.trim().toLowerCase(), pin = $('nuPin').value.trim();
    var gp = Number($('nuGp').value);
    var bad = !name ? 'BAD_NAME' : !/^[a-z0-9_.-]{3,32}$/.test(un) ? 'BAD_USERNAME' : weakPin(pin) || (!gp ? 'BAD_GP' : null);
    if (bad) { status(errText({ code: bad }), 'err'); return; }
    loading('Supervisor তৈরি হচ্ছে...');
    SB.callFunction('admin-users', { action: 'create_user', username: un, full_name: name, pin: pin, gp_id: gp })
      .then(function (r) {
        status('✅ ' + r.username + ' তৈরি হয়েছে। Login: username "' + r.username + '", PIN "' + pin + '"। PIN-টা supervisor-কে জানিয়ে দিন।', 'ok');
        $('nuName').value = ''; $('nuUsername').value = ''; $('nuPin').value = '';
        return Promise.all([loadUsers(), loadDashboard()]);
      }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  });

  // ---------- PIN reset (Edge Function) ----------
  var pinTarget = null;
  function openPinModal(u) {
    pinTarget = u; $('pinWho').textContent = (u.full_name || u.username) + ' (@' + u.username + ')';
    $('pinNew').value = ''; $('pinModal').classList.add('show'); $('pinNew').focus();
  }
  function closePin() { $('pinModal').classList.remove('show'); pinTarget = null; }
  $('pinClose').addEventListener('click', closePin);
  $('pinSave').addEventListener('click', function () {
    var pin = $('pinNew').value.trim(), bad = weakPin(pin);
    if (bad) { status(errText({ code: bad }), 'err'); return; }
    var u = pinTarget; if (!u) return;
    loading('PIN বদলানো হচ্ছে...');
    SB.callFunction('admin-users', { action: 'reset_pin', user_id: u.user_id, pin: pin })
      .then(function (r) {
        closePin();
        status('✅ ' + r.username + '-এর নতুন PIN: "' + pin + '"। সব device থেকে logout করানো হয়েছে।', 'ok');
        return Promise.all([loadUsers(), loadDashboard()]);
      }).catch(function (e) { if (!e.authLost) { closePin(); status(errText(e), 'err'); } })
      .then(function () { loading(''); });
  });

  // ---------- list preview ----------
  var pv = { data: null, row: null };
  function yn(b) { return b ? 'Yes' : 'No'; }
  function openPreview(r) {
    pv.row = r;
    loadPreview(true);
  }
  function loadPreview(first) {
    var r = pv.row; if (!r) return Promise.resolve();
    loading('List খুলছে...');
    return SB.rpc('admin_list_items', { p_list_id: r.list_id }).then(function (d) {
      pv.data = d;
      $('pvTitle').textContent = (d.work_name || '(Work Name নেই)') + ' — ' + (d.full_name || d.username) + ' (@' + d.username + ')';
      $('pvSub').textContent = STATE_BN[d.submit_state] + (d.submitted_at ? ' · জমা: ' + fmtDate(d.submitted_at) : '') +
        (Number(d.submissions) ? ' · আগের জমা: ' + d.submissions + 'টা' : '');
      var items = d.items || [], noAcc = 0, dup = 0, bad = 0, vs = {};
      items.forEach(function (x) { if (!x.account_no) noAcc++; if (x.in_other_lists > 0) dup++; if (!x.active || !x.eligible) bad++; vs[x.village_no] = true; });
      var need = Number(d.required_supervisors) || 1, have = (d.supervisors || []).length;
      var S = $('pvStats'); S.innerHTML = '';
      function stat(n, label, cls) { var e = el('div', null, 'stat ' + (cls || '')); e.appendChild(el('div', bn(n), 'n')); e.appendChild(el('div', label, 'l')); S.appendChild(e); }
      stat(items.length, 'মোট worker'); stat(Object.keys(vs).length, 'গ্রাম');
      stat(have + '/' + need, 'Supervisor (দেওয়া/লাগবে)', have < need ? 'bad' : 'good');
      stat(noAcc, 'Account নেই', noAcc ? 'warn' : ''); if (dup) stat(dup, 'অন্য list-এও আছে', 'bad');
      stat(bad, 'এখন inactive / eKYC-ABPS নেই', bad ? 'bad' : '');
      $('pvWork').value = d.work_name || '';
      $('pvSups').value = (d.supervisors || []).join(', ');
      if (first) {
        var sel = $('pvVillage'); sel.innerHTML = '';
        var o = el('option', 'সব গ্রাম'); o.value = ''; sel.appendChild(o);
        Object.keys(vs).map(Number).sort(function (a, b) { return a - b; }).forEach(function (v) { var oo = el('option', 'Village ' + vno(v)); oo.value = v; sel.appendChild(oo); });
        $('pvSearch').value = ''; $('pvAddInput').value = ''; $('pvAddResults').innerHTML = '';
      }
      $('pvPick').checked = dash.picked.has(r.list_id);
      renderListPreview(); $('pvModal').classList.add('show');
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  }
  function renderListPreview() {
    var q = $('pvSearch').value.trim().toLowerCase(), v = $('pvVillage').value, tb = $('pvBody'); tb.innerHTML = '';
    var sl = 0;
    (pv.data.items || []).forEach(function (x) {
      if (v && String(x.village_no) !== v) return;
      if (q && x.applicant_name.toLowerCase().indexOf(q) < 0 && x.job_card_no.toLowerCase().indexOf(q) < 0) return;
      var tr = el('tr', null, (!x.active || !x.eligible) ? 'flag-bad' : (x.in_other_lists > 0 || !x.account_no) ? 'flag-warn' : '');
      [++sl, x.job_card_no, x.applicant_no, x.applicant_name, yn(x.ekyc), yn(x.abps), x.account_no || '—', x.ifsc || '—'].forEach(function (c, i) {
        var td = el('td', String(c)); if (i === 1 || i === 6 || i === 7) td.className = 'mono nw'; tr.appendChild(td);
      });
      var notes = [];
      if (!x.active) notes.push('inactive'); else if (!x.eligible) notes.push('eKYC/ABPS নেই');
      if (x.in_other_lists > 0) notes.push('অন্য list-এও');
      if (!x.account_no) notes.push('account নেই');
      tr.appendChild(el('td', notes.join(', ')));
      var tdx = el('td'); var rb = el('button', '✕', 'btn-light btn-small'); rb.title = 'এই list থেকে বাদ দিন';
      rb.addEventListener('click', function () {
        if (!confirm(x.applicant_name + ' (' + x.job_card_no + ')-কে এই list থেকে বাদ দেবেন?')) return;
        editList([], [x.worker_id], x.applicant_name + ' বাদ দেওয়া হয়েছে।');
      });
      tdx.appendChild(rb); tr.appendChild(tdx);
      tb.appendChild(tr);
    });
    if (!sl) { var tr = el('tr'); var td = el('td', 'কিছু পাওয়া যায়নি।'); td.colSpan = 10; tr.appendChild(td); tb.appendChild(tr); }
  }
  function editList(add, remove, okMsg) {
    loading('List বদলানো হচ্ছে...');
    return SB.rpc('admin_edit_list', { p_list_id: pv.row.list_id, p_add: add, p_remove: remove }).then(function (r) {
      var rej = r.rejected || [];
      var why = { IN_OTHER_LIST: 'অন্য list-এ আছেন', NOT_ELIGIBLE: 'eKYC/ABPS নেই', INACTIVE: 'inactive', NOT_FOUND: 'এই GP-র নন' };
      status(rej.length ? ('⚠ যোগ হয়নি: ' + rej.map(function (x) { return why[x.reason] || x.reason; }).join(', ')) : ('✅ ' + okMsg), rej.length ? 'err' : 'ok');
      return Promise.all([loadPreview(false), loadDashboard()]);
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  }
  $('pvMetaSave').addEventListener('click', function () {
    var name = $('pvWork').value.trim();
    var sups = $('pvSups').value.split(/[,\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (!name) { status('Work Name লিখুন।', 'err'); return; }
    loading('Save হচ্ছে...');
    SB.rpc('admin_set_list_meta', { p_list_id: pv.row.list_id, p_work_name: name, p_supervisors: sups }).then(function () {
      status('✅ Work Name / Supervisor save হয়েছে।', 'ok');
      return Promise.all([loadPreview(false), loadDashboard()]);
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  });
  // "002/012 2/15 WB-08-005-001-003/007" -> village/household pairs
  function parsePairs(text) {
    var out = [];
    String(text || '').split(/[\s,;]+/).forEach(function (t) {
      var m = /^(?:WB-\d{2}-\d{3}-\d{3}-)?(\d{1,3})\/(\d{1,4})(?:-[A-Z])?$/i.exec(t.trim());
      if (m) out.push({ v: Number(m[1]), h: Number(m[2]) });
    });
    return out;
  }
  $('pvAddBtn').addEventListener('click', function () {
    var pairs = parsePairs($('pvAddInput').value);
    var box = $('pvAddResults'); box.innerHTML = '';
    if (!pairs.length) { box.appendChild(el('div', 'Job Card লিখুন, যেমন 002/012 (গ্রাম/household) বা পুরো নম্বর।', 'muted')); return; }
    SB.rpc('admin_search_households', { p_gp_id: pv.data.gp_id, p_villages: pairs.map(function (p) { return p.v; }), p_households: pairs.map(function (p) { return p.h; }) })
      .then(function (rows) {
        if (!(rows || []).length) { box.appendChild(el('div', 'কাউকে পাওয়া যায়নি।', 'muted')); return; }
        rows.forEach(function (w) {
          var row = el('div', null, 'addrow');
          row.appendChild(el('span', w.job_card_no + ' · ' + w.applicant_name + ' · eKYC ' + (w.ekyc ? '✓' : '✗') + ' ABPS ' + (w.abps ? '✓' : '✗'), 'mono'));
          if (w.taken_list_id === pv.row.list_id) row.appendChild(el('span', 'এই list-এ আছেন', 'pill on'));
          else if (w.taken_list_id) row.appendChild(el('span', '"' + w.taken_work + '" (' + w.taken_username + ')-এ আছেন', 'pill off'));
          else if (!w.eligible) row.appendChild(el('span', 'eKYC/ABPS নেই', 'pill off'));
          else {
            var b = el('button', '➕ যোগ', 'btn-success btn-small');
            b.addEventListener('click', function () { editList([w.id], [], w.applicant_name + ' যোগ হয়েছে।').then(function () { $('pvAddBtn').click(); }); });
            row.appendChild(b);
          }
          box.appendChild(row);
        });
      }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
  });
  $('pvAddInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('pvAddBtn').click(); });
  $('pvSearch').addEventListener('input', renderListPreview);
  $('pvVillage').addEventListener('change', renderListPreview);
  $('pvClose').addEventListener('click', function () { $('pvModal').classList.remove('show'); });
  $('pvPick').addEventListener('change', function () {
    if (!pv.row) return;
    if (this.checked) dash.picked.add(pv.row.list_id); else dash.picked.delete(pv.row.list_id);
    renderDashboard();
  });
  $('pvExcel').addEventListener('click', function () {
    if (!pv.data) return;
    loadXlsx().then(function () {
      var aoa = [['SL No', 'Job Card No', 'Applicant Name', 'eKYC', 'ABPS', 'Account No', 'IFSC Code']];
      (pv.data.items || []).forEach(function (x, i) { aoa.push([i + 1, x.job_card_no, x.applicant_name, yn(x.ekyc), yn(x.abps), x.account_no || '', x.ifsc || '']); });
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 6 }, { wch: 26 }, { wch: 30 }, { wch: 6 }, { wch: 6 }, { wch: 20 }, { wch: 13 }];
      var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'List');
      var info = [['Work Name', pv.data.work_name || ''], ['Supervisor', (pv.data.supervisors || []).join(', ')], ['Workers', (pv.data.items || []).length], ['Username', pv.data.username]];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(info), 'Work Info');
      XLSX.writeFile(wb, 'List_' + pv.data.username + '_' + String(pv.data.work_name || '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 30) + '_' + new Date().toISOString().slice(0, 10) + '.xlsx');
    }).catch(function (e) { status(errText(e), 'err'); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { ['pvModal', 'subModal', 'ekModal'].forEach(function (m) { $(m).classList.remove('show'); }); closePin(); }
  });

  // ---------- add a GP ----------
  $('gpPrefix').addEventListener('input', function () { var v = this.value.toUpperCase(); if (v !== this.value) this.value = v; });
  $('gpAddBtn').addEventListener('click', function () {
    var name = $('gpName').value.trim(), prefix = $('gpPrefix').value.trim().toUpperCase();
    if (name.length < 2) { status('GP-র নাম লিখুন।', 'err'); return; }
    if (!/^WB-\d{2}-\d{3}-\d{3}$/.test(prefix)) { status(errText({ code: 'BAD_PREFIX' }), 'err'); return; }
    if (!confirm('নতুন GP: ' + name + ' (' + prefix + ')\nযোগ করবেন?')) return;
    loading('GP যোগ হচ্ছে...');
    SB.rpc('admin_add_gp', { p_jc_prefix: prefix, p_name: name }).then(function (g) {
      status('✅ ' + g.name + ' (' + g.jc_prefix + ') যোগ হয়েছে। এবার উপরে GP বেছে এর data import করুন, তারপর Users tab থেকে supervisor বানান।', 'ok');
      $('gpName').value = ''; $('gpPrefix').value = '';
      return loadGps().then(function () { $('gpSelect').value = String(g.id); showGpStats(); });
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  });

  // ---------- backup ----------
  $('backupBtn').addEventListener('click', function () {
    var gp = Number($('gpSelect').value); if (!gp) return;
    var g = state.gps.filter(function (x) { return x.id === gp; })[0] || { name: 'GP' + gp };
    var workers = [], lists = [], users = [];
    loading('Backup তৈরি হচ্ছে... (workers)');
    function pageWorkers(after) {
      return SB.rpc('admin_backup_workers', { p_gp_id: gp, p_after_id: after, p_limit: 5000 }, { retry: true }).then(function (r) {
        var rows = (r && r.rows) || [];
        workers = workers.concat(rows);
        $('loadingText').textContent = 'Backup তৈরি হচ্ছে... ' + bn(workers.length) + ' worker';
        return rows.length ? pageWorkers(r.next_after_id) : null;
      });
    }
    function pageLists(offset) {
      return SB.rpc('admin_backup_lists', { p_gp_id: gp, p_offset: offset, p_limit: 5000 }, { retry: true }).then(function (r) {
        var rows = (r && r.rows) || [];
        lists = lists.concat(rows);
        return rows.length === 5000 ? pageLists(offset + 5000) : null;
      });
    }
    loadXlsx().then(function () { return pageWorkers(0); })
      .then(function () { return pageLists(0); })
      .then(function () { return SB.rpc('admin_list_users'); })
      .then(function (u) {
        users = (u || []).filter(function (x) { return x.role === 'super_admin' || x.gp_id === gp; });
        var wb = XLSX.utils.book_new();
        // Workers: same column names as the import, so this sheet can be imported again.
        var wa = [['Job Card No', 'Applicant No', 'Applicant Name', 'Aadhaar Seeded', 'Authentication Done', 'ABPS', 'eKYC', 'Account No', 'IFSC', 'Active']];
        workers.forEach(function (w) {
          wa.push([w.job_card_no, String(w.applicant_no), w.applicant_name, yn(w.aadhaar_seeded), yn(w.authentication_done),
                   yn(w.abps), yn(w.ekyc), w.account_no || '', w.ifsc || '', yn(w.active)]);
        });
        var ws = XLSX.utils.aoa_to_sheet(wa);
        ws['!cols'] = [{ wch: 26 }, { wch: 8 }, { wch: 30 }, { wch: 8 }, { wch: 8 }, { wch: 6 }, { wch: 6 }, { wch: 20 }, { wch: 13 }, { wch: 6 }];
        XLSX.utils.book_append_sheet(wb, ws, 'Workers');
        var la = [['Username', 'List অবস্থা', 'Submit অবস্থা', 'Work Name', 'তৈরি', 'জমা', 'Lock', 'Export', 'Job Card No', 'Applicant No', 'Applicant Name']];
        lists.forEach(function (x) {
          la.push([x.username, x.status === 'active' ? 'চলতি' : 'পুরনো দফা', STATE_BN[x.submit_state] || x.submit_state, x.work_name || '',
                   fmtDate(x.created_at), x.submitted_at ? fmtDate(x.submitted_at) : '', x.locked_at ? fmtDate(x.locked_at) : '',
                   x.exported_at ? fmtDate(x.exported_at) : '', x.job_card_no, String(x.applicant_no), x.applicant_name]);
        });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(la), 'Lists');
        var ua = [['Username', 'নাম', 'Role', 'অবস্থা', 'শেষ login']];
        users.forEach(function (x) { ua.push([x.username, x.full_name, x.role === 'super_admin' ? 'Super Admin' : x.role === 'kdesk' ? 'K-Desk' : 'Supervisor', x.active ? 'চালু' : 'বন্ধ', x.last_seen ? fmtDate(x.last_seen) : '']); });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ua), 'Users');
        var d = new Date(), stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        XLSX.writeFile(wb, 'GramG_Backup_' + g.name.replace(/[^A-Za-z0-9_-]+/g, '_') + '_' + stamp + '.xlsx');
        var msg = '✅ Backup নেমেছে: ' + bn(workers.length) + ' worker, ' + bn(lists.length) + ' list-row, ' + bn(users.length) + ' user।';
        $('backupInfo').textContent = msg + ' (' + fmtDate(d.toISOString()) + ')';
        status(msg, 'ok');
      }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  });

  $('logoutBtn').addEventListener('click', function () {
    SB.signOut().then(function () { location.replace('./index.html'); });
  });

  boot();
})();
