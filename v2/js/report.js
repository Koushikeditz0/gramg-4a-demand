// 📊 Report page (v228): for Report viewers (GRS / STP / NS / BDO) and for Admins.
// Reads only report_* RPCs. Viewers never get accounts, photos, Aadhaar or demand lists (the database enforces it).
(function () {
  'use strict';
  var SB = window.GramgSB;
  function $(id) { return document.getElementById(id); }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function read(k) { try { return localStorage.getItem(k) || ''; } catch (_e) { return ''; } }
  function store(k, v) { try { localStorage.setItem(k, v); } catch (_e) { /* convenience only */ } }
  function n(x) { return Number(x || 0).toLocaleString('en-IN'); }
  function rs(x) { x = Number(x || 0); if (!x) return '—'; return x >= 100000 ? '₹' + (x / 100000).toFixed(2) + ' L' : '₹' + n(Math.round(x)); }
  function pct(a, b) { return b ? Math.round(a * 100 / b) : 0; }
  function dmy(d) { if (!d) return ''; var p = String(d).slice(0, 10).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : d; }
  function when(ts) {
    if (!ts) return 'কখনো আসেনি';
    var d = new Date(ts), now = new Date(), days = Math.floor((now - d) / 864e5);
    var t = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
    if (days < 1 && d.getDate() === now.getDate()) return 'আজ ' + t;
    if (days < 2) return 'কাল ' + t;
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' }) + ' ' + t;
  }
  function daysLate(to, today) { if (!to || !today) return 0; return Math.round((new Date(today) - new Date(to)) / 864e5); }

  var S = { ctx: null, home: [], gp: null, page: 'home', viewerMode: read('gramg2.rViewer') === '1',
            mrs: null, mrStage: 'all', mrKind: 'all', works: null, reg: null, wkKind: 'all', caste: null, ek: null, limit: 300 };
  var STAGES = [
    ['all', 'সব বাকি'], ['fill_pending', 'Fill বাকি'], ['fill_today', 'আজ শেষ'], ['emb', 'e-MB বাকি'],
    ['verify', 'Verify বাকি'], ['wl_pending', 'WL বাকি'], ['running', 'চলছে']];
  var STAGE_LABEL = { fill_pending: 'Fill বাকি', fill_today: 'আজ শেষ', emb: 'e-MB বাকি', verify: 'Verify বাকি', wl_pending: 'WL বাকি', running: 'চলছে', wl_done: 'WL হয়েছে', zero: 'Zero' };

  function loading(t) { var l = $('loading'); l.textContent = t || ''; l.style.display = t ? 'block' : 'none'; }
  function status(t, kind) { var s = $('status'); s.textContent = t || ''; s.className = 'status' + (t ? ' ' + (kind || 'err') : ''); if (t && kind === 'ok') setTimeout(function () { if (s.textContent === t) status(''); }, 4000); }
  function errText(e) {
    var m = { NOT_AUTHORIZED: 'এই GP-র report দেখার অনুমতি নেই।', NETWORK: 'Internet connection দেখে আবার চেষ্টা করুন।',
              BAD_INPUT: 'লেখাটা ঠিক নেই (১ থেকে ৫০০ অক্ষর)।', TOO_MANY_NOTES: 'আজ অনেক note লেখা হয়েছে, কাল আবার লিখুন।', NOT_FOUND: 'Note-টা পাওয়া যায়নি।' };
    if (e && /report_context|Could not find the function/i.test(e.message || '')) return 'Database update (SQL v228) এখনো চালানো হয়নি। Admin-কে জানান।';
    return m[e && e.code] || ('সমস্যা: ' + ((e && e.message) || e));
  }
  function isAdmin() { return S.ctx && S.ctx.is_admin && !S.viewerMode; }
  function gpRow() { for (var i = 0; i < S.home.length; i++) if (S.home[i].id === S.gp) return S.home[i]; return null; }
  function gpName() { var g = gpRow(); return g ? g.name : ''; }

  SB.onAuthLost = function () { location.replace('./index.html'); };

  // ---------------- boot ----------------
  function boot() {
    if (!SB.hasSession()) { location.replace('./index.html'); return; }
    loading('Report খুলছে...');
    SB.rpc('register_session', { p_user_agent: String(navigator.userAgent).slice(0, 300) })
      .then(function () { return SB.rpc('report_context'); })
      .then(function (ctx) {
        S.ctx = ctx;
        if (!ctx.gps || !ctx.gps.length) { status('আপনার জন্য কোনো GP ঠিক করা নেই। Admin-কে জানান।'); return; }
        $('who').textContent = (ctx.full_name || ctx.username) + (ctx.designation ? ' · ' + ctx.designation : ctx.role === 'super_admin' ? ' · Admin' : ctx.role === 'gp_admin' ? ' · GP Admin' : '');
        if (!ctx.is_admin) { var ro = el('span', '👁 শুধু দেখা', 'ro'); $('who').appendChild(ro); }
        $('toAdmin').classList.toggle('hidden', !ctx.is_admin);
        $('asViewer').classList.toggle('hidden', !ctx.is_admin);
        $('asViewer').classList.toggle('on', S.viewerMode);
        var saved = Number(read('gramg2.rgp')) || Number(read('gramg2.gp')) || 0;
        S.gp = ctx.gps.some(function (g) { return g.id === saved; }) ? saved : (ctx.gps.length > 1 ? 0 : ctx.gps[0].id);
        fillGpSel();
        return loadHome();
      })
      .catch(function (e) {
        if (e.authLost) return;
        if (e.code === 'NOT_AUTHORIZED') { location.replace('./index.html'); return; }
        status(errText(e));
      })
      .then(function () { loading(''); });
  }

  function fillGpSel() {
    var sel = $('gpSel'), gps = S.ctx.gps; sel.innerHTML = '';
    if (gps.length < 2) { sel.classList.add('hidden'); return; }
    sel.classList.remove('hidden');
    var o0 = el('option', '🏛 সব GP (তুলনা)'); o0.value = '0'; sel.appendChild(o0);
    gps.forEach(function (g) { var o = el('option', g.name); o.value = g.id; sel.appendChild(o); });
    sel.value = String(S.gp || 0);
  }
  $('gpSel').addEventListener('change', function () { setGp(Number(this.value) || 0); });
  function setGp(id) {
    S.gp = id; store('gramg2.rgp', String(id)); $('gpSel').value = String(id);
    S.mrs = S.works = S.caste = S.ek = null;
    if (!id && S.page !== 'home') { go('home'); return; }
    render();
  }

  function loadHome() {
    return SB.rpc('report_home', {}, { retry: true, timeout: 60000 }).then(function (h) { S.home = h || []; render(); });
  }

  // ---------------- navigation ----------------
  [].forEach.call(document.querySelectorAll('#nav button'), function (b) { b.addEventListener('click', function () { go(b.dataset.p); }); });
  function go(p) {
    if (p !== 'home' && !S.gp) {
      if (S.ctx.gps.length > 1) { status('আগে উপরের তালিকা থেকে একটা GP বাছুন।'); return; }
    }
    status('');
    S.page = p;
    [].forEach.call(document.querySelectorAll('#nav button'), function (b) { b.classList.toggle('on', b.dataset.p === p); });
    ['home', 'pipe', 'works', 'reg', 'caste', 'ekyc', 'notes'].forEach(function (x) { $('p-' + x).classList.toggle('hidden', x !== p); });
    window.scrollTo(0, 0);
    render();
  }

  function render() {
    var g = gpRow();
    $('title').textContent = S.gp ? (gpName() + ' GP') : (S.ctx.block ? 'সব GP · Block' : 'Report');
    var ch = $('chips'); ch.innerHTML = '';
    if (g) ch.appendChild(el('span', '🔄 MR data: ' + when(g.mr_at), 'chip'));
    else {
      var latest = S.home.reduce(function (m, x) { return x.mr_at && (!m || x.mr_at > m) ? x.mr_at : m; }, null);
      ch.appendChild(el('span', '🔄 MR data: ' + when(latest), 'chip'));
    }
    if (S.page === 'home') renderHome();
    else if (S.page === 'pipe') loadMrs();
    else if (S.page === 'works') loadWorks();
    else if (S.page === 'reg') loadReg();
    else if (S.page === 'caste') loadCaste();
    else if (S.page === 'ekyc') loadEkyc();
    else if (S.page === 'notes') loadAllNotes();
  }

  // ---------------- home ----------------
  function st(g, k, f) { var s = (g.stages || {})[k]; return s ? Number(s[f || 'all'] || 0) : 0; }
  function sums(list) {
    var t = { fill: 0, today: 0, emb: 0, wl: 0, wlAmt: 0, pbaToday: 0, pbaTom: 0, works: 0, workers: 0, ekyc: 0, abps: 0, ready: 0, notes: 0 };
    list.forEach(function (g) {
      t.fill += st(g, 'fill_pending') + st(g, 'fill_today'); t.today += st(g, 'fill_today');
      t.emb += st(g, 'emb') + st(g, 'verify'); t.wl += st(g, 'wl_pending'); t.wlAmt += st(g, 'wl_pending', 'amt');
      t.pbaToday += st(g, 'fill_today', 'pba'); t.pbaTom += Number(g.pba_tomorrow || 0); t.works += Number(g.works_waiting || 0);
      var e = g.ekyc || {}; t.workers += Number(e.workers || 0); t.ekyc += Number(e.ekyc || 0); t.abps += Number(e.abps || 0); t.ready += Number(e.ready || 0);
      t.notes += Number(g.notes_7d || 0);
    });
    return t;
  }
  function tile(cls, icon, num, label, sub, onClick) {
    var b = el('button', null, 'tile ' + cls); b.type = 'button';
    b.appendChild(el('i', icon)); b.appendChild(el('b', num)); b.appendChild(el('span', label));
    if (sub) b.appendChild(el('em', sub));
    if (onClick) b.addEventListener('click', onClick); return b;
  }
  function pipeTo(stage, kind) { return function () { if (!S.gp) { status('আগে উপরের তালিকা থেকে একটা GP বাছুন।'); return; } S.mrStage = stage; S.mrKind = kind || 'all'; go('pipe'); }; }
  function renderHome() {
    var list = S.gp ? S.home.filter(function (g) { return g.id === S.gp; }) : S.home;
    var t = sums(list), tl = $('tiles'); tl.innerHTML = '';
    tl.appendChild(tile('t1', '⏳', n(t.fill), 'MR fill বাকি', t.today ? 'আজ শেষ: ' + n(t.today) : '', pipeTo('fill_pending')));
    tl.appendChild(tile('t2', '📐', n(t.emb), 'e-MB / Verify বাকি', '', pipeTo('emb')));
    tl.appendChild(tile('t5', '📄', n(t.wl), 'WL বানানো বাকি', t.wlAmt ? rs(t.wlAmt) : '', pipeTo('wl_pending')));
    tl.appendChild(tile('t6', '🏠', n(t.pbaToday), 'PBA আজ fill', 'কাল শেষ: ' + n(t.pbaTom), pipeTo('fill_today', 'pba')));
    tl.appendChild(tile('t3', '✅', pct(t.ready, t.workers) + '%', 'eKYC + ABPS ready', n(t.ready) + ' / ' + n(t.workers) + ' জন', function () { if (S.gp) go('ekyc'); else status('আগে একটা GP বাছুন।'); }));
    tl.appendChild(tile('t4', '📝', n(t.notes), 'নতুন note (৭ দিন)', '', function () { if (S.gp) go('notes'); else status('আগে একটা GP বাছুন।'); }));

    // GP compare (several GPs, none picked)
    var cc = $('cmpCard'), tb = $('cmp');
    cc.classList.toggle('hidden', !!S.gp || S.home.length < 2);
    if (!S.gp && S.home.length > 1) {
      tb.innerHTML = '';
      var hr = el('tr'); ['GP', 'Fill বাকি', 'e-MB/Verify', 'WL বাকি', 'Ready %', 'MR data'].forEach(function (h) { hr.appendChild(el('th', h)); }); tb.appendChild(hr);
      var mx = { f: 0, w: 0 }; S.home.forEach(function (g) { mx.f = Math.max(mx.f, st(g, 'fill_pending') + st(g, 'fill_today')); mx.w = Math.max(mx.w, st(g, 'wl_pending')); });
      S.home.forEach(function (g) {
        var tr = el('tr', null, 'click'), f = st(g, 'fill_pending') + st(g, 'fill_today'), e = g.ekyc || {};
        tr.appendChild(el('td', g.name));
        tr.appendChild(el('td', n(f), f && f === mx.f ? 'bad' : ''));
        tr.appendChild(el('td', n(st(g, 'emb') + st(g, 'verify'))));
        tr.appendChild(el('td', n(st(g, 'wl_pending')), st(g, 'wl_pending') && st(g, 'wl_pending') === mx.w ? 'bad' : ''));
        var p = pct(e.ready, e.workers); tr.appendChild(el('td', e.workers ? p + '%' : '—', p >= 85 ? 'ok' : ''));
        tr.appendChild(el('td', g.mr_at ? when(g.mr_at) : '—', 'mut'));
        tr.addEventListener('click', function () { setGp(g.id); });
        tb.appendChild(tr);
      });
    }

    // data freshness
    var ek = $('ekCard'); ek.innerHTML = '';
    ek.appendChild(el('h3', '🕘 Data কবে এসেছে'));
    var g1 = S.gp ? gpRow() : null;
    var rows = [['💸 MR pipeline (প্রতি ঘণ্টায় নিজে থেকে)', g1 ? g1.mr_at : latestOf('mr_at')],
                ['✅ eKYC / ABPS (K-Desk ABPS Sync)', g1 ? g1.abps_at : latestOf('abps_at')],
                ['⚖ WL caste (K-Desk ⚖ WL Caste)', g1 ? g1.caste_at : latestOf('caste_at')]];
    var tbl = el('table'); rows.forEach(function (r) { var tr = el('tr'); tr.appendChild(el('td', r[0])); tr.appendChild(el('td', when(r[1]), r[1] ? '' : 'mut')); tbl.appendChild(tr); });
    ek.appendChild(tbl);

    // admin-only numbers
    var ad = $('admCard'); ad.innerHTML = '';
    var admin = isAdmin() && list.some(function (g) { return g.admin; });
    ad.classList.toggle('hidden', !admin);
    if (admin) {
      var a = { na: 0, ar: 0, snap: null };
      list.forEach(function (g) { var x = g.admin || {}; a.na += Number(x.no_account || 0); a.ar += Number(x.account_requests || 0); if (x.snap_at && (!a.snap || x.snap_at > a.snap)) a.snap = x.snap_at; });
      ad.appendChild(el('h3', '🛡 শুধু Admin দেখেন'));
      var t2 = el('table');
      [['Account নেই (active worker)', n(a.na)], ['Account copy চাওয়া, খোলা', n(a.ar)], ['K-Desk Generate WL / Send Pay snapshot', when(a.snap)]].forEach(function (r) {
        var tr = el('tr'); tr.appendChild(el('td', r[0])); tr.appendChild(el('td', r[1])); t2.appendChild(tr); });
      ad.appendChild(t2);
      ad.appendChild(el('div', 'Viewer-রা এই অংশ দেখতে পান না।', 'mut'));
    }

    // new notes
    var nn = $('newNotes'); nn.innerHTML = '';
    nn.appendChild(el('h3', '📝 সাম্প্রতিক note'));
    if (!S.gp) { nn.appendChild(el('div', 'GP বাছলে সেই GP-র note দেখা যাবে।', 'mut')); return; }
    SB.rpc('report_notes', { p_gp: S.gp, p_limit: 5 }).then(function (list) {
      if (S.page !== 'home') return;
      if (!list.length) { nn.appendChild(el('div', 'এখনো কোনো note নেই। যেকোনো MR বা work-এ 📝 চাপলে note রাখা যায়।', 'mut')); return; }
      list.forEach(function (x) { nn.appendChild(noteEl(x, true)); });
    }).catch(function (e) { if (!e.authLost) nn.appendChild(el('div', errText(e), 'mut')); });
  }
  function latestOf(k) { return S.home.reduce(function (m, x) { return x[k] && (!m || x[k] > m) ? x[k] : m; }, null); }

  // ---------------- pipeline ----------------
  function loadMrs() {
    if (S.mrs && S.mrs.gp === S.gp) { renderMrs(); return; }
    loading('MR আনছে...');
    SB.rpc('report_mrs', { p_gp: S.gp, p_stage: null }, { retry: true, timeout: 60000 })
      .then(function (d) {
        return SB.rpc('report_mrs', { p_gp: S.gp, p_stage: 'running' }, { retry: true, timeout: 60000 }).then(function (r) {
          d.rows = (d.rows || []).concat(r.rows || []); d.gp = S.gp; S.mrs = d; S.limit = 300; renderMrs();
        });
      }).catch(function (e) { if (!e.authLost) status(errText(e)); })
      .then(function () { loading(''); });
  }
  function mrFiltered() {
    var q = $('pipeQ').value.trim().toLowerCase();
    return (S.mrs.rows || []).filter(function (r) {
      if (S.mrStage === 'all' ? r.s === 'running' : (S.mrStage === 'fill_pending' ? (r.s !== 'fill_pending' && r.s !== 'fill_today') : r.s !== S.mrStage)) return false;
      if (S.mrKind === 'pba' && !r.pba) return false;
      if (S.mrKind === 'other' && r.pba) return false;
      if (q && (String(r.mr) + ' ' + r.code + ' ' + r.name).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function renderMrs() {
    $('pipeAt').textContent = 'Data: ' + when(S.mrs.at);
    var rows = S.mrs.rows || [], cnt = {};
    rows.forEach(function (r) { var k = r.s === 'fill_today' ? 'fill_pending' : r.s; cnt[k] = (cnt[k] || 0) + 1; if (r.s !== 'running') cnt.all = (cnt.all || 0) + 1; if (r.s === 'fill_today') cnt.fill_today = (cnt.fill_today || 0) + 1; });
    cnt.fill_today = rows.filter(function (r) { return r.s === 'fill_today'; }).length;
    seg($('stageSeg'), STAGES, S.mrStage, cnt, function (k) { S.mrStage = k; S.limit = 300; renderMrs(); });
    seg($('kindSeg'), [['all', 'সব work'], ['pba', '🏠 PBA'], ['other', 'অন্য work']], S.mrKind, null, function (k) { S.mrKind = k; S.limit = 300; renderMrs(); });
    var list = mrFiltered(), box = $('pipeList'); box.innerHTML = '';
    if (!list.length) { box.appendChild(el('div', 'এই ধাপে কোনো MR নেই।', 'mut')); return; }
    var today = S.mrs.today;
    list.slice(0, S.limit).forEach(function (r) {
      var it = el('div', null, 'item' + (r.pba ? ' pba' : ''));
      it.appendChild(el('b', 'MR ' + r.mr + ' · ' + (r.name || '')));
      it.appendChild(el('div', r.code, 'mono'));
      var line = el('div', null, 'r'), left = el('span');
      left.appendChild(el('span', STAGE_LABEL[r.s] || r.s, 'tag' + (r.s === 'fill_today' ? ' today' : '')));
      if (r.pba) left.appendChild(el('span', 'PBA', 'tag pba'));
      left.appendChild(document.createTextNode(dmy(r.from) + ' – ' + dmy(r.to)));
      line.appendChild(left);
      var right = el('span'), late = daysLate(r.to, today);
      if (r.s !== 'running' && late > 0) right.appendChild(el('span', late + ' দিন দেরি', 'tag late'));
      if (r.amt) right.appendChild(el('span', rs(r.amt), 'tag'));
      right.appendChild(noteBtn('mr', String(r.mr), r.notes, 'MR ' + r.mr, r.name));
      line.appendChild(right); it.appendChild(line);
      if (r.meas || r.verif) it.appendChild(el('div', (r.meas ? 'e-MB: ' + dmy(r.meas) : '') + (r.verif ? ' · Verify: ' + dmy(r.verif) : ''), 'mut'));
      box.appendChild(it);
    });
    if (list.length > S.limit) {
      var m = el('button', 'আরও দেখুন (' + n(list.length - S.limit) + ')', 'btn more'); m.type = 'button';
      m.addEventListener('click', function () { S.limit += 300; renderMrs(); }); box.appendChild(m);
    }
  }
  $('pipeQ').addEventListener('input', function () { if (S.mrs) { S.limit = 300; renderMrs(); } });
  $('pipeCsv').addEventListener('click', function () {
    if (!S.mrs) return;
    csv('MR_' + gpName() + '_' + S.mrStage, ['MR No', 'Work Code', 'Work Name', 'Stage', 'PBA', 'From', 'To', 'Days late', 'e-MB', 'Verify', 'Amount'],
      mrFiltered().map(function (r) { return [r.mr, r.code, r.name, STAGE_LABEL[r.s] || r.s, r.pba ? 'Yes' : '', dmy(r.from), dmy(r.to), r.s === 'running' ? '' : Math.max(0, daysLate(r.to, S.mrs.today)), dmy(r.meas), dmy(r.verif), r.amt || '']; }));
  });
  function seg(box, items, cur, cnt, onPick) {
    box.innerHTML = '';
    items.forEach(function (it) {
      var b = el('button', it[1], it[0] === cur ? 'on' : ''); b.type = 'button';
      if (cnt) b.appendChild(el('b', n(cnt[it[0]] || 0)));
      b.addEventListener('click', function () { onPick(it[0]); }); box.appendChild(b);
    });
  }

  // ---------------- works ----------------
  function loadWorks() {
    if (S.works && S.works.gp === S.gp) { renderWorks(); return; }
    loading('Work আনছে...');
    SB.rpc('report_works', { p_gp: S.gp }, { retry: true, timeout: 60000 })
      .then(function (d) { S.works = { gp: S.gp, rows: d || [] }; S.limit = 300; renderWorks(); })
      .catch(function (e) { if (!e.authLost) status(errText(e)); })
      .then(function () { loading(''); });
  }
  function worksFiltered() {
    var q = $('worksQ').value.trim().toLowerCase();
    return S.works.rows.filter(function (w) {
      if (S.wkKind === 'waiting' && !w.waiting) return false;
      if (S.wkKind === 'pba' && !w.pba) return false;
      if (S.wkKind === 'other' && w.pba) return false;
      if (q && (w.code + ' ' + w.name).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function renderWorks() {
    var g = gpRow(); $('worksAt').textContent = g ? 'Data: ' + when(g.mr_at) : '';
    var rows = S.works.rows, cnt = { all: rows.length, waiting: 0, pba: 0, other: 0 };
    rows.forEach(function (w) { if (w.waiting) cnt.waiting++; if (w.pba) cnt.pba++; else cnt.other++; });
    seg($('wkSeg'), [['all', 'সব'], ['waiting', 'MR বাকি আছে'], ['pba', '🏠 PBA'], ['other', 'অন্য work']], S.wkKind, cnt, function (k) { S.wkKind = k; S.limit = 300; renderWorks(); });
    var list = worksFiltered(), box = $('worksList'); box.innerHTML = '';
    if (!list.length) { box.appendChild(el('div', 'কোনো work নেই।', 'mut')); return; }
    list.slice(0, S.limit).forEach(function (w) {
      var it = el('div', null, 'item' + (w.pba ? ' pba' : ''));
      it.appendChild(el('b', w.name || w.code));
      it.appendChild(el('div', w.code, 'mono'));
      var line = el('div', null, 'r'), left = el('span');
      left.appendChild(el('span', 'MR ' + n(w.mrs), 'tag'));
      if (w.running) left.appendChild(el('span', 'চলছে ' + n(w.running), 'tag'));
      if (w.waiting) left.appendChild(el('span', 'বাকি ' + n(w.waiting), 'tag late'));
      if (w.wl) left.appendChild(el('span', 'WL হয়েছে ' + n(w.wl), 'tag'));
      if (w.pba) left.appendChild(el('span', 'PBA', 'tag pba'));
      line.appendChild(left);
      var right = el('span');
      if (w.last_to) right.appendChild(el('span', 'শেষ MR: ' + dmy(w.last_to), 'mut'));
      if (w.amt) right.appendChild(el('span', ' ' + rs(w.amt), 'tag'));
      right.appendChild(noteBtn('work', w.code, w.notes, w.name || w.code, w.code));
      line.appendChild(right); it.appendChild(line);
      box.appendChild(it);
    });
    if (list.length > S.limit) {
      var m = el('button', 'আরও দেখুন (' + n(list.length - S.limit) + ')', 'btn more'); m.type = 'button';
      m.addEventListener('click', function () { S.limit += 300; renderWorks(); }); box.appendChild(m);
    }
  }
  $('worksQ').addEventListener('input', function () { if (S.works) { S.limit = 300; renderWorks(); } });
  $('worksCsv').addEventListener('click', function () {
    if (!S.works) return;
    csv('Works_' + gpName(), ['Work Code', 'Work Name', 'PBA', 'MRs', 'Running', 'Waiting', 'WL done', 'Last MR to', 'WL pending amount'],
      worksFiltered().map(function (w) { return [w.code, w.name, w.pba ? 'Yes' : '', w.mrs, w.running, w.waiting, w.wl, dmy(w.last_to), w.amt || '']; }));
  });

  // ---------------- Work Register (R6.12 via the Raspberry Pi → R2) ----------------
  var REG_GROUPS = [['cat', 'Category'], ['mcat', 'Master category'], ['wtype', 'Work type'], ['agency', 'Agency']];
  function gpPrefix() { var gs = S.ctx.gps; for (var i = 0; i < gs.length; i++) if (gs[i].id === S.gp) return gs[i].jc_prefix; return ''; }
  function loadReg() {
    if (S.reg && S.reg.gp === S.gp) { renderReg(); return; }
    var pre = gpPrefix();
    if (!pre) { status('এই GP-র Job Card prefix জানা নেই।'); return; }
    loading('Work Register আনছে...');
    var mrJob = (S.works && S.works.gp === S.gp) ? Promise.resolve(S.works.rows)
      : SB.rpc('report_works', { p_gp: S.gp }, { retry: true, timeout: 60000 }).then(function (d) { S.works = { gp: S.gp, rows: d || [] }; return S.works.rows; }).catch(function () { return []; });
    Promise.all([SB.register(pre), mrJob])
      .then(function (pair) {
        var d = pair[0], mrRows = pair[1] || [], mrBy = {};
        mrRows.forEach(function (m) { mrBy[m.code] = m; });
        S.regMr = mrBy;
        var f = d.fields || [];
        var rows = (d.rows || []).map(function (r) { var o = {}; f.forEach(function (k, i) { o[k] = r[i]; }); return o; });
        rows.forEach(function (w) {
          w.left = Math.max(0, (w.s_tot || 0) - Math.max(w.booked_all || 0, w.paid_all || 0));
          w.over = (w.s_tot || 0) > 0 && Math.max(w.booked_all || 0, w.paid_all || 0) > w.s_tot + 1;
          w.unpaid = Math.max(0, (w.booked_all || 0) - (w.paid_all || 0));
          pendingOf(w);
        });
        S.reg = { gp: S.gp, at: d.at, upd: d.upd, fy: d.fy, rows: rows, split: rows.some(function (w) { return w.booked_all_usk != null; }) };
        S.rgGroup = S.rgGroup || 'cat'; S.rgSt = 'all'; S.rgKind = S.rgKind || 'all'; S.rgFy = ''; S.rgSel = null; S.rgSort = 'sanction'; S.limit = 300;
        renderReg();
      })
      .catch(function (e) {
        if (e.authLost) return;
        if (e.code === 'NO_DATA') { S.reg = { gp: S.gp, rows: [], none: true }; renderReg(); return; }
        status(e.code === 'NOT_AUTHORIZED' ? errText(e) : 'Work Register আনা যায়নি: ' + (e.message || e.code));
      })
      .then(function () { loading(''); });
  }
  function isPba(w) { return /\/IAY\//i.test(w.code || ''); }       // PBA (IAY) house works carry /IAY/ in the work code
  function wageRate() { return Number((S.ctx && S.ctx.wage_rate) || 300) || 300; }
  // Pending unskilled = Sanction (Unskilled) − unskilled already booked. If the portal has no Unskilled/Material
  // split for booked, the unskilled spent is estimated as Total Mandays × wage rate. Completed works have no "pending".
  function pendingOf(w) {
    var rate = wageRate(), spent = w.booked_all_usk != null ? w.booked_all_usk : (w.mandays || 0) * rate;
    w.est = w.booked_all_usk == null;
    w.pu = stKey(w.status) === 'done' ? 0 : Math.max(0, (w.s_usk || 0) - spent);
    w.pmd = rate ? w.pu / rate : 0;
  }
  function stKey(s) { s = String(s || '').toLowerCase(); return /complet/.test(s) ? 'done' : /ongoing|progress|started/.test(s) ? 'on' : 'other'; }
  function regFiltered(skipSel) {
    var q = $('regQ').value.trim().toLowerCase();
    return S.reg.rows.filter(function (w) {
      if (S.rgKind === 'pba' && !isPba(w)) return false;
      if (S.rgKind === 'other' && isPba(w)) return false;
      if (S.rgSt !== 'all' && stKey(w.status) !== S.rgSt) return false;
      if (S.rgFy && w.fy !== S.rgFy) return false;
      if (!skipSel && S.rgSel != null && (w[S.rgGroup] || '—') !== S.rgSel) return false;
      if (q && (w.code + ' ' + w.name + ' ' + w.cat + ' ' + w.wtype + ' ' + w.mcat).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function regSum(list) {
    var t = { n: list.length, s: 0, su: 0, sm: 0, ba: 0, pa: 0, bf: 0, pf: 0, left: 0, over: 0, bu: 0, bm: 0, pu: 0, pm: 0, pend: 0, pmd: 0 };
    list.forEach(function (w) {
      t.s += w.s_tot || 0; t.su += w.s_usk || 0; t.sm += w.s_mat || 0; t.ba += w.booked_all || 0; t.pa += w.paid_all || 0;
      t.bf += w.booked_fy || 0; t.pf += w.paid_fy || 0; t.left += w.left; if (w.over) t.over++;
      t.bu += w.booked_all_usk || 0; t.bm += w.booked_all_mat || 0; t.pu += w.paid_all_usk || 0; t.pm += w.paid_all_mat || 0;
      t.pend += w.pu || 0; t.pmd += w.pmd || 0;
    });
    return t;
  }
  function rsC(x) { x = Number(x || 0); if (!x) return '—'; return x >= 1e7 ? '₹' + (x / 1e7).toFixed(2) + ' Cr' : rs(x); }
  function rsK(x) { x = Number(x || 0); if (!x) return '—'; return x >= 1e7 ? (x / 1e7).toFixed(2) + 'Cr' : x >= 1e5 ? (x / 1e5).toFixed(1) + 'L' : n(Math.round(x)); }
  function bars(box, paid, booked, left, cls) {
    box.innerHTML = ''; var tot = paid + Math.max(0, booked - paid) + left; if (!tot) return;
    [['c-paid', paid], ['c-book', Math.max(0, booked - paid)], ['c-left', left]].forEach(function (x) {
      var d = el('div', null, x[0]); d.style.width = (x[1] * 100 / tot) + '%'; box.appendChild(d);
    });
  }
  function renderReg() {
    var R = S.reg;
    $('regAt').textContent = R.at ? 'Data: ' + when(R.at) : '';
    if (R.none) {
      ['regTiles', 'regKindSeg', 'regGroupSeg', 'regStSeg', 'regBar', 'regBarKey', 'regFyLine'].forEach(function (id) { $(id).innerHTML = ''; });
      $('regTiles').appendChild(el('div', 'এই GP-র Work Register এখনো আসেনি। Raspberry Pi রাতে R6.12 পড়ে পাঠালে এখানে দেখা যাবে।', 'mut'));
      $('regGroupCard').classList.add('hidden'); $('regWorkCard').classList.add('hidden'); return;
    }
    seg($('regGroupSeg'), REG_GROUPS, S.rgGroup, null, function (k) { S.rgGroup = k; S.rgSel = null; renderReg(); });
    var kc = { all: 0, pba: 0, other: 0 };
    S.reg.rows.forEach(function (w) { if (S.rgFy && w.fy !== S.rgFy) return; kc.all++; kc[isPba(w) ? 'pba' : 'other']++; });
    seg($('regKindSeg'), [['all', 'সব work'], ['pba', '🏠 PBA'], ['other', 'অন্য (Others)']], S.rgKind, kc, function (k) { S.rgKind = k; S.rgSel = null; S.limit = 300; renderReg(); });
    var base = S.reg.rows.filter(function (w) { return (!S.rgFy || w.fy === S.rgFy) && (S.rgKind === 'all' || (S.rgKind === 'pba') === isPba(w)); }), sc = { all: base.length, on: 0, done: 0, other: 0 };
    base.forEach(function (w) { sc[stKey(w.status)]++; });
    seg($('regStSeg'), [['all', 'সব status'], ['on', 'চলছে'], ['done', 'শেষ'], ['other', 'অন্য']], S.rgSt, sc, function (k) { S.rgSt = k; S.limit = 300; renderReg(); });
    var fySel = $('regFy');
    if (!fySel.dataset.gp || fySel.dataset.gp !== String(S.gp)) {
      fySel.innerHTML = ''; fySel.dataset.gp = String(S.gp);
      var fys = {}; R.rows.forEach(function (w) { if (w.fy) fys[w.fy] = 1; });
      var o0 = el('option', 'শুরুর FY: সব'); o0.value = ''; fySel.appendChild(o0);
      Object.keys(fys).sort().reverse().forEach(function (f) { var o = el('option', 'শুরু ' + f); o.value = f; fySel.appendChild(o); });
    }
    fySel.value = S.rgFy;

    var all = regFiltered(true), t = regSum(all);
    var tl = $('regTiles'); tl.innerHTML = '';
    tl.appendChild(tile('t2', '📄', rsC(t.s), 'Sanction (' + n(t.n) + ' work)', 'Unskilled ' + rsC(t.su) + ' · Material ' + rsC(t.sm)));
    var sp = R.split, um = function (u, m) { return sp ? 'Unskilled ' + rsC(u) + ' · Material ' + rsC(m) : ''; };
    tl.appendChild(tile('t3', '✅', rsC(t.pa), 'Paid (শুরু থেকে)', (um(t.pu, t.pm) || pct(t.pa, t.s) + '% of Sanction') + (sp ? ' · ' + pct(t.pa, t.s) + '%' : '')));
    tl.appendChild(tile('t5', '⏳', rsC(Math.max(0, t.ba - t.pa)), 'Booked, payment বাকি', 'Booked মোট ' + rsC(t.ba) + (sp ? ' (U ' + rsC(t.bu) + ' · M ' + rsC(t.bm) + ')' : '')));
    tl.appendChild(tile('t1', '🧮', rsC(t.left), 'Sanction-এর বাকি', (sp ? 'Unskilled ' + rsC(Math.max(0, t.su - t.bu)) + ' · Material ' + rsC(Math.max(0, t.sm - t.bm)) : '') + (t.over ? (sp ? ' · ' : '') + '⚠ ' + n(t.over) + ' work ছাড়িয়েছে' : '')));
    tl.appendChild(tile('t6', '👷', n(Math.round(t.pmd)), 'Pending mandays', 'Pending unskilled ' + rsC(t.pend) + ' ÷ ₹' + n(wageRate()) + (R.split ? '' : ' (আনুমানিক)') + ' · চলমান work'));
    bars($('regBar'), t.pa, t.ba, t.left);
    $('regBarKey').innerHTML = '';
    [['c-paid', 'Paid'], ['c-book', 'Booked, বাকি payment'], ['c-left', 'Sanction-এর বাকি']].forEach(function (x) {
      $('regBarKey').appendChild(el('span', '', 'dot ' + x[0])); $('regBarKey').appendChild(document.createTextNode(x[1]));
    });
    var wl = $('regWage'); wl.innerHTML = '';
    wl.appendChild(document.createTextNode('👷 মজুরি হার: ₹' + n(wageRate()) + '/দিন (Pending mandays-এর হিসাবে)'));
    if (S.ctx.is_super && !S.viewerMode) {
      var eb = el('button', 'বদলান', 'btn sm'); eb.type = 'button'; eb.style.marginLeft = '8px';
      eb.addEventListener('click', function () {
        var v = window.prompt('নতুন মজুরি হার (₹ প্রতি দিন):', String(wageRate())); if (v == null) return;
        var num = Number(String(v).replace(/[^\d.]/g, '')); if (!(num >= 1 && num <= 5000)) { status('১ থেকে ৫০০০-এর মধ্যে একটা সংখ্যা দিন।'); return; }
        SB.rpc('admin_set_wage_rate', { p_rate: num }).then(function (r) {
          S.ctx.wage_rate = r.wage_rate; S.reg.rows.forEach(pendingOf); renderReg(); status('✅ মজুরি হার ₹' + n(r.wage_rate) + ' রাখা হয়েছে।', 'ok');
        }).catch(function (e) { if (!e.authLost) status(/Could not find the function/i.test(e.message || '') ? 'Database update (SQL v229) এখনো চালানো হয়নি।' : errText(e)); });
      });
      wl.appendChild(eb);
    }
    $('regFyLine').textContent = 'চলতি FY' + (R.fy ? ' (' + R.fy + ')' : '') + ': Booked ' + rsC(t.bf) + ' · Paid ' + rsC(t.pf) + (R.upd ? ' · Portal update: ' + R.upd : '');

    if (S.rgSel == null) {
      $('regGroupCard').classList.remove('hidden'); $('regWorkCard').classList.add('hidden');
      var lab = (REG_GROUPS.filter(function (g) { return g[0] === S.rgGroup; })[0] || [])[1];
      $('regGroupTitle').firstChild.textContent = lab + '-wise ';
      var g = {}; all.forEach(function (w) { var k = w[S.rgGroup] || '—'; (g[k] = g[k] || []).push(w); });
      var keys = Object.keys(g).map(function (k) { return [k, regSum(g[k])]; }).sort(function (a, b) { return b[1].s - a[1].s; });
      var tb = $('regGroups'); tb.innerHTML = '';
      var hr = el('tr'); [lab, 'Work', 'Sanction ₹', 'Booked ₹', 'Paid ₹', 'বাকি ₹'].forEach(function (h) { hr.appendChild(el('th', h)); }); tb.appendChild(hr);
      keys.forEach(function (k) {
        var x = k[1], tr = el('tr', null, 'click'), td = el('td');
        td.appendChild(el('div', k[0])); var mb = el('div', null, 'mbar'); bars(mb, x.pa, x.ba, x.left); td.appendChild(mb);
        if (x.over) { var ov = el('span', '⚠ ' + x.over, 'tag over'); ov.title = x.over + ' work Sanction ছাড়িয়েছে'; td.appendChild(ov); }
        tr.appendChild(td);
        [n(x.n), rsK(x.s), rsK(x.ba), rsK(x.pa), rsK(x.left)].forEach(function (v) { tr.appendChild(el('td', v)); });
        tr.addEventListener('click', function () { S.rgSel = k[0]; S.limit = 300; renderReg(); window.scrollTo(0, $('regWorkCard').offsetTop - 10); });
        tb.appendChild(tr);
      });
      if (!keys.length) { var tr0 = el('tr'); tr0.appendChild(el('td', 'কিছু পাওয়া যায়নি।', 'mut')); tb.appendChild(tr0); }
      return;
    }
    $('regGroupCard').classList.add('hidden'); $('regWorkCard').classList.remove('hidden');
    $('regWorkTitle').textContent = S.rgSel;
    seg($('regSortSeg'), [['sanction', 'Sanction বেশি আগে'], ['left', 'বাকি বেশি আগে'], ['mandays', 'Pending mandays বেশি আগে'], ['over', 'ছাড়িয়েছে আগে'], ['fy', 'নতুন আগে']], S.rgSort, null, function (k) { S.rgSort = k; renderReg(); });
    var list = regFiltered(false).slice().sort(function (a, b) {
      if (S.rgSort === 'left') return b.left - a.left;
      if (S.rgSort === 'mandays') return (b.pmd || 0) - (a.pmd || 0);
      if (S.rgSort === 'over') return (b.over - a.over) || (b.s_tot - a.s_tot);
      if (S.rgSort === 'fy') return String(b.fy).localeCompare(String(a.fy)) || (b.s_tot - a.s_tot);
      return (b.s_tot || 0) - (a.s_tot || 0);
    });
    var box = $('regWorks'); box.innerHTML = '';
    if (!list.length) { box.appendChild(el('div', 'কোনো work নেই।', 'mut')); return; }
    list.slice(0, S.limit).forEach(function (w) {
      var it = el('div', null, 'item'); if (w.over) it.style.borderLeftColor = 'var(--red)';
      it.appendChild(el('b', w.name || w.code)); it.appendChild(el('div', w.code, 'mono'));
      var tags = el('div', null, 'r'), l = el('span');
      if (w.status) l.appendChild(el('span', w.status, 'tag' + (stKey(w.status) === 'done' ? ' done' : '')));
      if (w.fy) l.appendChild(el('span', 'শুরু ' + w.fy, 'tag'));
      if (isPba(w)) l.appendChild(el('span', 'PBA', 'tag pba'));
      if (w.over) l.appendChild(el('span', 'Sanction ছাড়িয়েছে', 'tag over'));
      tags.appendChild(l);
      var mr = (S.regMr || {})[w.code], r = el('span'); if (w.wtype && S.rgGroup !== 'wtype') r.appendChild(el('span', w.wtype, 'mut'));
      r.appendChild(noteBtn('work', w.code, mr ? mr.notes : 0, w.name || w.code, w.code)); tags.appendChild(r); it.appendChild(tags);
      if (mr) {                                   // MR progress (from the MR pipeline report)
        var ml = el('div', null, 'r'), mt = el('span');
        mt.appendChild(el('span', 'MR ' + n(mr.mrs), 'tag'));
        if (mr.running) mt.appendChild(el('span', 'চলছে ' + n(mr.running), 'tag'));
        if (mr.waiting) mt.appendChild(el('span', 'MR বাকি ' + n(mr.waiting), 'tag late'));
        if (mr.wl) mt.appendChild(el('span', 'WL হয়েছে ' + n(mr.wl), 'tag'));
        ml.appendChild(mt); if (mr.last_to) ml.appendChild(el('span', 'শেষ MR: ' + dmy(mr.last_to), 'mut')); it.appendChild(ml);
      }
      var m = el('div', null, 'money');
      [['Sanction', w.s_tot, 'U ' + rs(w.s_usk) + ' · M ' + rs(w.s_mat)], ['Booked (শুরু থেকে)', w.booked_all, 'এই FY ' + rs(w.booked_fy)],
       ['Paid (শুরু থেকে)', w.paid_all, 'এই FY ' + rs(w.paid_fy)], ['বাকি', w.left, w.mandays ? 'মোট ' + n(w.mandays) + ' mandays' : '']].forEach(function (x) {
        var d = el('div'); d.appendChild(el('span', x[0], 'mut')); d.appendChild(el('b', rs(x[1]))); if (x[2]) d.appendChild(el('span', x[2], 'mut')); m.appendChild(d);
      });
      it.appendChild(m);
      if (w.pu > 0) it.appendChild(el('div', '👷 Pending unskilled ' + rs(w.pu) + ' ≈ ' + n(Math.round(w.pmd)) + ' mandays' + (w.est ? ' (আনুমানিক)' : ''), 'mut'));
      var mb = el('div', null, 'mbar'); bars(mb, w.paid_all || 0, w.booked_all || 0, w.left); it.appendChild(mb);
      box.appendChild(it);
    });
    if (list.length > S.limit) {
      var more = el('button', 'আরও দেখুন (' + n(list.length - S.limit) + ')', 'btn more'); more.type = 'button';
      more.addEventListener('click', function () { S.limit += 300; renderReg(); }); box.appendChild(more);
    }
  }
  $('regBack').addEventListener('click', function () { S.rgSel = null; renderReg(); });
  $('regFy').addEventListener('change', function () { if (S.reg) { S.rgFy = this.value; S.limit = 300; renderReg(); } });
  $('regQ').addEventListener('input', function () { if (S.reg && !S.reg.none) { S.limit = 300; renderReg(); } });
  $('regCsv').addEventListener('click', function () {
    if (!S.reg || S.reg.none) return;
    csv('Work_Register_' + gpName() + (S.rgKind !== 'all' ? '_' + S.rgKind : '') + (S.rgSel ? '_' + S.rgSel : ''),
      ['Work Code', 'Work Name', 'Status', 'Start FY', 'Master Category', 'Category', 'Work Type (new)', 'Work Type', 'Agency',
       'Sanction Unskilled', 'Sanction Material', 'Sanction Total', 'Booked this FY', 'Paid this FY', 'Booked since inception', 'Paid since inception',
       'Sanction left', 'Over sanction', 'PBA', 'Pending unskilled', 'Pending mandays', 'MR', 'MR running', 'MR waiting', 'WL done', 'Total Mandays', 'Mandays this FY', 'Units', 'Started', 'Completed'],
      regFiltered(false).map(function (w) { return [w.code, w.name, w.status, w.fy, w.mcat, w.cat, w.wtype, w.type, w.agency, w.s_usk, w.s_mat, w.s_tot,
        w.booked_fy, w.paid_fy, w.booked_all, w.paid_all, w.left, w.over ? 'Yes' : '', isPba(w) ? 'Yes' : '', Math.round(w.pu || 0), Math.round(w.pmd || 0),
        ((S.regMr || {})[w.code] || {}).mrs || '', ((S.regMr || {})[w.code] || {}).running || '', ((S.regMr || {})[w.code] || {}).waiting || '', ((S.regMr || {})[w.code] || {}).wl || '', w.mandays, w.mandays_fy, w.units, w.start, w.done]; }));
  });

  // ---------------- caste ----------------
  function loadCaste() {
    if (S.caste && S.caste.gp === S.gp) { renderCaste(); return; }
    loading('আনছে...');
    SB.rpc('report_caste', { p_gp: S.gp }, { retry: true })
      .then(function (d) { d.gp = S.gp; S.caste = d; renderCaste(); })
      .catch(function (e) { if (!e.authLost) status(errText(e)); })
      .then(function () { loading(''); });
  }
  function monthName(m) { if (!m) return '—'; var p = m.split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }); }
  function renderCaste() {
    $('casteAt').textContent = 'শেষ: ' + when(S.caste.at);
    var tb = $('caste'); tb.innerHTML = '';
    var ms = S.caste.months || [];
    if (!ms.length) { var tr0 = el('tr'); tr0.appendChild(el('td', 'এখনো কোনো WL caste data আসেনি। K-Desk-এ ⚖ WL Caste চালালে আসবে।', 'mut')); tb.appendChild(tr0); return; }
    var hr = el('tr'); ['মাস', 'WL', 'শ্রমিক', 'SC', 'ST', 'Others', 'জানা নেই', 'মোট'].forEach(function (h) { hr.appendChild(el('th', h)); }); tb.appendChild(hr);
    var fy = null, tot = null;
    function totRow() { if (!tot) return; var tr = el('tr'); tr.style.fontWeight = '700'; tr.style.background = '#fff7ed';
      [fy + ' মোট', n(tot.wls), n(tot.workers), rs(tot.sc), rs(tot.st), rs(tot.gen), rs(tot.unknown), rs(tot.amount)].forEach(function (v) { tr.appendChild(el('td', v)); }); tb.appendChild(tr); }
    ms.forEach(function (m) {
      if (m.fy !== fy) { totRow(); fy = m.fy; tot = { wls: 0, workers: 0, sc: 0, st: 0, gen: 0, unknown: 0, amount: 0 }; }
      Object.keys(tot).forEach(function (k) { tot[k] += Number(m[k] || 0); });
      var tr = el('tr');
      [monthName(m.month), n(m.wls), n(m.workers), rs(m.sc), rs(m.st), rs(m.gen), rs(m.unknown), rs(m.amount)].forEach(function (v) { tr.appendChild(el('td', v)); });
      tb.appendChild(tr);
    });
    totRow();
  }
  $('casteCsv').addEventListener('click', function () {
    if (!S.caste) return;
    csv('WL_Caste_' + gpName(), ['FY', 'Month', 'WLs', 'Workers', 'SC', 'ST', 'Others', 'Unknown', 'Total'],
      (S.caste.months || []).map(function (m) { return [m.fy, m.month, m.wls, m.workers, m.sc, m.st, m.gen, m.unknown, m.amount]; }));
  });

  // ---------------- eKYC ----------------
  function loadEkyc() {
    if (S.ek && S.ek.gp === S.gp) { renderEkyc(); return; }
    loading('আনছে...');
    SB.rpc('report_ekyc', { p_gp: S.gp }, { retry: true, timeout: 60000 })
      .then(function (d) { d.gp = S.gp; S.ek = d; S.limit = 300; renderEkyc(); })
      .catch(function (e) { if (!e.authLost) status(errText(e)); })
      .then(function () { loading(''); });
  }
  function vname(v) { return (v.village_no != null ? String(v.village_no).padStart(3, '0') : '—') + (v.name ? ' · ' + v.name : ''); }
  function renderEkyc() {
    $('ekAt').textContent = 'ABPS Sync: ' + when(S.ek.at);
    var tb = $('ekVill'); tb.innerHTML = '';
    var hr = el('tr'); ['গ্রাম', 'শ্রমিক', 'eKYC', 'ABPS', 'Ready', '%'].forEach(function (h) { hr.appendChild(el('th', h)); }); tb.appendChild(hr);
    var vn = {};
    (S.ek.villages || []).forEach(function (v) {
      vn[v.village_no] = v.name;
      var tr = el('tr'), p = pct(v.ready, v.workers);
      [vname(v), n(v.workers), n(v.ekyc), n(v.abps), n(v.ready)].forEach(function (x) { tr.appendChild(el('td', x)); });
      var td = el('td', p + '%', p >= 85 ? 'ok' : p < 60 ? 'bad' : ''); tr.appendChild(td); tb.appendChild(tr);
    });
    S.ek.vn = vn; renderNr();
  }
  function nrFiltered() {
    var q = $('nrQ').value.trim().toLowerCase();
    return (S.ek.not_ready || []).filter(function (w) { return !q || (w.name + ' ' + w.jc).toLowerCase().indexOf(q) >= 0; });
  }
  function renderNr() {
    var list = nrFiltered(), box = $('nrList'); box.innerHTML = '';
    $('nrCount').textContent = n((S.ek.not_ready || []).length) + ' জন';
    if (!list.length) { box.appendChild(el('div', 'কেউ নেই।', 'mut')); return; }
    var t = el('table'), hr = el('tr'); ['নাম', 'Job Card', 'গ্রাম', 'eKYC', 'ABPS', ''].forEach(function (h) { hr.appendChild(el('th', h)); }); t.appendChild(hr);
    list.slice(0, S.limit).forEach(function (w) {
      var tr = el('tr'), ref = w.jc + '#' + w.ap;
      tr.appendChild(el('td', w.name)); tr.appendChild(el('td', w.jc + ' (' + w.ap + ')', 'mono'));
      tr.appendChild(el('td', vname({ village_no: w.village_no, name: S.ek.vn[w.village_no] })));
      tr.appendChild(el('td', w.ekyc ? '✓' : '✗', w.ekyc ? 'ok' : 'bad')); tr.appendChild(el('td', w.abps ? '✓' : '✗', w.abps ? 'ok' : 'bad'));
      var td = el('td'); td.appendChild(noteBtn('worker', ref, 0, w.name, w.jc)); tr.appendChild(td);
      t.appendChild(tr);
    });
    var wrap = el('div', null, 'tw'); wrap.appendChild(t); box.appendChild(wrap);
    if (list.length > S.limit) {
      var m = el('button', 'আরও দেখুন (' + n(list.length - S.limit) + ')', 'btn more'); m.type = 'button';
      m.addEventListener('click', function () { S.limit += 300; renderNr(); }); box.appendChild(m);
    }
  }
  $('nrQ').addEventListener('input', function () { if (S.ek) { S.limit = 300; renderNr(); } });
  $('nrCsv').addEventListener('click', function () {
    if (!S.ek) return;
    csv('Not_ready_' + gpName(), ['Name', 'Job Card', 'Applicant No', 'Village', 'eKYC', 'ABPS'],
      nrFiltered().map(function (w) { return [w.name, w.jc, w.ap, vname({ village_no: w.village_no, name: S.ek.vn[w.village_no] }), w.ekyc ? 'Yes' : 'No', w.abps ? 'Yes' : 'No']; }));
  });

  // ---------------- notes ----------------
  var KIND = { mr: 'MR', work: 'Work', wl: 'WL', worker: 'শ্রমিক', gp: 'GP' };
  function noteBtn(kind, ref, count, title, sub) {
    var b = el('button', '📝' + (count ? ' ' + count : ''), 'nbtn' + (count ? ' has' : '')); b.type = 'button'; b.title = 'Note';
    b.style.marginLeft = '6px';
    b.addEventListener('click', function (ev) { ev.stopPropagation(); openSheet(kind, ref, title, sub); });
    return b;
  }
  function noteEl(x, showRef) {
    var d = el('div', null, 'note'), h = el('small');
    h.appendChild(el('span', (x.author || '') + ' · ' + when(x.at) + (x.private ? ' · 🔒 শুধু আমি' : '') + (showRef && x.kind !== 'gp' ? ' · ' + KIND[x.kind] + ' ' + x.ref.split('#')[0] : '')));
    if (x.can_delete) {
      var del = el('button', 'মুছুন', 'del'); del.type = 'button';
      del.addEventListener('click', function () {
        if (!window.confirm('এই note মুছবেন?')) return;
        SB.rpc('report_note_delete', { p_id: x.id }).then(function () { d.remove(); S.mrs = S.works = S.reg = null; status('Note মোছা হয়েছে।', 'ok'); })
          .catch(function (e) { if (!e.authLost) status(errText(e)); });
      });
      h.appendChild(del);
    }
    d.appendChild(h); d.appendChild(document.createTextNode(x.body)); return d;
  }
  var sh = { kind: null, ref: null };
  function openSheet(kind, ref, title, sub) {
    sh.kind = kind; sh.ref = ref;
    $('shTitle').textContent = '📝 ' + (title || ref); $('shSub').textContent = (sub && sub !== title ? sub + ' · ' : '') + gpName() + ' GP';
    $('shBody').value = ''; $('shPrivate').checked = false; $('shNotes').innerHTML = '';
    $('sheet').classList.add('show');
    SB.rpc('report_notes', { p_gp: S.gp, p_kind: kind, p_ref: ref }).then(function (list) {
      if (!list.length) $('shNotes').appendChild(el('div', 'এখনো কোনো note নেই।', 'mut'));
      list.forEach(function (x) { $('shNotes').appendChild(noteEl(x, false)); });
    }).catch(function (e) { if (!e.authLost) $('shNotes').appendChild(el('div', errText(e), 'mut')); });
    setTimeout(function () { $('shBody').focus(); }, 50);
  }
  function closeSheet() { $('sheet').classList.remove('show'); }
  $('shClose').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', function (e) { if (e.target === this) closeSheet(); });
  $('shSave').addEventListener('click', function () {
    var body = $('shBody').value.trim();
    if (!body) { $('shBody').focus(); return; }
    var btn = this; btn.disabled = true;
    SB.rpc('report_note_add', { p_gp: S.gp, p_kind: sh.kind, p_ref: sh.ref, p_body: body, p_private: $('shPrivate').checked })
      .then(function () {
        closeSheet(); status('✅ Note রাখা হয়েছে।', 'ok');
        bump(sh.kind, sh.ref);
        if (S.page === 'notes') loadAllNotes();
      })
      .catch(function (e) { if (!e.authLost) status(errText(e)); })
      .then(function () { btn.disabled = false; });
  });
  function bump(kind, ref) {      // show the new count without reloading the whole list
    if (kind === 'mr' && S.mrs) { S.mrs.rows.forEach(function (r) { if (String(r.mr) === ref) r.notes = (r.notes || 0) + 1; }); if (S.page === 'pipe') renderMrs(); }
    if (kind === 'work' && S.works) { S.works.rows.forEach(function (w) { if (w.code === ref) w.notes = (w.notes || 0) + 1; }); if (S.page === 'works') renderWorks(); if (S.page === 'reg' && S.reg && !S.reg.none) renderReg(); }
  }
  function loadAllNotes() {
    var box = $('allNotes'); box.innerHTML = '';
    SB.rpc('report_notes', { p_gp: S.gp, p_limit: 300 }).then(function (list) {
      if (!list.length) { box.appendChild(el('div', 'এখনো কোনো note নেই।', 'mut')); return; }
      list.forEach(function (x) { box.appendChild(noteEl(x, true)); });
    }).catch(function (e) { if (!e.authLost) status(errText(e)); });
  }
  $('gpNote').addEventListener('click', function () { openSheet('gp', 'gp', gpName() + ' GP', 'GP-র সাধারণ note'); });

  // ---------------- CSV (opens in Excel) ----------------
  function csv(name, head, rows) {
    var esc = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var text = '﻿' + [head].concat(rows).map(function (r) { return r.map(esc).join(','); }).join('\r\n');
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = name.replace(/[^\w.-]+/g, '_') + '_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------------- header buttons ----------------
  $('asViewer').addEventListener('click', function () {
    S.viewerMode = !S.viewerMode; store('gramg2.rViewer', S.viewerMode ? '1' : '');
    this.classList.toggle('on', S.viewerMode);
    status(S.viewerMode ? '👁 এখন Viewer যা দেখেন শুধু তা-ই দেখাচ্ছে।' : 'Admin view-এ ফিরলেন।', 'ok');
    render();
  });
  $('logout').addEventListener('click', function () { SB.signOut().then(function () { location.replace('./index.html'); }); });

  boot();
})();
