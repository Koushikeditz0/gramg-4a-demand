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
    if (g.head && !g.head.classList.contains('tab')) {
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
    box.classList.toggle('hidden', !many);
    pills.innerHTML = '';
    if (!many) return;
    $('subCrumb').textContent = g.title;
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
  var PAGE_GP = { dash: 'dashGp', photos: 'phGp', marks: 'mkGp', pmiss: 'pmGp', pipeline: 'ppGp', wlcaste: 'wcGp', masters: 'msGp', signup: 'suGp', import: 'gpSelect' };
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

  /* ------------------------------ folded help text ------------------------------ */
  // long grey explanations at the top of a card fold into "ⓘ How it works"
  [].forEach.call(document.querySelectorAll('main section .card > .muted:not([id])'), function (m) {
    if (m.textContent.trim().length < 170 || /keep it safe|⚠/i.test(m.textContent)) return;   // safety warnings stay open
    var d = el('details', null, 'help'); var s = el('summary', 'ⓘ How it works');
    m.parentNode.insertBefore(d, m); d.appendChild(s); d.appendChild(m);
  });

  /* ------------------------------ Today page ------------------------------ */
  function q(p) { return p.then(function (x) { return x; }, function () { return null; }); }
  function fmtDay(s) { if (!s) return ''; var d = new Date(s); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function age(s) { return s ? (Date.now() - new Date(s).getTime()) / 864e5 : Infinity; }
  function money(n) { return '₹' + Math.round(Number(n || 0)).toLocaleString('en-IN'); }
  var tdSeq = 0;
  function loadToday() {
    var g = gpId(); if (!g) return;
    var seq = ++tdSeq;
    var who = ($('who').textContent || '').trim();
    $('tdHello').textContent = 'নমস্কার' + (who && who !== '…' ? ', ' + who.split(' ')[0] : '');
    $('tdSub').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) + ' · ' + gpName() + ' · loading…';
    Promise.all([
      q(SB.rpc('admin_dashboard', { p_gp_id: g }, { retry: true })),
      window.AdminPipeline ? q(window.AdminPipeline.summary(g)) : Promise.resolve(null),
      q(SB.rpc('admin_count_account_requests', { p_gp_id: g })),
      q(SB.rpc('admin_account_photos', { p_gp_id: g, p_status: 'new' })),
      q(SB.rpc('admin_marks_list', { p_gp_id: g, p_filter: 'new' })),
      q(SB.rpc('admin_portal_missing', { p_gp_id: g })),
      q(SB.rpc('admin_data_status', { p_gp_id: g })),
      q(SB.rpc('db_version'))
    ]).then(function (r) { if (seq === tdSeq) renderToday(r); });
  }
  $('tdRefresh').addEventListener('click', loadToday);

  function renderToday(r) {
    var users = r[0] || [], pp = r[1], login = Number(r[2]) || 0, photos = (r[3] && r[3].new_count) || 0;
    var marks = ((r[4] && r[4].counts) || {}).new || 0, held = ((r[5] && r[5].held) || []).length, ds = r[6] || {}, db = r[7] || {};
    var lists = [], noList = 0;
    users.forEach(function (u) { if (!(u.lists || []).length) noList++; (u.lists || []).forEach(function (l) { lists.push(l); }); });
    var sub = lists.filter(function (l) { return l.submit_state === 'submitted'; }).length;
    var draft = lists.filter(function (l) { return l.submit_state === 'draft'; }).length;

    // ① … ⑥ work flow
    var F = $('tdFlow'); F.innerHTML = '';
    function card(n, val, of, label, note, kind, tab) {
      var c = el('button', null, 'tdf ' + (kind || '')); c.type = 'button';
      c.appendChild(el('span', String(n), 'tdn'));
      var b = el('b', val == null ? '—' : String(val)); if (of != null) b.appendChild(el('small', '/' + of)); c.appendChild(b);
      c.appendChild(el('div', label, 'tdl')); c.appendChild(el('div', note || '', 'tds'));
      c.addEventListener('click', function () { go(tab); });
      F.appendChild(c);
    }
    var p = pp || {};
    card(1, sub, lists.length, 'Lists submitted', draft ? draft + ' draft' : 'no draft', draft ? 'warn' : 'good', 'dash');
    card(2, p.fill, null, 'MR to fill', pp ? (p.fillPbaOnly ? 'PBA only' : 'period ended') : 'pipeline not ready', p.fill ? 'bad' : 'good', 'pipeline');
    card(3, p.emb, null, 'e-MB / AE verify', p.emb == null ? 'needs MR report' : 'MRs', p.emb ? 'warn' : '', 'pipeline');
    card(4, p.gen, null, 'WL not generated', p.gen == null ? 'K-Desk not read yet' : 'works', p.gen ? 'warn' : 'good', 'pipeline');
    card(5, p.send, null, 'Send for payment', p.send == null ? 'K-Desk not read yet' : (p.sendAmt ? money(p.sendAmt) : 'WLs'), p.send ? 'warn' : 'good', 'pipeline');
    card(6, p.sent, null, 'Sent · 7 days', 'WLs', 'good', 'pipeline');

    // waiting for you
    var T = $('tdTodo'); T.innerHTML = '';
    var todo = [
      [login, '🙋', login + ' supervisor login request' + (login === 1 ? '' : 's'), 'Team & Access → Login requests', 'signup'],
      [photos, '📷', photos + ' account cop' + (photos === 1 ? 'y' : 'ies') + ' to check', 'Photos are deleted after 30 days', 'photos'],
      [marks, '🗑', marks + ' Expired / Migrant mark' + (marks === 1 ? '' : 's'), 'Accept or Return', 'marks'],
      [held, '🚫', held + ' ABPS sync held', 'Workers not found on the portal · Apply or Ignore', 'pmiss'],
      [draft, '📝', draft + ' list' + (draft === 1 ? '' : 's') + ' still draft', sub + ' submitted' + (noList ? ' · ' + noList + ' supervisor(s) without a list' : ''), 'dash']
    ].filter(function (x) { return x[0] > 0; });
    if (!todo.length) T.appendChild(el('div', '✓ Nothing is waiting. সব কাজ শেষ।', 'tdempty'));
    todo.forEach(function (x) {
      var row = el('button', null, 'tdrow'); row.type = 'button';
      row.appendChild(el('span', x[1], 'tde'));
      var t = el('span', null, 'tdt'); t.appendChild(el('b', x[2])); t.appendChild(el('small', x[3])); row.appendChild(t);
      row.appendChild(el('span', 'Open', 'tdgo'));
      row.addEventListener('click', function () { go(x[4]); });
      T.appendChild(row);
    });
    $('tdSub').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) + ' · ' + gpName() +
      ' · ' + (todo.length ? 'আজ ' + todo.length + 'টা কাজ বাকি' : 'কিছু বাকি নেই');

    // system health
    var H = $('tdHealth'); H.innerHTML = '';
    function line(label, val, bad) { var d = el('div', null, 'tdh'); d.appendChild(el('span', label)); d.appendChild(el('b', val, bad ? 'warn' : 'ok')); H.appendChild(d); }
    function when(at, days) { return { v: at ? fmtDay(at) + (age(at) > days ? ' (old)' : '') : 'never', bad: age(at) > days }; }
    var need = 224;
    line('Database version', db.version ? 'v' + db.version + (db.version >= need ? ' ✓' : ' (old)') : 'unknown', !db.version || db.version < need);
    var a = when(ds.last_sync && ds.last_sync.at, 7); line('ABPS Sync (K-Desk)', a.v, a.bad);
    if (ds.last_import) { a = when(ds.last_import.at, 3650); line('Excel import', a.v, false); }
    if (pp) {
      a = when(p.at.rep, 2); line('MR-wise report (Pi / Tampermonkey)', a.v, a.bad);
      a = when(p.at.gen, 2); line('K-Desk read Generate Wagelist', a.v, a.bad);
      a = when(p.at.send, 2); line('K-Desk read Send for payment', a.v, a.bad);
      a = when(p.at.iay, 2); line('IAY Tracker report', a.v, a.bad);
    }
  }

  /* ------------------------------ start page ------------------------------ */
  // Today shows at once; a page named in the URL (#photos …) opens when the GP list has loaded
  var start = (location.hash || '').replace('#', '');
  onTab('today');
  fillGlobal();
  function openStart() {
    if (start && start !== 'today' && tabBtn(start)) go(start); else loadToday();
  }
})();
