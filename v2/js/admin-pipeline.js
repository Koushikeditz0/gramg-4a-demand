/* =====================================================================
   Admin panel — "💸 Pipeline" tab (SQL v217).
   Where the money is stuck, per GP:
     ① MR fill due        PBA MRs ended but not filled (IAY Tracker)
     ② Wage List pending  works on the portal's Generate Wagelist page (K-Desk saw them)
     ③ Send pending       wage lists on the portal's Send Wagelist For Payment page
     ④ Sent               wage lists K-Desk sent for payment (last 7 days)
     ⑤ Paid / Rejected    not connected yet (needs the portal's payment status page)
   plus every live demand list with its Demand / Allocation result and the step its work is at now.
   Kept in its own file so admin.js stays as it is.
   ===================================================================== */
(function () {
  'use strict';
  var SB = window.GramgSB;
  function $(id) { return document.getElementById(id); }
  if (!$('tab-pipeline') || !SB) return;

  var COLORS = ['#f59e0b', '#ec4899', '#8b5cf6', '#3b82f6', '#22c55e'];
  var pp = { gp: null, data: null, mode: 'all', open: '' };

  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function loading(text) { $('loadingText').textContent = text || 'Loading...'; $('loading').classList.toggle('show', !!text); }
  function status(msg, kind) { var s = $('status'); s.textContent = msg || ''; s.className = 'status' + (msg ? ' show ' + (kind || 'info') : ''); if (msg) window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function missing(e) { return e && (e.status === 404 || /admin_pipeline/.test(e.message || '')); }
  function errText(e) {
    if (missing(e)) return 'Run supabase/2026-11-16_payment_pipeline_v217.sql in Supabase → SQL Editor first.';
    var map = { NOT_AUTHORIZED: 'You are not allowed to do this.', NETWORK: 'Could not reach the server. Check the internet connection.' };
    return map[e && e.code] || (e && e.message) || String(e);
  }
  function money(n) { return '₹' + Math.round(Number(n || 0)).toLocaleString('en-IN'); }
  function fmtAt(s) { if (!s) return '—'; var d = new Date(s); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function fmtDay(s) { if (!s) return '—'; var d = new Date(s); return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); }
  function ageDays(s) { return s ? (Date.now() - new Date(s).getTime()) / 864e5 : Infinity; }
  function shortCode(c) { return String(c || '').replace(/^\d{10}\//, '…/'); }
  function shortWl(w) { return String(w || '').replace(/^\d+WL/i, 'WL'); }
  function isPba(code) { return /\/IAY\//i.test(code || ''); }
  function copyGps(dstId) {
    var src = $('phGp'), dst = $(dstId), keep = dst.value;
    dst.innerHTML = src.innerHTML; dst.disabled = src.disabled;
    dst.value = keep || src.value; if (!dst.value) dst.value = src.value;
  }
  function gp() { return Number($('ppGp').value) || null; }

  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () {
      var on = b.dataset.tab === 'pipeline';
      $('tab-pipeline').classList.toggle('hidden', !on);
      if (on) { copyGps('ppGp'); load(); }
    });
  });
  $('ppGp').addEventListener('change', load);

  // Today page (admin-shell.js): the same step numbers for one GP, All works, without touching this tab
  window.AdminPipeline = {
    summary: function (g) {
      var mrs = SB.rpc('admin_pipeline_mrs', { p_gp_id: g }).then(function (x) { return x || null; }, function () { return null; });
      return SB.rpc('admin_pipeline', { p_gp_id: g }).then(function (d) {
        return mrs.then(function (r) {
          (d = d || {}).mrRep = r;
          var m = model(d, 'all'), rep = m.rep, iay = m.iay;
          // Today page: the oldest "MR period ended" date, for "period শেষ N দিন আগে"
          var fillOldest = null;
          m.mrRows.forEach(function (x) { if ((x.s === 'fill_pending' || x.s === 'fill_today') && x.to && (!fillOldest || x.to < fillOldest)) fillOldest = x.to; });
          return {
            fill: rep ? m.cnt('fill_today') + m.cnt('fill_pending') : (iay.fill_due || 0), fillPbaOnly: !rep,
            fillToday: rep ? m.cnt('fill_today') : (iay.fill_today || 0), fillOldest: fillOldest,
            emb: rep ? m.cnt('emb') + m.cnt('verify') : null,
            gen: m.gen.at ? m.gen.items.length : null,
            send: m.send.at ? m.send.items.length : null,
            sendAmt: sum(m.send.items, function (x) { return x.amt; }),
            sent: m.sent.length, sentAmt: sum(m.sent, function (x) { return x.amt; }),
            at: { rep: rep && typeof rep.at === 'string' ? rep.at : null, gen: m.gen.at, send: m.send.at, iay: iay.report_at }
          };
        });
      });
    }
  };
  $('ppRefresh').addEventListener('click', load);
  [].forEach.call($('ppMode').querySelectorAll('button'), function (b) {
    b.addEventListener('click', function () {
      pp.mode = b.dataset.m;
      [].forEach.call($('ppMode').querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
      render();
    });
  });

  function load() {
    var g = gp(); if (!g) return;
    pp.gp = g; loading('Loading pipeline...');
    // v220: MR-wise report (R4.2 + R4.4) — optional, ignored when the SQL is not run yet
    var mrs = SB.rpc('admin_pipeline_mrs', { p_gp_id: g }).then(function (x) { return x || null; }, function () { return null; });
    SB.rpc('admin_pipeline', { p_gp_id: g }).then(function (d) {
      return mrs.then(function (r) { (d = d || {}).mrRep = r; return d; });
    }).then(function (d) {
      loading(''); if (pp.gp !== g) return;
      $('ppSetup').textContent = ''; pp.data = d || {}; render();
    }, function (e) {
      loading(''); pp.data = null; render();
      if (missing(e)) { $('ppSetup').textContent = '⚠ ' + errText(e); return; }
      if (!e || !e.authLost) status(errText(e), 'err');
    });
  }

  /* ---------------------- working out each step ---------------------- */
  function model(data, mode) {
    mode = mode || pp.mode;
    var d = data || pp.data || {}, pba = mode === 'pba', other = mode === 'other';
    function want(isP) { return pba ? !!isP : other ? !isP : true; }   // All / PBA / Other
    var wls = d.wls || [], byWl = {}, byCode = {}, pbaWl = {};
    (d.pba_wls || []).forEach(function (w) { pbaWl[String(w).toUpperCase()] = 1; });   // v218: PBA by WL number
    function wlPba(wl, code) { return isPba(code) || !!pbaWl[String(wl || '').toUpperCase()]; }
    wls.forEach(function (w) {
      var k = String(w.wl).toUpperCase(); byWl[k] = w;
      if (w.code) (byCode[String(w.code).toUpperCase()] = byCode[String(w.code).toUpperCase()] || []).push(w);
    });
    var gen = { items: [], at: null, scopes: [] }, send = { items: [], at: null, scopes: [] };
    (d.snaps || []).forEach(function (s) {
      var t = s.kind === 'wl_gen' ? gen : send;
      t.scopes.push({ scope: s.scope, at: s.at, n: s.n });
      if (!t.at || s.at > t.at) t.at = s.at;
      (s.items || []).forEach(function (x) { t.items.push(Object.assign({ scope: s.scope }, x)); });
    });
    gen.items = gen.items.filter(function (x) { return want(isPba(x.code)); });
    send.items = send.items.map(function (x) {
      var w = byWl[String(x.wl).toUpperCase()] || {};
      var c = (d.wl_caste || {})[String(x.wl).toUpperCase()] || {};     // v219: amount from ⚖ WL Caste
      var r = ((d.mrRep || {}).wl_code || {})[String(x.wl).toUpperCase()] || {};   // v221: work code from the MR-wise report
      var o = Object.assign({ code: w.code || r.code || '', name: r.name || '', date: w.date || c.date || '', n: w.n != null ? w.n : c.n }, x);
      if (o.amt == null && c.amt != null) { o.amt = Number(c.amt); o.amtFrom = 'wlc'; }
      return o;
    }).map(function (x) { x.pba = wlPba(x.wl, x.code); return x; }).filter(function (x) { return want(x.pba); });
    var weekAgo = Date.now() - 7 * 864e5;
    var sent = wls.filter(function (w) { return w.stage === 'sent' && w.sent_at && new Date(w.sent_at).getTime() >= weekAgo && want(wlPba(w.wl, w.code)); });
    // MR-wise report: rows still to move, filtered by mode; per work code the earliest open stage
    var rep = d.mrRep || null, mrRows = [], mrByCode = {}, ORDER = { emb: 1, verify: 2, fill_pending: 3, fill_today: 3, wl_pending: 4 };   // v238: e-MB → verify → fill → WL
    if (rep) {
      mrRows = (rep.rows || []).filter(function (x) { return want(isPba(x.code)); });
      (rep.rows || []).forEach(function (x) { var k = String(x.code).toUpperCase(); if (!mrByCode[k] || ORDER[x.s] < ORDER[mrByCode[k]]) mrByCode[k] = x.s; });
    }
    function cnt(st) { var c = rep && rep.counts && rep.counts[st]; return c ? (pba ? c.pba || 0 : other ? (c.all || 0) - (c.pba || 0) : c.all || 0) : 0; }
    return { d: d, iay: d.iay || {}, rep: rep, mrRows: mrRows, mrByCode: mrByCode, cnt: cnt, gen: gen, send: send, sent: sent, byWl: byWl, byCode: byCode };
  }

  function sum(a, f) { return a.reduce(function (t, x) { return t + (Number(f(x)) || 0); }, 0); }

  function render() {
    var stepsBox = $('ppSteps'), bar = $('ppBar');
    stepsBox.innerHTML = ''; bar.innerHTML = ''; $('ppBarText').textContent = ''; $('ppFresh').innerHTML = ''; $('ppLists').innerHTML = '';
    if (!pp.data) return;
    var m = model(), iay = m.iay;
    var held = m.gen.items.filter(function (x) { return x.held > 0; });
    var sendAmt = sum(m.send.items, function (x) { return x.amt; }), sendKnown = m.send.items.filter(function (x) { return x.amt != null; }).length;
    var sentAmt = sum(m.sent, function (x) { return x.amt; });
    var iayWhen = iay.report_at ? ' · IAY Tracker ' + fmtDay(iay.report_at) : '';

    var rep = m.rep, repWhen = rep ? ' · MR report ' + fmtAt(rep.at) : '';
    var wlAmt = sum(m.mrRows.filter(function (x) { return x.s === 'wl_pending'; }), function (x) { return x.tot; });
    var steps = [
      // v238: Running → e-MB / verify → MR fill → WL (Koushik). Count only: running MR rows are not sent to the page.
      rep
        ? { key: 'running', n: m.cnt('running'), unit: 'MR', title: 'Running MR', color: '#64748b', noDetail: true,
            sub: 'MR period not ended yet' + repWhen }
        : { key: 'running', n: null, unit: '', title: 'Running MR', off: true, color: '#64748b',
            sub: 'Needs the MR-wise report (R4.2 + R4.4) sent to Gram Setu.' },
      rep
        ? { key: 'emb', n: m.cnt('emb') + m.cnt('verify'), unit: 'MR', title: 'e-MB / AE verification pending',
            sub: m.cnt('emb') + ' e-MB entry · ' + m.cnt('verify') + ' AE verification · must be done before the MR can be filled (not for PBA)' }
        : { key: 'emb', n: null, unit: '', title: 'e-MB / AE verification pending', off: true,
            sub: 'Needs the MR-wise report (R4.2 + R4.4) sent to Gram Setu.' },
      rep
        ? { key: 'fill', n: m.cnt('fill_today') + m.cnt('fill_pending'), unit: 'MR', title: 'MR fill pending',
            sub: 'e-MB verified (PBA: period ended), not filled' + (m.cnt('fill_today') ? ' · ' + m.cnt('fill_today') + ' end today' : '') +
                 (m.cnt('wl_pending') ? ' · ' + m.cnt('wl_pending') + ' filled MRs wait for a wage list' + (wlAmt ? ' (' + money(wlAmt) + ')' : '') : '') }
        : pp.mode === 'other'
        ? { key: 'fill', n: null, unit: '', title: 'MR fill pending', off: true,
            sub: 'Needs the MR-wise report (R4.2 + R4.4) sent to Gram Setu.' }
        : { key: 'fill', n: iay.fill_due || 0, unit: 'MR', title: 'MR fill pending' + (pp.mode === 'all' ? ' (PBA only)' : ''),
            sub: 'PBA MRs whose period has ended but are not filled' + (iay.fill_today ? ' · ' + iay.fill_today + ' end today' : '') + iayWhen +
                 (pp.mode === 'all' ? '. Other works show after the MR-wise report (R4.2 + R4.4) is sent to Gram Setu.' : '') },
      { key: 'gen', n: m.gen.at ? m.gen.items.length : null, unit: 'work', title: 'Wage List not generated',
        sub: (m.gen.at ? 'MR filled, no wage list yet (Generate Wagelist page)' + (held.length ? ' · ' + held.length + ' held back for accounts' : '')
                       : 'K-Desk has not read the Generate Wagelist page yet') +
             (iay.wl_wait && pp.mode !== 'other' ? ' · PBA: ' + iay.wl_wait + ' filled MRs waiting' + iayWhen : ''),
        bad: held.length > 0 },
      { key: 'send', n: m.send.at ? m.send.items.length : null, unit: 'WL', title: 'Send for payment pending',
        sub: m.send.at ? (sendKnown ? money(sendAmt) + (sendKnown < m.send.items.length ? ' (amount read for ' + sendKnown + ' of ' + m.send.items.length + ')' : '') : 'Amount not read yet — run K-Desk 🧪 Test run once')
                       : 'K-Desk has not read the Send Wagelist For Payment page yet' },
      { key: 'sent', n: m.sent.length, unit: 'WL', title: 'Sent for payment (last 7 days)',
        sub: m.sent.length ? money(sentAmt) + ' · by K-Desk Send run' : 'Wage lists K-Desk sends for payment show here' },
      { key: 'paid', n: null, unit: '', title: 'Paid / Rejected', off: true,
        sub: 'Not connected yet. Needs the portal page that shows paid and rejected payments (next step).' }
    ];

    // bar
    var flowSteps = steps.filter(function (s) { return s.key !== 'running' && s.key !== 'paid'; });
    var parts = flowSteps.map(function (s, i) { return { n: s.n || 0, c: COLORS[i], t: s.title }; });
    var tot = sum(parts, function (p) { return p.n; });
    parts.forEach(function (p) { if (!p.n) return; var i = el('i'); i.style.width = (p.n * 100 / tot) + '%'; i.style.background = p.c; i.title = p.t + ': ' + p.n; bar.appendChild(i); });
    $('ppBarText').textContent = tot ? flowSteps.map(function (s) { return (s.n == null ? '—' : s.n) + ' ' + s.unit; }).join(' · ') : 'Nothing to show yet.';

    steps.forEach(function (s, i) {
      var row = el('div', null, 'pp-step' + (s.off ? ' off' : '') + (pp.open === s.key ? ' open' : ''));
      var ci = flowSteps.indexOf(s);
      var dot = el('div', s.off ? '?' : s.key === 'sent' ? '✓' : String(i + 1), 'pp-dot');
      dot.style.background = s.off ? '#94a3b8' : s.color || COLORS[ci] || '#94a3b8';
      var tx = el('div', null, 'pp-txt'); tx.appendChild(el('b', s.title)); tx.appendChild(el('small', s.sub));
      var num = el('div', s.n == null ? '—' : String(s.n), 'pp-num');
      if (s.bad) num.style.color = '#b91c1c';
      if (s.n != null && s.unit) num.appendChild(el('small', s.unit + (s.n === 1 ? '' : 's')));
      row.appendChild(dot); row.appendChild(tx); row.appendChild(num);
      stepsBox.appendChild(row);
      if (s.off || s.noDetail) { if (s.noDetail) row.style.cursor = 'default'; return; }
      row.addEventListener('click', function () { pp.open = pp.open === s.key ? '' : s.key; render(); });
      if (pp.open === s.key) stepsBox.appendChild(detail(s.key, m));
    });

    // freshness
    var f = $('ppFresh'), lines = [];
    function seen(label, at) { var old = ageDays(at) > 2; return label + ': <span class="' + (old ? 'old' : '') + '">' + (at ? fmtAt(at) + (old ? ' (old)' : '') : 'never') + '</span>'; }
    lines.push(seen('K-Desk last read Generate Wagelist', m.gen.at));
    lines.push(seen('Send Wagelist For Payment', m.send.at));
    lines.push(seen('MR-wise report', rep && rep.at));
    lines.push(seen('IAY Tracker report', iay.report_at));
    f.innerHTML = lines.join(' · ') + '<br>To update: open those two portal pages with K-Desk (logged in to Gram Setu). Nothing is clicked on the portal; K-Desk only reads the lists.';

    renderLists(m);
  }

  function table(head, rows) {
    var wrap = el('div', null, 'table-wrap'); wrap.style.maxHeight = '320px'; wrap.style.background = '#fff';
    var t = el('table'), th = el('thead'), tr = el('tr'), tb = el('tbody');
    head.forEach(function (h) { tr.appendChild(el('th', h)); }); th.appendChild(tr); t.appendChild(th);
    rows.forEach(function (r) { var x = el('tr'); r.forEach(function (c) { var td = el('td'); if (c instanceof Node) td.appendChild(c); else td.textContent = c; x.appendChild(td); }); tb.appendChild(x); });
    t.appendChild(tb); wrap.appendChild(t); return wrap;
  }
  function tag(text, cls) { return el('span', text, 'pp-tag ' + (cls || '')); }

  function detail(key, m) {
    var box = el('div', null, 'pp-detail');
    var STXT = { fill_today: ['Ends today', 'bad'], fill_pending: ['Not filled', 'bad'], emb: ['e-MB pending', 't1'], verify: ['AE verify pending', 't2'], wl_pending: ['WL pending', 't3'] };
    function mrTable(keys) {
      var rows = m.mrRows.filter(function (x) { return keys.indexOf(x.s) >= 0; });
      if (!rows.length) { box.appendChild(el('div', 'Nothing here.', 'muted')); return box; }
      box.appendChild(table(['Work code', 'Work', 'MR', 'MR ended', 'Stage', 'Amount'], rows.slice(0, 800).map(function (x) {
        return [el('span', shortCode(x.code), 'pp-code'), x.name || '', x.mr, fmtDay(x.to), tag(STXT[x.s][0], STXT[x.s][1]), x.tot ? money(x.tot) : '—'];
      })));
      if (rows.length > 800) box.appendChild(el('div', 'First 800 of ' + rows.length + ' MRs.', 'muted'));
      return box;
    }
    if (key === 'fill' && m.rep) return mrTable(['fill_today', 'fill_pending', 'wl_pending']);
    if (key === 'emb') return mrTable(['emb', 'verify']);
    if (key === 'fill') {
      box.appendChild(el('div', 'The IAY tab has the MR-wise list (which MR, which beneficiary, fill date).', 'muted'));
      var b = el('button', '🏠 Open IAY tab', 'btn-light btn-small'); b.style.marginTop = '6px';
      b.addEventListener('click', function () { var t = document.querySelector('.tab[data-tab="iay"]'); if (t) t.click(); });
      box.appendChild(b); return box;
    }
    if (key === 'gen') {
      if (!m.gen.items.length) { box.appendChild(el('div', m.gen.at ? 'No work is waiting for a wage list.' : 'Open Generate Wagelist on the portal with K-Desk once.', 'muted')); return box; }
      box.appendChild(table(['Work code', 'Work', 'Note'], m.gen.items.map(function (x) {
        return [el('span', shortCode(x.code), 'pp-code'), x.name || '', x.held > 0 ? tag(x.held + ' held back · A/c', 'bad') : tag('WL pending', 't2')];
      })));
      return box;
    }
    if (key === 'send') {
      if (!m.send.items.length) { box.appendChild(el('div', m.send.at ? 'No wage list is waiting to be sent.' : 'Open Send Wagelist For Payment on the portal with K-Desk once.', 'muted')); return box; }
      box.appendChild(table(['Wage list', 'FY', 'Work code', 'Amount'], m.send.items.map(function (x) {
        return [shortWl(x.wl), x.scope || '', x.code ? el('span', shortCode(x.code), 'pp-code') : x.pba ? tag('PBA', 't1') : '—', x.amt != null ? money(x.amt) + (x.amtFrom === 'wlc' ? ' ⚖' : '') : '—'];
      })));
      if (m.send.items.some(function (x) { return x.amtFrom === 'wlc'; })) box.appendChild(el('div', '⚖ = amount taken from the WL Caste report of that wage list.', 'muted'));
      return box;
    }
    if (key === 'sent') {
      if (!m.sent.length) { box.appendChild(el('div', 'Nothing sent by K-Desk in the last 7 days.', 'muted')); return box; }
      box.appendChild(table(['Wage list', 'Work code', 'Amount', 'Sent'], m.sent.map(function (x) {
        return [shortWl(x.wl), x.code ? el('span', shortCode(x.code), 'pp-code') : '—', x.amt != null ? money(x.amt) : '—', fmtAt(x.sent_at)];
      })));
    }
    return box;
  }

  /* ---------------------- demand lists ---------------------- */
  function listStage(l, m) {
    var code = String(l.code || '').toUpperCase();
    if (!l.n) return tag('No workers', 'dim');
    if (!l.d_ok && !l.d_err) return tag('Demand pending', 'dim');
    if (!l.d_ok) return tag('Demand failed', 'bad');
    if (!l.a_ok) return tag(l.a_err ? 'Allocation failed' : 'Allocation pending', l.a_err ? 'bad' : 't1');
    if (!code) return tag('Allocated · no work code', 't1');
    var g = m.gen.items.filter(function (x) { return String(x.code).toUpperCase() === code; })[0];
    if (g && g.held > 0) return tag('WL held · ' + g.held + ' A/c', 'bad');
    if (g) return tag('MR filled · WL pending', 't2');
    var ms = m.mrByCode[code];
    if (ms === 'fill_pending' || ms === 'fill_today') return tag('MR fill pending', 'bad');
    if (ms === 'emb') return tag('e-MB pending', 't1');
    if (ms === 'verify') return tag('AE verify pending', 't2');
    if (ms === 'wl_pending') return tag('MR filled · WL pending', 't2');
    var ws = m.byCode[code] || [], inSend = {};
    m.send.items.forEach(function (x) { inSend[String(x.wl).toUpperCase()] = 1; });
    var waiting = ws.filter(function (w) { return w.stage !== 'sent' && inSend[String(w.wl).toUpperCase()]; });
    if (waiting.length) return tag('Send pending · ' + waiting.length + ' WL', 't3');
    var sent = ws.filter(function (w) { return w.stage === 'sent'; });
    if (sent.length) return tag('Sent · ' + money(sum(sent, function (w) { return w.amt; })), 't4');
    if (ws.length) return tag('WL generated', 't3');
    return tag('Work running · MR', 't1');
  }
  function renderLists(m) {
    var body = $('ppLists'), lists = (m.d.lists || []).filter(function (l) { return pp.mode === 'pba' ? isPba(l.code) : pp.mode === 'other' ? !isPba(l.code) : true; });
    if (!lists.length) { var tr = el('tr'), c = el('td', 'No demand list' + (pp.mode === 'pba' ? ' with a PBA work code.' : pp.mode === 'other' ? ' with a non-PBA work code.' : '.'), 'muted'); c.colSpan = 6; tr.appendChild(c); body.appendChild(tr); return; }
    lists.forEach(function (l) {
      var tr = el('tr');
      function td(v, label) { var c = el('td'); c.setAttribute('data-label', label); if (v instanceof Node) c.appendChild(v); else c.textContent = v; tr.appendChild(c); }
      var w = el('div'); w.appendChild(el('div', l.name || '(no name)')); if (l.code) w.appendChild(el('div', shortCode(l.code), 'pp-code'));
      td(w, 'Work');
      td(String(l.n || 0), 'Workers');
      td(l.d_ok || l.d_err ? l.d_ok + ' ✓' + (l.d_err ? ' · ' + l.d_err + ' ✗' : '') : '—', 'Demand');
      td(l.a_ok || l.a_err ? l.a_ok + ' ✓' + (l.a_err ? ' · ' + l.a_err + ' ✗' : '') : '—', 'Allocation');
      td(listStage(l, m), 'Now');
      td(fmtAt(l.r_at || l.at), 'Last update');
      body.appendChild(tr);
    });
  }
})();
