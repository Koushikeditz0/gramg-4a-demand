/* =====================================================================
   IAY Tracker (v191) — reads the IAY Phase Report (Tampermonkey Excel),
   stores it GP-wise in Supabase and shows what must be done and when.
   Database: supabase/2026-11-09_iay_tracker_v191.sql
   ===================================================================== */
(function () {
  'use strict';
  var SB = window.GramgSB;
    var GP_KEY = 'gramg2.iay.gp';
  var $ = function (id) { return document.getElementById(id); };
  var me = { role: null, scope: null };
  var ov = null;                       // last iay_overview result
  var list = { kind: null, date: null, rows: [], title: '' };

  // ---------- small helpers ----------
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function nf(n) { return Number(n || 0).toLocaleString('en-IN'); }
  function dmy(iso) { if (!iso) return ''; var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : String(iso); }
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function dayName(iso) { var p = String(iso).split('-'); return WD[new Date(+p[0], p[1] - 1, +p[2]).getDay()]; }
  function when(ts) { if (!ts) return '—'; var d = new Date(ts); return d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function status(msg, kind) { var s = $('status'); s.textContent = msg || ''; s.className = 'status' + (msg ? ' show ' + (kind || 'info') : ''); }
  function loading(t) { $('loadingText').textContent = t || ''; $('loading').classList.toggle('show', !!t); }
  function errText(e) {
    var map = {
      NOT_AUTHORIZED: 'You are not allowed to view / upload data for this GP.',
      SESSION_REVOKED: 'This device was logged out. Please log in again.',
      NOT_LOGGED_IN: 'Please log in again.',
      WRONG_GP_ROWS: 'This GP sheet contains Job Cards of another GP.',
      NO_WORKS: 'No IAY works found in the sheet.',
      BAD_GP: 'Could not identify the GP from the Job Cards.',
      NETWORK: 'Check the internet connection and try again.'
    };
    return map[e.code] || ('Error: ' + (e.message || e));
  }
  function selPrefix() { return me.scope || $('gpSel').value || null; }

  // ---------- boot ----------
  SB.onAuthLost = function () { location.replace('./index.html'); };
  function boot() {
    if (!SB.hasSession()) { location.replace('./index.html'); return; }
    loading('Opening IAY Tracker...');
    SB.rpc('get_my_context').then(function (ctx) {
      if (ctx.role !== 'super_admin' && ctx.role !== 'gp_admin') { location.replace('./index.html'); return; }
      me.role = ctx.role;
      loadSync(); loadShare();
      return load(true);
    }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  }

  // ---------- overview ----------
  function load(first) {
    var p = first ? (me.role === 'super_admin' ? readGp() : null) : selPrefix();
    return SB.rpc('iay_overview', { p_jc_prefix: null }, { retry: true, timeout: 60000 }).then(function (all) {
      me.scope = all.scope || null;
      fillGpSelect(all.gps, p);
      ov = all;
      render(); loadJobs();
      loadSummary();
    });
  }
  function readGp() { try { return localStorage.getItem(GP_KEY) || ''; } catch (e) { return ''; } }
  function fillGpSelect(gps, keep) {
    var s = $('gpSel'), cur = keep != null ? keep : s.value;
    s.innerHTML = '';
    if (!me.scope) { var o = el('option', 'All GPs (Block)'); o.value = ''; s.appendChild(o); }
    gps.forEach(function (g) { var o = el('option', g.gp_name); o.value = g.jc_prefix; s.appendChild(o); });
    if (me.scope) { s.value = me.scope; s.disabled = true; }
    else s.value = gps.some(function (g) { return g.jc_prefix === cur; }) ? cur : '';
  }

  function picked() {
    var p = selPrefix(), gps = (ov && ov.gps) || [];
    return p ? gps.filter(function (g) { return g.jc_prefix === p; }) : gps;
  }
  function sum(gps, k) { return gps.reduce(function (s, g) { return s + Number(g[k] || 0); }, 0); }

  var CARDS = [
    ['fill_overdue', 'Fill overdue — MR ended, not filled yet', 'red'],
    ['fill_today', 'MR ends today — fill today', 'red'],
    ['fill_tomorrow', 'MR ends tomorrow — fill tomorrow', 'blue'],
    ['mr_gap', 'MR gap — next MR needed now', 'red'],
    ['mr_due5', 'Next MR needed within 5 days', 'amber'],
    ['wl_pending', 'MR filled, wagelist pending', 'amber'],
    ['no_mr', 'No MR yet', 'gray'],
    ['done6', '6 MRs (90 days) complete', 'green']
  ];
  function render() {
    var gps = picked(), p = selPrefix();
    // cards
    var box = $('cards'); box.innerHTML = '';
    CARDS.forEach(function (c) {
      var n = sum(gps, c[0]), d = el('div', null, 'k ' + c[2] + (n ? '' : ' zero'));
      d.appendChild(el('div', nf(n), 'n')); d.appendChild(el('div', c[1], 'l'));
      d.onclick = function () { openList(c[0], null, c[1]); };
      box.appendChild(d);
    });
    // report line
    var reps = gps.map(function (g) { return g.report_at; }).filter(Boolean).sort();
    var oldest = reps[0], todayIso = ov.today;
    var stale = !oldest || new Date(oldest).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) !== todayIso;
    $('repLine').innerHTML = '';
    $('repLine').appendChild(document.createTextNode('Today ' + dmy(todayIso) + ' · ' + (p ? '' : gps.length + ' GPs · ') +
      'IAY works: ' + nf(sum(gps, 'works')) + ' · Report: ' + (oldest ? when(oldest) : 'not uploaded yet')));
    if (stale) {
      var w = el('b', '  ⚠ Not today\'s report — run Phase Report Update on the portal and upload the new Excel.');
      w.style.color = '#b91c1c'; $('repLine').appendChild(w);
    }
    if (!gps.length) status('No data yet. Upload the IAY Phase Report Excel (Full) from the portal using “📤 Upload Phase Report”.', 'info');
    // calendar
    var cb = $('calBody'); cb.innerHTML = '';
    calendarFor(p).then(function (cal) {
      cb.innerHTML = '';
      if (!cal.length) { var tr0 = el('tr'); var td0 = el('td', 'Nothing in the next 35 days'); td0.colSpan = 3; tr0.appendChild(td0); cb.appendChild(tr0); return; }
      cal.forEach(function (c) {
        var tr = el('tr', null, c.date === todayIso ? 'today' : '');
        tr.appendChild(el('td', dmy(c.date) + ' (' + dayName(c.date) + ')' + (c.date === todayIso ? ' · today' : ''), 'nw'));
        tr.appendChild(cntCell(c.fill, function () { openList('fill_on', c.date, dmy(c.date) + ' — MR fill'); }));
        tr.appendChild(cntCell(c.mr_start, function () { openList('mr_start_on', c.date, dmy(c.date) + ' — new MR must start'); }));
        cb.appendChild(tr);
      });
    });
    // GP table
    $('gpCard').classList.toggle('hidden', !!me.scope);
    var gb = $('gpBody'); gb.innerHTML = '';
    ((ov && ov.gps) || []).forEach(function (g) {
      var tr = el('tr', null, g.jc_prefix === p ? 'today' : '');
      var a = el('a', g.gp_name, 'c'); a.onclick = function () { $('gpSel').value = g.jc_prefix; onGp(); };
      var td = el('td'); td.appendChild(a); tr.appendChild(td);
      ['works', 'fill_overdue', 'fill_today', 'fill_tomorrow', 'mr_gap', 'mr_due5', 'wl_pending', 'no_mr', 'avg_mrs', 'done6'].forEach(function (k) {
        tr.appendChild(el('td', k === 'avg_mrs' ? String(g[k] || 0) : nf(g[k]), 'n'));
      });
      tr.appendChild(el('td', when(g.report_at), 'nw'));
      gb.appendChild(tr);
    });
  }
  function cntCell(n, fn) {
    var td = el('td', null, 'n');
    if (n) { var a = el('a', nf(n), 'c'); a.onclick = fn; td.appendChild(a); } else td.textContent = '—';
    return td;
  }
  // the overview call was for all GPs; ask for the calendar of the chosen GP
  function calendarFor(p) {
    if (!p || me.scope) return Promise.resolve(ov.calendar || []);
    return SB.rpc('iay_overview', { p_jc_prefix: p }, { retry: true, timeout: 60000 })
      .then(function (r) { return r.calendar || []; }, function (e) { status(errText(e), 'err'); return []; });
  }

  function onGp() {
    try { localStorage.setItem(GP_KEY, $('gpSel').value); } catch (e) {}
    $('listCard').classList.add('hidden');
    render();
    renderSummary();
    loadJobs();
  }
  $('gpSel').addEventListener('change', onGp);
  $('refreshBtn').onclick = function () { loading('Refresh...'); loadSync(); load(false).catch(function (e) { status(errText(e), 'err'); }).then(function () { loading(''); }); };


  // ---------- Tampermonkey live sync key (SQL v192) ----------
  function loadSync() {
    return SB.rpc('iay_sync_key_status', {}, { retry: true }).then(function (st) {
      var l = $('syncLine'); l.innerHTML = '';
      if (!st.active) { l.appendChild(el('span', '⚪ Not connected — create a key and paste it in the Tampermonkey script.')); $('syncOff').classList.add('hidden'); return; }
      $('syncOff').classList.remove('hidden');
      l.appendChild(el('span', '🟢 Key active (created ' + when(st.created_at) + ') · ' +
        (st.last_used_at ? 'last sync ' + when(st.last_used_at) + (st.last_gp ? ' — ' + st.last_gp : '') : 'no sync received yet')));
    }).catch(function (e) { $('syncLine').textContent = errText(e); });
  }
  $('syncNew').onclick = function () {
    if (!window.confirm('Create a new sync key? Any older key stops working at once, so paste the new one in the Tampermonkey script.')) return;
    SB.rpc('iay_sync_key_create', {}).then(function (r) {
      $('syncKey').value = r.key; $('syncBox').classList.remove('hidden'); $('syncKey').select();
      loadSync();
    }).catch(function (e) { status(errText(e), 'err'); });
  };
  $('syncCopy').onclick = function () {
    var v = $('syncKey').value; if (!v) return;
    (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(function () { $('syncCopy').textContent = 'Copied ✓'; },
      function () { $('syncKey').select(); document.execCommand('copy'); $('syncCopy').textContent = 'Copied ✓'; });
  };
  $('syncOff').onclick = function () {
    if (!window.confirm('Stop live sync? The Tampermonkey script will no longer be able to send data until a new key is made.')) return;
    SB.rpc('iay_sync_key_revoke', {}).then(function () { $('syncBox').classList.add('hidden'); $('syncKey').value = ''; loadSync(); })
      .catch(function (e) { status(errText(e), 'err'); });
  };


  // ---------- day-wise MR Summary (SQL v193, js/iay-summary.js) ----------
  var sumData = null, IS = window.IaySummary;
  function loadSummary() {
    return SB.rpc('iay_mr_summary', { p_past: +$('sumPast').value, p_ahead: +$('sumAhead').value }, { retry: true, timeout: 60000 })
      .then(function (r) { sumData = r; renderSummary(); }, function (e) { status(errText(e), 'err'); });
  }
  function renderSummary() { if (sumData) IS.renderTable($('sumTable'), IS.model(sumData, selPrefix()), { onPick: pickPending, legendEl: $('sumLegend') }); }
  var pend = { rows: [], title: '' };
  function pickPending(kind, jc, date, title) {
    $('sumList').classList.remove('hidden'); $('sumListTitle').textContent = title + ' — loading…'; $('sumListTbl').innerHTML = ''; $('sumListNote').textContent = '';
    SB.rpc('iay_pending_list', { p_jc_prefix: jc, p_kind: kind, p_date: date, p_past: +$('sumPast').value }, { retry: true, timeout: 90000 }).then(function (rows) {
      pend = { rows: rows || [], title: title, kind: kind, jc: jc, date: date, past: +$('sumPast').value };
      var canJob = !!jc && kind !== 'wl' && pend.rows.length > 0;
      $('sumJobAttend').classList.toggle('hidden', !canJob); $('sumJobPay').classList.toggle('hidden', !canJob);
      $('sumListTitle').textContent = title + ' (' + nf(pend.rows.length) + ')';
      $('sumListNote').textContent = pend.rows.length > 500 ? 'Showing the first 500 here; the Excel has all ' + nf(pend.rows.length) + '.' : '';
      IS.renderList($('sumListTbl'), pend.rows, 500);
      $('sumList').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) { $('sumListTitle').textContent = title; status(errText(e), 'err'); });
  }
  $('sumJobAttend').onclick = function () { sendJob(pend.jc, 'attend', pend.kind, pend.date, pend.past, pend.title); };
  $('sumJobPay').onclick = function () { sendJob(pend.jc, 'pay', pend.kind, pend.date, pend.past, pend.title); };
  $('sumListClose').onclick = function () { $('sumList').classList.add('hidden'); };
  $('sumListXlsx').onclick = function () { if (pend.rows.length) IS.exportList(pend.rows, pend.title, 'IAY_' + pend.title.replace(/[^A-Za-z0-9-]+/g, '_')).catch(function (e) { status(e.message, 'err'); }); };
  $('sumPast').onchange = $('sumAhead').onchange = function () { loadSummary(); };
  $('sumXlsx').onclick = function () {
    if (!sumData || !sumData.gps.length) return;
    var m = IS.model(sumData, selPrefix()), one = selPrefix() && m.rows[0] ? m.rows[0].name : '';
    loading('Preparing Excel...');
    Promise.all([
      SB.rpc('iay_mr_window', { p_jc_prefix: selPrefix(), p_from: sumData.from, p_to: sumData.to }, { retry: true, timeout: 90000 }),
      SB.rpc('iay_list', { p_jc_prefix: selPrefix(), p_kind: 'fill_overdue', p_date: null }, { retry: true, timeout: 90000 })
    ]).then(function (r) {
      // MR Details = window; Pending List also gets MRs that ended before the window and are still not filled
      var rows = r[0] || [], seen = {}, extra = [];
      rows.forEach(function (x) { seen[x.work_code + '|' + x.mr_no] = 1; });
      (r[1] || []).forEach(function (x) { if (!seen[x.work_code + '|' + x.mr_no]) extra.push(x); });
      return IS.exportXlsx(m, rows, { titlePrefix: one ? one + ' — ' : '', fileTag: one, extraPending: extra });
    })
      .catch(function (e) { status(e.code ? errText(e) : (e.message || String(e)), 'err'); }).then(function () { loading(''); });
  };

  // ---------- public report link (SQL v194) ----------
  var PUB_BASE = location.origin + location.pathname.replace(/[^\/]*$/, '') + 'iay-report.html#k=';
  function loadShare() {
    return SB.rpc('iay_share_status', {}, { retry: true }).then(function (st) {
      var l = $('shareLine'); l.textContent = '';
      $('shareOff').classList.toggle('hidden', !st.active);
      l.textContent = st.active ? '🟢 Public link active (made ' + when(st.created_at) + ') · opened ' + nf(st.views) + ' times' + (st.last_view_at ? ', last ' + when(st.last_view_at) : '')
                                : '⚪ No public link.';
    }).catch(function (e) { $('shareLine').textContent = errText(e); });
  }
  $('shareNew').onclick = function () {
    if (!window.confirm('Make a new public link? Anyone with the link can see the GP-wise MR counts (no names or Job Cards). Any older link stops working.')) return;
    SB.rpc('iay_share_create', {}).then(function (r) {
      $('shareUrl').value = PUB_BASE + r.token; $('shareBox').classList.remove('hidden'); $('shareUrl').select(); loadShare();
    }).catch(function (e) { status(errText(e), 'err'); });
  };
  $('shareCopy').onclick = function () {
    var v = $('shareUrl').value; if (!v) return;
    (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(function () { $('shareCopy').textContent = 'Copied ✓'; },
      function () { $('shareUrl').select(); document.execCommand('copy'); $('shareCopy').textContent = 'Copied ✓'; });
  };
  $('shareWa').onclick = function () { var v = $('shareUrl').value; if (v) window.open('https://wa.me/?text=' + encodeURIComponent('PBAY Muster Roll Summary (live): ' + v), '_blank'); };
  $('shareOff').onclick = function () {
    if (!window.confirm('Stop the public link? Everyone who has it will lose access.')) return;
    SB.rpc('iay_share_revoke', {}).then(function () { $('shareBox').classList.add('hidden'); $('shareUrl').value = ''; loadShare(); })
      .catch(function (e) { status(errText(e), 'err'); });
  };

  // ---------- drill-down list ----------
  var MR_KINDS = ['fill_overdue', 'fill_on', 'wl_pending'];
  var MR_COLS = [['gp', 'GP'], ['work_code', 'Work Code'], ['reg_no', 'Reg No.'], ['name', 'Beneficiary'], ['jcn', 'Job Card'], ['village', 'Village'],
                 ['mr_no', 'MR No'], ['seq', 'Phase'], ['start', 'MR Start'], ['end', 'MR End'], ['status', 'Status']];
  var W_COLS = [['gp', 'GP'], ['work_code', 'Work Code'], ['reg_no', 'Reg No.'], ['name', 'Beneficiary'], ['jcn', 'Job Card'], ['village', 'Village'],
                ['mrs', 'MRs done'], ['remaining', 'MRs left'], ['last_end', 'Last MR ends'], ['next_start', 'Next MR starts'], ['finish_by', '90 days done by (est.)']];
  function cols() { return MR_KINDS.indexOf(list.kind) >= 0 ? MR_COLS : W_COLS; }
  function openList(kind, date, title) {
    loading('Loading list...');
    SB.rpc('iay_list', { p_jc_prefix: selPrefix(), p_kind: kind, p_date: date }, { retry: true, timeout: 60000 }).then(function (rows) {
      list = { kind: kind, date: date, rows: rows || [], title: title };
      var gpn = selPrefix() ? ($('gpSel').selectedOptions[0] || {}).textContent : 'All GPs';
      $('listTitle').textContent = title + ' · ' + gpn + ' (' + nf(list.rows.length) + ')';
      $('listNote').textContent = list.rows.length > 500 ? 'Showing the first 500 here; the Excel will have all ' + nf(list.rows.length) + '.' : '';
      var c = cols(), hr = el('tr');
      hr.appendChild(el('th', '#'));
      c.forEach(function (x) { hr.appendChild(el('th', x[1])); });
      $('listHead').innerHTML = ''; $('listHead').appendChild(hr);
      var body = $('listBody'); body.innerHTML = '';
      var todayIso = ov.today;
      list.rows.slice(0, 500).forEach(function (r, i) {
        var tr = el('tr', null, (r.end && r.end < todayIso && list.kind !== 'wl_pending') || (r.next_start && r.next_start <= todayIso) ? 'late' : '');
        tr.appendChild(el('td', String(i + 1), 'n'));
        c.forEach(function (x) {
          var v = r[x[0]];
          if (/start|end|finish_by/.test(x[0]) && v) v = dmy(v);
          tr.appendChild(el('td', v == null ? '' : String(v), /work_code|jcn|reg_no|mr_no/.test(x[0]) ? 'mono nw' : (/start|end|finish/.test(x[0]) ? 'nw' : '')));
        });
        body.appendChild(tr);
      });
      if (!list.rows.length) { var tr0 = el('tr'), td0 = el('td', 'Nothing pending ✅'); td0.colSpan = c.length + 1; tr0.appendChild(td0); body.appendChild(tr0); }
      var one = !!selPrefix() && list.rows.length > 0, dem = one && DEMAND_KINDS.indexOf(kind) >= 0, mr = one && (kind === 'fill_overdue' || kind === 'fill_on');
      $('listJobDemand').classList.toggle('hidden', !dem);
      $('listJobAttend').classList.toggle('hidden', !mr); $('listJobPay').classList.toggle('hidden', !mr);
      $('listCard').classList.remove('hidden');
      $('listCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) { status(errText(e), 'err'); }).then(function () { loading(''); });
  }
  $('listClose').onclick = function () { $('listCard').classList.add('hidden'); };

  // ---------- K-Desk jobs (SQL v199) ----------
  var DEMAND_KINDS = ['mr_gap', 'mr_due5', 'mr_start_on', 'no_mr'];
  var JOB_NAME = { demand: 'Demand + Allocation', attend: 'MR Attendance', pay: 'MR Payment' };
  function mrSource(kind) { return kind === 'fill_on' ? ['day', 0] : ['older', 0]; }   // fill_overdue = ended before today
  $('listJobDemand').onclick = function () {
    var d = list.date;
    if (list.kind === 'no_mr') {
      var v = window.prompt('These works have no MR yet. Demand “From” date (DD/MM/YYYY):', dmy(ov.today));
      if (!v) return; var m = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!m) { status('Date must be DD/MM/YYYY.', 'err'); return; }
      d = m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
    }
    sendJob(selPrefix(), 'demand', list.kind, d, 2, list.title);
  };
  $('listJobAttend').onclick = function () { var s = mrSource(list.kind); sendJob(selPrefix(), 'attend', s[0], list.date, s[1], list.title); };
  $('listJobPay').onclick = function () { var s = mrSource(list.kind); sendJob(selPrefix(), 'pay', s[0], list.date, s[1], list.title); };
  function gpName(jc) { var g = ((ov && ov.gps) || []).filter(function (x) { return x.jc_prefix === jc; })[0]; return g ? g.gp_name : jc; }
  function sendJob(jc, kind, source, date, past, title) {
    if (!jc) { status('Select one GP first — a K-Desk job is for one GP.', 'err'); return; }
    var t = JOB_NAME[kind] + ' · ' + String(title || '').replace(/\s*\(\d[\d,]*\)\s*$/, '');
    if (!window.confirm('Send this list to K-Desk as a “' + JOB_NAME[kind] + '” job for ' + gpName(jc) + '?\n\n' + t +
        '\n\nNothing is done on the portal until you load the job in K-Desk on the PC and press Start.')) return;
    loading('Making job...');
    SB.rpc('iay_job_create', { p_jc_prefix: jc, p_kind: kind, p_source: source, p_date: date || null, p_past: past, p_title: t }, { timeout: 90000 }).then(function (r) {
      if (!r.job_id) { status('Nothing to send — the list is empty' + (r.left_out ? ' (' + r.left_out + ' left out: ' + (kind === 'pay' ? 'no MB page' : 'Job Card / name / date missing') + ')' : '') + '.', 'err'); return; }
      status('✅ Job #' + r.job_id + ' sent to K-Desk: ' + nf(r.total) + ' rows' + (r.left_out ? ' · ' + nf(r.left_out) + ' left out (' + (kind === 'pay' ? 'no MB page yet' : 'Job Card / name / date missing') + ')' : '') +
             '.\nOn the PC: K-Desk → ' + JOB_NAME[kind] + ' panel → 📥 Admin job.', 'ok');
      loadJobs(); $('jobCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) { status(errText(e), 'err'); }).then(function () { loading(''); });
  }
  var jobTimer = null;
  function loadJobs() {
    clearTimeout(jobTimer);
    var p = selPrefix();
    SB.rpc('iay_mb_status', { p_jc_prefix: p }, { retry: true }).then(function (m) {
      $('mbLine').textContent = !p ? '' : (m && m.first_mb ? 'MB books: ' + m.first_mb + '–' + m.last_mb + ' · ' + nf(m.slots) + ' works have pages · last MB used ' + (m.last_used || '—') +
        (m.waiting ? ' · ' + nf(m.waiting) + ' Ongoing works get pages at the next payment job' : '') : 'MB books not set for this GP — payment jobs need them.');
    }).catch(function () { $('mbLine').textContent = ''; });
    return SB.rpc('iay_jobs_list', { p_jc_prefix: p }, { retry: true }).then(function (jobs) {
      var b = $('jobBody'); b.innerHTML = '';
      if (!jobs.length) { var tr0 = el('tr'), td0 = el('td', 'No jobs yet'); td0.colSpan = 10; tr0.appendChild(td0); b.appendChild(tr0); }
      var live = false;
      jobs.forEach(function (j) {
        var tr = el('tr');
        tr.appendChild(el('td', String(j.id), 'n'));
        var t = el('td'); t.appendChild(el('b', JOB_NAME[j.kind])); t.appendChild(el('div', j.title.replace(JOB_NAME[j.kind] + ' · ', ''), 'muted')); tr.appendChild(t);
        tr.appendChild(el('td', gpName(j.jc_prefix), 'nw'));
        [j.total, j.ok, j.failed, j.skipped].forEach(function (n) { tr.appendChild(el('td', nf(n), 'n')); });
        var st = { queued: '⏳ Waiting for K-Desk', running: '▶ Running', done: '✅ Done', cancelled: '✕ Cancelled' }[j.status] || j.status;
        tr.appendChild(el('td', st + (j.status === 'running' ? ' (' + nf(j.ok + j.failed + j.skipped) + '/' + nf(j.total) + ')' : ''), 'nw'));
        tr.appendChild(el('td', when(j.created_at), 'nw'));
        var act = el('td', null, 'nw');
        var x = el('button', '⬇', 'btn-success btn-small'); x.title = 'Rows + results Excel'; x.onclick = function () { jobXlsx(j.id); }; act.appendChild(x);
        if (j.status === 'queued' || j.status === 'running') {
          live = true;
          var c = el('button', '✕', 'btn-light btn-small'); c.title = 'Cancel job'; c.style.marginLeft = '4px';
          c.onclick = function () { if (window.confirm('Cancel job #' + j.id + '? K-Desk will not show it any more.')) SB.rpc('iay_job_cancel', { p_id: j.id }).then(loadJobs).catch(function (e) { status(errText(e), 'err'); }); };
          act.appendChild(c);
        }
        tr.appendChild(act); b.appendChild(tr);
      });
      if (live) jobTimer = setTimeout(function () { if (!document.hidden) loadJobs(); else jobTimer = setTimeout(loadJobs, 30000); }, 20000);
    }).catch(function (e) { $('jobBody').innerHTML = ''; status(errText(e), 'err'); });
  }
  $('jobRefresh').onclick = function () { loadJobs(); };
  var RES = { done: 'Done', error: 'Error', skipped: 'Skipped' };
  function jobXlsx(id) {
    loading('Preparing Excel...');
    Promise.all([needXlsx(), SB.rpc('iay_job_detail', { p_id: id }, { timeout: 60000 })]).then(function (r) {
      var d = r[1], k = d.job.kind, res = d.results || {}, H, rows;
      if (k === 'demand') {
        H = ['Work Code', 'Reg. No.', 'Applicant', 'From', 'Days', 'Demand', 'Demand note', 'Allocation', 'Allocation note'];
        rows = d.items.map(function (x) { var z = res[x.work_code] || {}; return [x.work_code, x.reg, x.app, x.from, x.days, RES[z.d] || '', z.dm || '', RES[z.a] || '', z.am || '']; });
      } else {
        H = ['Work Code', 'MR No', 'MR End'].concat(k === 'pay' ? ['MB No', 'Page No'] : []).concat(['Result', 'Note']);
        rows = d.items.map(function (x) { var z = res[x.work_code + '|' + x.mr] || {};
          return [x.work_code, x.mr, dmy(x.end)].concat(k === 'pay' ? [x.mb, x.page] : []).concat([RES[z.s] || '', z.sm || '']); });
      }
      var ws = XLSX.utils.aoa_to_sheet([H].concat(rows));
      ws['!cols'] = H.map(function (h) { return { wch: /Work Code|note|Note/.test(h) ? 30 : /Applicant|Reg/.test(h) ? 24 : 11 }; });
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: H.length - 1 } }) };
      var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, safeName(JOB_NAME[k]));
      XLSX.writeFile(wb, 'IAY_Job_' + id + '_' + k + '.xlsx');
    }).catch(function (e) { status(e.code ? errText(e) : (e.message || String(e)), 'err'); }).then(function () { loading(''); });
  }

  // ---------- Excel ----------
  function needXlsx() { return window.IaySummary.needXlsx(); }
  function safeName(s) { return String(s || '').replace(/[\\\/?*\[\]:]/g, '').slice(0, 31) || 'Sheet1'; }
  $('listXlsx').onclick = function () {
    if (!list.rows.length) return;
    needXlsx().then(function () {
      var c = cols();
      var aoa = [c.map(function (x) { return x[1]; })].concat(list.rows.map(function (r) {
        return c.map(function (x) { var v = r[x[0]]; return /start|end|finish_by/.test(x[0]) && v ? dmy(v) : (v == null ? '' : v); });
      }));
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = c.map(function (x) { return { wch: x[0] === 'work_code' ? 28 : x[0] === 'name' ? 24 : x[0] === 'jcn' ? 24 : 13 }; });
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: c.length - 1 } }) };
      var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, safeName(list.kind));
      var gpn = selPrefix() ? ($('gpSel').selectedOptions[0] || {}).textContent : 'Block';
      XLSX.writeFile(wb, 'IAY_' + safeName(gpn) + '_' + list.kind + (list.date ? '_' + list.date : '') + '_' + ov.today + '.xlsx');
    }).catch(function (e) { status(e.message, 'err'); });
  };
  $('gpXlsx').onclick = function () {
    var gps = (ov && ov.gps) || []; if (!gps.length) return;
    needXlsx().then(function () {
      var H = ['GP', 'IAY works', 'Fill overdue', 'Fill today', 'Fill tomorrow', 'MR gap', 'MR due in 5 days', 'WL pending', 'No MR', 'Avg MRs', '6 MRs done', 'Report time'];
      var rows = gps.map(function (g) { return [g.gp_name, g.works, g.fill_overdue, g.fill_today, g.fill_tomorrow, g.mr_gap, g.mr_due5, g.wl_pending, g.no_mr, Number(g.avg_mrs || 0), g.done6, when(g.report_at)]; });
      var tot = ['TOTAL'].concat([1, 2, 3, 4, 5, 6, 7, 8].map(function (i) { return rows.reduce(function (s, r) { return s + Number(r[i] || 0); }, 0); }), ['', rows.reduce(function (s, r) { return s + Number(r[10] || 0); }, 0), '']);
      var ws = XLSX.utils.aoa_to_sheet([['IAY Tracker — GP-wise summary · ' + dmy(ov.today)], [], H].concat(rows, [tot]));
      ws['!cols'] = H.map(function (h, i) { return { wch: i === 0 ? 20 : i === 11 ? 18 : 12 }; });
      var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Summary');
      XLSX.writeFile(wb, 'IAY_Block_Summary_' + ov.today + '.xlsx');
    }).catch(function (e) { status(e.message, 'err'); });
  };

  // ---------- upload: IAY Phase Report Excel ----------
  $('uploadBtn').onclick = function () { $('fileIn').value = ''; $('fileIn').click(); };
  $('fileIn').addEventListener('change', function () {
    var f = this.files && this.files[0]; if (!f) return;
    loading('Reading Excel...');
    needXlsx().then(function () { return f.arrayBuffer(); }).then(function (buf) {
      var wb = XLSX.read(buf, { type: 'array' });
      var parsed = parseReport(wb, f.name);
      if (!parsed.gps.length) throw new Error('No IAY Phase Report GP sheets found in this file. Use the “Full” Excel from the Tampermonkey script.');
      loading('');
      return importAll(parsed, f.name);
    }).catch(function (e) { loading(''); status(e.code ? errText(e) : (e.message || String(e)), 'err'); });
  });

  function txt(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }
  function isoOf(s) { var m = txt(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : ''; }
  function reportTime(wb, fileName) {
    var sh = wb.Sheets['Summary'];
    if (sh) {
      var rows = XLSX.utils.sheet_to_json(sh, { header: 1, raw: false, defval: '' }).slice(0, 5);
      for (var i = 0; i < rows.length; i++) {
        var m = txt(rows[i][0]).match(/Generated:\s*(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
        if (m) {
          var h = +m[4]; if (m[7]) { var pm = /pm/i.test(m[7]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
          return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) + 'T' + ('0' + h).slice(-2) + ':' + m[5] + ':' + (m[6] || '00') + '+05:30';
        }
      }
    }
    var f = String(fileName).match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
    if (f) return f[3] + '-' + ('0' + f[2]).slice(-2) + '-' + ('0' + f[1]).slice(-2) + 'T12:00:00+05:30';
    return new Date().toISOString();
  }
  function parseReport(wb, fileName) {
    var out = { reportAt: reportTime(wb, fileName), gps: [] };
    wb.SheetNames.forEach(function (name) {
      if (/^summary$/i.test(name)) return;
      var rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
      var hi = -1;
      for (var i = 0; i < Math.min(rows.length, 10); i++) if (rows[i].map(txt).indexOf('Work Code') >= 0) { hi = i; break; }
      if (hi < 0) return;
      var H = rows[hi].map(txt), ix = function (n) { return H.indexOf(n); };
      var c = { gp: ix('GP'), code: ix('Work Code'), reg: ix('Reg No.'), name: ix('Beneficiary Name'), jcn: ix('Job Card (JCN)'),
                vill: ix('Village'), ws: ix('Work Status'), md: ix('Mandays'), wl: ix('Wagelist Generated'), wlno: ix('WageList No.'), wld: ix('WL Date') };
      var ph = [];
      H.forEach(function (h, j) { var m = h.match(/^P(\d+) MR No$/); if (m) ph.push({ seq: +m[1], no: j, dates: ix('P' + m[1] + ' Dates'), st: ix('P' + m[1] + ' Status') }); });
      if (c.code < 0 || c.jcn < 0) return;
      var works = [], mrs = [], pre = {};
      rows.slice(hi + 1).forEach(function (r) {
        var code = txt(r[c.code]); if (!code || code.indexOf('/') < 0) return;      // TOTAL / blank rows
        var jcn = txt(r[c.jcn]);
        works.push({ work_code: code, reg_no: txt(r[c.reg]), ben_name: c.name >= 0 ? txt(r[c.name]) : '', jcn: jcn,
                     village: c.vill >= 0 ? txt(r[c.vill]) : '', work_status: c.ws >= 0 ? txt(r[c.ws]) : '',
                     mandays: c.md >= 0 ? txt(r[c.md]) : '', wl_info: c.wl >= 0 ? txt(r[c.wl]) : '',
                     wl_no: c.wlno >= 0 ? txt(r[c.wlno]) : '', wl_date: c.wld >= 0 ? isoOf(r[c.wld]) : '' });
        var p13 = jcn.slice(0, 13); if (/^WB-\d{2}-\d{3}-\d{3}$/.test(p13)) pre[p13] = (pre[p13] || 0) + 1;
        ph.forEach(function (p) {
          var no = txt(r[p.no]).replace(/\.0+$/, ''), d = txt(r[p.dates]).split('--');
          if (!/^\d+$/.test(no) || d.length !== 2) return;
          var s = isoOf(d[0]), e = isoOf(d[1]); if (!s || !e) return;
          mrs.push({ work_code: code, mr_no: no, seq: String(p.seq), start_date: s, end_date: e, status: txt(r[p.st]) });
        });
      });
      if (!works.length) return;
      var prefix = Object.keys(pre).sort(function (a, b) { return pre[b] - pre[a]; })[0];
      if (!prefix) return;
      var keep = works.filter(function (w) { return w.jcn.slice(0, 13) === prefix; });
      var codes = {}; keep.forEach(function (w) { codes[w.work_code] = 1; });
      out.gps.push({ name: txt(rows[hi + 1] && c.gp >= 0 ? rows[hi + 1][c.gp] : '') || name, prefix: prefix, works: keep,
                     mrs: mrs.filter(function (m) { return codes[m.work_code]; }), skipped: works.length - keep.length });
    });
    return out;
  }

  function importAll(parsed, fileName) {
    var gps = parsed.gps.filter(function (g) { return !me.scope || g.prefix === me.scope; });
    if (!gps.length) { status('This file has no sheet for your GP.', 'err'); return Promise.resolve(); }
    var msg = 'Report time: ' + when(parsed.reportAt) + '\n' + gps.length + ' GPs, ' +
      nf(gps.reduce(function (s, g) { return s + g.works.length; }, 0)) + ' works, ' +
      nf(gps.reduce(function (s, g) { return s + g.mrs.length; }, 0)) + ' MRs.\nThis report will replace the previous data. Upload?';
    if (!window.confirm(msg)) return Promise.resolve();
    var done = [], fail = [], i = 0;
    $('prog').classList.remove('hidden'); $('progBar').style.width = '0';
    function one(g, force) {
      status('Uploading: ' + g.name + ' (' + (i + 1) + '/' + gps.length + ')...', 'info');
      return SB.rpc('iay_import_gp', { p_jc_prefix: g.prefix, p_gp_name: g.name, p_report_at: parsed.reportAt, p_file_name: fileName,
                                       p_works: g.works, p_mrs: g.mrs, p_force: !!force }, { timeout: 120000 })
        .then(function (r) { done.push(g.name + ': ' + nf(r.works) + ' works, ' + nf(r.mrs) + ' MR' + (g.skipped ? ' (' + g.skipped + ' rows of other GPs skipped)' : '')); },
          function (e) {
            if (e.code === 'OLDER_REPORT' && !force) {
              if (window.confirm(g.name + ': a newer report is already saved. Replace it with this older report anyway?')) return one(g, true);
              fail.push(g.name + ': skipped (a newer report is already saved)'); return;
            }
            if (e.authLost) throw e;
            fail.push(g.name + ': ' + errText(e));
          });
    }
    return gps.reduce(function (p, g) {
      return p.then(function () { return one(g); }).then(function () { i++; $('progBar').style.width = Math.round(i * 100 / gps.length) + '%'; });
    }, Promise.resolve()).then(function () {
      $('prog').classList.add('hidden');
      status('✅ Upload complete\n' + done.join('\n') + (fail.length ? '\n\n❌ ' + fail.join('\n❌ ') : ''), fail.length ? 'err' : 'ok');
      return load(false);
    });
  }

  boot();
})();
