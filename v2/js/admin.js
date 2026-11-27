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
  // message = small pop-up (toast) at the top right; OK / info close by themselves, errors stay until tapped
  var statusTimer = null;
  function status(msg, kind) {
    var el = $('status'); el.textContent = msg || ''; el.className = 'status' + (msg ? ' show ' + (kind || 'info') : '');
    clearTimeout(statusTimer);
    if (msg && kind !== 'err') statusTimer = setTimeout(function () { el.className = 'status'; }, 6000);
  }
  $('status').addEventListener('click', function () { this.className = 'status'; });
  function loading(text) { $('loadingText').textContent = text || 'Loading...'; $('loading').classList.toggle('show', !!text); }
  // own Yes/No box: browser confirm() can be blocked silently on phones
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
  // Yes/No box with a text box; resolves to the text, or null when cancelled
  function askText(msg, value, yes) {
    var inp = $('askInput'); inp.value = value || ''; inp.classList.remove('hidden');
    var p = ask(msg, yes, 'danger');
    setTimeout(function () { inp.focus(); inp.select(); }, 30);
    return p.then(function (ok) { inp.classList.add('hidden'); return ok ? inp.value : null; });
  }
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
      ALREADY_DONE: 'This photo was already verified or returned. Refresh.', NEED_REASON: 'Write a reason.',
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
  // read-only functions that several parts of the panel ask at the same moment (Today page,
  // Dashboard, badges, DB version check): one request is shared while it is running (sb-client.js)
  if (SB.shareReads) SB.shareReads(['get_my_context', 'admin_list_gps', 'admin_dashboard', 'admin_list_duplicates', 'admin_list_extras',
    'admin_import_history', 'admin_list_users', 'admin_list_viewers', 'admin_data_status', 'db_version', 'admin_count_account_requests',
    'admin_account_photos', 'admin_marks_list', 'admin_portal_missing', 'admin_portal_new_count', 'admin_pipeline', 'admin_pipeline_mrs',
    'admin_worker_stats', 'admin_get_signup_link', 'admin_list_account_requests']);

  // ---------- boot ----------
  function boot() {
    if (!SB.hasSession()) { location.replace('./index.html'); return; }
    loading('Opening the admin panel...');
    // Speed (2026-11-20): after register_session, the login context and the GP list are asked
    // together, then Dashboard, History and Users load side by side (before: 7 requests one after another).
    var gpsReq = null;
    SB.rpc('register_session', { p_user_agent: String(navigator.userAgent).slice(0, 300) })
      .then(function () {
        gpsReq = SB.rpc('admin_list_gps'); gpsReq.catch(function () {});   // a supervisor gets NOT_AUTHORIZED here: ignored
        return SB.rpc('get_my_context');
      })
      .then(function (ctx) {
        if (ctx.role !== 'super_admin' && ctx.role !== 'gp_admin') { location.replace('./index.html'); return; }
        me.role = ctx.role; me.gp = ctx.gp_id; me.gpName = ctx.gp_name || '';
        $('who').textContent = ctx.full_name || ctx.username;
        if (me.role === 'super_admin') {
          try { view.gp = Number(localStorage.getItem(VIEW_KEY)) || null; } catch (_e) { view.gp = null; }
        }
        return loadGps(gpsReq).then(function () { applyView(false); })
          .then(function () { return Promise.all([loadDashboard(), loadHistory(), loadUsers()]); })
          .then(function () { photoCleanupAll(); photoBadge(); });
      })
      .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  }

  function loadGps(req) {
    return (req || SB.rpc('admin_list_gps')).then(function (gps) {
      state.gps = gps || [];
      if (view.gp && !state.gps.some(function (g) { return g.id === view.gp; })) view.gp = null;
      fillGpSelects(); fillRenameGp();
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
    [$('gpSelect'), $('linkGp'), $('dashGp'), $('nuGp'), $('gaGp'), $('phGp')].forEach(function (sel) {
      var keep = sel.value; sel.innerHTML = '';
      if (!keep) { try { keep = localStorage.getItem('gramg2.gp') || ''; } catch (_e) { keep = ''; } }   // the one GP picker (admin-shell.js)
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
      ['dash', 'iay', 'photos', 'import', 'history', 'users'].forEach(function (t) { $('tab-' + t).classList.toggle('hidden', t !== b.dataset.tab); });
      if (b.dataset.tab === 'iay' && window.IayDash) window.IayDash.show();
      if (b.dataset.tab === 'photos') loadPhotos(true);
      if (b.dataset.tab === 'dash') loadDashboard();
      if (b.dataset.tab === 'history') loadHistory();
      if (b.dataset.tab === 'users') loadUsers();
    });
  });

  // ---------- account copy photos (v239: 4 steps + full-page Account check) ----------
  var BUCKET = 'account-copies';
  var ph = { filter: 'done', step: 'check', rows: [], cur: null, ready: true, q: '', z: 1, rot: 0, x: 0, y: 0, undo: null };
  function phSetupMissing(e) { return e && (e.status === 404 || /admin_account_photo/.test(e.message || '')); }
  var V239 = 'Run supabase/2026-11-27_account_check_v239.sql in the Supabase SQL Editor first.';
  // Delete files whose time is over (new: 30 days, Verified / Returned: 7 days) — any admin page open does this.
  function photoCleanup(gp) {
    return SB.rpc('admin_account_photo_cleanup', { p_gp_id: gp }).then(function (rows) {
      rows = rows || [];
      if (!rows.length) return 0;
      var paths = rows.map(function (r) { return r.path; });
      var chunks = [];
      for (var i = 0; i < paths.length; i += 100) chunks.push(paths.slice(i, i + 100));
      return chunks.reduce(function (p, c) { return p.then(function () { return SB.photos.remove(c); }); }, Promise.resolve())
        .then(function () { return SB.rpc('admin_account_photo_purged', { p_ids: rows.map(function (r) { return r.id; }) }); });
    });
  }
  function photoCleanupAll() {
    var lim = gpView();
    var gps = state.gps.filter(function (g) { return !lim || g.id === lim; });
    return gps.reduce(function (p, g) { return p.then(function () { return photoCleanup(g.id).catch(function (e) { if (phSetupMissing(e)) ph.ready = false; }); }); }, Promise.resolve());
  }
  function setBadge(n) {
    $('phBadge').textContent = n ? String(n) : ''; $('phBadge').classList.toggle('hidden', !n);
    $('acN-check').textContent = String(n || 0);
  }
  function photoBadge() {
    var gp = Number($('phGp').value); if (!gp || !ph.ready) return;
    SB.rpc('admin_account_photos', { p_gp_id: gp, p_status: 'new' }).then(function (r) { setBadge((r && r.new_count) || 0); }, function () {});
  }
  function loadPhotos(clean) {
    var gp = Number($('phGp').value); if (!gp) return Promise.resolve();
    loading('Loading account copies...');
    return (clean ? photoCleanup(gp).catch(function (e) { if (phSetupMissing(e)) throw e; }) : Promise.resolve())
      .then(function () { return SB.rpc('admin_account_photos', { p_gp_id: gp, p_status: 'all' }); })
      .then(function (r) {
        ph.ready = true;
        ph.rows = (r && r.rows) || [];
        setBadge((r && r.new_count) || 0);
        var mb = ((r && r.stored_bytes) || 0) / 1048576;
        $('phStore').textContent = 'ছবি রাখা আছে ' + mb.toFixed(1) + ' MB' + (r && r.all_gps ? ' (সব GP)' : '');
        renderPhotos();
        loadRequests();
      })
      .catch(function (e) {
        if (e.authLost) return;
        if (phSetupMissing(e)) { ph.ready = false; $('phCards').innerHTML = ''; status('Account copy is not set up yet: run supabase/2026-10-31_account_copy.sql in the Supabase SQL Editor.', 'err'); return; }
        status(errText(e), 'err');
      })
      .then(function () { loading(''); });
  }
  function newRows() {   // ② list: oldest first
    return ph.rows.filter(function (r) { return r.status === 'new'; })
      .sort(function (a, b) { return String(a.uploaded_at).localeCompare(String(b.uploaded_at)); });
  }
  function ago(s) {
    if (!s) return '';
    var d = Math.floor((Date.now() - new Date(s).getTime()) / 86400000);
    if (d <= 0) return 'আজ ' + new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return d === 1 ? 'কাল' : d + ' দিন আগে';
  }
  function hit(r) {
    if (!ph.q) return true;
    return [r.applicant_name, r.job_card_no, vno(r.village_no), r.uploaded_by, r.sent_account_no, r.holder_name]
      .join(' ').toLowerCase().indexOf(ph.q) >= 0;
  }
  function accTag(r) {
    if (!r.account_no) return el('span', 'account নেই', 'ac-tag w');
    var same = r.account_no === r.sent_account_no && (!r.sent_ifsc || r.ifsc === r.sent_ifsc);
    var w = el('span'); w.appendChild(el('span', r.account_no, 'mono jc'));
    if (r.sent_account_no) w.appendChild(el('span', same ? 'একই' : 'আলাদা', 'ac-tag ' + (same ? 'g' : 'r')));
    return w;
  }
  function setStep(s) {
    ph.step = s;
    document.querySelectorAll('#acTiles button').forEach(function (b) { b.classList.toggle('on', b.dataset.step === s); });
    ['req', 'check', 'kdesk', 'done'].forEach(function (k) { $('acP-' + k).classList.toggle('hidden', k !== s); });
  }
  function renderPhotos() {
    var box = $('phCards'); box.innerHTML = '';
    var nw = newRows(), list = nw.filter(hit);
    $('acS-check').textContent = nw.length ? 'সবচেয়ে পুরনো ' + ago(nw[0].uploaded_at).replace('আগে', '') : 'কিছু বাকি নেই';
    $('phStart').disabled = !nw.length;
    if (!list.length) { var tr0 = el('tr'), td0 = el('td', nw.length ? 'কিছু পাওয়া যায়নি।' : 'নতুন account copy নেই।', 'muted'); td0.colSpan = 6; tr0.appendChild(td0); box.appendChild(tr0); }
    list.forEach(function (r) {
      var tr = el('tr', null, 'click'); tr.onclick = function () { openPhoto(r); };
      var c1 = el('td'); c1.setAttribute('data-label', 'কর্মী');
      c1.appendChild(el('div', r.applicant_name || '', 'nm')); c1.appendChild(el('div', r.job_card_no + ' · App ' + r.applicant_no, 'jc')); tr.appendChild(c1);
      var c2 = el('td', vno(r.village_no)); c2.setAttribute('data-label', 'Sansad'); tr.appendChild(c2);
      var c3 = el('td'); c3.setAttribute('data-label', 'Supervisor দিয়েছে');
      c3.appendChild(el('div', r.sent_account_no || '—', 'mono')); c3.appendChild(el('div', r.sent_ifsc || (r.sent_account_no ? '' : 'শুধু ছবি'), 'jc')); tr.appendChild(c3);
      var c4 = el('td'); c4.setAttribute('data-label', 'এখন data-তে'); c4.appendChild(accTag(r)); tr.appendChild(c4);
      var c5 = el('td'); c5.setAttribute('data-label', 'পাঠিয়েছে');
      var age = Math.floor((Date.now() - new Date(r.uploaded_at).getTime()) / 86400000);
      c5.appendChild(el('div', r.uploaded_by || '')); c5.appendChild(el('div', ago(r.uploaded_at), age >= 3 ? 'ac-old' : 'jc')); tr.appendChild(c5);
      var c6 = el('td'); c6.setAttribute('data-label', ''); c6.appendChild(el('button', 'খুলুন ›', 'ac-open')); tr.appendChild(c6);
      box.appendChild(tr);
    });
    renderDone();
  }
  function renderDone() {
    var box = $('phDone'); box.innerHTML = '';
    var all = ph.rows.filter(function (r) { return r.status === 'done' || r.status === 'returned'; });
    $('acN-done').textContent = String(all.length);
    document.querySelectorAll('#phFilters button').forEach(function (b) { b.classList.toggle('active', b.dataset.f === ph.filter); });
    var list = all.filter(function (r) { return r.status === ph.filter && hit(r); });
    if (!list.length) { var tr0 = el('tr'), td0 = el('td', 'গত 30 দিনে কিছু নেই।', 'muted'); td0.colSpan = 5; tr0.appendChild(td0); box.appendChild(tr0); return; }
    list.forEach(function (r) {
      var tr = el('tr');
      var c1 = el('td'); c1.setAttribute('data-label', 'কর্মী');
      c1.appendChild(el('div', r.applicant_name || '', 'nm')); c1.appendChild(el('div', r.job_card_no + ' · App ' + r.applicant_no + ' · ' + (r.uploaded_by || ''), 'jc')); tr.appendChild(c1);
      var c2 = el('td'); c2.setAttribute('data-label', 'Account · IFSC');
      c2.appendChild(el('div', (r.sent_account_no || '—') + (r.sent_ifsc ? ' · ' + r.sent_ifsc : ''), 'mono'));
      if (r.sup_account_no || r.sup_ifsc || r.sup_holder_name) c2.appendChild(el('span', '✎ Admin ঠিক করেছেন', 'ac-tag w'));
      tr.appendChild(c2);
      var c3 = el('td', fmtDate(r.done_at)); c3.setAttribute('data-label', 'কবে'); tr.appendChild(c3);
      var c4 = el('td'); c4.setAttribute('data-label', r.status === 'returned' ? 'কারণ' : 'Portal');
      if (r.status === 'returned') c4.appendChild(el('span', r.return_reason || '', 'ac-tag r'));
      else if (r.portal_status === 'ok') c4.appendChild(el('span', '🏦 Portal updated ' + fmtDate(r.portal_at), 'ac-tag g'));
      else if (r.portal_status === 'fail') c4.appendChild(el('span', '🏦 Failed · ' + (r.portal_note || ''), 'ac-tag r'));
      else if (r.portal_status === 'removed') c4.appendChild(el('span', '🗑 K-Desk থেকে সরানো', 'ac-tag b'));
      else if (r.sent_account_no) c4.appendChild(el('span', '🏦 K-Desk-এ বাকি', 'ac-tag b'));
      tr.appendChild(c4);
      var c5 = el('td'); c5.setAttribute('data-label', '');
      if (r.can_reopen) { var b = el('button', '↩ ফিরিয়ে আনুন', 'ac-open'); b.onclick = function () { photoReopen(r); }; c5.appendChild(b); }
      else c5.appendChild(el('span', 'ছবি মুছে গেছে', 'muted'));
      tr.appendChild(c5);
      box.appendChild(tr);
    });
  }
  function photoName(r) {
    return (String(r.job_card_no || '').replace(/[^A-Za-z0-9-]+/g, '_') + '_' + r.applicant_no + '_' +
            String(r.applicant_name || '').replace(/[^A-Za-z0-9]+/g, '_')).replace(/_+/g, '_').slice(0, 90) + '.jpg';
  }

  // ----- Account check page -----
  var ACC_RE = /^\d{6,20}$/, IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
  function cleanAcc(v) { return String(v || '').replace(/\D+/g, ''); }
  function cleanIfsc(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]+/g, ''); }
  function cleanName(v) { return String(v || '').toUpperCase().replace(/\s+/g, ' ').trim(); }
  function group4(v) { return v.replace(/(\d{4})(?=\d)/g, '$1 '); }
  // name match %: letter pairs of both names (order and spaces do not matter much)
  function nameMatch(a, b) {
    function grams(s) { s = cleanName(s).replace(/[^A-Z]/g, ''); var g = {}, n = 0; for (var i = 0; i < s.length - 1; i++) { var k = s.substr(i, 2); g[k] = (g[k] || 0) + 1; n++; } return { g: g, n: n }; }
    var x = grams(a), y = grams(b); if (!x.n || !y.n) return null;
    var c = 0; Object.keys(x.g).forEach(function (k) { if (y.g[k]) c += Math.min(x.g[k], y.g[k]); });
    return Math.round(200 * c / (x.n + y.n));
  }
  // IFSC → bank + branch (free public lookup, only the IFSC code is sent; remembered per code)
  var ifscCache = {};
  try { ifscCache = JSON.parse(sessionStorage.getItem('gramg2.ifsc') || '{}') || {}; } catch (e) { ifscCache = {}; }
  function ifscLookup(code) {
    if (ifscCache[code] !== undefined) return Promise.resolve(ifscCache[code]);
    return fetch('https://ifsc.razorpay.com/' + encodeURIComponent(code)).then(function (res) {
      if (res.status === 404) return false;
      if (!res.ok) throw new Error('lookup');
      return res.json().then(function (j) { return { bank: j.BANK || '', branch: j.BRANCH || '', city: j.DISTRICT || j.CITY || '' }; });
    }).then(function (v) {
      ifscCache[code] = v; try { sessionStorage.setItem('gramg2.ifsc', JSON.stringify(ifscCache)); } catch (e) {}
      return v;
    });
  }
  var ifscSeq = 0;
  function acvBank() {
    var code = cleanIfsc($('acvIfsc').value), b = $('acvBank'), my = ++ifscSeq;
    b.className = 'i-b';
    if (!code) { b.textContent = '🏦 IFSC নেই'; return; }
    if (!IFSC_RE.test(code)) { b.textContent = '⚠ IFSC ঠিক নয় (4 অক্ষর + 0 + 6)'; b.className = 'i-b bad'; return; }
    b.textContent = '🏦 খোঁজা হচ্ছে…';
    ifscLookup(code).then(function (v) {
      if (my !== ifscSeq) return;
      if (v === false) { b.textContent = '⚠ এই IFSC কোনো bank-এ পাওয়া যায়নি'; b.className = 'i-b bad'; return; }
      b.textContent = '🏦 ' + v.bank + ' · ' + v.branch + (v.city ? ', ' + v.city : ''); b.className = 'i-b ok';
    }, function () { if (my === ifscSeq) b.textContent = '🏦 ' + code; });
  }
  function supOf(r, k) {   // what the supervisor sent (kept apart once the Admin corrected it)
    var edited = r.sup_account_no != null || r.sup_ifsc != null || r.sup_holder_name != null;
    if (k === 'acc') return edited ? r.sup_account_no : r.sent_account_no;
    if (k === 'ifsc') return edited ? r.sup_ifsc : r.sent_ifsc;
    return edited ? r.sup_holder_name : r.holder_name;
  }
  function acvRefresh() {
    var r = ph.cur; if (!r) return;
    var acc = cleanAcc($('acvAcc').value), ifsc = cleanIfsc($('acvIfsc').value), nm = cleanName($('acvHolder').value);
    [['acvAcc', 'acvAccEd', acc, cleanAcc(supOf(r, 'acc')), acc && !ACC_RE.test(acc)],
     ['acvIfsc', 'acvIfscEd', ifsc, cleanIfsc(supOf(r, 'ifsc')), ifsc && !IFSC_RE.test(ifsc)],
     ['acvHolder', 'acvHolderEd', nm, cleanName(supOf(r, 'name')), false]].forEach(function (f) {
      var changed = r.status === 'new' && f[2] !== f[3];
      $(f[0]).classList.toggle('ed', changed && !f[4]); $(f[0]).classList.toggle('bad', !!f[4]);
      $(f[1]).textContent = f[4] ? '⚠ ঠিক নয়' : changed ? '✎ আপনি বদলেছেন' : '';
    });
    $('acvSupAcc').innerHTML = ''; $('acvSupIfsc').innerHTML = ''; $('acvSupHolder').innerHTML = '';
    [['acvSupAcc', supOf(r, 'acc'), acc, cleanAcc], ['acvSupIfsc', supOf(r, 'ifsc'), ifsc, cleanIfsc], ['acvSupHolder', supOf(r, 'name'), nm, cleanName]].forEach(function (f) {
      var v = f[1] || '—', box = $(f[0]);
      if (f[1] && r.status === 'new' && f[3](f[1]) !== f[2]) box.appendChild(el('s', v));   // Admin changed it
      else box.textContent = v;
    });
    $('acvDig').textContent = acc ? acc.length + ' digit' + (acc.length > 3 ? ' · ' + group4(acc) : '') : '';
    var m = nameMatch(nm, r.applicant_name);
    $('acvMatch').textContent = m == null ? '' : 'নাম মিল ' + m + '%';
    $('acvMatch').className = 'i-m' + (m != null && m < 60 ? ' low' : '');
  }
  function acvPos() {
    var nw = newRows(), i = ph.cur ? nw.indexOf(nw.filter(function (x) { return x.id === ph.cur.id; })[0]) : -1;
    $('acvLeft').textContent = String(nw.length);
    $('acvPos').textContent = i >= 0 ? (i + 1) + ' / ' + nw.length : '—';
    $('acvPrev').disabled = i <= 0; $('acvNext').disabled = i < 0 || i >= nw.length - 1;
  }
  function chip(text, cls) { var s = el('span', null, cls || ''); s.textContent = text; return s; }
  function openPhoto(r) {
    ph.cur = r;
    $('phvTitle').textContent = r.status === 'new' ? 'Passbook মিলিয়ে দেখুন' : r.status === 'done' ? 'Verified (ফিরিয়ে এনে ঠিক করুন)' : 'ফেরত গেছে';
    var bar = $('phvSub'); bar.innerHTML = '';
    var a = chip('Sansad '), b = el('b', vno(r.village_no)); a.appendChild(b); bar.appendChild(a);
    var p = chip('পাঠিয়েছে '); p.appendChild(el('b', r.uploaded_by || '')); p.appendChild(document.createTextNode(' · ' + fmtDate(r.uploaded_at))); bar.appendChild(p);
    if (r.ekyc != null) bar.appendChild(chip((r.ekyc ? '✓' : '✕') + ' eKYC', r.ekyc ? 'ok' : 'no'));
    if (r.abps != null) bar.appendChild(chip((r.abps ? '✓' : '✕') + ' ABPS', r.abps ? 'ok' : 'no'));
    if (r.work_name) bar.appendChild(chip('📋 ' + r.work_name));
    if (r.reopened_at) bar.appendChild(chip('↩ ফিরিয়ে আনা ' + fmtDate(r.reopened_at)));
    $('acvName').textContent = r.applicant_name || '';
    $('acvJc').textContent = r.job_card_no + ' · Applicant ' + r.applicant_no;
    $('acvAcc').value = cleanAcc(r.sent_account_no); $('acvIfsc').value = cleanIfsc(r.sent_ifsc); $('acvHolder').value = cleanName(r.holder_name);
    var open = r.status === 'new';
    ['acvAcc', 'acvIfsc', 'acvHolder'].forEach(function (id) { $(id).disabled = !open; });
    $('acvAct').classList.toggle('hidden', !open);
    var db = $('acvDoneBox'); db.innerHTML = ''; db.classList.toggle('hidden', open);
    if (!open) {
      db.appendChild(el('span', r.status === 'done' ? '✔ Verified ' + fmtDate(r.done_at) : '✕ ফেরত ' + fmtDate(r.done_at) + ' · ' + (r.return_reason || '')));
      if (r.can_reopen) { var u = el('button', '↩ ফিরিয়ে আনুন'); u.type = 'button'; u.onclick = function () { photoReopen(r); }; db.appendChild(u); }
    }
    $('acvOld').textContent = 'এখন data-তে: ' + (r.account_no ? r.account_no + (r.ifsc ? ' · ' + r.ifsc : '') : 'account নেই');
    acvRefresh(); acvBank(); acvPos();
    ph.z = 1; ph.rot = 0; ph.x = 0; ph.y = 0; imgApply();
    $('phvImg').removeAttribute('src');
    $('phvModal').classList.add('show'); document.body.style.overflow = 'hidden';
    SB.photos.blob(r.path).then(function (bl) {
        if (ph.cur !== r) return;
        if (ph.imgUrl) URL.revokeObjectURL(ph.imgUrl);
        ph.imgUrl = URL.createObjectURL(bl); $('phvImg').src = ph.imgUrl;
      },
      function (e) { if (!e.authLost) status('Could not open the photo: ' + (e.message || e), 'err'); });
    if (open) setTimeout(function () { $('phvDone').focus(); }, 30);
  }
  function closePhoto() {
    $('phvModal').classList.remove('show'); $('phvImg').removeAttribute('src'); ph.cur = null; document.body.style.overflow = '';
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    if (ph.imgUrl) { URL.revokeObjectURL(ph.imgUrl); ph.imgUrl = null; }
  }
  // photo: fit, zoom, drag, rotate
  function imgFit() {
    var img = $('phvImg'), st = $('acvStage');
    if (!img.naturalWidth) return 1;
    var side = ph.rot % 180 !== 0, w = side ? img.naturalHeight : img.naturalWidth, h = side ? img.naturalWidth : img.naturalHeight;
    return Math.min(st.clientWidth / w, st.clientHeight / h) * 0.96;
  }
  function imgApply() {
    var img = $('phvImg'), s = imgFit() * ph.z;
    img.style.transform = 'translate(-50%,-50%) translate(' + ph.x + 'px,' + ph.y + 'px) rotate(' + ph.rot + 'deg) scale(' + s + ')';
  }
  function zoomBy(f) { ph.z = Math.min(8, Math.max(0.5, ph.z * f)); imgApply(); }
  $('phvImg').addEventListener('load', imgApply);
  window.addEventListener('resize', function () { if (ph.cur) imgApply(); });
  $('acvZi').addEventListener('click', function () { zoomBy(1.25); });
  $('acvZo').addEventListener('click', function () { zoomBy(0.8); });
  $('acvRot').addEventListener('click', function () { ph.rot = (ph.rot + 90) % 360; ph.x = ph.y = 0; imgApply(); });
  $('acvFit').addEventListener('click', function () { ph.z = 1; ph.x = ph.y = 0; imgApply(); });
  function fullScreen() {
    var st = $('acvStage');
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    else if (st.requestFullscreen) st.requestFullscreen().catch(function () {});
  }
  $('acvFull').addEventListener('click', fullScreen);
  document.addEventListener('fullscreenchange', function () { setTimeout(imgApply, 60); });
  (function () {
    var st = $('acvStage'), drag = null;
    st.addEventListener('wheel', function (e) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.15 : 0.87); }, { passive: false });
    st.addEventListener('pointerdown', function (e) { drag = { x: e.clientX - ph.x, y: e.clientY - ph.y }; st.classList.add('drag'); st.setPointerCapture(e.pointerId); });
    st.addEventListener('pointermove', function (e) { if (!drag) return; ph.x = e.clientX - drag.x; ph.y = e.clientY - drag.y; imgApply(); });
    function end() { drag = null; st.classList.remove('drag'); }
    st.addEventListener('pointerup', end); st.addEventListener('pointercancel', end);
    st.addEventListener('dblclick', fullScreen);
  })();
  ['acvAcc', 'acvIfsc', 'acvHolder'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      if (id === 'acvAcc') { var v = cleanAcc(this.value); if (v !== this.value) this.value = v; }
      if (id === 'acvIfsc') { var w = cleanIfsc(this.value); if (w !== this.value) this.value = w; acvBank(); }
      acvRefresh();
    });
  });
  function goRel(d) {
    var nw = newRows(), i = ph.cur ? nw.map(function (x) { return x.id; }).indexOf(ph.cur.id) : -1;
    var n = nw[i + d]; if (n) openPhoto(n);
  }
  $('acvPrev').addEventListener('click', function () { goRel(-1); });
  $('acvNext').addEventListener('click', function () { goRel(1); });

  function downloadPhoto(r) {
    loading('Downloading...');
    SB.photos.blob(r.path)
      .then(function (b) {
        var a = document.createElement('a'), u = URL.createObjectURL(b);
        a.href = u; a.download = photoName(r); document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
      })
      .catch(function (e) { if (!e.authLost) status('Download failed: ' + (e.message || e), 'err'); })
      .then(function () { loading(''); });
  }
  function toast(r, text) {
    clearTimeout(ph.toastT);
    ph.undo = r; $('acvToastT').innerHTML = '';
    $('acvToastT').appendChild(document.createTextNode(text.split('|')[0])); $('acvToastT').appendChild(el('b', r.applicant_name || ''));
    $('acvToastT').appendChild(document.createTextNode(text.split('|')[1] || ''));
    $('acvToast').classList.remove('hidden');
    ph.toastT = setTimeout(function () { $('acvToast').classList.add('hidden'); }, 15000);
  }
  $('acvToastX').addEventListener('click', function () { $('acvToast').classList.add('hidden'); });
  $('acvUndo').addEventListener('click', function () {
    $('acvToast').classList.add('hidden');
    var r = ph.undo; if (!r) return;
    var row = ph.rows.filter(function (x) { return x.id === r.id; })[0] || r;
    photoReopen(row, true);
  });
  // after Verify / Return: photo is kept 7 days (v239) so ↩ can bring it back
  function photoFinish(r, rpc, args, okMsg, toastText) {
    var wasOpen = ph.cur === r, nw = newRows(), idx = nw.map(function (x) { return x.id; }).indexOf(r.id);
    loading('Saving...');
    return SB.rpc(rpc, args)
      .then(function (res) {
        res = res || {};
        if (res.paths && res.paths.length) { status(okMsg(res) + ' ' + V239 + ' (↩ ফিরিয়ে আনা যাবে না)', 'info'); return true; }   // old SQL
        status(okMsg(res), 'ok'); toast(r, toastText);
        return true;
      }, function (e) {
        if (e.authLost) return false;
        if (e.status === 404 || /admin_account_photo_verify|function .* does not exist/.test(e.message || '')) { status(V239, 'err'); return false; }
        var map = { BAD_ACCOUNT_NO: 'Account number ঠিক নয় (6–20 সংখ্যা)।', BAD_IFSC: 'IFSC ঠিক নয়।', ALREADY_DONE: 'এটা আগেই check হয়ে গেছে।' };
        status(map[e.code] || map[(e.message || '').trim()] || errText(e), 'err'); return false;
      })
      .then(function (ok) {
        loading('');
        return loadPhotos(false).then(function () {
          if (!ok || !wasOpen) return;
          var rest = newRows(), next = rest[Math.min(idx < 0 ? 0 : idx, rest.length - 1)];
          if (next) openPhoto(next); else { closePhoto(); status('✔ সব account copy check হয়ে গেছে।', 'ok'); }
        });
      });
  }
  function photoVerify(r) {
    if (r.status !== 'new') return;
    var acc = cleanAcc($('acvAcc').value), ifsc = cleanIfsc($('acvIfsc').value), nm = cleanName($('acvHolder').value);
    if (acc && !ACC_RE.test(acc)) { status('Account number ঠিক নয় (6–20 সংখ্যা)।', 'err'); $('acvAcc').focus(); return; }
    if (ifsc && !IFSC_RE.test(ifsc)) { status('IFSC ঠিক নয় (যেমন SBIN0001234)।', 'err'); $('acvIfsc').focus(); return; }
    if ((acc && !ifsc) || (!acc && ifsc)) { status('Account number আর IFSC দুটোই দিন (নাহলে data-তে account বসবে না)।', 'err'); return; }
    photoFinish(r, 'admin_account_photo_verify',
      { p_id: r.id, p_update: true, p_account_no: acc || null, p_ifsc: ifsc || null, p_holder_name: nm || null },
      function (res) { return '✔ Verified: ' + (r.applicant_name || '') + (res.data_updated ? ' (account data-তে বসেছে, K-Desk portal-এ বসাবে)' : '') + (res.edited ? ' · আপনার সংশোধন সহ' : ''); },
      '✔ |' + ' verified' + (acc ? ' · ' + acc : ''));
  }
  function photoReturn(r) {
    if (r.status !== 'new') return;
    askText('Supervisor-কে কেন ফেরত পাঠাচ্ছেন? (উনি এই কারণটা দেখবেন)', 'ছবি পরিষ্কার নয়', '✕ ফেরত').then(function (reason) {
      if (reason === null) return;
      if (!reason.trim()) { status('একটা কারণ লিখুন।', 'err'); return; }
      photoFinish(r, 'admin_account_photo_return', { p_id: r.id, p_reason: reason.trim() },
        function () { return '✕ Supervisor-কে ফেরত গেছে: ' + (r.applicant_name || '') + '.'; }, '✕ |' + ' ফেরত গেছে');
    });
  }
  function photoReopen(r, quick) {
    var msg = r.portal_status === 'ok'
      ? '⚠ K-Desk এই account portal-এ বসিয়ে ফেলেছে (' + (r.sent_account_no || '') + ').\nফিরিয়ে এনে ঠিক করে আবার Verify করলে K-Desk নতুনটা আবার portal-এ বসাবে।\nফিরিয়ে আনবেন?'
      : 'ফিরিয়ে আনবেন? ' + (r.applicant_name || '') + ' আবার ② Check বাকি-তে যাবে' + (r.status === 'done' ? ', data-তে আগের account ফিরে যাবে, K-Desk-এর তালিকা থেকে সরে যাবে।' : '।');
    (quick && r.portal_status !== 'ok' ? Promise.resolve(true) : ask(msg, '↩ ফিরিয়ে আনুন', 'ok')).then(function (yes) {
      if (!yes) return;
      loading('ফিরিয়ে আনা হচ্ছে...');
      SB.rpc('admin_account_photo_reopen', { p_id: r.id }).then(function (res) {
        res = res || {};
        var note = { old: ' data-তে আগের account ফিরে গেছে।', removed: ' data থেকে এই account সরানো হয়েছে।',
                     changed_since: ' ⚠ এর মধ্যে data-তে account বদলেছে, তাই data ছোঁয়া হয়নি।' }[res.restored] || '';
        status('↩ ফিরিয়ে আনা হয়েছে: ' + (r.applicant_name || '') + '.' + note, res.restored === 'changed_since' ? 'info' : 'ok');
        loading('');
        return loadPhotos(false).then(function () {
          var row = ph.rows.filter(function (x) { return x.id === r.id; })[0];
          setStep('check'); if (row) openPhoto(row);
        });
      }, function (e) {
        loading(''); if (e.authLost) return;
        var map = { TOO_OLD: '7 দিনের বেশি পুরনো, ছবি মুছে গেছে, তাই ফিরিয়ে আনা যাবে না।', NEWER_COPY: 'এই কর্মীর নতুন account copy আছে, সেটাই check করুন।', NOT_DONE: 'এটা এখনো check বাকি।' };
        status(map[e.code] || map[(e.message || '').trim()] || (e.status === 404 ? V239 : errText(e)), 'err');
      });
    });
  }
  $('phvClose').addEventListener('click', closePhoto);
  $('phvDl').addEventListener('click', function () { if (ph.cur) downloadPhoto(ph.cur); });
  $('phvDone').addEventListener('click', function () { if (ph.cur) photoVerify(ph.cur); });
  $('phvRet').addEventListener('click', function () { if (ph.cur) photoReturn(ph.cur); });
  // keyboard in the Account check page: A = Verify, R = Return, ←/→ = previous/next, Esc = back; Enter = Yes in the question box
  document.addEventListener('keydown', function (e) {
    if ($('askBox').classList.contains('show')) {
      if (e.key === 'Enter' && $('askInput').classList.contains('hidden')) { e.preventDefault(); $('askYes').click(); }
      return;
    }
    if (!$('phvModal').classList.contains('show')) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'escape') { if (!document.fullscreenElement) closePhoto(); return; }
    if (/INPUT|TEXTAREA|SELECT/.test((e.target || {}).tagName || '')) { if (k === 'enter' && ph.cur && ph.cur.status === 'new') { e.preventDefault(); photoVerify(ph.cur); } return; }
    if (k === 'a') { e.preventDefault(); $('phvDone').click(); }
    else if (k === 'r') { e.preventDefault(); $('phvRet').click(); }
    else if (k === 'arrowleft') goRel(-1);
    else if (k === 'arrowright') goRel(1);
  });
  $('phRefresh').addEventListener('click', function () { loadPhotos(true); });
  $('phGp').addEventListener('change', function () { loadPhotos(true); });
  document.querySelectorAll('#phFilters button').forEach(function (b) {
    b.addEventListener('click', function () { ph.filter = b.dataset.f; renderDone(); });
  });
  document.querySelectorAll('#acTiles button').forEach(function (b) {
    b.addEventListener('click', function () { setStep(b.dataset.step); });
  });
  $('phSearch').addEventListener('input', function () { ph.q = this.value.trim().toLowerCase(); renderPhotos(); });
  $('phStart').addEventListener('click', function () { var n = newRows()[0]; if (n) openPhoto(n); });
  $('acAskBtn').addEventListener('click', function () { setStep('req'); $('acAskCard').classList.remove('hidden'); $('rqText').focus(); });
  $('acAskClose').addEventListener('click', function () { $('acAskCard').classList.add('hidden'); });

  // ---------- account copy requests (account not frozen) ----------
  var JC_RE = /WB-?\d{2}-?\d{3}-?\d{3}-?\d{3}\s*\/\s*\d+(?:-[A-Z])?/i;
  var rq = { rows: [], file: [] };
  function rowsFromTable(aoa) {
    var out = [], head = -1, jcCol = -1, nmCol = -1;
    for (var h = 0; h < Math.min(15, aoa.length); h++) {
      var cells = aoa[h].map(function (c) { return String(c || '').trim(); });
      var j = cells.findIndex(function (c) { return /job\s*card/i.test(c); });
      if (j >= 0) {
        head = h; jcCol = j;
        nmCol = cells.findIndex(function (c) { return /seeker|applicant\s*name|worker\s*name/i.test(c); });
        if (nmCol < 0) nmCol = cells.findIndex(function (c) { return /name/i.test(c) && !/bank|father|husband/i.test(c); });
        break;
      }
    }
    aoa.forEach(function (row, i) {
      if (i <= head) return;
      var cells = row.map(function (c) { return String(c == null ? '' : c).trim(); });
      var jc = '', k = -1;
      if (jcCol >= 0 && JC_RE.test(cells[jcCol] || '')) { k = jcCol; jc = cells[jcCol].match(JC_RE)[0]; }
      else for (var c = 0; c < cells.length; c++) { var m = cells[c].match(JC_RE); if (m) { k = c; jc = m[0]; break; } }
      if (!jc) return;
      var name = '';
      if (nmCol >= 0) name = cells[nmCol] || '';
      if (!name) {
        var rest = cells[k].replace(JC_RE, '').replace(/[^A-Za-z .]/g, ' ').trim();     // "JC NAME" in one cell
        if (/[A-Za-z]{2}/.test(rest)) name = rest;
      }
      if (!name) for (var c2 = k + 1; c2 < cells.length; c2++) { if (/[A-Za-z]{2}/.test(cells[c2]) && !/\d/.test(cells[c2])) { name = cells[c2]; break; } }
      out.push({ jc: jc.replace(/\s+/g, '').toUpperCase(), name: name.replace(/\s+/g, ' ').trim() });
    });
    return out;
  }
  function rqParse() {
    var lines = $('rqText').value.split(/\r?\n/).filter(function (l) { return l.trim(); });
    var fromText = rowsFromTable(lines.map(function (l) { return l.indexOf('\t') >= 0 ? l.split('\t') : [l]; }));
    var all = fromText.concat(rq.file), seen = {};
    rq.rows = all.filter(function (r) { var k = r.jc + '|' + r.name.toUpperCase(); if (seen[k]) return false; seen[k] = 1; return true; });
    $('rqParsed').textContent = rq.rows.length ? rq.rows.length + ' worker(s) found' + (rq.rows.some(function (r) { return !r.name; }) ? ' (some without a name)' : '') : '';
  }
  $('rqText').addEventListener('input', rqParse);
  $('rqFile').addEventListener('change', function () {
    var f = this.files && this.files[0]; rq.file = [];
    if (!f) { rqParse(); return; }
    var isCsv = /\.csv$/i.test(f.name);
    loadXlsx().then(function () { return isCsv ? f.text() : f.arrayBuffer(); }).then(function (data) {
      var wb = isCsv ? XLSX.read(String(data), { type: 'string', raw: true }) : XLSX.read(data, { type: 'array', cellText: true });
      wb.SheetNames.forEach(function (n) { rq.file = rq.file.concat(rowsFromTable(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }))); });
      rqParse();
      if (!rq.file.length) status('No Job Card No found in this file.', 'err');
    }).catch(function (e) { status(errText(e), 'err'); });
  });
  function rqFillWho() {
    var gp = Number($('phGp').value), sel = $('rqWho'), keep = sel.value;
    sel.innerHTML = ''; var o = el('option', '👥 All supervisors of this GP'); o.value = ''; sel.appendChild(o);
    state.users.filter(function (u) { return u.role === 'gp_user' && u.gp_id === gp && u.active !== false; }).forEach(function (u) {
      var x = el('option', '👤 ' + (u.full_name || u.username) + ' (' + u.username + ')'); x.value = u.user_id; sel.appendChild(x);
    });
    sel.value = keep; if (sel.value !== keep) sel.value = '';
  }
  $('rqSend').addEventListener('click', function () {
    rqParse();
    var gp = Number($('phGp').value);
    if (!rq.rows.length) { status('Paste or choose the list first (Job Card No + name).', 'err'); return; }
    loading('Sending ' + rq.rows.length + ' worker(s)...');
    SB.rpc('admin_add_account_requests', { p_gp_id: gp, p_rows: rq.rows, p_assign: $('rqWho').value || null, p_note: $('rqNote').value.trim() || null })
      .then(function (r) {
        var msg = '✅ Sent: ' + r.added + (r.already ? '   · already asked: ' + r.already : '');
        if ((r.unclear || []).length) msg += '\n⚠ Name did not match anyone on the job card (' + r.unclear.length + '): ' + r.unclear.map(function (x) { return x.jc + ' ' + (x.name || '(no name)'); }).join(', ');
        if ((r.not_found || []).length) msg += '\n✕ Job card not in this GP\'s data (' + r.not_found.length + '): ' + r.not_found.map(function (x) { return x.jc; }).join(', ');
        $('rqResult').textContent = msg;
        status('✅ ' + r.added + ' account copy request(s) sent to the supervisors.', 'ok');
        $('rqText').value = ''; $('rqFile').value = ''; rq.file = []; rqParse();
        return loadRequests();
      })
      .catch(function (e) {
        if (e.authLost) return;
        if (e.status === 404) { status('Run supabase/2026-10-31_account_requests.sql (v181) in the Supabase SQL Editor first.', 'err'); return; }
        status(errText(e), 'err');
      })
      .then(function () { loading(''); });
  });
  var RQ_LBL = { open: '⏳ Waiting', photo: '📷 Photo received', closed: '✅ Closed' };
  function loadRequests() {
    var gp = Number($('phGp').value); if (!gp) return Promise.resolve();
    rqFillWho();
    return SB.rpc('admin_account_requests', { p_gp_id: gp, p_all: $('rqAll').checked }).then(function (rows) {
      rows = rows || [];
      var tb = $('rqBody'); tb.innerHTML = '';
      var c = { open: 0, photo: 0, closed: 0 };
      rows.forEach(function (r) {
        c[r.status] = (c[r.status] || 0) + 1;
        var tr = document.createElement('tr');
        [['Village', vno(r.village_no)], ['Job Card', r.job_card_no], ['Name', r.applicant_name], ['Account in data', r.account_no || '—'],
         ['To', r.assigned || 'All supervisors'], ['Status', RQ_LBL[r.status] || r.status]].forEach(function (p) {
          var td = el('td', p[1]); td.setAttribute('data-label', p[0]); tr.appendChild(td);
        });
        var td = el('td'); td.setAttribute('data-label', '');
        if (r.status !== 'closed') {
          var x = el('button', '✕', 'btn-light btn-small'); x.title = 'Remove this request';
          x.onclick = function () {
            ask('Remove the request for ' + r.applicant_name + '?', 'Remove').then(function (yes) {
              if (!yes) return;
              SB.rpc('admin_close_account_requests', { p_ids: [r.id] }).then(loadRequests, function (e) { status(errText(e), 'err'); });
            });
          };
          td.appendChild(x);
        }
        tr.appendChild(td); tb.appendChild(tr);
      });
      if (!rows.length) { var tr0 = document.createElement('tr'); var td0 = el('td', 'No request.'); td0.colSpan = 7; tr0.appendChild(td0); tb.appendChild(tr0); }
      $('acN-req').textContent = String(c.open);
      $('acS-req').textContent = c.photo ? 'ছবি আসেনি · ' + c.photo + ' টা ছবি এসেছে' : 'ছবি আসেনি';
      $('rqSum').textContent = 'Waiting: ' + c.open + ' · Photo received: ' + c.photo + ($('rqAll').checked ? ' · Closed: ' + c.closed : '');
    }, function (e) { if (e.status !== 404 && !e.authLost) status(errText(e), 'err'); });
  }
  $('rqAll').addEventListener('change', loadRequests);

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

  $('commitBtn').addEventListener('click', async function () {
    var c = state.counts; if (!c || state.busy) return;
    var msg = 'Confirm the import?\n\nNew: ' + bn(c.new) + '\nChanged: ' + bn(c.updated) +
              (c.deactivate_missing ? '\nWill become inactive: ' + bn(c.missing_from_file) : '') +
              '\nSkipped: ' + bn(c.invalid + c.conflicting_repeats) + '\n\nIf it is wrong you can roll it back from Import History.';
    if (!await ask(msg)) return;
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
          b.addEventListener('click', async function () {
            if (!await ask('Roll back this import? The data goes back to how it was before it.')) return;
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
  var ROLE_LABEL = { super_admin: 'Super Admin', gp_admin: '🛡 GP Admin', gp_user: 'Supervisor', kdesk: '🖥 K-Desk login', viewer: '📊 Report viewer' };
  var viewers = {};   // user_id → { designation, block } (v228)
  function loadUsers() {
    var usersReq = SB.rpc('admin_list_users');   // asked together with the viewer list
    usersReq.catch(function () {});              // (its error is handled below)
    return SB.rpc('admin_list_viewers').catch(function () { return []; }).then(function (vs) {
      viewers = {}; (vs || []).forEach(function (v) { viewers[v.user_id] = v; });
      return usersReq;
    }).then(function (users) {
      state.users = users || []; gaPrefill();
      var tb = $('users'); tb.innerHTML = '';
      var lim = gpView();
      if (lim) users = users.filter(function (u) { return u.gp_id === lim; });
      users.forEach(function (u) {
        var tr = document.createElement('tr');
        tr.appendChild(el('td', u.username)); tr.appendChild(el('td', u.full_name));
        var vw = u.role === 'viewer' ? (viewers[u.user_id] || {}) : null;
        tr.appendChild(el('td', u.role === 'super_admin' ? 'Super Admin'
          : vw ? (vw.block ? 'All GPs (block)' : (u.gp_name || '')) + ' · ' + ROLE_LABEL.viewer + (vw.designation ? ' (' + vw.designation + ')' : '')
          : (u.gp_name || '') + (u.role === 'kdesk' || u.role === 'gp_admin' ? ' · ' + ROLE_LABEL[u.role] : '')));
        var st = el('td'); st.appendChild(el('span', u.active ? 'Active' : 'Disabled', 'pill ' + (u.active ? 'on' : 'off'))); tr.appendChild(st);
        tr.appendChild(el('td', String(u.active_devices)));
        tr.appendChild(el('td', fmtDate(u.last_seen)));
        var act = el('td');
        // a GP Admin manages only their GP's supervisors and K-Desk login (the database checks this too)
        var canManage = u.role === 'gp_user' || u.role === 'kdesk' || u.role === 'viewer' || (u.role === 'gp_admin' && !lim);
        if (u.role === 'gp_user' || u.role === 'kdesk' || u.role === 'viewer' || !lim) {   // ✏ Rename (full name); Super Admin can rename anyone incl. themself
          var rn = el('button', '✏ Rename', 'btn-light btn-small');
          rn.addEventListener('click', function () { renameUser(u); });
          act.appendChild(rn);
        }
        if (canManage) {
          var t = el('button', u.active ? 'Disable' : 'Enable', (u.active ? 'btn-danger' : 'btn-success') + ' btn-small');
          t.addEventListener('click', async function () {
            if (u.active && !await ask('Disable the account of ' + u.username + '? They are logged out of every device at once.')) return;
            SB.rpc('admin_set_user_active', { p_user_id: u.user_id, p_active: !u.active })
              .then(function () { status(u.username + ' ' + (u.active ? 'disabled' : 'enabled') + '.', 'ok'); return loadUsers(); })
              .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
          });
          act.appendChild(t);
          var pb = el('button', '🔑 PIN', 'btn-light btn-small'); pb.style.marginLeft = '4px';
          pb.addEventListener('click', function () { openPinModal(u); });
          act.appendChild(pb);
          // K-Desk Suite login: may only read this GP's submitted lists and lock them (database: kdesk_*).
          var kb = u.role === 'gp_admin' || u.role === 'viewer' ? null : el('button', u.role === 'kdesk' ? '↩ Make Supervisor' : '🖥 Make K-Desk login', 'btn-light btn-small'); if (kb) kb.style.marginLeft = '4px';
          if (kb) kb.addEventListener('click', async function () {
            var to = u.role === 'kdesk' ? 'gp_user' : 'kdesk';
            var q = to === 'kdesk'
              ? 'Make ' + u.username + ' a K-Desk login? It can no longer build lists in the phone app; the K-Desk extension can only fetch and lock submitted lists with it. It is logged out of every device.'
              : 'Make ' + u.username + ' a Supervisor again? K-Desk can no longer fetch lists with it.';
            if (!await ask(q)) return;
            SB.rpc('admin_set_user_role', { p_user_id: u.user_id, p_role: to })
              .then(function () { status(u.username + (to === 'kdesk' ? ' is now a K-Desk login.' : ' is now a Supervisor.'), 'ok'); return loadUsers(); })
              .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
          });
          if (kb) act.appendChild(kb);
          // 📊 Report viewer: designation + this GP / whole block (block = Super Admin only)
          if (u.role === 'viewer') {
            var vb = el('button', '📊 Access', 'btn-light btn-small'); vb.style.marginLeft = '4px';
            vb.addEventListener('click', function () { editViewer(u); });
            act.appendChild(vb);
          }
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
    // IAY Dashboard card (js/iay-dash.js): the database limits it to the GP Admin's own GP
    if (window.IayDash) window.IayDash.load({ gps: state.gps, fixedGpId: gpView(), role: me.role });
    var gp = Number($('dashGp').value);
    if (!gp || dash.loading) return Promise.resolve();
    dash.loading = true;
    return Promise.all([
      SB.rpc('admin_dashboard', { p_gp_id: gp }, { retry: true }),
      SB.rpc('admin_list_duplicates', { p_gp_id: gp }, { retry: true }),
      // dates + missing accounts per list (SQL v190); older database: nothing extra
      SB.rpc('admin_list_extras', { p_gp_id: gp }, { retry: true }).catch(function () { return null; })
    ]).then(function (res) {
      dash.users = res[0] || []; dash.dups = res[1] || [];
      var extra = {}; dash.extrasOk = Array.isArray(res[2]); (res[2] || []).forEach(function (x) { extra[x.list_id] = x; });
      dash.rows = [];
      dash.users.forEach(function (u) {
        (u.lists || []).forEach(function (l) {
          var r = Object.assign({}, l, extra[l.list_id] || {}); r.user_id = u.user_id; r.username = u.username; r.full_name = u.full_name; r.user_active = u.active;
          dash.rows.push(r);
        });
      });
      var ids = new Set(dash.rows.map(function (r) { return r.list_id; }));
      dash.picked.forEach(function (id) { if (!ids.has(id)) dash.picked.delete(id); });
      renderDashboard();
      dash.at = new Date(); dashStamp();          // one "last updated" line: the page header's, next to its Refresh
      loadDataLine(gp);
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { dash.loading = false; });
  }

  // "Last data" line: when and from where this GP's worker data was last updated.
  // 2026-11-20: shown small, inside the ⓘ box next to the page title (with the villages of the lists);
  // the ⓘ turns orange when the data is older than STALE_DAYS.
  var STALE_DAYS = 7;
  function loadDataLine(gp) {
    return SB.rpc('admin_data_status', { p_gp_id: gp }).then(function (d) { dash.dataStatus = d || {}; loadDataLineText(); })
      .catch(function () { dash.dataStatus = null; loadDataLineText(); });   // older database without admin_data_status
  }
  function loadDataLineText() {
    var box = $('dataLine'), d = dash.dataStatus, parts = [], newest = 0;
    if (d) {
      if (d.last_sync) { parts.push('ABPS Sync (K-Desk) ' + fmtDate(d.last_sync.at) + ', ' + bn(d.last_sync.changed) + ' changed'); newest = Math.max(newest, Date.parse(d.last_sync.at)); }
      if (d.last_import) { parts.push('Excel import ' + fmtDate(d.last_import.at) + ' (' + d.last_import.file + ')'); newest = Math.max(newest, Date.parse(d.last_import.at)); }
    }
    var old = !!d && (!newest || Date.now() - newest > STALE_DAYS * 86400000);
    box.className = 'dataline' + (old ? ' old' : '');
    box.textContent = !d ? '' : parts.length ? '📅 Last data: ' + parts.join(' · ') + (old ? ' — older than ' + STALE_DAYS + ' days, run an ABPS Sync in K-Desk.' : '')
                                             : '📅 Last data: no import or ABPS Sync yet.';
    var vl = $('dashVillages'); if (vl) vl.textContent = (dash.villages && dash.villages.length) ? '🏘 ' + T('List-এর গ্রাম: ', 'Villages in the lists: ') + dash.villages.join(', ') : '';
    var sm = $('dashInfoSum');
    if (sm) { sm.textContent = old ? '⚠ ' + T('ডেটা পুরোনো', 'Old data') : 'ⓘ ' + T('ডেটা', 'Data');
      sm.title = newest ? T('শেষ ডেটা: ', 'Last data: ') + ago(new Date(newest).toISOString()) : ''; sm.parentNode.classList.toggle('old', old); }
  }
  // ---------- Demand lists page (2026-11-20): grouped by what has to be done ----------
  // Same data as before (admin_dashboard + admin_list_extras), only the layout changed:
  //  ① ready for K-Desk (Submitted + Locked) ② work left (drafts with workers) ③ empty drafts (folded)
  //  ④ supervisors without a list (folded). "Supervisor ধরে" (old cards) and "☰ List" views stay.
  // Colour rule: red ⛔ = the export would stop · orange ⚠ = work left · grey = information · green ✓ = fine.
  var LANG_KEY = 'gramg2.adminLang';                 // same EN/বাং setting as the Today page
  function dlang() { try { return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'bn'; } catch (e) { return 'bn'; } }
  function T(b, e) { return dlang() === 'bn' ? b : e; }
  function ago(s) {
    if (!s) return T('কখনও না', 'never');
    var m = Math.max(0, Math.round((Date.now() - new Date(s).getTime()) / 60000));
    if (m < 1) return T('এইমাত্র', 'just now');
    if (m < 60) return T(m + ' মিনিট আগে', m + ' min ago');
    var h = Math.floor(m / 60); if (h < 24) return T(h + ' ঘণ্টা আগে', h + ' h ago');
    var d = Math.floor(h / 24); return T(d + ' দিন আগে', d + (d === 1 ? ' day ago' : ' days ago'));
  }
  function ageDays(s) { return s ? (Date.now() - new Date(s).getTime()) / 864e5 : 0; }
  function stLbl(st) { return st === 'empty' ? T('List নেই', 'No list') : (STATE_BN[st] || st); }
  function hasDate(r) { return !!(r.from_date && r.work_days); }
  function needSup(r) { var n = Number(r.workers || 0); return n > 0 && (r.supervisors || []).length < reqSup(n); }
  function isToday(r) { return !!r.submitted_at && r.submit_state !== 'draft' && new Date(r.submitted_at).toDateString() === new Date().toDateString(); }
  function userOf(r) { return dash.users.filter(function (u) { return u.user_id === r.user_id; })[0] || { username: r.username, full_name: r.full_name, active: r.user_active }; }
  function rowOf(l) { return (dash.byId && dash.byId[l.list_id]) || l; }
  // the filter chips + the clickable number tiles
  function passRow(r) {
    var f = dash.filter;
    if (f === 'all') return true;
    if (f === 'empty') return false;
    if (f === 'nosup') return needSup(r);
    if (f === 'noacc') return Number(r.no_account || 0) > 0;
    if (f === 'today') return isToday(r);
    return r.submit_state === f;
  }
  function filterName(f) {
    return { nosup: T('Supervisor-এর নাম নেই/কম', 'Supervisor names missing'), noacc: T('Account/IFSC নেই', 'No Account/IFSC'), today: T('আজ submit', 'Submitted today') }[f] || '';
  }
  // small coloured label: kind = bad | warn | ok | info (the icon is part of the text)
  function tag(kind, text, title) { var t = el('span', text, 'tg tg-' + kind); if (title) t.title = title; return t; }
  function phoneOrUser(u) {
    var un = String(u.username || '');
    if (/^[6-9]\d{9}$/.test(un)) {
      var a = el('a', '📱 ' + un, 'tel'); a.href = 'tel:' + un; a.title = T('ফোন করুন', 'Call');
      a.addEventListener('click', function (e) { e.stopPropagation(); }); return a;
    }
    return el('span', '@' + un, 'un');
  }

  // ⋯ menu next to a supervisor's name: PIN, Disable / Enable, Team & Access
  var supMenu = null;
  function closeSupMenu() { if (supMenu) { supMenu.remove(); supMenu = null; } }
  function toggleUser(u) {
    return async function () {
      if (u.active && !await ask(T(u.username + '-এর account বন্ধ (Disable) করবেন? সব device থেকে সঙ্গে সঙ্গে logout হয়ে যাবে।',
        'Disable the account of ' + u.username + '? They are logged out of every device at once.'), 'Disable user')) return;
      SB.rpc('admin_set_user_active', { p_user_id: u.user_id, p_active: !u.active })
        .then(function () { status(u.username + ' ' + (u.active ? 'disabled' : 'enabled') + '.', 'ok'); return loadDashboard(); })
        .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
    };
  }
  function openSupMenu(u, anchor) {
    var was = supMenu && supMenu.dataset.user === String(u.user_id); closeSupMenu(); if (was) return;
    var m = el('div', null, 'supmenu'); m.setAttribute('role', 'menu'); m.dataset.user = u.user_id;
    m.appendChild(el('div', u.full_name || u.username, 'smh'));
    var sub = el('div', null, 'sms'); sub.appendChild(phoneOrUser(u));
    sub.appendChild(document.createTextNode(' · ' + T('শেষ login ', 'last login ') + ago(u.last_seen) + ' · ' +
      T(bn(u.active_devices) + 'টা device', bn(u.active_devices) + ' device(s)')));
    sub.title = u.last_seen ? fmtDate(u.last_seen) : ''; m.appendChild(sub);
    function item(label, fn, cls) { var b = el('button', label, 'smi' + (cls ? ' ' + cls : '')); b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.addEventListener('click', function () { closeSupMenu(); fn(); }); m.appendChild(b); }
    item('🔑 ' + T('নতুন PIN দিন', 'New PIN'), function () { openPinModal(u); });
    item(u.active ? '⛔ Disable user' : '✅ Enable user', toggleUser(u), u.active ? 'danger' : '');
    item('👥 ' + T('Team & Access-এ খুলুন', 'Open Team & Access'), function () { var b = document.querySelector('.tab[data-tab="users"]'); if (b) b.click(); });
    document.body.appendChild(m); supMenu = m;
    var r = anchor.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
    m.style.top = (r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px';
    m.querySelector('.smi').focus();
  }
  document.addEventListener('click', function (e) { if (supMenu && !e.target.closest('.supmenu,.dots')) closeSupMenu(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSupMenu(); });
  window.addEventListener('scroll', closeSupMenu, true);
  function dotsBtn(u) {
    var b = el('button', '⋯', 'dots'); b.type = 'button'; b.title = T('PIN, Disable ইত্যাদি', 'PIN, Disable and more'); b.setAttribute('aria-label', b.title);
    b.addEventListener('click', function (e) { e.stopPropagation(); openSupMenu(u, b); }); return b;
  }
  // "Nilkamal Mondal · 📱 7908378318 · login 3 দিন আগে ⋯"
  function supLine(u) {
    var d = el('div', null, 'wsup');
    d.appendChild(el('b', u.full_name || u.username)); d.appendChild(document.createTextNode(' · ')); d.appendChild(phoneOrUser(u));
    var lg = el('span', ' · login ' + ago(u.last_seen), 'lg'); lg.title = T('শেষ login: ', 'Last login: ') + (u.last_seen ? fmtDate(u.last_seen) : '—'); d.appendChild(lg);
    if (u.active === false) { d.appendChild(document.createTextNode(' ')); d.appendChild(el('span', 'User disabled', 'pill off')); }
    if (u.user_id) d.appendChild(dotsBtn(u));
    return d;
  }

  // ---------- page language (EN / বাং): static texts carry data-bn / data-en ----------
  function applyDashLang() {
    var L = dlang();
    [].forEach.call(document.querySelectorAll('#tab-dash [data-bn]'), function (x) {
      var v = x.getAttribute('data-' + L); if (v == null) return;
      if (x.hasAttribute('data-html')) x.innerHTML = v; else x.textContent = v;
    });
    [].forEach.call(document.querySelectorAll('#dashLang button'), function (b) { b.classList.toggle('on', b.dataset.l === L); });
    if (!$('tab-dash').classList.contains('hidden')) document.documentElement.lang = L;
  }
  $('dashLang').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-l]'); if (!b) return;
    try { localStorage.setItem(LANG_KEY, b.dataset.l); } catch (x) {}
    applyDashLang(); renderDashboard(); dashStamp(); loadDataLineText();
  });

  // one "last updated" line: the page header's (admin-shell.js shows it next to its Refresh button)
  function dashStamp() {
    if (!dash.at || $('tab-dash').classList.contains('hidden') || !$('subWhen')) return;
    $('subWhen').textContent = T('শেষ আপডেট ', 'Updated ') + dash.at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' (' + ago(dash.at.toISOString()) + ')';
  }
  setInterval(dashStamp, 30000);
  [].forEach.call(document.querySelectorAll('.tab[data-tab="dash"]'), function (b) {
    b.addEventListener('click', function () { setTimeout(function () { applyDashLang(); dashStamp(); }, 20); });
  });

  function renderDashboard() {
    dash.byId = {}; dash.rows.forEach(function (r) { dash.byId[r.list_id] = r; });
    // a list that went back to draft cannot stay ticked for the export
    dash.picked.forEach(function (id) { var r = dash.byId[id]; if (r && r.submit_state === 'draft') dash.picked.delete(id); });
    renderTiles();

    var D = $('dupBox'); D.innerHTML = '';
    D.classList.toggle('hidden', !dash.dups.length);
    if (dash.dups.length) {
      var det = el('details', null, 'dups'); det.id = 'dupDetails'; det.appendChild(el('summary', '⚠ ' + dash.dups.length + ' worker(s) are in more than one list (from before the new rule) — show'));
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

    // filter chips with numbers: All 10 · Submitted 0 · Draft 9 · No list 4 · Locked 1
    var c = { all: dash.rows.length, submitted: 0, draft: 0, locked: 0, empty: dash.users.filter(function (u) { return !(u.lists || []).length; }).length };
    dash.rows.forEach(function (r) { c[r.submit_state]++; });
    var names = { all: T('সব', 'All'), submitted: 'Submitted', draft: 'Draft', empty: T('List নেই', 'No list'), locked: 'Locked' };
    document.querySelectorAll('#dashFilters button[data-f]').forEach(function (b) {
      b.textContent = names[b.dataset.f] + ' ' + bn(c[b.dataset.f]); b.classList.toggle('active', b.dataset.f === dash.filter);
    });
    var fx = $('dashFilterX'); fx.classList.toggle('hidden', !filterName(dash.filter)); fx.textContent = '✕ ' + filterName(dash.filter);
    document.querySelectorAll('#dashView button').forEach(function (b) { b.classList.toggle('on', b.dataset.v === dashView); });
    var C = $('dashCards'); C.innerHTML = ''; C.className = 'ucards' + (dashView === 'work' ? ' wview' : '');
    if (dashView === 'list') { renderListTable(C); updateExportSummary(); return; }
    if (dashView === 'work') { renderWorkView(C); updateExportSummary(); return; }
    var shown = 0;
    dash.users.forEach(function (u) {
      var lists = (u.lists || []).filter(function (l) { return passRow(rowOf(l)); });
      if (dash.filter === 'empty' ? (u.lists || []).length : (dash.filter !== 'all' && !lists.length)) return;
      C.appendChild(userCard(u, lists)); shown++;
    });
    if (!shown) C.appendChild(el('div', dash.users.length ? T('এই ভাগে কিছু নেই।', 'Nothing in this group.') : T('এই GP-তে এখনও কোনো supervisor নেই। Team & Access থেকে যোগ করুন।', 'This GP has no supervisors yet. Add them from the Users tab.'), 'card muted'));
    updateExportSummary();
  }

  // One row of numbers (the old number tiles + the old summary block). A tile with a filter is a button.
  function renderTiles() {
    var S = $('dashStats'); S.innerHTML = '';
    var old = $('dashSum'); if (old) old.remove();          // (the separate summary block is now part of the tiles)
    var c = { submitted: 0, draft: 0, locked: 0, short: 0, todo: 0 }, workers = 0, noAcc = 0, tLists = 0, tWorkers = 0, vs = {};
    dash.rows.forEach(function (r) {
      var n = Number(r.workers || 0); c[r.submit_state]++; workers += n; noAcc += Number(r.no_account || 0);
      if (needSup(r)) c.short++;
      if (r.submit_state === 'draft' && n > 0) c.todo++;
      if (isToday(r)) { tLists++; tWorkers += n; }
      (r.villages || []).forEach(function (v) { vs[vno(v)] = 1; });
    });
    dash.villages = Object.keys(vs).sort();
    var noList = dash.users.filter(function (u) { return !(u.lists || []).length; });
    function tile(icon, n, label, sub, cls, f, title) {
      var d = el(f ? 'button' : 'div', null, 'stat ' + (cls || '') + (f ? ' click' : '') + (f && f === dash.filter && f !== 'all' ? ' on' : ''));
      if (f) { d.type = 'button'; d.addEventListener('click', function () {
        if (f === 'dups') { var x = $('dupDetails'); if (x) { x.open = true; x.scrollIntoView({ behavior: 'smooth', block: 'center' }); } return; }
        dash.filter = dash.filter === f ? 'all' : f; renderDashboard(); }); }
      var top = el('div', null, 'n'); top.appendChild(el('span', icon, 'ic')); top.appendChild(document.createTextNode(bn(n))); d.appendChild(top);
      d.appendChild(el('div', label, 'l')); if (sub) d.appendChild(el('div', sub, 's'));
      if (title) d.title = title;
      S.appendChild(d);
    }
    tile('📋', dash.rows.length, T('মোট list', 'Lists'), T(bn(workers) + ' জন worker', bn(workers) + ' workers'), '', 'all');
    tile('✓', c.submitted, 'Submitted', T('export করা যাবে', 'ready to export'), c.submitted ? 'good' : '', 'submitted');
    tile('⚠', c.draft, 'Draft', c.todo ? T(bn(c.todo) + 'টায় worker আছে', bn(c.todo) + ' with workers') : T('কোনোটায় worker নেই', 'none has workers'), c.todo ? 'warn' : '', 'draft');
    tile('🔒', c.locked, 'Locked', T('K-Desk-এর জন্য বন্ধ', 'closed for K-Desk'), '', 'locked');
    tile('➖', noList.length, T('List নেই', 'No list'), T('supervisor', 'supervisors'), '', 'empty', noList.map(function (u) { return u.full_name || u.username; }).join(', '));
    tile(c.short ? '⚠' : '✓', c.short, T('list-এ supervisor-এর নাম নেই বা কম', 'lists without enough supervisor names'), T('ক্লিক করলে list দেখাবে', 'click to see them'), c.short ? 'warn' : 'good', 'nosup');
    if (dash.extrasOk) tile(noAcc ? '⚠' : '✓', noAcc, T('জনের Account/IFSC নেই', 'workers without Account/IFSC'), noAcc ? T('export আটকাবে না', 'does not stop the export') : T('সবার আছে', 'all have one'), noAcc ? 'warn' : 'good', 'noacc');
    tile('📅', tLists, T('আজ submit', 'Submitted today'), T(bn(tWorkers) + ' জন worker', bn(tWorkers) + ' workers'), '', 'today');
    tile('👥', dash.users.length, 'Supervisors', T(bn(dash.users.filter(function (u) { return u.active; }).length) + ' জন চালু', bn(dash.users.filter(function (u) { return u.active; }).length) + ' active'), '', null);
    if (dash.dups.length) tile('⚠', dash.dups.length, T('worker দুই list-এ (পুরোনো)', 'Same worker in two lists (old)'), T('ক্লিক করে দেখুন', 'click to see'), 'warn', 'dups');
    loadDataLineText();
  }

  // ---------- default view: grouped by what has to be done ----------
  function section(kind, title, sub, count) {
    var box = el('div', null, 'wsec ' + kind), head = el('div', null, 'wsh');
    var h = el('h3'); h.appendChild(document.createTextNode(title + ' ')); h.appendChild(el('span', bn(count), 'cnt')); head.appendChild(h);
    box.appendChild(head); if (sub) box.appendChild(el('div', sub, 'wss'));
    var body = el('div', null, 'wbody'); box.appendChild(body);
    return { box: box, head: head, body: body };
  }
  function fold(kind, summary, open) {
    var d = el('details', null, 'wsec wfold ' + kind); if (open) d.open = true;
    d.appendChild(el('summary', summary)); var body = el('div', null, 'wbody'); d.appendChild(body);
    return { box: d, body: body };
  }
  function renderWorkView(C) {
    var ready = [], todo = [], empty = [];
    dash.rows.forEach(function (r) {
      if (!passRow(r)) return;
      var n = Number(r.workers || 0);
      if (!n) empty.push(r); else if (r.submit_state === 'draft') todo.push(r); else ready.push(r);
    });
    function t(r, k) { var v = r[k] ? Date.parse(r[k]) : 0; return v || 0; }
    ready.sort(function (a, b) { return (a.submit_state === 'submitted' ? 0 : 1) - (b.submit_state === 'submitted' ? 0 : 1) || t(b, 'submitted_at') - t(a, 'submitted_at'); });
    todo.sort(function (a, b) { return t(a, 'list_updated_at') - t(b, 'list_updated_at'); });
    empty.sort(function (a, b) { return t(a, 'list_updated_at') - t(b, 'list_updated_at'); });
    var noList = dash.users.filter(function (u) { return !(u.lists || []).length; });
    var all = dash.filter === 'all';

    if (!dash.users.length) { C.appendChild(el('div', T('এই GP-তে এখনও কোনো supervisor নেই। Team & Access থেকে যোগ করুন।', 'This GP has no supervisors yet. Add them from Team & Access.'), 'card muted')); return; }

    if (all || ready.length) {
      var s1 = section('ready', '✅ ' + T('K-Desk-এ পাঠানোর জন্য তৈরি', 'Ready for K-Desk'), T('Submitted আর Locked list। টিক দিয়ে এখান থেকেই Excel বানান।', 'Submitted and Locked lists. Tick them and make the Excel right here.'), ready.length);
      var tools = el('div', null, 'wtools');
      if (ready.some(function (r) { return r.submit_state === 'submitted'; })) {
        var pa = el('button', T('সব submitted বাছুন', 'Select all submitted'), 'btn-light btn-small'); pa.type = 'button';
        pa.addEventListener('click', function () { $('pickSubmitted').click(); }); tools.appendChild(pa);
      }
      var ex = el('button', '', 'btn-success btn-small expMirror'); ex.type = 'button'; ex.addEventListener('click', goExport); tools.appendChild(ex);
      s1.head.appendChild(tools);
      ready.forEach(function (r) { s1.body.appendChild(workRow(r, 'ready')); });
      if (!ready.length) s1.body.appendChild(el('div', T('এখনও কোনো list submit হয়নি। নিচের "কাজ বাকি" দেখুন।', 'No list is submitted yet. See "Work left" below.'), 'wempty'));
      C.appendChild(s1.box);
    }
    if (todo.length) {
      var s2 = section('todo', '⚠ ' + T('কাজ বাকি', 'Work left'), T('Worker আছে কিন্তু এখনও submit হয়নি। প্রতিটার পাশে লেখা আছে কী বাকি।', 'These have workers but are not submitted yet. Each says what is missing.'), todo.length);
      todo.forEach(function (r) { s2.body.appendChild(workRow(r, 'todo')); });
      C.appendChild(s2.box);
    }
    if (empty.length) {
      var s3 = fold('empty', T('খালি draft (' + bn(empty.length) + 'টা) · কোনো worker নেই', 'Empty drafts (' + bn(empty.length) + ') · no workers'), false);
      var del = el('button', '🗑 ' + T('সব খালি draft মুছুন', 'Delete all empty drafts'), 'btn-ghost btn-small'); del.type = 'button';
      del.addEventListener('click', function () { deleteEmptyDrafts(empty); });
      var bar = el('div', null, 'wtools'); bar.appendChild(del); s3.body.appendChild(bar);
      empty.forEach(function (r) { s3.body.appendChild(workRow(r, 'empty')); });
      C.appendChild(s3.box);
    }
    if ((all || dash.filter === 'empty') && noList.length) {
      var s4 = fold('nolist', T('List বানাননি (' + bn(noList.length) + ' জন supervisor)', 'No list yet (' + bn(noList.length) + ' supervisors)'), dash.filter === 'empty');
      noList.forEach(function (u) { var r = el('div', null, 'wrow nl'); r.appendChild(supLine(u)); s4.body.appendChild(r); });
      C.appendChild(s4.box);
    }
    if (!C.children.length) C.appendChild(el('div', T('এই ভাগে কিছু নেই।', 'Nothing in this group.'), 'card muted'));
  }

  // what a draft still needs before it can be submitted
  function missingOf(r) {
    var m = [], sups = (r.supervisors || []).length;
    if (!sups) m.push(T('Supervisor-এর নাম নেই', 'No supervisor name'));
    else if (needSup(r)) m.push(T('Supervisor কম: ' + reqSup(r.workers) + ' জন দরকার', 'Too few supervisors: ' + reqSup(r.workers) + ' needed'));
    if (!r.work_code) m.push(T('Work code নেই', 'No Work code'));
    if (dash.extrasOk && !hasDate(r)) m.push(T('Date নেই', 'No date'));
    return m;
  }
  function draftAge(r) {
    var d = Math.floor(ageDays(r.list_updated_at));
    var txt = d < 1 ? T('🕘 আজ বদলেছে', '🕘 changed today') : T('🕘 ' + bn(d) + ' দিন ধরে draft', '🕘 draft for ' + bn(d) + (d === 1 ? ' day' : ' days'));
    return { d: d, txt: txt, title: T('শেষ বদল: ', 'Last change: ') + fmtDate(r.list_updated_at) };
  }
  function workRow(r, kind) {
    var n = Number(r.workers || 0), st = r.submit_state, u = userOf(r);
    var row = el('div', null, 'wrow ' + kind + (dash.picked.has(r.list_id) ? ' sel' : ''));
    var ck = el('label', null, 'wck');
    if (kind !== 'empty') {
      var cb = document.createElement('input'); cb.type = 'checkbox';
      if (st === 'draft') { cb.disabled = true; ck.title = T('আগে submit করতে হবে', 'Submit it first'); ck.classList.add('off'); }
      else {
        cb.checked = dash.picked.has(r.list_id); ck.title = T('K-Desk export-এ যোগ করুন', 'Add to K-Desk export');
        cb.addEventListener('change', function () { if (cb.checked) dash.picked.add(r.list_id); else dash.picked.delete(r.list_id); row.classList.toggle('sel', cb.checked); updateExportSummary(); });
      }
      cb.setAttribute('aria-label', ck.title); ck.appendChild(cb);
    }
    row.appendChild(ck);
    var main = el('div', null, 'wmain');
    var head = el('div', null, 'whead');
    var nm = el('div', r.work_name || T('(Work Name নেই)', '(no Work Name)'), 'wname'); nm.title = r.work_name || '';
    head.appendChild(nm); head.appendChild(el('span', stLbl(st), 'pill ' + st)); main.appendChild(head);
    main.appendChild(supLine(u));
    var tags = el('div', null, 'wtags');
    if (kind === 'todo') {
      var miss = missingOf(r);
      miss.forEach(function (x) { tags.appendChild(tag('warn', '⚠ ' + x)); });
      tags.appendChild(tag('warn', '⚠ ' + (miss.length ? T('Submit বাকি', 'Not submitted') : T('সব আছে, শুধু submit বাকি', 'All filled, only Submit left'))));
    }
    if (kind !== 'empty') {
      if (kind === 'ready') {
        if (r.kdesk_loaded_at) tags.appendChild(tag('ok', '✓ ' + T('K-Desk-এ গেছে ', 'In K-Desk ') + ago(r.kdesk_loaded_at), fmtDate(r.kdesk_loaded_at) + (r.export_count > 1 ? ' (' + r.export_count + 'x)' : '')));
        else if (r.exported_at) tags.appendChild(tag('info', '📤 Export ' + ago(r.exported_at), fmtDate(r.exported_at) + (r.export_count > 1 ? ' (' + r.export_count + 'x)' : '')));
        if (needSup(r)) tags.appendChild(tag('warn', '⚠ ' + T('Supervisor কম: ' + reqSup(n) + ' জন দরকার', 'Too few supervisors: ' + reqSup(n) + ' needed')));
      }
      if (dash.extrasOk) {
        if (hasDate(r)) tags.appendChild(tag('info', '📅 ' + ddmmyyyy(r.from_date).slice(0, 5) + ' → ' + dateTo(r.from_date, Number(r.work_days)).slice(0, 5) + ' · ' + T(r.work_days + ' দিন', r.work_days + ' days'), dateText(r.from_date, r.work_days)));
        else if (kind === 'ready') tags.appendChild(tag('info', '📅 ' + T('Date নেই: panel-এর From/Days বসবে', 'No date: panel From/Days used')));
        var na = Number(r.no_account || 0);
        if (na) tags.appendChild(tag('warn', '⚠ ' + T(bn(na) + ' জনের Account/IFSC নেই', bn(na) + ' without Account/IFSC'), T('Export আটকাবে না, তবে payment-এর আগে ঠিক করুন', 'Does not stop the export; fix before payment')));
        else if (kind === 'ready') tags.appendChild(tag('ok', '✓ ' + T('সবার Account আছে', 'All have an account')));
      }
      if (kind === 'ready') {
        if (r.work_code) tags.appendChild(tag('info mono', '🏷 ' + r.work_code));
        else tags.appendChild(tag('info', '🏷 ' + T('Work code নেই: panel-এরটা বসবে', 'No Work code: panel one used')));
        if (r.submitted_at) tags.appendChild(tag('info', '🕘 Submit ' + ago(r.submitted_at), fmtDate(r.submitted_at)));
        var rt = resultsText(r.results, n);
        if (rt) tags.appendChild(tag((r.results.demand_err || r.results.alloc_err) ? 'warn' : 'ok', ((r.results.demand_err || r.results.alloc_err) ? '⚠ ' : '✓ ') + rt));
      }
      if (r.villages && r.villages.length) tags.appendChild(tag('info', '🏘 ' + r.villages.map(vno).join(', ')));
    }
    if (st === 'draft') { var ag = draftAge(r); tags.appendChild(tag(kind === 'todo' && ag.d > 3 ? 'warn' : 'info', ag.txt, ag.title)); }
    main.appendChild(tags);
    row.appendChild(main);
    var num = el('div', null, 'wnum'); num.appendChild(el('b', bn(n))); num.appendChild(el('span', T('জন', 'workers'))); row.appendChild(num);
    var acts = el('div', null, 'wacts');
    function act(label, cls, fn, title) { var b = el('button', label, cls + ' btn-small'); b.type = 'button'; if (title) b.title = title; b.addEventListener('click', fn); acts.appendChild(b); return b; }
    act('👁 View', 'btn-primary', function () { openPreview(r); });
    if ((st === 'submitted' || st === 'draft') && n > 0) act('🔒 Lock', 'btn-light', function () { listAction(r, 'lock'); });
    if (st === 'submitted' || st === 'locked') act('↩ Send back', 'btn-light', function () {
      ask('Make "' + r.work_name + '" (' + r.username + ') a draft again? The supervisor can then change it.').then(function (ok) { if (ok) listAction(r, 'reopen'); });
    });
    if (st === 'locked') act('✔ Work complete', 'btn-light', function () {
      ask('"' + r.work_name + '" (' + r.username + ') — work complete?\nThe list is closed (it stays in the history) and its ' + n + ' workers can be picked for new work again.', 'Yes, complete', 'ok').then(function (ok) { if (ok) listAction(r, 'complete'); });
    });
    if (Number(r.submissions)) act('🕘 ' + r.submissions, 'btn-light', function () { openSubmissions(r); }, 'Past submissions (' + r.submissions + ')');
    act('🗑', 'btn-ghost', function () { deleteList(r); }, T('List মুছুন', 'Delete list'));
    row.appendChild(acts);
    return row;
  }

  // ---------- ☰ List view: one row per list ----------
  var dashView = 'work';
  try { dashView = localStorage.getItem('gramg2.adminDashView2') || 'work'; } catch (e) {}
  if (['work', 'details', 'list'].indexOf(dashView) < 0) dashView = 'work';
  $('dashView').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-v]'); if (!b) return;
    dashView = b.dataset.v; try { localStorage.setItem('gramg2.adminDashView2', dashView); } catch (x) {}
    renderDashboard();
  });
  function renderListTable(C) {
    var rows = [];
    dash.users.forEach(function (u) {
      var ls = u.lists || [];
      if (dash.filter === 'empty') { if (!ls.length) rows.push({ u: u, r: null }); return; }
      ls.forEach(function (l) {
        var r = rowOf(l);
        if (!passRow(r)) return;
        rows.push({ u: u, r: r });
      });
      if (dash.filter === 'all' && !ls.length) rows.push({ u: u, r: null });
    });
    if (!rows.length) { C.appendChild(el('div', dash.users.length ? T('এই ভাগে কিছু নেই।', 'Nothing in this group.') : 'This GP has no supervisors yet. Add them from the Users tab.', 'card muted')); return; }
    var wrap = el('div', null, 'lwrap'), t = el('table', null, 'ltable'), hr = el('tr');
    ['', 'Supervisor', 'Work', 'Status', 'Workers', 'Date', 'Accounts', ''].forEach(function (h) { hr.appendChild(el('th', h)); });
    var th = el('thead'); th.appendChild(hr); t.appendChild(th);
    var tb = el('tbody');
    function cell(tr, label, cls) { var c = el('td', null, cls || ''); c.setAttribute('data-label', label); tr.appendChild(c); return c; }
    rows.forEach(function (x) {
      var u = x.u, r = x.r, tr = el('tr', null, r && dash.picked.has(r.list_id) ? 'sel' : '');
      var c0 = cell(tr, 'Export');
      var n = r ? Number(r.workers || 0) : 0;
      if (r && n > 0) {
        var cb = document.createElement('input'); cb.type = 'checkbox';
        if (r.submit_state === 'draft') { cb.disabled = true; cb.title = T('আগে submit করতে হবে', 'Submit it first'); }
        else {
          cb.title = 'Add to K-Desk export'; cb.checked = dash.picked.has(r.list_id);
          cb.addEventListener('change', function () { if (cb.checked) dash.picked.add(r.list_id); else dash.picked.delete(r.list_id); tr.classList.toggle('sel', cb.checked); updateExportSummary(); });
        }
        c0.appendChild(cb);
      }
      var cs = cell(tr, 'Supervisor'); cs.appendChild(el('div', u.full_name || u.username));
      var sl = el('div', null, 'sub'); sl.appendChild(phoneOrUser(u)); if (!u.active) sl.appendChild(document.createTextNode(' · disabled')); cs.appendChild(sl);
      if (!r) { var cn = cell(tr, 'Work', 'sub'); cn.textContent = T('এখন কোনো list নেই', 'No current list'); cn.colSpan = 6; tr.appendChild(el('td')); tb.appendChild(tr); return; }
      var cw = cell(tr, 'Work', 'wk'); var wn = el('div', r.work_name || '(no Work Name)', 'clamp2'); wn.title = r.work_name || ''; cw.appendChild(wn);
      cw.appendChild(el('div', r.work_code || 'no Work Code', 'sub'));
      if (r.villages && r.villages.length) cw.appendChild(el('div', 'village ' + r.villages.map(vno).join(', '), 'sub'));
      cell(tr, 'Status').appendChild(el('span', STATE_BN[r.submit_state], 'pill ' + r.submit_state));
      var cwk = cell(tr, 'Workers'); cwk.appendChild(el('div', bn(n)));
      if (needSup(r)) cwk.appendChild(el('div', '⚠ needs ' + reqSup(n) + ' sup.', 'sub warn'));
      var cd = cell(tr, 'Date', hasDate(r) ? '' : 'sub');
      if (hasDate(r)) { cd.appendChild(el('div', ddmmyyyy(r.from_date).slice(0, 5) + ' → ' + dateTo(r.from_date, Number(r.work_days)))); cd.appendChild(el('div', r.work_days + ' working days', 'sub')); }
      else cd.textContent = '—';
      var ca = cell(tr, 'Accounts');
      if (dash.extrasOk && n) { var na = Number(r.no_account || 0); ca.textContent = na ? '⚠ ' + bn(na) + ' no A/C' : '✓ all'; ca.title = na ? bn(na) + ' worker(s) without Account No / IFSC' : 'Every worker has an account'; ca.className = na ? 'warn' : 'okc'; } else ca.textContent = '—';
      var cact = cell(tr, '', 'acts');
      function act(label, cls, fn, title) { var b = el('button', label, cls + ' btn-small'); if (title) b.title = title; b.addEventListener('click', fn); cact.appendChild(b); }
      act('👁', 'btn-primary', function () { openPreview(r); }, 'View the list');
      if ((r.submit_state === 'submitted' || r.submit_state === 'draft') && n > 0) act('🔒', 'btn-light', function () { listAction(r, 'lock'); }, 'Lock');
      if (r.submit_state === 'submitted' || r.submit_state === 'locked') act('↩', 'btn-light', function () {
        ask('Make "' + r.work_name + '" (' + r.username + ') a draft again? The supervisor can then change it.').then(function (ok) { if (ok) listAction(r, 'reopen'); });
      }, 'Send back (make it a draft again)');
      tb.appendChild(tr);
    });
    t.appendChild(tb); wrap.appendChild(t); C.appendChild(wrap);
  }

  // ---------- "Supervisor ধরে" view: one card per supervisor (the old Details view) ----------
  function userCard(u, lists) {
    var card = el('div', null, 'ucard');
    var top = el('div', null, 'top');
    var who = el('div'); who.appendChild(el('div', u.full_name || u.username, 'nm'));
    var un = el('div', null, 'un'); un.appendChild(phoneOrUser(u)); if (!u.active) un.appendChild(document.createTextNode(' · disabled')); who.appendChild(un);
    var pills = el('div', null, 'tr'); pills.style.textAlign = 'right';
    pills.appendChild(el('span', (u.lists || []).length + ' list(s)', 'pill neutral'));
    if (!u.active) { pills.appendChild(document.createTextNode(' ')); pills.appendChild(el('span', 'User disabled', 'pill off')); }
    pills.appendChild(dotsBtn(u));
    top.appendChild(who); top.appendChild(pills); card.appendChild(top);
    var meta = el('div', 'Devices: ' + u.active_devices + ' active · last login ' + ago(u.last_seen), 'meta'); meta.title = u.last_seen ? fmtDate(u.last_seen) : ''; card.appendChild(meta);
    if (!(u.lists || []).length) card.appendChild(el('div', T('এখন কোনো list নেই।', 'No current list.'), 'muted'));
    lists.forEach(function (l) { card.appendChild(listCard(rowOf(l))); });
    // 🔑 PIN and Disable user moved into the ⋯ menu next to the name
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
    var ln = el('div', r.work_name || '(no Work Name)', 'lname clamp2'); ln.title = r.work_name || ''; head.appendChild(ln);
    head.appendChild(el('span', STATE_BN[st], 'pill ' + st));
    box.appendChild(head);
    var meta = el('div', null, 'meta');
    function line(label, value, cls) { var d = el('div', null, cls || ''); d.appendChild(el('b', label + ': ')); d.appendChild(document.createTextNode(value)); meta.appendChild(d); return d; }
    line('Workers', bn(n) + (r.villages && r.villages.length ? ' · village ' + r.villages.map(vno).join(', ') : ''));
    line('Supervisors', (sups.length ? sups.join(', ') : '—') + (needSup(r) ? '  ⚠ ' + need + ' needed' : ''), needSup(r) ? 'warnline' : '');
    line('Work Code', r.work_code || '— (not set)', r.work_code ? 'mono' : 'muted');
    if (dash.extrasOk) {
      line('Date', hasDate(r) ? dateText(r.from_date, r.work_days) : '— (supervisor has not given it)', hasDate(r) ? '' : 'muted');
      if (n > 0) line('Accounts', Number(r.no_account) ? '⚠ ' + bn(r.no_account) + ' of ' + bn(n) + ' workers have no Account No / IFSC' : '✓ all ' + bn(n) + ' have an account', Number(r.no_account) ? 'warnline' : 'kdline');
    }
    if (st === 'draft') { var ag = draftAge(r); var al = line(T('Draft', 'Draft'), ag.txt.replace('🕘 ', ''), n > 0 && ag.d > 3 ? 'warnline' : 'muted'); al.title = ag.title; }
    if (r.submitted_at) line('Submitted', fmtDate(r.submitted_at));
    if (r.kdesk_loaded_at) line('🖥 K-Desk', 'loaded ' + fmtDate(r.kdesk_loaded_at) + (r.export_count > 1 ? ' (' + r.export_count + ' times in all)' : ''), 'kdline');
    else if (r.exported_at) line('Exported', fmtDate(r.exported_at) + (r.export_count > 1 ? ' (' + r.export_count + ' times)' : ''));
    var rt = resultsText(r.results, n);
    if (rt) line('Results', rt, (r.results.demand_err || r.results.alloc_err) ? 'warnline' : 'kdline');
    box.appendChild(meta);
    if (n > 0) {
      var pick = el('label', null, 'pick'); var cb = document.createElement('input'); cb.type = 'checkbox';
      cb.dataset.list = r.list_id;
      if (st === 'draft') { cb.disabled = true; pick.title = T('আগে submit করতে হবে', 'Submit it first'); pick.classList.add('off'); }
      else {
        cb.checked = dash.picked.has(r.list_id);
        cb.addEventListener('change', function () {
          if (cb.checked) dash.picked.add(r.list_id); else dash.picked.delete(r.list_id);
          box.classList.toggle('sel', cb.checked); updateExportSummary();
        });
      }
      pick.appendChild(cb); pick.appendChild(document.createTextNode('Add to K-Desk export' + (st === 'draft' ? T(' (আগে submit করতে হবে)', ' (submit it first)') : ''))); box.appendChild(pick);
    }
    var acts = el('div', null, 'acts');
    function act(label, cls, fn) { var b = el('button', label, cls + ' btn-small'); b.addEventListener('click', fn); acts.appendChild(b); return b; }
    act('👁 View', 'btn-primary', function () { openPreview(r); });
    if ((st === 'submitted' || st === 'draft') && n > 0) act('🔒 Lock', 'btn-light', function () { listAction(r, 'lock'); });
    if (st === 'submitted' || st === 'locked') act('↩ Send back', 'btn-light', function () {
      ask('Make "' + r.work_name + '" (' + r.username + ') a draft again? The supervisor can then change it.').then(function (ok) { if (ok) listAction(r, 'reopen'); });
    });
    if (st === 'locked') act('✔ Work complete', 'btn-light', function () {
      ask('"' + r.work_name + '" (' + r.username + ') — work complete?\nThe list is closed (it stays in the history) and its ' + n + ' workers can be picked for new work again.', 'Yes, complete', 'ok').then(function (ok) { if (ok) listAction(r, 'complete'); });
    });
    if (Number(r.submissions)) act('🕘 Past submissions (' + r.submissions + ')', 'btn-light', function () { openSubmissions(r); });
    act('🗑 Delete', 'btn-ghost', function () { deleteList(r); });
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

  // ---------- delete list (database: admin_delete_list; soft delete, kept in Backup) ----------
  // A list with workers needs its name typed before Delete works.
  function normName(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function askTyped(msg, need, yes) {
    var inp = $('askInput'), y = $('askYes');
    inp.value = ''; inp.placeholder = need; inp.classList.remove('hidden');
    var p = ask(msg, yes, 'danger');
    y.disabled = true;
    function check() { y.disabled = normName(inp.value) !== normName(need); }
    inp.addEventListener('input', check);
    setTimeout(function () { inp.focus(); }, 30);
    return p.then(function (ok) { inp.removeEventListener('input', check); inp.classList.add('hidden'); inp.placeholder = ''; y.disabled = false; return ok && normName(inp.value) === normName(need); });
  }
  async function deleteList(r) {
    var n = Number(r.workers || 0), name = r.work_name || '';
    var msg = T('এই list মুছবেন?', 'Delete this list?') + '\n\n📋 ' + (name || '(no Work Name)') + '\n👤 ' + (r.full_name || r.username) + ' · ' + (STATE_BN[r.submit_state] || r.submit_state) +
      ' · ' + T(bn(n) + ' জন worker', bn(n) + ' workers') + '\n\n' +
      T('List-টা panel আর supervisor app থেকে সরে যাবে, এর worker-রা আবার নতুন list-এ বাছা যাবে। Database-এ (Backup) K-Desk result সহ থেকে যাবে।',
        'The list disappears from the panel and the supervisor app, and its workers can be picked for a new list again. It stays in the database (Backup) with its K-Desk results.') +
      (r.submit_state === 'locked' ? '\n\n⚠ ' + T('এই list Locked (হয়তো এখন K-Desk-এ আছে)।', 'This list is Locked (it may be in K-Desk now).') : '');
    var ok = n > 0
      ? await askTyped(msg + '\n\n' + T('নিশ্চিত করতে list-এর নাম টাইপ করুন: ', 'Type the list name to confirm: ') + (name || r.username), name || r.username, '🗑 ' + T('মুছুন', 'Delete'))
      : await ask(msg, '🗑 ' + T('মুছুন', 'Delete'));
    if (!ok) return;
    loading('Deleting the list...');
    return SB.rpc('admin_delete_list', { p_list_id: r.list_id })
      .then(function () {
        status('🗑 "' + r.work_name + '" (' + r.username + ') deleted.', 'ok');
        dash.picked.delete(r.list_id);
        return loadDashboard();
      }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  }
  // "সব খালি draft মুছুন": the same admin_delete_list, once per empty draft (only lists with 0 workers)
  async function deleteEmptyDrafts(list) {
    list = list.filter(function (r) { return !Number(r.workers || 0) && r.submit_state === 'draft'; });
    if (!list.length) return;
    var names = list.slice(0, 12).map(function (r) { return '• ' + (r.work_name || '(no Work Name)') + ' — ' + (r.full_name || r.username); }).join('\n') + (list.length > 12 ? '\n…' : '');
    if (!await ask(T(bn(list.length) + 'টা খালি draft মুছবেন? এগুলোতে কোনো worker নেই।', 'Delete ' + list.length + ' empty drafts? They have no workers.') + '\n\n' + names +
      '\n\n' + T('Database-এ (Backup) থেকে যাবে।', 'They stay in the database (Backup).'), '🗑 ' + T('সব মুছুন', 'Delete all'))) return;
    var done = 0, failed = 0;
    for (var i = 0; i < list.length; i++) {
      loading(T('মুছছি… ', 'Deleting… ') + (i + 1) + '/' + list.length);
      try { await SB.rpc('admin_delete_list', { p_list_id: list[i].list_id }); done++; dash.picked.delete(list[i].list_id); }
      catch (e) { if (e.authLost) { loading(''); return; } failed++; }
    }
    loading('');
    status('🗑 ' + T(bn(done) + 'টা খালি draft মোছা হয়েছে।', done + ' empty draft(s) deleted.') + (failed ? ' ⚠ ' + T(failed + 'টা মোছা যায়নি।', failed + ' could not be deleted.') : ''), failed ? 'err' : 'ok');
    return loadDashboard();
  }

  // ---------- K-Desk export panel ----------
  function pickedRows() { return dash.rows.filter(function (r) { return dash.picked.has(r.list_id); }); }
  function shortNames(rs) { return rs.map(function (r) { return '"' + (r.work_name || '—') + '" (' + (r.full_name || r.username) + ')'; }).join(', '); }
  // what still stops the export: missing From/Days or Work code for lists that have none of their own
  function exportNeeds() {
    var rows = pickedRows();
    var noDate = rows.filter(function (r) { return !hasDate(r); }), noCode = rows.filter(function (r) { return !r.work_code; });
    var days = parseInt($('expDays').value, 10);
    return { rows: rows, noDate: noDate, noCode: noCode,
             dateBad: noDate.length && (!$('expFrom').value || !(days >= 1 && days <= 366)), codeBad: noCode.length && !$('expWork').value.trim() };
  }
  function updateExportSummary() {
    var x = exportNeeds(), rows = x.rows, n = 0;
    rows.forEach(function (r) { n += Number(r.workers || 0); });
    $('expDateBox').classList.toggle('hidden', !x.noDate.length);
    $('expCodeBox').classList.toggle('hidden', !x.noCode.length);
    $('expDateFor').textContent = x.noDate.length ? T('এই ' + bn(x.noDate.length) + 'টা list-এ date নেই: ', 'These ' + x.noDate.length + ' list(s) have no date: ') + shortNames(x.noDate) : '';
    $('expCodeFor').textContent = x.noCode.length ? T('এই ' + bn(x.noCode.length) + 'টা list-এ Work code নেই: ', 'These ' + x.noCode.length + ' list(s) have no Work code: ') + shortNames(x.noCode) : '';
    var S = $('expSummary'); S.innerHTML = '';
    if (!rows.length) S.appendChild(el('div', T('কোনো list বাছা হয়নি। উপরে "K-Desk-এ পাঠানোর জন্য তৈরি" থেকে টিক দিন।', 'No list selected. Tick lists in "Ready for K-Desk".'), 'muted'));
    else {
      S.appendChild(el('div', T(bn(rows.length) + 'টা list বাছা হয়েছে: ', rows.length + ' list(s) selected: ') + shortNames(rows), 'muted'));
      if (x.dateBad) S.appendChild(tag('bad', '⛔ ' + T('From আর Days দিন, নইলে export হবে না', 'Enter From and Days, or the export stops')));
      if (x.codeBad) S.appendChild(tag('bad', '⛔ ' + T('Work code দিন, নইলে export হবে না', 'Enter the Work code, or the export stops')));
      if (!x.noDate.length && !x.noCode.length) S.appendChild(tag('ok', '✓ ' + T('সব list-এ নিজের date আর Work code আছে', 'Every list has its own date and Work code')));
    }
    var label = rows.length ? T('📥 ' + bn(rows.length) + 'টা list-এর K-Desk Excel বানান (মোট ' + bn(n) + ' জন)', '📥 Make K-Desk Excel of ' + rows.length + ' list(s) (' + bn(n) + ' workers)')
                            : T('📥 K-Desk Excel বানান', '📥 Create K-Desk Excel');
    $('expBtn').textContent = label; $('expBtn').disabled = !rows.length;
    [].forEach.call(document.querySelectorAll('.expMirror'), function (b) { b.textContent = label; b.disabled = !rows.length; });
    $('expFloatN').textContent = T(bn(rows.length) + 'টা বাছাই', rows.length + ' selected');
    $('expFloat').classList.toggle('hidden', !rows.length);
  }
  // the sticky bar on phones and the button in "Ready for K-Desk": export at once, or show the
  // export panel first when it still needs From/Days or the Work code
  function goExport() {
    var x = exportNeeds();
    if (!x.rows.length) return;
    if (x.dateBad || x.codeBad) {
      $('exportCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      var f = x.dateBad ? (!$('expFrom').value ? $('expFrom') : $('expDays')) : $('expWork');
      setTimeout(function () { f.focus(); }, 400);
      status(T('আগে export panel-এ ', 'First fill ') + (x.dateBad ? 'From/Days' : 'Work code') + T(' দিন।', ' in the export panel.'), 'err');
      return;
    }
    $('expBtn').click();
  }
  $('expFloat').addEventListener('click', goExport);
  ['expFrom', 'expDays', 'expWork'].forEach(function (id) { $(id).addEventListener('input', updateExportSummary); });
  // phone: tables become cards, each cell shows its column name
  function labelTable(tbody) {
    var tbl = tbody.closest('table'), heads = tbl ? Array.prototype.map.call(tbl.querySelectorAll('thead th'), function (h) { return h.textContent.trim(); }) : [];
    Array.prototype.forEach.call(tbody.rows, function (tr) { Array.prototype.forEach.call(tr.cells, function (td, i) { if (td.colSpan > 1) return; td.setAttribute('data-label', heads[i] || ''); }); });
  }
  if (window.MutationObserver) ['users', 'history'].forEach(function (id) {
    new MutationObserver(function () { labelTable($(id)); }).observe($(id), { childList: true });
  });

  $('dashGp').addEventListener('change', function () { dash.picked.clear(); loadDashboard(); });
  $('dashRefresh').addEventListener('click', loadDashboard);
  document.querySelectorAll('#dashFilters button[data-f]').forEach(function (b) {
    b.addEventListener('click', function () { dash.filter = b.dataset.f; renderDashboard(); });
  });
  $('dashFilterX').addEventListener('click', function () { dash.filter = 'all'; renderDashboard(); });
  applyDashLang();
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
  // Working days N → To date by the portal's 6+1 rule (N + floor(N/6) days in all)
  function dateTo(iso, n) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); if (!m || !n) return ''; var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n + Math.floor(n / 6) - 1));
    return String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear(); }
  function dateText(iso, n) { return 'From ' + ddmmyyyy(iso) + ' · ' + n + ' working days · To ' + dateTo(iso, n); }
  function ddmmyyyy(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  // Pure function (also used by tests): API rows -> K-Desk sheet rows + report.
  // codeByList (optional): list_id -> that list's own Work Code; workCode is used for the rest.
  // dateByList (optional): list_id -> {from: 'dd/mm/yyyy', days: N} given by the supervisor; from/days are used for the rest.
  function buildKdeskRows(apiRows, from, days, workCode, codeByList, dateByList) {
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
    out.forEach(function (r, i) { var dl = dateByList && dateByList[r.list_id];
      aoa.push([i + 1, r.job_card_no, r.applicant_name, dl ? dl.from : from, dl ? dl.days : days, (codeByList && codeByList[r.list_id]) || workCode]); });
    return { aoa: aoa, count: out.length, skipped: skipped, dupes: dupes };
  }
  window.GramgKdesk = { buildKdeskRows: buildKdeskRows, ddmmyyyy: ddmmyyyy };

  $('expBtn').addEventListener('click', async function () {
    var rows = pickedRows();
    var from = ddmmyyyy($('expFrom').value), days = parseInt($('expDays').value, 10), work = $('expWork').value.trim();
    var codeByList = {}; rows.forEach(function (r) { if (r.work_code) codeByList[r.list_id] = r.work_code; });
    var needCode = rows.some(function (r) { return !r.work_code; });
    var dateByList = {}; rows.forEach(function (r) { if (r.from_date && r.work_days) dateByList[r.list_id] = { from: ddmmyyyy(r.from_date), days: Number(r.work_days) }; });
    var needDate = rows.some(function (r) { return !dateByList[r.list_id]; });
    if (!rows.length) { status('Select lists first.', 'err'); return; }
    if (needDate && !from) { status('Enter From (work date) — some selected lists have no date from the supervisor.', 'err'); return; }
    if (needDate && !(days >= 1 && days <= 366)) { status('Enter valid Days (1 to 366) — some selected lists have no date from the supervisor.', 'err'); return; }
    if (needCode && !work) { status('Enter the Work code (some selected lists have no Work Code of their own).', 'err'); return; }
    var notSub = rows.filter(function (r) { return r.submit_state === 'draft'; });
    if (notSub.length && !await ask(notSub.map(function (r) { return r.username; }).join(', ') + ' has not submitted the list yet. Export anyway?')) return;
    var doLock = $('expLock').checked;
    loading('Creating the K-Desk file...');
    var report;
    loadXlsx().then(function () {
      return SB.rpc('admin_export_lists', { p_list_ids: rows.map(function (r) { return r.list_id; }) });
    }).then(function (apiRows) {
      report = buildKdeskRows(apiRows || [], from, days, work, codeByList, dateByList);
      if (!report.count) throw { hint: 'There are no workers to export.' };
      var ws = XLSX.utils.aoa_to_sheet(report.aoa);
      ws['!cols'] = [{ wch: 6 }, { wch: 26 }, { wch: 30 }, { wch: 12 }, { wch: 6 }, { wch: 30 }];
      var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Demand');
      var safe = (work || rows[0].work_code || 'list').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
      XLSX.writeFile(wb, 'KDesk_Demand_' + safe + '_' + (from || (dateByList[rows[0].list_id] || {}).from || '').replace(/\//g, '-') + '.xlsx');
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
    var what = role === 'kdesk' ? 'K-Desk login' : role === 'viewer' ? 'Report viewer' : 'supervisor';
    var desig = $('nuDesig').value.trim(), block = role === 'viewer' && !gpView() && $('nuBlock').checked;
    loading('Creating the ' + what + '...');
    SB.callFunction('admin-users', { action: 'create_user', username: un, full_name: name, pin: pin, gp_id: gp, role: role })
      .then(function (r) {
        if (role !== 'viewer') return r;
        return SB.rpc('admin_set_viewer', { p_user_id: r.user_id, p_designation: desig || null, p_block: block }).then(function () { return r; });
      })
      .then(function (r) {
        status('✅ ' + r.username + ' (' + what + ') created. Login: username "' + r.username + '", PIN "' + pin + '". Give the PIN to them yourself.', 'ok');
        $('nuName').value = ''; $('nuUsername').value = ''; $('nuPin').value = ''; $('nuDesig').value = ''; $('nuBlock').checked = false;
        return Promise.all([loadUsers(), loadDashboard()]);
      }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  });

  // ---------- 📊 Report viewer (v228) ----------
  function nuRoleView() {
    var v = $('nuRole').value === 'viewer';
    $('nuViewer').classList.toggle('hidden', !v);
    $('nuBlockBox').classList.toggle('hidden', !v || !!gpView());
  }
  $('nuRole').addEventListener('change', nuRoleView); nuRoleView();
  async function editViewer(u) {
    var cur = viewers[u.user_id] || {};
    var d = window.prompt('Designation of ' + (u.full_name || u.username) + ' (e.g. GRS, STP, NS, JE, BDO):', cur.designation || '');
    if (d === null) return;
    var block = false;
    if (!gpView()) block = await ask('Let ' + u.username + ' see EVERY GP (block level, e.g. BDO)?\n\nNo = only ' + (u.gp_name || 'their GP') + '.', 'All GPs (block)');
    loading('Saving...');
    SB.rpc('admin_set_viewer', { p_user_id: u.user_id, p_designation: d.trim() || null, p_block: block })
      .then(function () { status(u.username + ': ' + (block ? 'sees every GP' : 'sees only ' + (u.gp_name || 'their GP')) + '.', 'ok'); return loadUsers(); })
      .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  }

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
  async function toggleGpAdmin(u) {
    var to = u.role === 'gp_admin' ? 'gp_user' : 'gp_admin';
    var q = to === 'gp_admin'
      ? 'Make ' + u.username + ' the GP Admin of ' + (u.gp_name || 'this GP') + '? They open the Admin panel for this GP only (no phone list building). Their PIN stays the same; they are logged out of every device.' + (kdeskOf(u.gp_id) ? '' : ' A K-Desk login for the GP is made too.')
      : 'Make ' + u.username + ' a Supervisor again? They lose the Admin panel.';
    if (!await ask(q)) return;
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
  async function renameUser(u) {
    var v = window.prompt('Full name of @' + u.username + ':', u.full_name || ''); if (v == null) return;
    v = v.trim(); if (v.length < 2) { status('Enter the full name (at least 2 letters).', 'err'); return; }
    if (v === (u.full_name || '')) return;
    SB.rpc('admin_rename_user', { p_user_id: u.user_id, p_name: v })
      .then(function (r) { status('✅ ' + u.username + ': name changed to ' + r.full_name, 'ok'); return loadUsers(); })
      .catch(function (e) { if (!e.authLost) status(/Could not find the function/i.test(e.message || '') ? 'Database update (SQL v231) has not been run yet.' : errText(e), 'err'); });
  }
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
      var dOk = 0, dAll = 0, dAl = 0, aOk = 0, aAll = 0;
      items.forEach(function (x) { if (x.demand_status) { dAll++; if (isAlready(x.demand_status, x.demand_msg)) dAl++; else if (x.demand_status === 'done') dOk++; } if (x.alloc_status) { aAll++; if (x.alloc_status === 'done') aOk++; } });
      if (dAll) { stat(dOk + '/' + dAll, 'Demand done (K-Desk)', dOk < dAll ? 'warn' : 'good'); }
      if (dAl) { stat(dAl, 'Demand already there (portal)', 'warn'); }
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
      // a draft cannot go to the K-Desk export: it has to be submitted first
      var pvDraft = d.submit_state === 'draft'; $('pvPick').disabled = pvDraft;
      $('pvPick').parentNode.title = pvDraft ? T('আগে submit করতে হবে', 'Submit it first') : '';
      $('pvPick').parentNode.classList.toggle('off', pvDraft);
      renderListPreview(); $('pvModal').classList.add('show');
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  }
  var RES = { done: 'Success', error: 'Error', skipped: 'Skipped' };
  // portal: "Demand of X for period … is already there (and work is allotted)": K-Desk reports done, but nothing new was entered
  function isAlready(s, msg) { return s === 'done' && /already there|already exists/i.test(msg || ''); }
  function resCell(s, msg, at, demand) {
    var al = demand && isAlready(s, msg);
    var td = el('td', al ? '⚠ Already there' : s ? (s === 'done' ? '✓ ' : '✕ ') + RES[s] : '—', al ? 'res-warn' : s ? (s === 'done' ? 'res-ok' : 'res-bad') : 'muted');
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
      tr.appendChild(resCell(x.demand_status, x.demand_msg, x.demand_at, true)); tr.appendChild(resCell(x.alloc_status, x.alloc_msg, x.alloc_at));
      var notes = [];
      if (!x.active) notes.push('inactive'); else if (!x.eligible) notes.push('no eKYC/ABPS');
      if (x.in_other_lists > 0) notes.push('also in another list');
      if (!x.account_no) notes.push('no account');
      tr.appendChild(el('td', notes.join(', ')));
      var tdx = el('td'); var rb = el('button', '✕', 'btn-light btn-small'); rb.title = 'Remove from this list';
      rb.addEventListener('click', async function () {
        if (!await ask('Remove ' + x.applicant_name + ' (' + x.job_card_no + ') from this list?')) return;
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
        (isAlready(x.demand_status, x.demand_msg) ? 'Already there' : RES[x.demand_status] || ''), x.demand_msg || '', RES[x.alloc_status] || '', x.alloc_msg || '']); });
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
  // From the "New GP Admin" form: jump to the New Gram Panchayat card (Data Import tab)
  $('gaNewGp').addEventListener('click', function () {
    var t = document.querySelector('.tab[data-tab="import"]'); if (t) t.click();
    setTimeout(function () { $('gpAddCard').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('gpName').focus(); }, 80);
  });
  $('gpPrefix').addEventListener('input', function () { var v = this.value.toUpperCase(); if (v !== this.value) this.value = v; });
  $('gpAddBtn').addEventListener('click', async function () {
    var name = $('gpName').value.trim(), prefix = $('gpPrefix').value.trim().toUpperCase();
    if (name.length < 2) { status('Enter the GP name.', 'err'); return; }
    if (!/^WB-\d{2}-\d{3}-\d{3}$/.test(prefix)) { status(errText({ code: 'BAD_PREFIX' }), 'err'); return; }
    if (!await ask('New GP: ' + name + ' (' + prefix + ')\nAdd it?')) return;
    loading('Adding the GP...');
    SB.rpc('admin_add_gp', { p_jc_prefix: prefix, p_name: name }).then(function (g) {
      status('✅ ' + g.name + ' (' + g.jc_prefix + ') added. Now pick the GP below and import its data, then create supervisors in the Users tab.', 'ok');
      $('gpName').value = ''; $('gpPrefix').value = '';
      return loadGps().then(function () { $('gpSelect').value = String(g.id); showGpStats(); });
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  });

  // ---------- rename a GP (Super Admin) ----------
  function fillRenameGp() {
    var sel = $('gpRenSel'); if (!sel) return; var cur = sel.value; sel.innerHTML = '';
    state.gps.forEach(function (g) { var o = document.createElement('option'); o.value = String(g.id); o.textContent = g.name + ' (' + g.jc_prefix + ')'; sel.appendChild(o); });
    if (cur) sel.value = cur;
    var g0 = state.gps.filter(function (x) { return String(x.id) === sel.value; })[0]; if (g0 && !$('gpRenName').value) $('gpRenName').value = g0.name;
  }
  $('gpRenSel').addEventListener('change', function () { var g = state.gps.filter(function (x) { return String(x.id) === $('gpRenSel').value; })[0]; $('gpRenName').value = g ? g.name : ''; });
  $('gpRenBtn').addEventListener('click', async function () {
    var id = Number($('gpRenSel').value), name = $('gpRenName').value.trim();
    var g = state.gps.filter(function (x) { return x.id === id; })[0]; if (!g) return;
    if (name.length < 2) { status('Enter the new GP name.', 'err'); return; }
    if (name === g.name) { status('That is already the name.', 'err'); return; }
    if (!await ask('Rename GP\n' + g.name + '  →  ' + name + '\n(Job Card prefix ' + g.jc_prefix + ' stays the same.)')) return;
    loading('Saving the name...');
    SB.rpc('admin_rename_gp', { p_gp_id: id, p_name: name }).then(function (r) {
      status('✅ GP renamed: ' + g.name + ' → ' + r.name, 'ok');
      return loadGps().then(function () { $('gpRenSel').value = String(id); $('gpRenName').value = r.name; });
    }).catch(function (e) { if (!e.authLost) status(/Could not find the function/i.test(e.message || '') ? 'Database update (SQL v230) has not been run yet.' : errText(e), 'err'); })
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
