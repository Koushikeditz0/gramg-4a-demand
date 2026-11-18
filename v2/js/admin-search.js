// Admin: 🔍 search (Ctrl+K / "/") and the worker drawer (SQL v225: admin_find, admin_worker_card).
(function () {
  'use strict';
  var SB = window.GramgSB;
  function $(id) { return document.getElementById(id); }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  if (!SB || !$('gGp')) return;

  var NEED = 'Search needs SQL v225 (supabase/2026-11-18_admin_search_worker_card_v225.sql). Run it in the Supabase SQL Editor.';
  function gp() { return Number($('gGp').value) || null; }
  function missing(e) { return e && (e.status === 404 || /admin_find|admin_worker_card|PGRST202/.test((e.code || '') + (e.message || ''))); }
  function day(s) { if (!s) return ''; var d = new Date(s); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }); }
  function go(tab) { var b = document.querySelector('.tab[data-tab="' + tab + '"]'); if (b) b.click(); }

  /* ------------------------------ search box ------------------------------ */
  var box = el('div', null, 'srch-dim hidden'); box.id = 'srchBox';
  box.innerHTML = '<div class="srch" role="dialog" aria-label="Search"><div class="srch-in"><span>🔍</span>' +
    '<input id="srchQ" type="search" autocomplete="off" placeholder="Job Card, name, work code, list, MR or WL No…"><kbd>Esc</kbd></div>' +
    '<div class="srch-res" id="srchRes"></div><div class="srch-foot">↑↓ choose · Enter open · Ctrl+K anywhere</div></div>';
  document.body.appendChild(box);
  var items = [], pick = 0, seq = 0, timer = null;

  function open() {
    if (!gp()) return;
    box.classList.remove('hidden'); $('srchQ').value = ''; render(null); setTimeout(function () { $('srchQ').focus(); }, 0);
  }
  function close() { box.classList.add('hidden'); }
  window.AdminSearch = { open: open };
  box.addEventListener('click', function (e) { if (e.target === box) close(); });
  document.addEventListener('keydown', function (e) {
    var typing = /INPUT|TEXTAREA|SELECT/.test((e.target || {}).tagName || '');
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); open(); return; }
    if (e.key === '/' && !typing && box.classList.contains('hidden')) { e.preventDefault(); open(); return; }
    if (box.classList.contains('hidden')) { if (e.key === 'Escape') closeDrawer(); return; }
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pick = Math.max(0, Math.min(items.length - 1, pick + (e.key === 'ArrowDown' ? 1 : -1))); mark(); }
    if (e.key === 'Enter' && items[pick]) { e.preventDefault(); items[pick].act(); }
  });
  $('srchQ').addEventListener('input', function () {
    clearTimeout(timer);
    var q = this.value.trim();
    if (q.length < 2) { render(null); return; }
    timer = setTimeout(function () { find(q); }, 250);
  });
  function find(q) {
    var my = ++seq;
    $('srchRes').innerHTML = '<div class="srch-msg">Searching…</div>';
    SB.rpc('admin_find', { p_gp_id: gp(), p_q: q }).then(function (r) { if (my === seq) render(r || {}); },
      function (e) { if (my !== seq) return; $('srchRes').innerHTML = ''; $('srchRes').appendChild(el('div', missing(e) ? NEED : 'Could not search: ' + (e.message || e.code), 'srch-msg')); });
  }
  function render(r) {
    var R = $('srchRes'); R.innerHTML = ''; items = []; pick = 0;
    if (!r) { R.appendChild(el('div', 'Type at least 2 letters. Searches this Gram Panchayat only.', 'srch-msg')); return; }
    function group(title, list, row) {
      if (!list || !list.length) return;
      R.appendChild(el('div', title, 'srch-h'));
      list.forEach(function (x) {
        var o = row(x), b = el('button', null, 'srch-it'); b.type = 'button';
        var l = el('span', null, 'l'); l.appendChild(el('b', o.t)); if (o.s) l.appendChild(el('small', o.s));
        b.appendChild(l); b.appendChild(el('span', o.r || '', 'r'));
        var it = { b: b, act: function () { close(); o.act(); } };
        b.addEventListener('click', it.act); b.addEventListener('mousemove', function () { pick = items.indexOf(it); mark(); });
        items.push(it); R.appendChild(b);
      });
    }
    group('Workers', r.workers, function (w) {
      return { t: w.name + (w.active ? '' : ' (inactive)'), s: w.job_card_no + ' · App ' + w.applicant_no,
               r: String(w.village_no).padStart(3, '0') + (w.village ? ' · ' + w.village : ''), act: function () { openDrawer(w.id); } };
    });
    group('Works', r.works, function (w) { return { t: w.name, s: w.code, r: 'Payment pipeline', act: function () { go('pipeline'); } }; });
    group('Lists', r.lists, function (l) { return { t: l.work_name || 'List', s: (l.full_name || l.username || '') + (l.work_code ? ' · ' + l.work_code : ''), r: l.state || '', act: function () { go('dash'); } }; });
    group('MR / Wage list', r.mrs, function (m) { return { t: 'MR ' + m.mr_no + (m.wl_no ? ' · ' + m.wl_no : ''), s: (m.name || '') + ' · ' + day(m.from) + '–' + day(m.to), r: m.filled ? 'filled' : 'not filled', act: function () { go('pipeline'); } }; });
    if (!items.length) R.appendChild(el('div', 'Nothing found.', 'srch-msg'));
    mark();
  }
  function mark() { items.forEach(function (x, i) { x.b.classList.toggle('on', i === pick); if (i === pick) x.b.scrollIntoView({ block: 'nearest' }); }); }

  /* ------------------------------ worker drawer ------------------------------ */
  var dr = el('aside', null, 'wdrawer'); dr.id = 'wDrawer'; dr.setAttribute('aria-label', 'Worker');
  var shade = el('div', null, 'wshade'); shade.addEventListener('click', closeDrawer);
  document.body.appendChild(shade); document.body.appendChild(dr);
  function closeDrawer() { dr.classList.remove('show'); shade.classList.remove('show'); }
  function sec(title) { var s = el('div', null, 'wsec'); s.appendChild(el('h4', title)); dr.appendChild(s); return s; }
  function kv(s, k, v, cls) { var d = el('div', null, 'wkv'); d.appendChild(el('span', k)); d.appendChild(el('b', v == null || v === '' ? '—' : String(v), cls || '')); s.appendChild(d); }
  function tag(t, kind) { return el('span', t, 'stag ' + (kind || '')); }

  function openDrawer(id) {
    var g = gp(); if (!g) return;
    dr.innerHTML = ''; dr.appendChild(el('div', 'Loading…', 'muted'));
    dr.classList.add('show'); shade.classList.add('show');
    SB.rpc('admin_worker_card', { p_gp_id: g, p_worker_id: id }).then(draw, function (e) {
      dr.innerHTML = ''; head('Worker', ''); dr.appendChild(el('div', missing(e) ? NEED : 'Could not load: ' + (e.message || e.code), 'muted'));
    });
  }
  window.AdminSearch.openWorker = openDrawer;

  // a Job Card number in any table → that worker (or the search, when the Job Card has several people)
  var JC = /WB-\d{2}-\d{3}-\d{3}-\d{3}\/\d{1,4}/i;
  document.addEventListener('click', function (e) {
    var td = e.target && e.target.closest && e.target.closest('main td');
    if (!td || e.target.closest('button,a,input,select,label') || !gp()) return;
    var m = JC.exec(td.textContent || ''); if (!m) return;
    var rowText = (td.parentNode.textContent || '').toUpperCase();
    SB.rpc('admin_find', { p_gp_id: gp(), p_q: m[0] }).then(function (r) {
      var ws = ((r && r.workers) || []).filter(function (w) { return w.job_card_no.toUpperCase() === m[0].toUpperCase(); });
      var one = ws.length === 1 ? ws[0] : ws.filter(function (w) { return rowText.indexOf(String(w.name || '').toUpperCase()) >= 0; })[0];
      if (one) openDrawer(one.id); else { open(); $('srchQ').value = m[0]; find(m[0]); }
    }, function () {});
  });
  function head(t, s) {
    var h = el('div', null, 'whead'), l = el('div');
    l.appendChild(el('h2', t)); if (s) l.appendChild(el('div', s, 'muted'));
    var x = el('button', '✕', 'btn-light btn-small'); x.addEventListener('click', closeDrawer);
    h.appendChild(l); h.appendChild(x); dr.appendChild(h);
  }
  function draw(d) {
    var w = d.worker || {};
    dr.innerHTML = '';
    head(w.name || 'Worker', w.job_card_no + ' · App ' + w.applicant_no + ' · ' + String(w.village_no).padStart(3, '0') + (w.village ? ' · ' + w.village : ''));
    var tags = el('div', null, 'wtags');
    tags.appendChild(w.active ? tag('Active', 'good') : tag('Inactive' + (w.inactive_reason === 'portal_missing' ? ' · not on portal' : ''), 'bad'));
    tags.appendChild(tag('eKYC ' + (w.ekyc ? '✓' : '✗'), w.ekyc ? 'good' : 'warn'));
    tags.appendChild(tag('ABPS ' + (w.abps ? '✓' : '✗'), w.abps ? 'good' : 'warn'));
    if (w.keep_active) tags.appendChild(tag('Kept active', 'info'));
    dr.appendChild(tags);

    var a = d.account, s = sec('Bank account');
    if (a) { kv(s, 'A/c', a.account_no); kv(s, 'IFSC', a.ifsc); if (a.bank) kv(s, 'Bank', a.bank); kv(s, 'From', (a.source || '') + (a.updated_at ? ' · ' + day(a.updated_at) : '')); }
    else s.appendChild(el('div', 'No account in the data.', 'muted wwarn'));
    (d.photos || []).forEach(function (p) {
      kv(s, 'Account copy ' + day(p.at), p.status === 'done' ? 'Verified' : p.status === 'returned' ? 'Returned' + (p.reason ? ': ' + p.reason : '') : p.status,
         p.status === 'done' ? 'ok' : p.status === 'returned' ? 'bad' : 'warn');
    });

    s = sec('Demand lists');
    if (!(d.lists || []).length) s.appendChild(el('div', 'Not in any list.', 'muted'));
    (d.lists || []).forEach(function (l) {
      var r = el('div', null, 'wlist');
      var t = el('div'); t.appendChild(el('b', l.work_name || 'List'));
      t.appendChild(el('small', (l.username || '') + (l.work_code ? ' · ' + l.work_code : '') + (l.from_date ? ' · from ' + day(l.from_date) + (l.work_days ? ', ' + l.work_days + ' days' : '') : '') +
                                 (l.list_status === 'archived' ? ' · old round' : '') + (l.in_list === false ? ' · removed from list' : '')));
      r.appendChild(t);
      var st = el('div', null, 'wst');
      st.appendChild(tag(l.state || '', l.state === 'submitted' ? 'good' : l.state === 'draft' ? 'warn' : ''));
      if (l.demand) st.appendChild(tag('Demand ' + l.demand, /ok|done|success/i.test(l.demand) ? 'good' : 'bad'));
      if (l.alloc) st.appendChild(tag('Alloc ' + l.alloc, /ok|done|success/i.test(l.alloc) ? 'good' : 'bad'));
      r.appendChild(st); s.appendChild(r);
    });

    if ((d.pba || []).length) {
      s = sec('PBA (IAY) work of this Job Card');
      d.pba.forEach(function (p) { kv(s, p.work_code, (p.status || '') + ' · ' + p.mrs + ' MR' + (p.wl_no ? ' · ' + p.wl_no : '')); });
    }
    if ((d.marks || []).length) {
      s = sec('Expired / Migrant marks');
      d.marks.forEach(function (m) { kv(s, m.reason + ' · ' + day(m.at), m.status + (m.admin_note ? ' · ' + m.admin_note : ''), m.status === 'returned' ? 'ok' : 'warn'); });
    }
    if ((d.household || []).length) {
      s = sec('Same Job Card');
      d.household.forEach(function (h) {
        var b = el('button', 'App ' + h.applicant_no + ' · ' + h.name + (h.active ? '' : ' (inactive)'), 'wlink'); b.type = 'button';
        b.addEventListener('click', function () { openDrawer(h.id); }); s.appendChild(b);
      });
    }
    s = sec('Data');
    kv(s, 'Added', day(w.created_at)); kv(s, 'Last change', day(w.updated_at));
    if (!w.active) kv(s, 'Inactive since', day(w.inactive_at), 'bad');
    dr.appendChild(el('div', 'MR / wage list per worker is not in Gram Setu yet: the MR report is per work.', 'muted wfoot'));
  }
})();
