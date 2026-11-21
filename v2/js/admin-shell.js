// Admin panel shell (2026-11-18): sidebar groups, one Gram Panchayat picker,
// page in the URL (#photos …), folded help text and the Today page.
// Every page keeps its own section + JS file; this file only moves between them.
(function () {
  'use strict';
  var SB = window.GramgSB;
  function $(id) { return document.getElementById(id); }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  if (!$('tab-today') || !SB) return;

  var GP_KEY = 'gramg2.gp', LAST_KEY = 'gramg2.adminLastSub';
  function store(k, v) { try { localStorage.setItem(k, v); } catch (_e) { /* convenience only */ } }
  function read(k) { try { return localStorage.getItem(k) || ''; } catch (_e) { return ''; } }

  /* ------------------------------ groups ------------------------------ */
  var groups = [].map.call(document.querySelectorAll('.side .grp'), function (g) {
    return { box: g, key: g.dataset.g, head: g.querySelector('.ghead'), tabs: [].slice.call(g.querySelectorAll('.tab')),
             title: (g.querySelector('.ghead span') || {}).textContent || '' };
  });
  function groupOf(tab) { for (var i = 0; i < groups.length; i++) if (groups[i].tabs.some(function (b) { return b.dataset.tab === tab; })) return groups[i]; return null; }
  function tabBtn(tab) { return document.querySelector('.tab[data-tab="' + tab + '"]'); }
  var lastSub = {}; try { lastSub = JSON.parse(read(LAST_KEY) || '{}') || {}; } catch (_e) { lastSub = {}; }

  function go(tab) { var b = tabBtn(tab); if (b) b.click(); }
  groups.forEach(function (g) {
    if (g.head && !g.head.classList.contains('tab') && g.tabs.length) {   // a link-only group (📊 Reports) just navigates
      g.head.addEventListener('click', function () {
        var want = lastSub[g.key];
        go(g.tabs.some(function (b) { return b.dataset.tab === want; }) ? want : g.tabs[0].dataset.tab);
      });
    }
  });
  // action links inside a group (eKYC summary, K-Desk activity) open their popup from the Demand lists page
  [].forEach.call(document.querySelectorAll('.sact[data-click]'), function (a) {
    a.addEventListener('click', function () { var t = $(a.dataset.click); if (t) t.click(); });
  });

  var current = 'today';
  function onTab(tab) {
    current = tab;
    var g = groupOf(tab);
    groups.forEach(function (x) { x.box.classList.toggle('open', x === g); if (x.head) x.head.classList.toggle('on', x === g); });
    $('tab-today').classList.toggle('hidden', tab !== 'today');
    if (tab !== 'today') document.documentElement.lang = 'en';
    if (g) { lastSub[g.key] = tab; store(LAST_KEY, JSON.stringify(lastSub)); }
    renderSubnav(g, tab);
    if (history.replaceState) history.replaceState(null, '', '#' + tab); else location.hash = tab;
    window.scrollTo(0, 0);
    if (tab === 'today') loadToday();
    if (tab === 'iay') setTimeout(syncIay, 0);
  }
  [].forEach.call(document.querySelectorAll('.tab'), function (b) {
    b.addEventListener('click', function () { onTab(b.dataset.tab); });
  });

  function renderSubnav(g, tab) {
    var box = $('subnav'), pills = $('subPills');
    var many = g && g.tabs.length > 1;
    box.classList.toggle('hidden', !g || tab === 'today');
    pills.innerHTML = '';
    if (!g) return;
    $('subCrumb').textContent = g.title;
    $('subRefresh').classList.toggle('hidden', !REFRESH[tab]);
    if (renderSubnav.last !== tab) { renderSubnav.last = tab; $('subWhen').textContent = ''; setTimeout(stamp, 0); }
    if (typeof aCount === 'function') setTimeout(aCount, 0);
    if (!many) return;
    g.tabs.forEach(function (b) {
      var p = el('button', null, 'pill2' + (b.dataset.tab === tab ? ' on' : '')); p.type = 'button';
      p.appendChild(el('span', (b.querySelector('i') || {}).textContent + ' ' + labelOf(b)));
      var n = badgeOf(b); if (n) p.appendChild(el('b', n));
      p.addEventListener('click', function () { b.click(); });
      pills.appendChild(p);
    });
    [].forEach.call(g.box.querySelectorAll('.sact'), function (a) {
      var p = el(a.tagName === 'A' ? 'a' : 'button', null, 'pill2 act'); if (a.href) p.href = a.getAttribute('href'); else p.type = 'button';
      p.appendChild(el('span', a.textContent.trim()));
      if (a.dataset.click) p.addEventListener('click', function () { a.click(); });
      pills.appendChild(p);
    });
  }
  function labelOf(b) { var s = b.querySelector('span'); if (!s) return ''; var t = ''; [].forEach.call(s.childNodes, function (n) { if (n.nodeType === 3) t += n.textContent; }); return t.trim(); }
  function badgeOf(b) { var x = b.querySelector('.badge'); return x && !x.classList.contains('hidden') ? x.textContent.trim() : ''; }

  // group badge = sum of its pages' badges ('!' stays '!')
  function groupBadges() {
    groups.forEach(function (g) {
      var gb = g.head && g.head.querySelector('.gbadge'); if (!gb) return;
      var sum = 0, bang = false;
      g.tabs.forEach(function (b) { var v = badgeOf(b); if (!v) return; if (/^\d+$/.test(v)) sum += Number(v); else bang = true; });
      var txt = sum ? String(sum) : bang ? '!' : '';
      gb.textContent = txt; gb.classList.toggle('hidden', !txt);
    });
    var g = groupOf(current); if (g && g.tabs.length > 1) renderSubnav(g, current);
  }
  if (window.MutationObserver) {
    var mo = new MutationObserver(function () { clearTimeout(mo.t); mo.t = setTimeout(groupBadges, 50); });
    [].forEach.call(document.querySelectorAll('.tab .badge'), function (b) { mo.observe(b, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] }); });
  }

  /* ------------------------ one Gram Panchayat picker ------------------------ */
  // page → its own (now hidden) GP picker
  var PAGE_GP = { dash: 'dashGp', photos: 'phGp', marks: 'mkGp', pmiss: 'pmGp', pipeline: 'ppGp', wlcaste: 'wcGp', masters: 'msGp', signup: 'suGp', sreq: 'srGp', import: 'gpSelect' };
  Object.keys(PAGE_GP).forEach(function (k) {
    var s = $(PAGE_GP[k]); if (!s) return;
    s.classList.add('gp-dup');
    var l = document.querySelector('label[for="' + PAGE_GP[k] + '"]'); if (l) l.classList.add('gp-dup');
  });
  // Data import: still show which GP the file goes into
  (function () {
    var s = $('gpSelect'); if (!s) return;
    var chip = el('div', '', 'gp-chip'); chip.id = 'gpImportChip'; s.parentNode.insertBefore(chip, s);
  })();
  function gpName() { var o = $('gGp').selectedOptions[0]; return o ? o.textContent : ''; }
  function gpPrefix() { var o = $('gGp').selectedOptions[0]; return o ? o.dataset.prefix || '' : ''; }
  function gpId() { return Number($('gGp').value) || null; }
  function hasOpt(sel, v) { return [].some.call(sel.options, function (o) { return o.value === v; }); }

  function fillGlobal() {
    var src = $('phGp'), dst = $('gGp'); if (!src || !src.options.length) return;
    var keep = dst.value || read(GP_KEY) || src.value;
    dst.innerHTML = '';
    [].forEach.call(src.options, function (o) {   // short name here; the Job Card prefix is kept aside
      var m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(o.textContent) || [null, o.textContent, ''];
      var x = el('option', m[1]); x.value = o.value; x.dataset.prefix = m[2]; x.title = o.textContent; dst.appendChild(x);
    });
    dst.disabled = src.disabled;
    dst.value = hasOpt(dst, keep) ? keep : src.value;
    $('gpImportChip').textContent = '📍 ' + ($('gpSelect').selectedOptions[0] || {}).textContent;
    store('gramg2.iayDashGp', gpPrefix());
    if (!fillGlobal.done) { fillGlobal.done = true; openStart(); }
  }
  if (window.MutationObserver) new MutationObserver(fillGlobal).observe($('phGp'), { childList: true, attributes: true, attributeFilter: ['disabled'] });

  $('gGp').addEventListener('change', function () {
    var v = this.value; store(GP_KEY, v);
    Object.keys(PAGE_GP).forEach(function (k) {
      var s = $(PAGE_GP[k]); if (!s || !hasOpt(s, v) || s.value === v) return;
      s.value = v;
      // reload only the page that is open now; the others load with this GP when opened
      var sec = $('tab-' + k);
      if ((sec && !sec.classList.contains('hidden')) || k === 'import') s.dispatchEvent(new Event('change'));
    });
    $('gpImportChip').textContent = '📍 ' + ($('gpSelect').selectedOptions[0] || {}).textContent;
    store('gramg2.iayDashGp', gpPrefix());
    if (current === 'iay') syncIay();
    if (current === 'today') loadToday();
  });
  // PBA page has its own picker (it can also show the whole Block); follow the one picker when it changes
  var iayFollowed = '';
  function syncIay() {
    var s = $('idGp'), p = gpPrefix(); if (!s || s.disabled || !p || iayFollowed === p) return;
    iayFollowed = p;
    if (hasOpt(s, p) && s.value !== p) { s.value = p; s.dispatchEvent(new Event('change')); }
  }


  /* ------------------------------ profile menu + dark mode ------------------------------ */
  var THEME_KEY = 'gramg2.theme';
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
    $('themeBtn').textContent = t === 'dark' ? '☀ Light mode' : '🌙 Dark mode';
    var m = document.querySelector('meta[name=theme-color]'); if (m) m.content = t === 'dark' ? '#0b1120' : '#f97316';
  }
  applyTheme(read(THEME_KEY));
  $('themeBtn').addEventListener('click', function () {
    var t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    store(THEME_KEY, t); applyTheme(t);
  });
  $('profBtn').addEventListener('click', function (e) { e.stopPropagation(); $('profMenu').classList.toggle('hidden'); });
  document.addEventListener('click', function (e) { if (!e.target.closest('#profMenu,#profBtn')) $('profMenu').classList.add('hidden'); });
  function syncProfile() {
    var n = ($('who').textContent || '').trim();
    $('profName').textContent = n; $('profRole').textContent = $('roleLbl').textContent;
    $('profAv').textContent = (n && n !== '…' ? n : 'A').charAt(0).toUpperCase();
    var b = $('dbVer'); $('pmDb').textContent = '🗄 Database: ' + (b ? b.textContent.replace('DB ', '') : '…') + (b && b.title ? '' : '');
  }
  if (window.MutationObserver) {
    var po = new MutationObserver(syncProfile);
    po.observe($('who'), { childList: true, characterData: true, subtree: true });
    po.observe($('roleLbl'), { childList: true, characterData: true, subtree: true });
    po.observe(document.querySelector('.side .header-title'), { childList: true, subtree: true, characterData: true });
  }
  syncProfile();
  $('srchBtn').addEventListener('click', function () { if (window.AdminSearch) window.AdminSearch.open(); });

  /* ------------------------------ page header: refresh + time ------------------------------ */
  var REFRESH = { dash: 'dashRefresh', photos: 'phRefresh', marks: 'mkRefresh', pmiss: 'pmRefresh', pipeline: 'ppRefresh', wlcaste: 'wcRefresh', signup: 'suRefresh', sreq: 'srRefresh', iay: 'idRefresh' };
  function stamp() { $('subWhen').textContent = 'Updated ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  $('subRefresh').addEventListener('click', function () { var b = $(REFRESH[current]); if (b) { b.click(); stamp(); } });

  /* ------------------------------ ticked rows → action bar ------------------------------ */
  var ABAR = { marks: { body: 'mkBody', all: 'mkAll', btns: ['mkAccept', 'mkReturn', 'mkXlsx', 'mkSent', 'mkDeleted'] },
               pmiss: { body: 'pmBody', all: 'pmAll', btns: ['pmRestore'] } };
  function aCount() {
    var c = ABAR[current], bar = $('aBar');
    var n = c && $(c.body) ? $(c.body).querySelectorAll('input[type=checkbox]:checked').length : 0;
    bar.classList.toggle('hidden', !n);
    if (!n) return;
    $('aBarN').textContent = n + ' selected';
    var B = $('aBarBtns'); B.innerHTML = '';
    c.btns.forEach(function (id) {
      var o = $(id); if (!o || o.offsetParent === null && o.closest('.hidden')) return;
      var b = el('button', o.textContent.replace(/\s*\(?ticked\)?/i, ''), 'ab-b'); b.type = 'button'; b.disabled = o.disabled;
      b.addEventListener('click', function () { o.click(); setTimeout(aCount, 600); setTimeout(aCount, 2500); });
      B.appendChild(b);
    });
  }
  document.addEventListener('change', function (e) { if (e.target && e.target.type === 'checkbox' && e.target.closest('#tab-marks,#tab-pmiss')) setTimeout(aCount, 0); });
  if (window.MutationObserver) ['mkBody', 'pmBody'].forEach(function (id) { if ($(id)) new MutationObserver(function () { setTimeout(aCount, 0); }).observe($(id), { childList: true }); });
  $('aBarX').addEventListener('click', function () {
    var c = ABAR[current]; if (!c) return;
    var all = $(c.all); if (all && all.checked) { all.checked = false; all.dispatchEvent(new Event('change', { bubbles: true })); }
    [].forEach.call($(c.body).querySelectorAll('input[type=checkbox]:checked'), function (x) { x.checked = false; x.dispatchEvent(new Event('change', { bubbles: true })); });
    aCount();
  });

  /* ------------------------------ folded help text ------------------------------ */
  // long grey explanations at the top of a card fold into "ⓘ How it works"
  [].forEach.call(document.querySelectorAll('main section .card > .muted:not([id])'), function (m) {
    if (m.textContent.trim().length < 170 || /keep it safe|⚠/i.test(m.textContent)) return;   // safety warnings stay open
    var d = el('details', null, 'help'); var s = el('summary', 'ⓘ How it works');
    m.parentNode.insertBefore(d, m); d.appendChild(s); d.appendChild(m);
  });

  /* ------------------------------ Today page ------------------------------ */
  // 2026-11-20: every number on this page comes from one place. buildFlow() makes the ① … ⑥ cards,
  // buildTodayTasks() turns the same data into "Waiting for you", and the hero count = that list's length.
  // Colour rule (CSS classes, never inline): late = red, deadline passed · warn = orange, work left ·
  // idle = grey, 0 and nothing to do · done = green, step complete. Each colour also has ⏰ / ⚠ / ✓ text.
  function q(p) { return p.then(function (x) { return x; }, function () { return null; }); }
  function hm(d) { return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function fmtDay(s) { if (!s) return ''; var d = new Date(s); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + hm(d); }
  function age(s) { return s ? (Date.now() - new Date(s).getTime()) / 864e5 : Infinity; }
  function money(n) { return '₹' + Math.round(Number(n || 0)).toLocaleString('en-IN'); }
  function num(n) { return Number(n || 0).toLocaleString('en-IN'); }

  // EN / বাং for the Today page (the rest of the Admin panel is English)
  var LANG_KEY = 'gramg2.adminLang';
  var lang = read(LANG_KEY) === 'en' ? 'en' : 'bn';
  function L(bn, en) { return lang === 'bn' ? bn : en; }
  function cnt(n, bnUnit, enOne, enMany) { return lang === 'bn' ? num(n) + 'টা ' + bnUnit : num(n) + ' ' + (n === 1 ? enOne : (enMany || enOne + 's')); }
  function setLang(l) {
    lang = l; store(LANG_KEY, l);
    [].forEach.call($('tdLang').querySelectorAll('button'), function (b) { b.classList.toggle('on', b.dataset.l === l); });
    if (current === 'today') document.documentElement.lang = l;
    $('tdTodoH').textContent = L('আপনার জন্য অপেক্ষা', 'Waiting for you');
    $('tdHealthH').textContent = L('System health', 'System health');
    $('tdRefresh').textContent = L('🔄 Refresh', '🔄 Refresh');
    if (tdLast) renderToday(tdLast.r, tdLast.opt); else if (current === 'today') loadToday();
  }
  [].forEach.call($('tdLang').querySelectorAll('button'), function (b) { b.addEventListener('click', function () { if (b.dataset.l !== lang) setLang(b.dataset.l); }); });
  function rel(at) {
    if (!at) return L('কখনও না', 'never');
    var m = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 6e4));
    var r = m < 1 ? L('এইমাত্র', 'just now') : m < 60 ? L(m + ' মিনিট আগে', m + ' min ago') : m < 1440 ? L(Math.round(m / 60) + ' ঘণ্টা আগে', Math.round(m / 60) + ' h ago')
      : L(Math.floor(m / 1440) + ' দিন আগে', Math.floor(m / 1440) + (Math.floor(m / 1440) === 1 ? ' day ago' : ' days ago'));
    return r + ' · ' + fmtDay(at);
  }
  var ICON = { late: '⏰', warn: '⚠', idle: '✓', done: '✓' };
  function stTxt(k) { return { late: L('⏰ দেরি', '⏰ Late'), warn: L('⚠ বাকি', '⚠ To do'), idle: L('✓ কিছু নেই', '✓ Nothing'), done: L('✓ ঠিক আছে', '✓ Done') }[k] || ''; }

  // the day before's numbers for ▲ / ▼ (per GP, this browser only)
  function today0() { var d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function deltas(g, vals) {
    var k = 'gramg2.tdDay.' + g, s = null;
    try { s = JSON.parse(localStorage.getItem(k) || 'null'); } catch (_e) { s = null; }
    if (!s || typeof s !== 'object') s = {};
    var t = today0();
    if (s.d && s.d !== t) { s.pd = s.d; s.pv = s.v; }
    s.d = t; s.v = vals;
    try { localStorage.setItem(k, JSON.stringify(s)); } catch (_e) { /* convenience only */ }
    return s.pv || null;
  }

  var tdSeq = 0, tdLast = null, lastGood = {};
  function loadToday() {
    var g = gpId(); if (!g) return;
    var seq = ++tdSeq;
    document.documentElement.lang = lang;
    tdLast = null;
    renderLoading();   // a new GP never shows the old GP's numbers, not even for a moment
    Promise.all([
      q(SB.rpc('admin_dashboard', { p_gp_id: g }, { retry: true })),
      window.AdminPipeline ? q(window.AdminPipeline.summary(g)) : Promise.resolve(null),
      q(SB.rpc('admin_count_account_requests', { p_gp_id: g })),
      q(SB.rpc('admin_account_photos', { p_gp_id: g, p_status: 'new' })),
      q(SB.rpc('admin_marks_list', { p_gp_id: g, p_filter: 'new' })),
      q(SB.rpc('admin_portal_missing', { p_gp_id: g })),
      q(SB.rpc('admin_data_status', { p_gp_id: g })),
      q(SB.rpc('db_version')),
      q(SB.rpc('admin_portal_new_count', { p_gp_id: g })),
      q(SB.rpc('admin_sr_count', { p_gp_id: g }))
    ]).then(function (r) {
      if (seq !== tdSeq) return;
      if (r[0] == null) {   // network / server failed: keep the last good numbers of this GP, say when, offer Retry
        var lg = lastGood[g];
        if (lg) renderToday(lg.r, { stale: lg.at, g: g }); else renderFailed();
        return;
      }
      lastGood[g] = { r: r, at: new Date() };
      renderToday(r, { at: lastGood[g].at, g: g });
    });
  }
  $('tdRefresh').addEventListener('click', loadToday);

  function heroTop() {
    var who = ($('who').textContent || '').trim();
    $('tdHello').textContent = L('নমস্কার', 'Namaskar') + (who && who !== '…' ? ', ' + who : '');
    var d = new Date().toLocaleDateString(lang === 'bn' ? 'bn-IN' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    $('tdSub').textContent = d + ' · ' + gpName();
  }
  function renderLoading() {
    heroTop();
    $('tdUrgent').className = 'td-urgent'; $('tdUrgent').textContent = L('লোড হচ্ছে…', 'Loading…');
    $('tdCount').className = 'td-count hidden'; $('tdCount').dataset.n = ''; $('tdNet').classList.add('hidden');
    var F = $('tdFlow'); F.innerHTML = '';
    for (var i = 1; i <= 6; i++) {
      var c = el('div', null, 'tdf loading'); var top = el('div', null, 'tdtop'); top.appendChild(el('span', String(i), 'tdn')); c.appendChild(top);
      c.appendChild(el('b', '…')); c.appendChild(el('div', ' ', 'tdl')); c.appendChild(el('div', ' ', 'tds')); F.appendChild(c);
    }
    $('tdTodo').innerHTML = ''; $('tdTodo').appendChild(el('div', L('লোড হচ্ছে…', 'Loading…'), 'muted'));
    $('tdHealth').innerHTML = ''; $('tdMoney').innerHTML = ''; $('tdMoney').classList.add('hidden');
  }
  function netBar(text) {
    var N = $('tdNet'); N.innerHTML = ''; N.classList.remove('hidden');
    N.appendChild(el('span', text));
    var b = el('button', L('🔄 আবার চেষ্টা', '🔄 Retry'), 'btn-light btn-small'); b.type = 'button'; b.addEventListener('click', loadToday); N.appendChild(b);
  }
  function renderFailed() {
    $('tdUrgent').className = 'td-urgent warn'; $('tdUrgent').textContent = L('⚠ সংখ্যা আনা গেল না', '⚠ Could not load the numbers');
    netBar(L('⚠ Network সমস্যা — এই GP-র কোনো sync এখনও হয়নি।', '⚠ Network problem — this GP has not synced yet.'));
    [].forEach.call($('tdFlow').querySelectorAll('.tdf b'), function (b) { b.textContent = '—'; });
    $('tdTodo').innerHTML = ''; $('tdTodo').appendChild(el('div', L('Retry চাপুন।', 'Press Retry.'), 'muted'));
  }

  // ① … ⑥ (key 1–6 opens the same page)
  function buildFlow(D) {
    var p = D.pp || {}, has = !!D.pp;
    var f = [];
    var lsState = D.draft || D.noList ? 'warn' : D.lists ? 'done' : 'idle';
    f.push({ key: 'lists', n: 1, val: D.sub, of: D.lists, unit: '', label: L('List submit হয়েছে', 'Lists submitted'),
             note: D.draft ? cnt(D.draft, 'draft list', 'draft list') : D.lists ? L('সব submit হয়েছে', 'all submitted') : L('এখনও কোনো list নেই', 'no list yet'), state: lsState, tab: 'dash' });
    var fillLate = has && p.fill > 0;
    var dl = p.fillOldest ? Math.floor((Date.now() - new Date(p.fillOldest + 'T23:59:59').getTime()) / 864e5) : null;
    f.push({ key: 'fill', n: 2, val: has ? p.fill : null, unit: has ? L('টা MR', p.fill === 1 ? 'MR' : 'MRs') : '', label: L('MR fill বাকি', 'MR to fill'),
             note: !has ? L('pipeline তৈরি নয়', 'pipeline not ready') : !p.fill ? L('period শেষ হওয়া সব MR fill হয়েছে', 'all ended MRs are filled')
               : (dl != null && dl > 0 ? L('period শেষ ' + dl + ' দিন আগে', 'period ended ' + dl + (dl === 1 ? ' day' : ' days') + ' ago')
                 : p.fillToday ? L('period আজ শেষ', 'period ends today') : L('period শেষ', 'period ended')) + (p.fillPbaOnly ? ' · PBA' : ''),
             state: fillLate ? 'late' : 'idle', tab: 'pipeline', days: dl });
    f.push({ key: 'emb', n: 3, val: p.emb, unit: p.emb != null ? L('টা MR', p.emb === 1 ? 'MR' : 'MRs') : '', label: L('e-MB / AE verify', 'e-MB / AE verify'),
             note: p.emb == null ? L('MR report লাগবে', 'needs MR report') : p.emb ? L('e-MB entry বা AE verify বাকি', 'e-MB entry or AE verify left') : L('কিছু বাকি নেই', 'nothing left'),
             state: p.emb ? 'warn' : 'idle', tab: 'pipeline' });
    f.push({ key: 'gen', n: 4, val: p.gen, unit: p.gen != null ? L('টা work', p.gen === 1 ? 'work' : 'works') : '', label: L('WL generate হয়নি', 'WL not generated'),
             note: p.gen == null ? L('K-Desk এখনও পড়েনি', 'K-Desk not read yet') : p.gen ? L('MR fill হয়েছে, WL নেই', 'MR filled, no wage list') : L('কিছু বাকি নেই', 'nothing left'),
             state: p.gen ? 'warn' : 'idle', tab: 'pipeline' });
    f.push({ key: 'send', n: 5, val: p.send, unit: p.send != null ? L('টা WL', p.send === 1 ? 'WL' : 'WLs') : '', label: L('Payment-এ পাঠানো বাকি', 'Send for payment'),
             note: p.send == null ? L('K-Desk এখনও পড়েনি', 'K-Desk not read yet') : p.send ? (p.sendAmt ? { money: money(p.sendAmt) } : L('টাকা এখনও পড়া হয়নি', 'amount not read yet')) : L('কিছু বাকি নেই', 'nothing left'),
             state: p.send ? 'warn' : 'idle', tab: 'pipeline' });
    var sentState = p.sent > 0 ? 'done' : p.send > 0 ? 'warn' : 'idle';
    f.push({ key: 'sent', n: 6, val: has ? p.sent : null, unit: has ? L('টা WL', p.sent === 1 ? 'WL' : 'WLs') : '', label: L('পাঠানো হয়েছে · 7 দিন', 'Sent · 7 days'),
             note: p.sent ? { money: money(p.sentAmt) } : p.send > 0 ? L('7 দিনে কিছু পাঠানো হয়নি', 'nothing sent in 7 days') : L('K-Desk Send run-এর পরে দেখাবে', 'shows after a K-Desk Send run'),
             state: sentState, tab: 'pipeline' });
    return f;
  }

  // "Waiting for you": one row for every flow step that has work + the other inbox counts. Most urgent first.
  function buildTodayTasks(D, flow) {
    var F = {}; flow.forEach(function (s) { F[s.key] = s; });
    var t = [];
    function add(rank, state, icon, title, sub, tab) { t.push({ rank: rank, state: state, icon: icon, title: title, sub: sub, tab: tab }); }
    var fill = F.fill;
    if (fill.val > 0) add(fill.days != null ? -fill.days : 0, 'late', '🧾', cnt(fill.val, 'MR fill বাকি', 'MR to fill', 'MRs to fill'), fill.note, 'pipeline');
    if (F.send.val > 0) add(10, 'warn', '💸', cnt(F.send.val, 'WL payment-এ পাঠানো বাকি', 'WL to send for payment', 'WLs to send for payment'),
                            D.pp && D.pp.sendAmt ? money(D.pp.sendAmt) + ' · ' + L('Send Wagelist For Payment', 'Send Wagelist For Payment') : L('Send Wagelist For Payment', 'Send Wagelist For Payment'), 'pipeline');
    if (F.gen.val > 0) add(11, 'warn', '📄', cnt(F.gen.val, 'work-এর WL generate হয়নি', 'work without a wage list', 'works without a wage list'), L('MR fill হয়েছে · Generate Wagelist', 'MR filled · Generate Wagelist'), 'pipeline');
    if (F.emb.val > 0) add(12, 'warn', '📏', cnt(F.emb.val, 'MR-এ e-MB / AE verify বাকি', 'MR waiting for e-MB / AE verify', 'MRs waiting for e-MB / AE verify'), L('MR-wise report অনুযায়ী', 'from the MR-wise report'), 'pipeline');
    // ① card already says "x/y submitted"; the row adds what the card does not
    if (D.noList) add(13, 'warn', '📝', lang === 'bn' ? D.noList + ' জন supervisor এখনও list বানাননি' : D.noList + ' supervisor' + (D.noList === 1 ? ' has' : 's have') + ' not made a list yet',
                      D.draft ? cnt(D.draft, 'list draft-এ আছে', 'list still draft', 'lists still draft') : L('Demand lists', 'Demand lists'), 'dash');
    else if (D.draft) add(13, 'warn', '📝', cnt(D.draft, 'list এখনও submit হয়নি', 'list not submitted yet', 'lists not submitted yet'), L('Supervisor-কে submit করতে বলুন', 'Ask the supervisor to submit'), 'dash');
    if (D.marks) add(14, 'warn', '🗑', cnt(D.marks, 'Expired / Migrant mark', 'Expired / Migrant mark'), L('Accept বা Return করুন', 'Accept or Return'), 'marks');
    if (D.sreq) add(14.5, 'warn', '📨', cnt(D.sreq, 'নতুন supervisor request / নোট', 'new supervisor request / note', 'new supervisor requests / notes'), L('Workers & Accounts → Supervisor requests', 'Workers & Accounts → Supervisor requests'), 'sreq');
    if (D.login) add(15, 'warn', '🙋', cnt(D.login, 'supervisor login request', 'supervisor login request'), L('Team & Access → Login requests', 'Team & Access → Login requests'), 'signup');
    if (D.pnew) add(16, 'warn', '🆕', cnt(D.pnew, 'নতুন worker portal-এ', 'new worker on the portal', 'new workers on the portal'), L('ABPS Sync-এ পাওয়া, Gram Setu-তে নেই · Accept বা Ignore', 'Found by ABPS Sync, not in Gram Setu yet · Accept or Ignore'), 'pmiss');
    if (D.held) add(17, 'warn', '🚫', cnt(D.held, 'ABPS sync আটকে', 'ABPS sync held', 'ABPS syncs held'), L('Portal-এ worker পাওয়া যায়নি · Apply বা Ignore', 'Workers not found on the portal · Apply or Ignore'), 'pmiss');
    if (D.photos) add(18, 'warn', '📷', cnt(D.photos, 'account copy দেখা বাকি', 'account copy to check', 'account copies to check'), L('30 দিন পরে ছবি মুছে যায়', 'Photos are deleted after 30 days'), 'photos');
    t.sort(function (a, b) { return (a.state === 'late' ? 0 : 1) - (b.state === 'late' ? 0 : 1) || a.rank - b.rank; });
    return t;
  }

  function healthItems(D) {
    var p = D.pp || {}, db = D.db || {}, ds = D.ds || {}, need = (window.AdminDbVer && window.AdminDbVer.need) || 235, out = [];
    function fresh(at, okDays, warnDays) { var a = age(at); return a <= okDays ? 'ok' : a <= warnDays ? 'warn' : 'late'; }
    out.push({ label: L('Database version', 'Database version'),
               v: db.version ? 'v' + db.version + (db.version >= need ? '' : ' · ' + L('দরকার v' + need, 'needs v' + need)) : L('জানা নেই', 'unknown'),
               st: db.version && db.version >= need ? 'ok' : 'late',
               help: L('Supabase → SQL Editor-এ repo-র supabase/ folder থেকে v' + need + ' পর্যন্ত বাকি SQL file-গুলো চালান (পুরোনোটা আগে)।', 'In Supabase → SQL Editor run the missing SQL files from the repo folder supabase/ up to v' + need + ' (oldest first).') });
    var sy = ds.last_sync && ds.last_sync.at;
    out.push({ label: L('ABPS Sync (K-Desk)', 'ABPS Sync (K-Desk)'), at: sy, st: fresh(sy, 7, 14),
               help: L('Portal-এ login করে K-Desk → 🔄 ABPS Sync চালান (K-Desk-এ Gram Setu login থাকতে হবে)। সপ্তাহে একবার যথেষ্ট।', 'Log in to the portal and run K-Desk → 🔄 ABPS Sync (K-Desk must be logged in to Gram Setu). Once a week is enough.') });
    if (ds.last_import) out.push({ label: L('Excel import', 'Excel import'), at: ds.last_import.at, st: 'idle' });
    if (D.pp) {
      out.push({ label: L('MR-wise report (Pi / Tampermonkey)', 'MR-wise report (Pi / Tampermonkey)'), at: p.at.rep, st: fresh(p.at.rep, 1, 3), tab: 'pipeline',
                 help: L('Raspberry Pi-র nightly script (বা Tampermonkey) দিয়ে MR-wise report (R4.2 + R4.4) Gram Setu-তে পাঠান। Pi চালু আছে কিনা দেখুন।', 'Send the MR-wise report (R4.2 + R4.4) with the Raspberry Pi nightly script (or Tampermonkey). Check that the Pi is on.') });
      out.push({ label: L('K-Desk: Generate Wagelist পড়া', 'K-Desk read Generate Wagelist'), at: p.at.gen, st: fresh(p.at.gen, 1, 3), tab: 'pipeline',
                 help: L('Portal-এ Generate Wagelist page-টা K-Desk চালু রেখে একবার খুলুন। K-Desk শুধু list পড়ে, কিছু click করে না।', 'Open the Generate Wagelist page on the portal once with K-Desk on. K-Desk only reads the list.') });
      out.push({ label: L('K-Desk: Send for payment পড়া', 'K-Desk read Send for payment'), at: p.at.send, st: fresh(p.at.send, 1, 3), tab: 'pipeline',
                 help: L('Portal-এ Send Wagelist For Payment page-টা K-Desk চালু রেখে একবার খুলুন।', 'Open the Send Wagelist For Payment page on the portal once with K-Desk on.') });
      out.push({ label: L('IAY Tracker report', 'IAY Tracker report'), at: p.at.iay, st: fresh(p.at.iay, 1, 3), tab: 'iay',
                 help: L('Pi-র script বা K-Desk দিয়ে IAY Tracker report আবার পাঠান।', 'Send the IAY Tracker report again (Pi script or K-Desk).') });
    }
    return out;
  }

  function renderToday(r, opt) {
    opt = opt || {}; tdLast = { r: r, opt: opt };
    var users = r[0] || [], pp = r[1], ds = r[6] || {}, db = r[7] || {};
    var D = { pp: pp, ds: ds, db: db, login: Number(r[2]) || 0, photos: (r[3] && r[3].new_count) || 0,
              marks: ((r[4] && r[4].counts) || {}).new || 0, held: ((r[5] && r[5].held) || []).length, pnew: Number(r[8]) || 0, sreq: Number(r[9]) || 0 };
    var lists = [], noList = 0;
    users.forEach(function (u) { if (!(u.lists || []).length) noList++; (u.lists || []).forEach(function (l) { lists.push(l); }); });
    D.lists = lists.length; D.noList = noList;
    D.sub = lists.filter(function (l) { return l.submit_state === 'submitted'; }).length;
    D.draft = lists.filter(function (l) { return l.submit_state === 'draft'; }).length;

    var flow = buildFlow(D), tasks = buildTodayTasks(D, flow);
    heroTop();

    // network state
    if (opt.stale) netBar(L('⚠ Network সমস্যা — দেখাচ্ছে শেষ sync: ', '⚠ Network problem — showing last sync: ') + hm(opt.stale));
    else $('tdNet').classList.add('hidden');
    $('tdWhen').textContent = L('শেষ আপডেট ', 'Last update ') + hm(opt.stale || opt.at || new Date());

    // ① … ⑥
    var prev = opt.stale ? null : deltas(opt.g || gpId(), flow.reduce(function (o, s) { o[s.key] = s.val; return o; }, {}));
    var Fx = $('tdFlow'); Fx.innerHTML = '';
    flow.forEach(function (s) {
      var c = el('button', null, 'tdf ' + s.state); c.type = 'button'; c.dataset.state = s.state;
      c.title = L('চাপুন বা কি-বোর্ডে ' + s.n + ' টিপুন', 'Click or press ' + s.n);
      var top = el('div', null, 'tdtop'); top.appendChild(el('span', String(s.n), 'tdn')); top.appendChild(el('span', s.val == null ? '' : stTxt(s.state), 'tdst')); c.appendChild(top);
      var b = el('b', s.val == null ? '—' : num(s.val));
      if (s.of != null) b.appendChild(el('small', '/' + num(s.of)));
      if (s.unit && s.val != null) b.appendChild(el('span', s.unit, 'u'));
      c.appendChild(b);
      c.appendChild(el('div', s.label, 'tdl'));
      var note = el('div', null, 'tds');
      if (s.note && s.note.money) note.appendChild(el('span', s.note.money, 'money')); else note.textContent = s.note || '';
      c.appendChild(note);
      var d = el('div', '', 'tdd');
      if (prev && prev[s.key] != null && s.val != null && prev[s.key] !== s.val) {
        var x = s.val - prev[s.key];
        d.textContent = (x > 0 ? '▲' : '▼') + Math.abs(x) + ' ' + L('গতকালের তুলনায়', 'vs yesterday');
      }
      c.appendChild(d);
      c.addEventListener('click', function () { go(s.tab); });
      Fx.appendChild(c);
    });
    todayFlow = flow;

    // Waiting for you
    var T = $('tdTodo'); T.innerHTML = '';
    if (!tasks.length) T.appendChild(el('div', L('আজ কোনো কাজ বাকি নেই ✓', 'Nothing is waiting today ✓'), 'tdempty'));
    tasks.forEach(function (x) {
      var row = el('button', null, 'tdrow ' + x.state); row.type = 'button';
      row.appendChild(el('span', x.icon, 'tde'));
      var t = el('span', null, 'tdt'); t.appendChild(el('b', x.title)); t.appendChild(el('small', x.sub)); row.appendChild(t);
      row.appendChild(el('span', stTxt(x.state), 'tdtag'));
      row.appendChild(el('span', L('খুলুন', 'Open'), 'tdgo'));
      row.addEventListener('click', function () { go(x.tab); });
      T.appendChild(row);
    });

    // hero: N = tasks.length (the same list as above), second line = the most urgent task
    var top1 = tasks[0];
    var C = $('tdCount'); C.className = 'td-count ' + (top1 ? top1.state : 'done');
    C.textContent = tasks.length ? L('আজ ' + tasks.length + 'টা কাজ বাকি', tasks.length + (tasks.length === 1 ? ' task' : ' tasks') + ' left today') : L('✓ সব কাজ শেষ', '✓ All done');
    C.dataset.n = String(tasks.length);
    var U = $('tdUrgent'); U.className = 'td-urgent ' + (top1 ? top1.state : 'done');
    U.textContent = top1 ? ICON[top1.state] + ' ' + L('সবচেয়ে জরুরি: ', 'Most urgent: ') + top1.title + (top1.state === 'late' ? ' — ' + top1.sub : '')
                         : L('আজ কোনো কাজ বাকি নেই ✓', 'Nothing is waiting today ✓');

    // System health
    var H = $('tdHealth'); H.innerHTML = '';
    healthItems(D).forEach(function (h) {
      var bad = h.st === 'warn' || h.st === 'late';
      var row = el(bad && h.help ? 'button' : 'div', null, 'tdh'); if (row.tagName === 'BUTTON') row.type = 'button';
      row.appendChild(el('span', h.label));
      var v = el('b', null, h.st);
      v.appendChild(document.createTextNode((h.st === 'ok' ? '✓ ' : h.st === 'warn' ? '⚠ ' : h.st === 'late' ? '⏰ ' : '') + (h.v || rel(h.at).split(' · ')[0])));
      if (!h.v && h.at) v.appendChild(el('small', fmtDay(h.at)));
      row.appendChild(v); H.appendChild(row);
      if (!(bad && h.help)) return;
      row.title = L('কী করতে হবে দেখতে চাপুন', 'Click to see what to do');
      var help = el('div', null, 'tdhelp hidden'); help.appendChild(el('div', h.help));
      if (h.tab) { var b = el('button', L('খুলুন →', 'Open →'), 'btn-light btn-small'); b.type = 'button'; b.addEventListener('click', function () { go(h.tab); }); help.appendChild(b); }
      H.appendChild(help);
      row.addEventListener('click', function () { help.classList.toggle('hidden'); });
    });

    // Money waiting (also fills the space under System health)
    var M = $('tdMoney'); M.innerHTML = '';
    var p = pp || {};
    var showM = !!pp && p.send != null && (p.send > 0 || p.sent > 0);
    M.classList.toggle('hidden', !showM);
    if (showM) {
      M.appendChild(el('h2', L('💰 Payment-এর অপেক্ষায়', '💰 Waiting for payment')));
      M.appendChild(el('div', p.sendAmt || !p.send ? money(p.sendAmt) : '—', 'big'));
      var s1 = el('div', null, 'sm'); s1.appendChild(el('b', cnt(p.send, 'WL', 'WL'))); s1.appendChild(document.createTextNode(' · ' + L('Send for payment বাকি', 'not sent for payment yet'))); M.appendChild(s1);
      var s2 = el('div', null, 'sm'); s2.appendChild(document.createTextNode(L('গত 7 দিনে পাঠানো: ', 'Sent in the last 7 days: '))); s2.appendChild(el('b', money(p.sentAmt) + ' · ' + cnt(p.sent || 0, 'WL', 'WL'))); M.appendChild(s2);
    }
  }

  // keys 1–6 on the Today page open that step's page (not while typing)
  var todayFlow = [];
  document.addEventListener('keydown', function (e) {
    if (current !== 'today' || e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target, tg = t && t.tagName;
    if (tg === 'INPUT' || tg === 'TEXTAREA' || tg === 'SELECT' || (t && t.isContentEditable)) return;
    if (document.querySelector('.modal.show,.ask.show,.wdrawer.show,#srchBox:not(.hidden)')) return;
    var k = Number(e.key); if (!(k >= 1 && k <= 6) || !todayFlow[k - 1]) return;
    e.preventDefault(); go(todayFlow[k - 1].tab);
  });
  [].forEach.call($('tdLang').querySelectorAll('button'), function (b) { b.classList.toggle('on', b.dataset.l === lang); });
  $('tdTodoH').textContent = L('আপনার জন্য অপেক্ষা', 'Waiting for you');

  /* ------------------------------ start page ------------------------------ */
  // Today shows at once; a page named in the URL (#photos …) opens when the GP list has loaded
  var start = (location.hash || '').replace('#', '');
  onTab('today');
  fillGlobal();
  function openStart() {
    if (start && start !== 'today' && tabBtn(start)) go(start); else loadToday();
  }
})();
