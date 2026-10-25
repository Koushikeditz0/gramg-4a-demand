/* =====================================================================
   G RAM-G 4A v2 — Admin panel (Super Admin and GP Admins).
   All permissions are enforced by the database (private.require_super_admin /
   private.require_admin_gp: a GP Admin only reaches their own GP);
   this page only drives the workflow. The Super Admin can switch to a GP
   Admin's view of one GP (UI only: it hides what a GP Admin cannot do).
   ===================================================================== */
(function () {
  'use strict';
  var SB = window.GramgSB, MAP = window.GramgImportMap;
  var XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  var STAGE_CHUNK = 1000;
  var $ = function (id) { return document.getElementById(id); };
  var state = { users: [], gps: [], jobId: null, problems: [], counts: null, busy: false };
  var me = { role: null, gp: null, gpName: '' };       // who is logged in
  var view = { gp: null };                             // Super Admin viewing as GP Admin of this GP
  var VIEW_KEY = 'gramg2.adminView';
  // GP the page is limited to (GP Admin, or Super Admin in GP Admin view); null = all GPs
  function gpView() { return me.role === 'gp_admin' ? me.gp : view.gp; }

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
      NOT_AUTHORIZED: 'You are not allowed to do this.', IMPORT_NOT_OPEN: 'This import is no longer open. Start again with the file.',
      IMPORT_NOT_READY: 'Run the Preview first.', NOT_LATEST_IMPORT: 'Only the latest import can be rolled back.',
      IMPORT_NOT_COMMITTED: 'This import was already rolled back or cancelled.', FILE_TOO_LARGE: 'The file is too large (more than 100,000 rows).',
      NETWORK: 'Could not reach the server. Check the internet connection.',
      LIST_NOT_FOUND: 'List not found (perhaps a new round has started). Please refresh.',
      LIST_NOT_LOCKED: 'Lock the list before starting a new round.',
      LIST_LOCKED: 'The list is locked.',
      BAD_PREFIX: 'The Job Card prefix is not valid. Example: WB-08-005-014 (the first 13 characters).',
      GP_EXISTS: 'A GP with this prefix already exists.',
      NEED_WORK_NAME: 'Enter the Work Name.',
      BAD_USERNAME: 'Invalid username: 3–32 characters, only lowercase English letters, digits, _ . -',
      BAD_NAME: 'Enter the full name (up to 100 characters).', BAD_GP: 'Choose a GP.',
      PIN_FORMAT: 'The PIN must be 6 to 12 digits, numbers only.',
      WEAK_PIN: 'The PIN is too easy (like 111111 or 123456). Choose another PIN.',
      USERNAME_TAKEN: 'This username already exists. Choose another one.',
      BAD_ROLE: 'You cannot create this kind of user.',
      USER_NOT_FOUND: 'User not found.', ONLY_SUPERVISORS: 'Only a supervisor\'s PIN can be changed here. For a K-Desk login, switch it back to Supervisor first, change the PIN, then make it a K-Desk login again.',
      BAD_WORK_CODE: 'The Work Code format does not match (e.g. 3206003006/IF/93393042892327).',
      CONFIRM_MISMATCH: 'The username you typed does not match.', CANNOT_DELETE_ADMIN: 'A Super Admin cannot be deleted.',
      USER_HAS_IMPORTS: 'This user started data imports, so the account is kept for the import history. Disable it instead.',
      BAD_INPUT: 'The input is not valid.', SESSION_REVOKED: 'This device was logged out. Please log in again.',
      USER_DISABLED: 'This account is disabled.', NOT_LOGGED_IN: 'Please log in again.',
      AUTH_ERROR: 'Supabase Auth had a problem. Try again in a little while.',
      SERVER_NOT_CONFIGURED: 'The Edge Function is not set up correctly (key not found).',
      FUNCTION_JWT_SETTING: '"Verify JWT" is on for the Edge Function. Turn it off in Supabase → Edge Functions → admin-users → settings (see the guide).',
      FUNCTION_UNREACHABLE: 'Could not reach the Edge Function. Check the internet, then check that "admin-users" is deployed and "Verify JWT" is off.',
      FUNCTION_NOT_DEPLOYED: 'The "admin-users" Edge Function is not deployed yet. Deploy it using the guide, or use the old method.'
    };
    return map[e.code] || (e.hint ? e.hint : 'Error: ' + (e.message || e));
  }

  SB.onAuthLost = function () { location.replace('./index.html'); };

  // ---------- boot ----------
  function boot() {
    if (!SB.hasSession()) { location.replace('./index.html'); return; }
    loading('Opening the admin panel...');
    SB.rpc('register_session', { p_user_agent: String(navigator.userAgent).slice(0, 300) })
      .then(function () { return SB.rpc('get_my_context'); })
      .then(function (ctx) {
        if (ctx.role !== 'super_admin' && ctx.role !== 'gp_admin') { location.replace('./index.html'); return; }
        me.role = ctx.role; me.gp = ctx.gp_id; me.gpName = ctx.gp_name || '';
        $('who').textContent = ctx.full_name || ctx.username;
        if (me.role === 'super_admin') {
          try { view.gp = Number(localStorage.getItem(VIEW_KEY)) || null; } catch (_e) { view.gp = null; }
        }
        return loadGps().then(function () { applyView(false); }).then(loadDashboard).then(loadHistory).then(loadUsers);
      })
      .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  }

  function loadGps() {
    return SB.rpc('admin_list_gps').then(function (gps) {
      state.gps = gps || [];
      if (view.gp && !state.gps.some(function (g) { return g.id === view.gp; })) view.gp = null;
      fillGpSelects();
      if (me.role === 'super_admin') {
        var vs = $('viewSel'), keep = view.gp ? String(view.gp) : '';
        vs.innerHTML = '';
        var o0 = el('option', '👑 Super Admin (all GPs)'); o0.value = ''; vs.appendChild(o0);
        state.gps.forEach(function (g) { var o = el('option', '🛡 GP Admin: ' + g.name); o.value = g.id; vs.appendChild(o); });
        vs.value = keep;
      }
    });
  }
  function fillGpSelects() {
    var lim = gpView();
    var gps = state.gps.filter(function (g) { return !lim || g.id === lim; });
    [$('gpSelect'), $('linkGp'), $('dashGp'), $('nuGp'), $('gaGp')].forEach(function (sel) {
      var keep = sel.value; sel.innerHTML = '';
      gps.forEach(function (g) { var o = el('option', g.name + ' (' + g.jc_prefix + ')'); o.value = g.id; sel.appendChild(o); });
      if (keep && gps.some(function (g) { return String(g.id) === keep; })) sel.value = keep;
      sel.disabled = !!lim && sel.id !== 'linkGp';
    });
    showGpStats();
  }

  // ---------- Super Admin ⇄ GP Admin view ----------
  function applyView(reload) {
    var lim = gpView();
    var g = state.gps.filter(function (x) { return x.id === lim; })[0];
    document.querySelectorAll('.super-only').forEach(function (e) { e.classList.toggle('hidden', !!lim); });
    $('viewBar').classList.toggle('hidden', me.role !== 'super_admin');
    if (me.role === 'gp_admin') $('roleLbl').textContent = 'GP Admin · ' + (me.gpName || (g && g.name) || '');
    else $('roleLbl').textContent = lim ? 'Super Admin · viewing as GP Admin' : 'Super Admin';
    $('viewNote').textContent = me.role === 'super_admin' && lim
      ? 'You see what the GP Admin of ' + (g ? g.name : '') + ' sees. Switch back to Super Admin to add a GP or a GP Admin.' : '';
    fillGpSelects();
    if (reload) { loadDashboard(); loadHistory(); loadUsers(); }
  }
  $('viewSel').addEventListener('change', function () {
    view.gp = Number(this.value) || null;
    try { if (view.gp) localStorage.setItem(VIEW_KEY, String(view.gp)); else localStorage.removeItem(VIEW_KEY); } catch (_e) { /* per-device convenience only */ }
    // reload the page so every tab starts clean in the new view
    location.reload();
  });
  function showGpStats() {
    var g = state.gps.filter(function (x) { return String(x.id) === $('gpSelect').value; })[0];
    $('gpStats').textContent = g ? 'In the database now: ' + bn(g.workers) + ' workers (' + bn(g.active_workers) + ' active), ' + bn(g.accounts) + ' with an account' : '';
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
      s.onerror = function () { xlsxLoading = null; rej(new Error('The Excel library did not load. Check the internet.')); };
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
      throw new Error('The file has no "Job Card No" and "Applicant No" columns.');
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
    progress(0.02, 'Reading the file...');
    readFile(file).then(function (p) {
      parsed = p;
      rows = MAP.toRaw(p.aoa.slice(p.headerRow + 1), p.mapping.map, p.headerRow + 2);
      if (!rows.length) throw new Error('The file has no data rows.');
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
          progress(0.05 + 0.75 * i / rows.length, bn(i) + ' / ' + bn(rows.length) + ' rows sent...');
          return next();
        });
      }
      return next();
    }).then(function () {
      progress(0.85, 'Checking (new / changed / duplicate)...');
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
    if (parsed.mapping.ignored.length) info.appendChild(el('div', parsed.mapping.ignored.length + ' column(s) not taken (struck through).'));

    var S = $('stats'); S.innerHTML = '';
    function stat(n, label, cls) { var d = el('div', null, 'stat ' + (cls || '')); d.appendChild(el('div', bn(n), 'n')); d.appendChild(el('div', label, 'l')); S.appendChild(d); }
    stat(c.total_rows, 'Rows in file');
    stat(c.workers_in_file, 'Distinct workers');
    stat(c.new, 'New workers', 'good');
    stat(c.updated, 'Changed', c.updated ? 'warn' : '');
    stat(c.unchanged, 'Unchanged');
    stat(c.with_account, 'With account');
    stat(c.merged_repeats, 'Repeated rows of one worker (merged)');
    stat(c.conflicting_repeats + c.invalid, 'Will be skipped (invalid / conflicting)', (c.conflicting_repeats + c.invalid) ? 'bad' : '');
    stat(c.account_warnings, 'Account skipped (bad Account/IFSC)', c.account_warnings ? 'warn' : '');
    stat(c.missing_from_file, c.deactivate_missing ? 'Not in file → will become inactive' : 'Not in file (nothing happens)', c.deactivate_missing && c.missing_from_file ? 'bad' : '');

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
    $('commitBtn').textContent = $('commitBtn').disabled ? 'No changes' : '✅ Confirm Import';
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
    var msg = 'Confirm the import?\n\nNew: ' + bn(c.new) + '\nChanged: ' + bn(c.updated) +
              (c.deactivate_missing ? '\nWill become inactive: ' + bn(c.missing_from_file) : '') +
              '\nSkipped: ' + bn(c.invalid + c.conflicting_repeats) + '\n\nIf it is wrong you can roll it back from Import History.';
    if (!confirm(msg)) return;
    state.busy = true; loading('Importing... (do not close the page)');
    SB.rpc('admin_commit_import', { p_job_id: state.jobId }, { timeout: 180000 }).then(function (r) {
      status('✅ Import done: new ' + bn(r.new) + ', changed ' + bn(r.updated) + ', accounts ' + bn(r.accounts) +
             (r.deactivated ? ', inactive ' + bn(r.deactivated) : '') + '.', 'ok');
      $('previewCard').classList.add('hidden'); $('fileInput').value = ''; $('previewBtn').disabled = true; state.jobId = null;
      return loadGps().then(loadHistory);
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { state.busy = false; loading(''); });
  });

  $('cancelBtn').addEventListener('click', function () {
    if (!state.jobId) return;
    SB.rpc('admin_cancel_import', { p_job_id: state.jobId }).catch(function () {});
    state.jobId = null; $('previewCard').classList.add('hidden'); status('Import cancelled. Nothing was changed.', 'info');
  });

  // ---------- history ----------
  function loadHistory() {
    var gp = Number($('gpSelect').value); if (!gp) return Promise.resolve();
    return SB.rpc('admin_import_history', { p_gp_id: gp }).then(function (rows) {
      var tb = $('history'); tb.innerHTML = '';
      var label = { committed: 'Done', staged: 'In preview', rolled_back: 'Rolled back', failed: 'Failed' };
      if (!rows.length) { var tr0 = document.createElement('tr'); var td0 = el('td', 'No imports yet.'); td0.colSpan = 9; tr0.appendChild(td0); tb.appendChild(tr0); }
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
            if (!confirm('Roll back this import? The data goes back to how it was before it.')) return;
            loading('Rolling back...');
            SB.rpc('admin_rollback_import', { p_job_id: j.id }, { timeout: 180000 }).then(function (r) {
              status('↩ Rollback done: ' + bn(r.restored) + ' worker(s) restored, ' + bn(r.deleted_new) + ' new worker(s) deleted' +
                     (r.deactivated_new_in_lists ? ', ' + bn(r.deactivated_new_in_lists) + ' made inactive (they are in a list)' : '') + '.', 'ok');
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
  var ROLE_LABEL = { super_admin: 'Super Admin', gp_admin: '🛡 GP Admin', gp_user: 'Supervisor', kdesk: '🖥 K-Desk login' };
  function loadUsers() {
    return SB.rpc('admin_list_users').then(function (users) {
      state.users = users || []; gaPrefill();
      var tb = $('users'); tb.innerHTML = '';
      var lim = gpView();
      if (lim) users = users.filter(function (u) { return u.gp_id === lim; });
      users.forEach(function (u) {
        var tr = document.createElement('tr');
        tr.appendChild(el('td', u.username)); tr.appendChild(el('td', u.full_name));
        tr.appendChild(el('td', u.role === 'super_admin' ? 'Super Admin' : (u.gp_name || '') + (u.role === 'kdesk' || u.role === 'gp_admin' ? ' · ' + ROLE_LABEL[u.role] : '')));
        var st = el('td'); st.appendChild(el('span', u.active ? 'Active' : 'Disabled', 'pill ' + (u.active ? 'on' : 'off'))); tr.appendChild(st);
        tr.appendChild(el('td', String(u.active_devices)));
        tr.appendChild(el('td', fmtDate(u.last_seen)));
        var act = el('td');
        // a GP Admin manages only their GP's supervisors and K-Desk login (the database checks this too)
        var canManage = u.role === 'gp_user' || u.role === 'kdesk' || (u.role === 'gp_admin' && !lim);
        if (canManage) {
          var t = el('button', u.active ? 'Disable' : 'Enable', (u.active ? 'btn-danger' : 'btn-success') + ' btn-small');
          t.addEventListener('click', function () {
            if (u.active && !confirm('Disable the account of ' + u.username + '? They are logged out of every device at once.')) return;
            SB.rpc('admin_set_user_active', { p_user_id: u.user_id, p_active: !u.active })
              .then(function () { status(u.username + ' ' + (u.active ? 'disabled' : 'enabled') + '.', 'ok'); return loadUsers(); })
              .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
          });
          act.appendChild(t);
          var pb = el('button', '🔑 PIN', 'btn-light btn-small'); pb.style.marginLeft = '4px';
          pb.addEventListener('click', function () { openPinModal(u); });
          act.appendChild(pb);
          // K-Desk Suite login: may only read this GP's submitted lists and lock them (database: kdesk_*).
          var kb = u.role === 'gp_admin' ? null : el('button', u.role === 'kdesk' ? '↩ Make Supervisor' : '🖥 Make K-Desk login', 'btn-light btn-small'); if (kb) kb.style.marginLeft = '4px';
          if (kb) kb.addEventListener('click', function () {
            var to = u.role === 'kdesk' ? 'gp_user' : 'kdesk';
            var q = to === 'kdesk'
              ? 'Make ' + u.username + ' a K-Desk login? It can no longer build lists in the phone app; the K-Desk extension can only fetch and lock submitted lists with it. It is logged out of every device.'
              : 'Make ' + u.username + ' a Supervisor again? K-Desk can no longer fetch lists with it.';
            if (!confirm(q)) return;
            SB.rpc('admin_set_user_role', { p_user_id: u.user_id, p_role: to })
              .then(function () { status(u.username + (to === 'kdesk' ? ' is now a K-Desk login.' : ' is now a Supervisor.'), 'ok'); return loadUsers(); })
              .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
          });
          if (kb) act.appendChild(kb);
          // Super Admin only: Supervisor <-> GP Admin
          if (!lim && (u.role === 'gp_user' || u.role === 'gp_admin')) {
            var gb = el('button', u.role === 'gp_admin' ? '↩ Make Supervisor' : '🛡 Make GP Admin', 'btn-light btn-small'); gb.style.marginLeft = '4px';
            gb.addEventListener('click', function () { toggleGpAdmin(u); });
            act.appendChild(gb);
          }
          if (u.active_devices > 0) {
            var lo = el('button', 'Log out all devices', 'btn-light btn-small'); lo.style.marginLeft = '4px';
            lo.addEventListener('click', function () {
              SB.rpc('admin_logout_user_everywhere', { p_user_id: u.user_id })
                .then(function (r) { status(u.username + ': ' + r.sessions_revoked + ' device(s) logged out.', 'ok'); return loadUsers(); })
                .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
            });
            act.appendChild(lo);
          }
          var db = el('button', '🗑 Delete', 'btn-danger btn-small'); db.style.marginLeft = '4px';
          db.addEventListener('click', function () { openDelModal(u); });
          act.appendChild(db);
        }
        tr.appendChild(act);
        tb.appendChild(tr);
      });
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
  }

  // ---------- delete user (database: admin_delete_user) ----------
  var delTarget = null;
  function openDelModal(u) {
    delTarget = u;
    $('delWho').textContent = (u.full_name || u.username) + ' (@' + u.username + ') · ' + (ROLE_LABEL[u.role] || u.role) + (u.gp_name ? ' · ' + u.gp_name : '');
    $('delConfirm').value = ''; $('delSave').disabled = true;
    $('delModal').classList.add('show'); $('delConfirm').focus();
  }
  function closeDel() { $('delModal').classList.remove('show'); delTarget = null; }
  $('delClose').addEventListener('click', closeDel);
  $('delConfirm').addEventListener('input', function () {
    $('delSave').disabled = !delTarget || this.value.trim().toLowerCase() !== delTarget.username;
  });
  $('delSave').addEventListener('click', function () {
    var u = delTarget; if (!u) return;
    loading('Deleting ' + u.username + '...');
    SB.rpc('admin_delete_user', { p_user_id: u.user_id, p_confirm_username: $('delConfirm').value.trim().toLowerCase() })
      .then(function (r) {
        closeDel();
        status('🗑 ' + r.username + ' deleted' + (r.lists_deleted ? ' (with ' + r.lists_deleted + ' list(s))' : '') + '.', 'ok');
        return Promise.all([loadUsers(), loadDashboard()]);
      }).catch(function (e) { if (!e.authLost) { closeDel(); status(errText(e), 'err'); } })
      .then(function () { loading(''); });
  });

  $('refreshUnlinked').addEventListener('click', function () {
    SB.rpc('admin_unlinked_auth_users').then(function (list) {
      var sel = $('linkUser'); sel.innerHTML = '';
      if (!list.length) { $('unlinkedBox').textContent = 'No new user without a profile. Create the user in Supabase first.'; $('linkForm').classList.add('hidden'); return; }
      $('unlinkedBox').textContent = list.length + ' new user(s) found.';
      list.forEach(function (u) { var o = el('option', u.email); o.value = u.user_id; o.dataset.email = u.email; sel.appendChild(o); });
      $('linkForm').classList.remove('hidden'); fillUsername();
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
  });
  function fillUsername() {
    var o = $('linkUser').selectedOptions[0]; var email = o ? o.dataset.email : '';
    var m = /^([a-z0-9_.-]{3,32})@users\.gramg\.invalid$/i.exec(email || '');
    $('linkUsername').value = m ? m[1].toLowerCase() : '';
    $('linkBtn').disabled = !m;
    $('unlinkedBox').textContent = m ? '' : 'This email has the wrong format: it must be username@users.gramg.invalid';
  }
  $('linkUser').addEventListener('change', fillUsername);
  $('linkRole').addEventListener('change', function () { $('linkGp').disabled = this.value !== 'gp_user'; });
  $('linkBtn').addEventListener('click', function () {
    var name = $('linkName').value.trim();
    if (!name) { status('Enter the full name.', 'err'); return; }
    SB.rpc('admin_link_profile', { p_user_id: $('linkUser').value, p_username: $('linkUsername').value, p_full_name: name,
                                    p_role: $('linkRole').value, p_gp_id: Number($('linkGp').value) })
      .then(function () {
        status('✅ Profile added for ' + $('linkUsername').value + '. They can log in now.', 'ok');
        $('linkName').value = ''; $('linkForm').classList.add('hidden'); $('unlinkedBox').textContent = '';
        return loadUsers();
      }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
  });

  // ---------- dashboard (one card per supervisor, one sub-card per list/work) ----------
  var dash = { users: [], rows: [], dups: [], filter: 'all', picked: new Set(), loading: false };
  var STATE_BN = { draft: 'Draft', submitted: 'Submitted', locked: 'Locked', empty: 'No list' };
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
      $('dashUpdated').textContent = 'Last updated: ' + fmtDate(new Date().toISOString());
      loadDataLine(gp);
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { dash.loading = false; });
  }

  // "Last data" line: when and from where this GP's worker data was last updated
  var STALE_DAYS = 7;
  function loadDataLine(gp) {
    return SB.rpc('admin_data_status', { p_gp_id: gp }).then(function (d) {
      var box = $('dataLine'), parts = [], newest = 0;
      if (d.last_sync) { parts.push('ABPS Sync (K-Desk) ' + fmtDate(d.last_sync.at) + ', ' + bn(d.last_sync.changed) + ' changed'); newest = Math.max(newest, Date.parse(d.last_sync.at)); }
      if (d.last_import) { parts.push('Excel import ' + fmtDate(d.last_import.at) + ' (' + d.last_import.file + ')'); newest = Math.max(newest, Date.parse(d.last_import.at)); }
      var old = !newest || Date.now() - newest > STALE_DAYS * 86400000;
      box.className = 'dataline' + (old ? ' old' : '');
      box.textContent = parts.length ? '📅 Last data: ' + parts.join(' · ') + (old ? ' — older than ' + STALE_DAYS + ' days, run an ABPS Sync in K-Desk.' : '')
                                     : '📅 Last data: no import or ABPS Sync yet.';
    }).catch(function () { $('dataLine').textContent = ''; });   // older database without admin_data_status
  }
  function renderDashboard() {
    var S = $('dashStats'); S.innerHTML = '';
    var c = { submitted: 0, draft: 0, locked: 0, short: 0 };
    dash.rows.forEach(function (r) { c[r.submit_state]++; if ((r.supervisors || []).length < reqSup(r.workers)) c.short++; });
    var noList = dash.users.filter(function (u) { return !(u.lists || []).length; }).length;
    function stat(n, label, cls) { var d = el('div', null, 'stat ' + (cls || '')); d.appendChild(el('div', bn(n), 'n')); d.appendChild(el('div', label, 'l')); S.appendChild(d); }
    stat(dash.users.length, 'Supervisors'); stat(dash.rows.length, 'Current lists (works)');
    stat(c.submitted, 'Submitted', 'good'); stat(c.draft, 'Draft (not submitted)', 'warn'); stat(c.locked, 'Locked');
    stat(noList, 'No list'); stat(c.short, 'Too few supervisor names', c.short ? 'bad' : '');
    if (dash.dups.length) stat(dash.dups.length, 'Same worker in two lists (old)', 'bad');

    var D = $('dupBox'); D.innerHTML = '';
    D.classList.toggle('hidden', !dash.dups.length);
    if (dash.dups.length) {
      var det = el('details', null, 'dups'); det.appendChild(el('summary', '⚠ ' + dash.dups.length + ' worker(s) are in more than one list (from before the new rule) — show'));
      var wrap = el('div', null, 'table-wrap'); wrap.style.marginTop = '6px';
      var t = el('table'); var th = el('tr');
      ['Job Card No', 'App', 'Name', 'In the lists of'].forEach(function (h) { th.appendChild(el('th', h)); });
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
    if (!shown) C.appendChild(el('div', dash.users.length ? 'Nothing in this group.' : 'This GP has no supervisors yet. Add them from the Users tab.', 'card muted'));
    updateExportSummary();
  }

  function userCard(u, lists) {
    var card = el('div', null, 'ucard');
    var top = el('div', null, 'top');
    var who = el('div'); who.appendChild(el('div', u.full_name || u.username, 'nm')); who.appendChild(el('div', '@' + u.username + (u.active ? '' : ' · disabled'), 'un'));
    var pills = el('div'); pills.style.textAlign = 'right';
    pills.appendChild(el('span', (u.lists || []).length + ' list(s)', 'pill neutral'));
    if (!u.active) { pills.appendChild(document.createTextNode(' ')); pills.appendChild(el('span', 'User disabled', 'pill off')); }
    top.appendChild(who); top.appendChild(pills); card.appendChild(top);
    card.appendChild(el('div', 'Devices: ' + u.active_devices + ' active · last login ' + fmtDate(u.last_seen), 'meta'));
    if (!(u.lists || []).length) card.appendChild(el('div', 'No current list.', 'muted'));
    lists.forEach(function (l) {
      var r = dash.rows.filter(function (x) { return x.list_id === l.list_id; })[0];
      card.appendChild(listCard(r));
    });
    var acts = el('div', null, 'acts');
    function act(label, cls, fn) { var b = el('button', label, cls + ' btn-small'); b.addEventListener('click', fn); acts.appendChild(b); return b; }
    act('🔑 PIN', 'btn-light', function () { openPinModal(u); });
    act(u.active ? 'Disable user' : 'Enable user', u.active ? 'btn-danger' : 'btn-success', function () {
      if (u.active && !confirm('Disable the account of ' + u.username + '? They are logged out of every device at once.')) return;
      SB.rpc('admin_set_user_active', { p_user_id: u.user_id, p_active: !u.active })
        .then(function () { status(u.username + ' ' + (u.active ? 'disabled' : 'enabled') + '.', 'ok'); return loadDashboard(); })
        .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
    });
    card.appendChild(acts);
    return card;
  }

  // "Demand 8/10 ✓ · Allocation 7/8 ✓" from the results K-Desk wrote back
  function resultsText(res, n) {
    if (!res || !(res.demand_ok + res.demand_err + res.alloc_ok + res.alloc_err)) return '';
    var t = 'Demand ' + res.demand_ok + '/' + (res.demand_ok + res.demand_err);
    if (res.alloc_ok + res.alloc_err) t += ' · Allocation ' + res.alloc_ok + '/' + (res.alloc_ok + res.alloc_err);
    return t + (res.at ? ' (' + fmtDate(res.at) + ')' : '');
  }
  function listCard(r) {
    var st = r.submit_state, n = Number(r.workers || 0), sups = r.supervisors || [], need = reqSup(n);
    var box = el('div', null, 'lcard' + (dash.picked.has(r.list_id) ? ' sel' : ''));
    box.dataset.list = r.list_id;
    var head = el('div', null, 'lhead');
    head.appendChild(el('div', r.work_name || '(no Work Name)', 'lname'));
    head.appendChild(el('span', STATE_BN[st], 'pill ' + st));
    box.appendChild(head);
    var meta = el('div', null, 'meta');
    function line(label, value, cls) { var d = el('div', null, cls || ''); d.appendChild(el('b', label + ': ')); d.appendChild(document.createTextNode(value)); meta.appendChild(d); return d; }
    line('Workers', bn(n) + (r.villages && r.villages.length ? ' · village ' + r.villages.map(vno).join(', ') : ''));
    line('Supervisors', (sups.length ? sups.join(', ') : '—') + (sups.length < need ? '  ⚠ ' + need + ' needed' : ''), sups.length < need ? 'warnline' : '');
    line('Work Code', r.work_code || '— (not set)', r.work_code ? 'mono' : 'muted');
    if (r.submitted_at) line('Submitted', fmtDate(r.submitted_at));
    if (r.kdesk_loaded_at) line('🖥 K-Desk', 'loaded ' + fmtDate(r.kdesk_loaded_at) + (r.export_count > 1 ? ' (' + r.export_count + ' times in all)' : ''), 'kdline');
    else if (r.exported_at) line('Exported', fmtDate(r.exported_at) + (r.export_count > 1 ? ' (' + r.export_count + ' times)' : ''));
    var rt = resultsText(r.results, n);
    if (rt) line('Results', rt, (r.results.demand_err || r.results.alloc_err) ? 'warnline' : 'kdline');
    box.appendChild(meta);
    if (n > 0) {
      var pick = el('label', null, 'pick'); var cb = document.createElement('input'); cb.type = 'checkbox';
      cb.checked = dash.picked.has(r.list_id); cb.dataset.list = r.list_id;
      cb.addEventListener('change', function () {
        if (cb.checked) dash.picked.add(r.list_id); else dash.picked.delete(r.list_id);
        box.classList.toggle('sel', cb.checked); updateExportSummary();
      });
      pick.appendChild(cb); pick.appendChild(document.createTextNode('Add to K-Desk export')); box.appendChild(pick);
    }
    var acts = el('div', null, 'acts');
    function act(label, cls, fn) { var b = el('button', label, cls + ' btn-small'); b.addEventListener('click', fn); acts.appendChild(b); return b; }
    act('👁 View', 'btn-primary', function () { openPreview(r); });
    if ((st === 'submitted' || st === 'draft') && n > 0) act('🔒 Lock', 'btn-light', function () { listAction(r, 'lock'); });
    if (st === 'submitted' || st === 'locked') act('↩ Send back', 'btn-light', function () {
      if (confirm('Make "' + r.work_name + '" (' + r.username + ') a draft again? The supervisor can then change it.')) listAction(r, 'reopen');
    });
    if (st === 'locked') act('✔ Work complete', 'btn-success', function () {
      if (confirm('"' + r.work_name + '" (' + r.username + ') — work complete?\nThe list is closed (it stays in the history) and its ' + n + ' workers can be picked for new work again.')) listAction(r, 'complete');
    });
    if (Number(r.submissions)) act('🕘 Past submissions (' + r.submissions + ')', 'btn-light', function () { openSubmissions(r); });
    box.appendChild(acts);
    return box;
  }

  function listAction(r, action) {
    loading('Please wait...');
    return SB.rpc('admin_set_list_state', { p_list_id: r.list_id, p_action: action })
      .then(function () {
        var msg = { lock: 'locked.', reopen: 'back to draft.', complete: 'work complete — the list is closed and its workers can be picked again.' }[action];
        status('"' + r.work_name + '" (' + r.username + '): ' + msg, 'ok');
        if (action === 'complete') dash.picked.delete(r.list_id);
        return loadDashboard();
      }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  }

  function pickedRows() { return dash.rows.filter(function (r) { return dash.picked.has(r.list_id); }); }
  function updateExportSummary() {
    var rows = pickedRows(), n = 0, notSub = 0, noCode = 0;
    rows.forEach(function (r) { n += Number(r.workers || 0); if (r.submit_state === 'draft') notSub++; if (!r.work_code) noCode++; });
    $('expSummary').textContent = rows.length
      ? rows.length + ' list(s) selected (' + rows.map(function (r) { return (r.work_name || '—') + ' / ' + r.username; }).join(', ') + '), ' + bn(n) + ' workers in all.' +
        (notSub ? ' ⚠ ' + notSub + ' list(s) not submitted yet.' : '') +
        (noCode ? ' ' + noCode + ' list(s) have no Work Code of their own: the Work code below is used for them.' : ' Every selected list has its own Work Code.')
      : 'No list selected.';
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
    loading('Opening past submissions...');
    SB.rpc('admin_list_submissions', { p_list_id: r.list_id }).then(function (subs) {
      $('subTitle').textContent = 'Past submissions — ' + (r.work_name || '') + ' (@' + r.username + ')';
      var box = $('subBody'); box.innerHTML = '';
      (subs || []).forEach(function (s, i) {
        var det = el('details'); if (i === 0) det.open = true;
        det.appendChild(el('summary', fmtDate(s.submitted_at) + ' · ' + bn(s.worker_count) + ' workers · ' + (s.work_name || '') +
          ((s.supervisors || []).length ? ' · Supervisor: ' + s.supervisors.join(', ') : '')));
        var wrap = el('div', null, 'table-wrap'); wrap.style.margin = '6px 0 10px';
        var t = el('table'), thead = el('thead'), th = el('tr');
        ['SL', 'Job Card No', 'App', 'Name'].forEach(function (h) { th.appendChild(el('th', h)); });
        thead.appendChild(th); t.appendChild(thead);
        var tb = el('tbody');
        (s.workers || []).forEach(function (w, k) {
          var tr = el('tr');
          [k + 1, w.job_card_no, w.applicant_no, w.applicant_name].forEach(function (v, ci) { var td = el('td', String(v)); if (ci === 1) td.className = 'mono nw'; tr.appendChild(td); });
          tb.appendChild(tr);
        });
        t.appendChild(tb); wrap.appendChild(t); det.appendChild(wrap); box.appendChild(det);
      });
      if (!(subs || []).length) box.appendChild(el('div', 'No submissions.', 'muted'));
      $('subModal').classList.add('show');
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  }
  $('subClose').addEventListener('click', function () { $('subModal').classList.remove('show'); });

  // ---------- eKYC / ABPS report ----------
  $('ekycBtn').addEventListener('click', function () {
    var gp = Number($('dashGp').value); if (!gp) return;
    loading('Counting...');
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
      ['Total', bn(tot.workers), bn(tot.eligible), bn(tot.no_ekyc), bn(tot.no_abps), bn(tot.no_both)].forEach(function (x) { var td = el('td', x); td.style.fontWeight = '800'; tr.appendChild(td); });
      tb.appendChild(tr);
      $('ekSub').textContent = bn((rep.missing || []).length) + ' active worker(s) have no eKYC or ABPS (they cannot be picked for a list).';
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
      var va = [['Village', 'Total workers', 'eKYC+ABPS done', 'No eKYC', 'No ABPS', 'Neither']];
      (rep.villages || []).forEach(function (v) { va.push([vno(v.village_no), v.workers, v.eligible, v.no_ekyc, v.no_abps, v.no_both]); });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(va), 'By village');
      var ma = [['Village', 'Job Card No', 'Applicant No', 'Applicant Name', 'eKYC', 'ABPS', 'Aadhaar Seeded', 'Authentication Done']];
      (rep.missing || []).forEach(function (w) { ma.push([vno(w.village_no), w.job_card_no, String(w.applicant_no), w.applicant_name, yn(w.ekyc), yn(w.abps), yn(w.aadhaar_seeded), yn(w.authentication_done)]); });
      var ws = XLSX.utils.aoa_to_sheet(ma); ws['!cols'] = [{ wch: 7 }, { wch: 26 }, { wch: 8 }, { wch: 30 }, { wch: 6 }, { wch: 6 }, { wch: 10 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, ws, 'No eKYC-ABPS');
      XLSX.writeFile(wb, 'eKYC_ABPS_' + g.name.replace(/[^A-Za-z0-9_-]+/g, '_') + '_' + new Date().toISOString().slice(0, 10) + '.xlsx');
    }).catch(function (e) { status(errText(e), 'err'); });
  });

  // ---------- K-Desk export ----------
  function ddmmyyyy(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  // Pure function (also used by tests): API rows -> K-Desk sheet rows + report.
  // codeByList (optional): list_id -> that list's own Work Code; workCode is used for the rest.
  function buildKdeskRows(apiRows, from, days, workCode, codeByList) {
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
    out.forEach(function (r, i) { aoa.push([i + 1, r.job_card_no, r.applicant_name, from, days, (codeByList && codeByList[r.list_id]) || workCode]); });
    return { aoa: aoa, count: out.length, skipped: skipped, dupes: dupes };
  }
  window.GramgKdesk = { buildKdeskRows: buildKdeskRows, ddmmyyyy: ddmmyyyy };

  $('expBtn').addEventListener('click', function () {
    var rows = pickedRows();
    var from = ddmmyyyy($('expFrom').value), days = parseInt($('expDays').value, 10), work = $('expWork').value.trim();
    var codeByList = {}; rows.forEach(function (r) { if (r.work_code) codeByList[r.list_id] = r.work_code; });
    var needCode = rows.some(function (r) { return !r.work_code; });
    if (!rows.length) { status('Select lists first.', 'err'); return; }
    if (!from) { status('Enter From (work date).', 'err'); return; }
    if (!(days >= 1 && days <= 366)) { status('Enter valid Days (1 to 366).', 'err'); return; }
    if (needCode && !work) { status('Enter the Work code (some selected lists have no Work Code of their own).', 'err'); return; }
    var notSub = rows.filter(function (r) { return r.submit_state === 'draft'; });
    if (notSub.length && !confirm(notSub.map(function (r) { return r.username; }).join(', ') + ' has not submitted the list yet. Export anyway?')) return;
    var doLock = $('expLock').checked;
    loading('Creating the K-Desk file...');
    var report;
    loadXlsx().then(function () {
      return SB.rpc('admin_export_lists', { p_list_ids: rows.map(function (r) { return r.list_id; }) });
    }).then(function (apiRows) {
      report = buildKdeskRows(apiRows || [], from, days, work, codeByList);
      if (!report.count) throw { hint: 'There are no workers to export.' };
      var ws = XLSX.utils.aoa_to_sheet(report.aoa);
      ws['!cols'] = [{ wch: 6 }, { wch: 26 }, { wch: 30 }, { wch: 12 }, { wch: 6 }, { wch: 30 }];
      var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Demand');
      var safe = (work || rows[0].work_code || 'list').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
      XLSX.writeFile(wb, 'KDesk_Demand_' + safe + '_' + from.replace(/\//g, '-') + '.xlsx');
      if (!doLock) return null;
      return rows.filter(function (r) { return r.submit_state !== 'locked'; }).reduce(function (p, r) {
        return p.then(function () { return SB.rpc('admin_set_list_state', { p_list_id: r.list_id, p_action: 'lock' }); });
      }, Promise.resolve());
    }).then(function () {
      var msg = '✅ K-Desk file created: ' + bn(report.count) + ' workers.';
      if (report.dupes) msg += ' ' + report.dupes + ' worker(s) were in more than one list and appear once.';
      if (report.skipped.length) msg += ' ⚠ ' + report.skipped.length + ' skipped (now inactive or no eKYC/ABPS): ' +
        report.skipped.slice(0, 10).map(function (r) { return r.job_card_no + ' ' + r.applicant_name; }).join('; ') + (report.skipped.length > 10 ? ' …' : '');
      if (doLock) msg += ' The lists were locked.';
      status(msg, report.skipped.length ? 'info' : 'ok');
      return loadDashboard();
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  });

  // ---------- K-Desk activity (database: admin_kdesk_activity) ----------
  var KD_ACTION = { lists_loaded_kdesk: '⭳ Lists loaded', lists_locked_kdesk: '🔒 Lists locked', flags_synced_kdesk: '🔄 ABPS Sync', results_reported_kdesk: '📋 Results written back' };
  function kdDetails(a) {
    var d = a.details || {};
    if (a.action === 'flags_synced_kdesk') return bn(d.rows_in) + ' rows in report, ' + bn(d.matched) + ' matched, ' + bn(d.changed) + ' changed';
    if (a.action === 'results_reported_kdesk') return (d.demand ? 'Demand: ' + bn(d.demand_ok) + ' ok of ' + bn(d.demand) : '') + (d.alloc ? (d.demand ? ' · ' : '') + 'Allocation: ' + bn(d.alloc_ok) + ' ok of ' + bn(d.alloc) : '') || '—';
    if (a.action === 'lists_locked_kdesk') return bn(d.locked) + ' locked';
    return '';
  }
  $('kdActBtn').addEventListener('click', function () {
    var gp = Number($('dashGp').value); if (!gp) return;
    loading('Loading K-Desk activity...');
    SB.rpc('admin_kdesk_activity', { p_gp_id: gp, p_limit: 30 }, { retry: true }).then(function (rep) {
      var g = state.gps.filter(function (x) { return x.id === gp; })[0];
      $('kdSub').textContent = (g ? g.name + ' · ' : '') + 'what the K-Desk extension did for this GP (latest first).';
      var S = $('kdStats'); S.innerHTML = '';
      function stat(n, label, cls) { var d = el('div', null, 'stat ' + (cls || '')); d.appendChild(el('div', n, 'n')); d.appendChild(el('div', label, 'l')); S.appendChild(d); }
      var ls = rep.last_sync;
      stat(ls ? fmtDate(ls.at) : 'never', 'Last ABPS Sync', ls ? '' : 'warn');
      if (ls) { stat(bn(ls.matched), 'Workers matched'); stat(bn(ls.changed), 'eKYC/ABPS changed', ls.changed ? 'good' : ''); }
      var tb = $('kdBody'); tb.innerHTML = '';
      (rep.events || []).forEach(function (a) {
        var tr = el('tr');
        [fmtDate(a.at), KD_ACTION[a.action] || a.action, (a.lists || []).join(', '), kdDetails(a), a.username || '—'].forEach(function (v) { tr.appendChild(el('td', v)); });
        tb.appendChild(tr);
      });
      if (!(rep.events || []).length) { var tr = el('tr'); var td = el('td', 'No K-Desk activity yet.'); td.colSpan = 5; tr.appendChild(td); tb.appendChild(tr); }
      $('kdModal').classList.add('show');
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  });
  $('kdClose').addEventListener('click', function () { $('kdModal').classList.remove('show'); });

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

  // ---------- create supervisor / K-Desk login (Edge Function) ----------
  $('nuBtn').addEventListener('click', function () {
    var name = $('nuName').value.trim(), un = $('nuUsername').value.trim().toLowerCase(), pin = $('nuPin').value.trim();
    var gp = Number($('nuGp').value), role = $('nuRole').value;
    var bad = !name ? 'BAD_NAME' : !/^[a-z0-9_.-]{3,32}$/.test(un) ? 'BAD_USERNAME' : weakPin(pin) || (!gp ? 'BAD_GP' : null);
    if (bad) { status(errText({ code: bad }), 'err'); return; }
    var what = role === 'kdesk' ? 'K-Desk login' : 'supervisor';
    loading('Creating the ' + what + '...');
    SB.callFunction('admin-users', { action: 'create_user', username: un, full_name: name, pin: pin, gp_id: gp, role: role })
      .then(function (r) {
        status('✅ ' + r.username + ' (' + what + ') created. Login: username "' + r.username + '", PIN "' + pin + '". Give the PIN to them yourself.', 'ok');
        $('nuName').value = ''; $('nuUsername').value = ''; $('nuPin').value = '';
        return Promise.all([loadUsers(), loadDashboard()]);
      }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  });

  // ---------- new GP Admin + K-Desk login (Super Admin; Edge Function) ----------
  onlyDigits($('gaPin')); onlyDigits($('gaKdPin'));
  ['gaUsername', 'gaKdUsername'].forEach(function (id) {
    $(id).addEventListener('input', function () { var v = this.value.toLowerCase().replace(/\s+/g, ''); if (v !== this.value) this.value = v; });
  });
  $('gaPinGen').addEventListener('click', function () { $('gaPin').value = randomPin(); });
  $('gaKdPinGen').addEventListener('click', function () { $('gaKdPin').value = randomPin(); });
  $('gaJump').addEventListener('click', function () { $('gaCard').scrollIntoView({ behavior: 'smooth' }); $('gaName').focus(); });
  function gpSlug(g) { return (String(g.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20)) || ('gp' + g.id); }
  function gpOf(id) { return state.gps.filter(function (x) { return x.id === id; })[0] || { id: id, name: 'GP' + id }; }
  function kdeskOf(gp) { return state.users.filter(function (u) { return u.role === 'kdesk' && u.gp_id === gp; })[0]; }
  // Fill the form for the chosen GP: suggested usernames and fresh PINs; K-Desk only if the GP has none yet.
  var gaAuto = { un: '', kun: '' };
  function gaPrefill() {
    var gp = Number($('gaGp').value); if (!gp) return;
    var g = gpOf(gp), slug = gpSlug(g), kd = kdeskOf(gp);
    if (!$('gaUsername').value || $('gaUsername').value === gaAuto.un) $('gaUsername').value = gaAuto.un = slug + '.admin';
    if (!$('gaPin').value) $('gaPin').value = randomPin();
    if (!$('gaKdUsername').value || $('gaKdUsername').value === gaAuto.kun) $('gaKdUsername').value = gaAuto.kun = slug + '.kdesk';
    if (!$('gaKdPin').value) $('gaKdPin').value = randomPin();
    $('gaKdBox').classList.toggle('hidden', !!kd);
    $('gaKdNote').textContent = kd ? g.name + ' already has a K-Desk login (' + kd.username + '), so no new one is made.'
      : 'The GP\'s K-Desk login is created automatically with it (username and PIN are filled in for you; change them if you like).';
  }
  $('gaGp').addEventListener('change', gaPrefill);
  // Make the GP's K-Desk login if it has none. Resolves to a text line for the login details.
  function ensureKdesk(gp, kun, kpin) {
    if (kdeskOf(gp)) return Promise.resolve('K-Desk extension login: already exists (' + kdeskOf(gp).username + ')');
    var g = gpOf(gp);
    kun = kun || gpSlug(g) + '.kdesk'; kpin = kpin || randomPin();
    loading('Creating the K-Desk login...');
    return SB.callFunction('admin-users', { action: 'create_user', username: kun, full_name: g.name + ' K-Desk', pin: kpin, gp_id: gp, role: 'kdesk' })
      .then(function () { return 'K-Desk extension login\n  Username: ' + kun + '\n  PIN: ' + kpin; })
      .catch(function (e) { if (e.authLost) throw e; return '⚠ K-Desk login NOT created: ' + errText(e) + ' Create it with "New user" (Type: K-Desk login).'; });
  }
  function showCreds(lines) { $('gaCreds').textContent = lines.join('\n'); $('gaCreds').classList.remove('hidden'); }
  function toggleGpAdmin(u) {
    var to = u.role === 'gp_admin' ? 'gp_user' : 'gp_admin';
    var q = to === 'gp_admin'
      ? 'Make ' + u.username + ' the GP Admin of ' + (u.gp_name || 'this GP') + '? They open the Admin panel for this GP only (no phone list building). Their PIN stays the same; they are logged out of every device.' + (kdeskOf(u.gp_id) ? '' : ' A K-Desk login for the GP is made too.')
      : 'Make ' + u.username + ' a Supervisor again? They lose the Admin panel.';
    if (!confirm(q)) return;
    loading('Changing the role...');
    SB.rpc('admin_set_user_role', { p_user_id: u.user_id, p_role: to })
      .then(function () {
        if (to !== 'gp_admin') { status(u.username + ' is now a Supervisor.', 'ok'); return null; }
        return ensureKdesk(u.gp_id).then(function (kdLine) {
          showCreds(['GP: ' + (u.gp_name || ''), '', 'Admin panel login (GP Admin)', '  Username: ' + u.username, '  PIN: (their current PIN)', '', kdLine]);
          status('✅ ' + u.username + ' is now GP Admin of ' + (u.gp_name || 'the GP') + '. Login details are in the "New GP Admin" box below.', 'ok');
        });
      })
      .then(function () { return loadUsers(); })
      .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  }
  $('gaBtn').addEventListener('click', function () {
    var gp = Number($('gaGp').value), name = $('gaName').value.trim();
    var un = $('gaUsername').value.trim(), pin = $('gaPin').value.trim();
    var withKd = !kdeskOf(gp), kun = $('gaKdUsername').value.trim(), kpin = $('gaKdPin').value.trim();
    var bad = !gp ? 'BAD_GP' : !name ? 'BAD_NAME' : !/^[a-z0-9_.-]{3,32}$/.test(un) ? 'BAD_USERNAME' : weakPin(pin);
    if (!bad && withKd) bad = !/^[a-z0-9_.-]{3,32}$/.test(kun) || kun === un ? 'BAD_USERNAME' : weakPin(kpin);
    if (bad) { status(errText({ code: bad }), 'err'); return; }
    var g = state.gps.filter(function (x) { return x.id === gp; })[0] || { name: 'GP' };
    var lines = ['GP: ' + g.name];
    $('gaCreds').classList.add('hidden');
    loading('Creating the GP Admin...');
    SB.callFunction('admin-users', { action: 'create_user', username: un, full_name: name, pin: pin, gp_id: gp, role: 'gp_admin' })
      .then(function () {
        lines.push('', 'Admin panel login (GP Admin)', '  Username: ' + un, '  PIN: ' + pin);
        return ensureKdesk(gp, kun, kpin).then(function (kdLine) { lines.push('', kdLine); });
      })
      .then(function () {
        showCreds(lines);
        status('✅ GP Admin for ' + g.name + ' created. Login details are below the form: give them to the GP yourself.', 'ok');
        ['gaName', 'gaUsername', 'gaPin', 'gaKdUsername', 'gaKdPin'].forEach(function (id) { $(id).value = ''; });
        return loadUsers();   // refills the form with fresh suggestions
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
    loading('Changing the PIN...');
    SB.callFunction('admin-users', { action: 'reset_pin', user_id: u.user_id, pin: pin })
      .then(function (r) {
        closePin();
        status('✅ New PIN for ' + r.username + ': "' + pin + '". They were logged out of every device.', 'ok');
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
    loading('Opening the list...');
    return SB.rpc('admin_list_items', { p_list_id: r.list_id }).then(function (d) {
      pv.data = d;
      $('pvTitle').textContent = (d.work_name || '(no Work Name)') + ' — ' + (d.full_name || d.username) + ' (@' + d.username + ')';
      $('pvSub').textContent = STATE_BN[d.submit_state] + (d.submitted_at ? ' · submitted: ' + fmtDate(d.submitted_at) : '') +
        (Number(d.submissions) ? ' · past submissions: ' + d.submissions : '');
      var items = d.items || [], noAcc = 0, dup = 0, bad = 0, vs = {};
      items.forEach(function (x) { if (!x.account_no) noAcc++; if (x.in_other_lists > 0) dup++; if (!x.active || !x.eligible) bad++; vs[x.village_no] = true; });
      var need = Number(d.required_supervisors) || 1, have = (d.supervisors || []).length;
      var S = $('pvStats'); S.innerHTML = '';
      function stat(n, label, cls) { var e = el('div', null, 'stat ' + (cls || '')); e.appendChild(el('div', typeof n === 'string' ? n : bn(n), 'n')); e.appendChild(el('div', label, 'l')); S.appendChild(e); }
      stat(items.length, 'Workers'); stat(Object.keys(vs).length, 'Villages');
      stat(have + '/' + need, 'Supervisors (given/needed)', have < need ? 'bad' : 'good');
      stat(noAcc, 'No account', noAcc ? 'warn' : ''); if (dup) stat(dup, 'Also in another list', 'bad');
      stat(bad, 'Now inactive / no eKYC-ABPS', bad ? 'bad' : '');
      $('pvWork').value = d.work_name || '';
      $('pvCode').value = d.work_code || '';
      var dOk = 0, dAll = 0, aOk = 0, aAll = 0;
      items.forEach(function (x) { if (x.demand_status) { dAll++; if (x.demand_status === 'done') dOk++; } if (x.alloc_status) { aAll++; if (x.alloc_status === 'done') aOk++; } });
      if (dAll) { stat(dOk + '/' + dAll, 'Demand done (K-Desk)', dOk < dAll ? 'warn' : 'good'); }
      if (aAll) { stat(aOk + '/' + aAll, 'Allocation done (K-Desk)', aOk < aAll ? 'warn' : 'good'); }
      $('pvKdesk').textContent = d.exported_at ? '🖥 Last taken to K-Desk / exported: ' + fmtDate(d.exported_at) + (d.export_count > 1 ? ' (' + d.export_count + ' times)' : '') : 'Not taken to K-Desk yet.';
      $('pvSups').value = (d.supervisors || []).join(', ');
      if (first) {
        var sel = $('pvVillage'); sel.innerHTML = '';
        var o = el('option', 'All villages'); o.value = ''; sel.appendChild(o);
        Object.keys(vs).map(Number).sort(function (a, b) { return a - b; }).forEach(function (v) { var oo = el('option', 'Village ' + vno(v)); oo.value = v; sel.appendChild(oo); });
        $('pvSearch').value = ''; $('pvAddInput').value = ''; $('pvAddResults').innerHTML = '';
      }
      $('pvPick').checked = dash.picked.has(r.list_id);
      renderListPreview(); $('pvModal').classList.add('show');
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  }
  var RES = { done: 'Success', error: 'Error', skipped: 'Skipped' };
  function resCell(s, msg, at) {
    var td = el('td', s ? (s === 'done' ? '✓ ' : '✕ ') + RES[s] : '—', s ? (s === 'done' ? 'res-ok' : 'res-bad') : 'muted');
    td.title = (msg || '') + (at ? (msg ? ' · ' : '') + fmtDate(at) : ''); td.style.whiteSpace = 'nowrap';
    return td;
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
      tr.appendChild(resCell(x.demand_status, x.demand_msg, x.demand_at)); tr.appendChild(resCell(x.alloc_status, x.alloc_msg, x.alloc_at));
      var notes = [];
      if (!x.active) notes.push('inactive'); else if (!x.eligible) notes.push('no eKYC/ABPS');
      if (x.in_other_lists > 0) notes.push('also in another list');
      if (!x.account_no) notes.push('no account');
      tr.appendChild(el('td', notes.join(', ')));
      var tdx = el('td'); var rb = el('button', '✕', 'btn-light btn-small'); rb.title = 'Remove from this list';
      rb.addEventListener('click', function () {
        if (!confirm('Remove ' + x.applicant_name + ' (' + x.job_card_no + ') from this list?')) return;
        editList([], [x.worker_id], x.applicant_name + ' removed.');
      });
      tdx.appendChild(rb); tr.appendChild(tdx);
      tb.appendChild(tr);
    });
    if (!sl) { var tr = el('tr'); var td = el('td', 'Nothing found.'); td.colSpan = 12; tr.appendChild(td); tb.appendChild(tr); }
  }
  function editList(add, remove, okMsg) {
    loading('Changing the list...');
    return SB.rpc('admin_edit_list', { p_list_id: pv.row.list_id, p_add: add, p_remove: remove }).then(function (r) {
      var rej = r.rejected || [];
      var why = { IN_OTHER_LIST: 'in another list', NOT_ELIGIBLE: 'no eKYC/ABPS', INACTIVE: 'inactive', NOT_FOUND: 'not in this GP' };
      status(rej.length ? ('⚠ Not added: ' + rej.map(function (x) { return why[x.reason] || x.reason; }).join(', ')) : ('✅ ' + okMsg), rej.length ? 'err' : 'ok');
      return Promise.all([loadPreview(false), loadDashboard()]);
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  }
  $('pvMetaSave').addEventListener('click', function () {
    var name = $('pvWork').value.trim();
    var sups = $('pvSups').value.split(/[,\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (!name) { status('Enter the Work Name.', 'err'); return; }
    loading('Saving...');
    SB.rpc('admin_set_list_meta', { p_list_id: pv.row.list_id, p_work_name: name, p_supervisors: sups }).then(function () {
      status('✅ Work Name / supervisors saved.', 'ok');
      return Promise.all([loadPreview(false), loadDashboard()]);
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  });
  $('pvCodeSave').addEventListener('click', function () {
    var code = $('pvCode').value.replace(/\s+/g, '');
    if (code && !/^[^\/]+\/[A-Za-z]{2,3}\/[^\/]+/.test(code)) { status(errText({ code: 'BAD_WORK_CODE' }), 'err'); return; }
    loading('Saving...');
    SB.rpc('admin_set_list_work_code', { p_list_id: pv.row.list_id, p_work_code: code }).then(function (r) {
      status(r.work_code ? '✅ Work Code saved: ' + r.work_code + '. K-Desk fills it in when this list is loaded.' : '✅ Work Code removed.', 'ok');
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
    if (!pairs.length) { box.appendChild(el('div', 'Enter a Job Card, e.g. 002/012 (village/household) or the full number.', 'muted')); return; }
    SB.rpc('admin_search_households', { p_gp_id: pv.data.gp_id, p_villages: pairs.map(function (p) { return p.v; }), p_households: pairs.map(function (p) { return p.h; }) })
      .then(function (rows) {
        if (!(rows || []).length) { box.appendChild(el('div', 'Nobody found.', 'muted')); return; }
        rows.forEach(function (w) {
          var row = el('div', null, 'addrow');
          row.appendChild(el('span', w.job_card_no + ' · ' + w.applicant_name + ' · eKYC ' + (w.ekyc ? '✓' : '✗') + ' ABPS ' + (w.abps ? '✓' : '✗'), 'mono'));
          if (w.taken_list_id === pv.row.list_id) row.appendChild(el('span', 'in this list', 'pill on'));
          else if (w.taken_list_id) row.appendChild(el('span', 'in "' + w.taken_work + '" (' + w.taken_username + ')', 'pill off'));
          else if (!w.eligible) row.appendChild(el('span', 'no eKYC/ABPS', 'pill off'));
          else {
            var b = el('button', '➕ Add', 'btn-success btn-small');
            b.addEventListener('click', function () { editList([w.id], [], w.applicant_name + ' added.').then(function () { $('pvAddBtn').click(); }); });
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
      var aoa = [['SL No', 'Job Card No', 'Applicant Name', 'eKYC', 'ABPS', 'Account No', 'IFSC Code', 'Demand', 'Demand result', 'Allocation', 'Allocation result']];
      (pv.data.items || []).forEach(function (x, i) { aoa.push([i + 1, x.job_card_no, x.applicant_name, yn(x.ekyc), yn(x.abps), x.account_no || '', x.ifsc || '',
        RES[x.demand_status] || '', x.demand_msg || '', RES[x.alloc_status] || '', x.alloc_msg || '']); });
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 6 }, { wch: 26 }, { wch: 30 }, { wch: 6 }, { wch: 6 }, { wch: 20 }, { wch: 13 }, { wch: 9 }, { wch: 28 }, { wch: 10 }, { wch: 28 }];
      var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'List');
      var info = [['Work Name', pv.data.work_name || ''], ['Work Code', pv.data.work_code || ''], ['Supervisor', (pv.data.supervisors || []).join(', ')], ['Workers', (pv.data.items || []).length], ['Username', pv.data.username]];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(info), 'Work Info');
      XLSX.writeFile(wb, 'List_' + pv.data.username + '_' + String(pv.data.work_name || '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 30) + '_' + new Date().toISOString().slice(0, 10) + '.xlsx');
    }).catch(function (e) { status(errText(e), 'err'); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { ['pvModal', 'subModal', 'ekModal', 'kdModal'].forEach(function (m) { $(m).classList.remove('show'); }); closePin(); closeDel(); }
  });

  // ---------- add a GP ----------
  $('gpPrefix').addEventListener('input', function () { var v = this.value.toUpperCase(); if (v !== this.value) this.value = v; });
  $('gpAddBtn').addEventListener('click', function () {
    var name = $('gpName').value.trim(), prefix = $('gpPrefix').value.trim().toUpperCase();
    if (name.length < 2) { status('Enter the GP name.', 'err'); return; }
    if (!/^WB-\d{2}-\d{3}-\d{3}$/.test(prefix)) { status(errText({ code: 'BAD_PREFIX' }), 'err'); return; }
    if (!confirm('New GP: ' + name + ' (' + prefix + ')\nAdd it?')) return;
    loading('Adding the GP...');
    SB.rpc('admin_add_gp', { p_jc_prefix: prefix, p_name: name }).then(function (g) {
      status('✅ ' + g.name + ' (' + g.jc_prefix + ') added. Now pick the GP below and import its data, then create supervisors in the Users tab.', 'ok');
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
    loading('Making the backup... (workers)');
    function pageWorkers(after) {
      return SB.rpc('admin_backup_workers', { p_gp_id: gp, p_after_id: after, p_limit: 5000 }, { retry: true }).then(function (r) {
        var rows = (r && r.rows) || [];
        workers = workers.concat(rows);
        $('loadingText').textContent = 'Making the backup... ' + bn(workers.length) + ' workers';
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
        var la = [['Username', 'List status', 'Submit status', 'Work Name', 'Created', 'Submitted', 'Locked', 'Exported', 'Job Card No', 'Applicant No', 'Applicant Name']];
        lists.forEach(function (x) {
          la.push([x.username, x.status === 'active' ? 'Current' : 'Past round', STATE_BN[x.submit_state] || x.submit_state, x.work_name || '',
                   fmtDate(x.created_at), x.submitted_at ? fmtDate(x.submitted_at) : '', x.locked_at ? fmtDate(x.locked_at) : '',
                   x.exported_at ? fmtDate(x.exported_at) : '', x.job_card_no, String(x.applicant_no), x.applicant_name]);
        });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(la), 'Lists');
        var ua = [['Username', 'Name', 'Role', 'Status', 'Last login']];
        users.forEach(function (x) { ua.push([x.username, x.full_name, x.role === 'super_admin' ? 'Super Admin' : x.role === 'kdesk' ? 'K-Desk' : x.role === 'gp_admin' ? 'GP Admin' : 'Supervisor', x.active ? 'Active' : 'Disabled', x.last_seen ? fmtDate(x.last_seen) : '']); });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ua), 'Users');
        var d = new Date(), stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        XLSX.writeFile(wb, 'GramG_Backup_' + g.name.replace(/[^A-Za-z0-9_-]+/g, '_') + '_' + stamp + '.xlsx');
        var msg = '✅ Backup downloaded: ' + bn(workers.length) + ' workers, ' + bn(lists.length) + ' list rows, ' + bn(users.length) + ' users.';
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
