/* =====================================================================
   G RAM-G 4A v2 — IAY Dashboard card on the admin panel's first page (SQL v200 iay_dashboard).
   What it shows is decided by the database: a GP Admin always gets only their own GP,
   the Super Admin gets the whole block or the GP picked here / in the GP Admin view.
   admin.js calls IayDash.load({ gps: [{ id, name, jc_prefix }], fixedGpId, role }).
   ===================================================================== */
(function () {
  'use strict';
  var SB = window.GramgSB;
  var $ = function (id) { return document.getElementById(id); };
  var RATE_KEY = 'gramg2.iayRate', GP_KEY = 'gramg2.iayDashGp';
  var ctx = { gps: [], fixed: null, role: null }, last = null, busy = false;

  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function nf(n) { return Number(n || 0).toLocaleString('en-IN'); }
  function pct(a, b) { return b ? Math.round(1000 * a / b) / 10 : 0; }
  function when(ts) { if (!ts) return '—'; var d = new Date(ts); return d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function rate() { try { var v = parseFloat(localStorage.getItem(RATE_KEY)); return v > 0 ? v : 0; } catch (e) { return 0; } }
  function prefixOf(id) { var g = ctx.gps.filter(function (x) { return x.id === id; })[0]; return g ? g.jc_prefix : null; }

  function load(o) {
    if (o) { ctx.gps = o.gps || []; ctx.fixed = o.fixedGpId || null; ctx.role = o.role; }
    var card = $('iayDash'); if (!card) return Promise.resolve();
    var sel = $('idGp');
    // GP picker: GP Admin / GP Admin view = fixed; Super Admin = block or any GP
    sel.innerHTML = '';
    if (!ctx.fixed) { var o0 = el('option', 'All GPs (Block)'); o0.value = ''; sel.appendChild(o0); }
    ctx.gps.filter(function (g) { return !ctx.fixed || g.id === ctx.fixed; }).forEach(function (g) { var op = el('option', g.name); op.value = g.jc_prefix; sel.appendChild(op); });
    var keep = ''; try { keep = localStorage.getItem(GP_KEY) || ''; } catch (e) {}
    sel.value = ctx.fixed ? prefixOf(ctx.fixed) || '' : ([].some.call(sel.options, function (x) { return x.value === keep; }) ? keep : '');
    sel.disabled = !!ctx.fixed;
    $('idRate').value = rate() || '';
    return fetch();
  }
  function fetch() {
    if (busy) return Promise.resolve(); busy = true;
    $('idLine').textContent = 'Loading…';
    return SB.rpc('iay_dashboard', { p_jc_prefix: $('idGp').value || null }, { retry: true, timeout: 60000 }).then(function (d) {
      last = d; render();
    }).catch(function (e) {
      $('idLine').textContent = /iay_dashboard|PGRST202/.test((e.code || '') + (e.message || '')) ? 'IAY dashboard is not installed on the server yet (SQL v200).' : 'Could not load: ' + (e.message || e.code);
    }).then(function () { busy = false; });
  }

  function kpi(box, n, label, cls, sub) {
    var d = el('div', null, 'idk ' + (cls || ''));
    d.appendChild(el('div', n, 'n')); d.appendChild(el('div', label, 'l'));
    if (sub) d.appendChild(el('div', sub, 's'));
    box.appendChild(d);
  }
  function bar(parts) {   // [[value, color, title]]
    var tot = parts.reduce(function (s, p) { return s + p[0]; }, 0), b = el('div', null, 'idbar');
    parts.forEach(function (p) { if (!p[0]) return; var s = el('span'); s.style.width = (100 * p[0] / tot) + '%'; s.style.background = p[1]; s.title = p[2] + ': ' + nf(p[0]); b.appendChild(s); });
    return b;
  }

  function render() {
    var d = last; if (!d) return;
    var works = +d.works || 0, target = works * 90, doneMd = (+d.mr_done || 0) * 15, p = pct(doneMd, target);
    var stale = !d.report_oldest || new Date(d.report_oldest).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) !== d.today;
    var line = $('idLine'); line.innerHTML = '';
    line.appendChild(document.createTextNode('Data: ' + when(d.report_newest) + (d.prefix ? '' : ' (oldest GP ' + when(d.report_oldest) + ')')));
    if (stale) { var w = el('b', '  ⚠ not today\'s report'); w.style.color = '#b91c1c'; line.appendChild(w); }

    // 1. 90-day progress
    var k = $('idKpi'); k.innerHTML = '';
    kpi(k, nf(works), 'IAY works', '', nf(d.ongoing) + ' ongoing · ' + nf(d.approved) + ' approved');
    kpi(k, p + '%', '90-day progress', 'blue', '≈ ' + nf(doneMd) + ' / ' + nf(target) + ' days');
    kpi(k, nf(d.mr_pend), 'MRs to fill (ended)', d.mr_pend ? 'red' : 'green', nf(d.mr_run) + ' running now');
    kpi(k, nf(d.mr_gap), 'MR gap — new MR needed', d.mr_gap ? 'red' : 'green');
    kpi(k, nf(d.done6), '6 MRs (90 days) done', 'green');
    var pb = $('idProg'); pb.innerHTML = '';
    var pr = el('div', null, 'idbar'), ps = el('span'); ps.style.width = Math.min(100, p) + '%'; ps.style.background = '#16a34a'; pr.appendChild(ps); pb.appendChild(pr);

    // works by MRs done
    var dist = d.dist || [], dl = $('idDist'); dl.innerHTML = '';
    var mx = Math.max.apply(null, dist.concat([1]));
    dist.forEach(function (n, i) {
      var r = el('div', null, 'iddr');
      r.appendChild(el('span', i === 0 ? 'No MR' : i + ' MR' + (i > 1 ? 's' : ''), 'k'));
      var b = el('span', null, 'b'), f = el('i'); f.style.width = (100 * n / mx) + '%'; f.style.background = i === 6 ? '#16a34a' : i === 0 ? '#94a3b8' : '#6366f1'; b.appendChild(f); r.appendChild(b);
      r.appendChild(el('span', nf(n) + (works ? ' · ' + pct(n, works) + '%' : ''), 'v'));
      dl.appendChild(r);
    });

    // 2. wagelist & money
    var wl = $('idWl'); wl.innerHTML = '';
    wl.appendChild(bar([[+d.mr_wl, '#16a34a', 'WL generated'], [+d.mr_wait, '#f59e0b', 'Filled, WL pending'], [+d.mr_pend, '#ef4444', 'Not filled'], [+d.mr_run, '#93c5fd', 'Running']]));
    var lg = el('div', null, 'idlg');
    [['#16a34a', 'WL generated', d.mr_wl], ['#f59e0b', 'Filled, WL pending', d.mr_wait], ['#ef4444', 'Ended, not filled', d.mr_pend], ['#93c5fd', 'Running', d.mr_run]].forEach(function (x) {
      var s = el('span'); var dot = el('i'); dot.style.background = x[0]; s.appendChild(dot); s.appendChild(document.createTextNode(x[1] + ' ' + nf(x[2]))); lg.appendChild(s);
    });
    wl.appendChild(lg);
    var r = rate(), mw = el('div', null, 'muted');
    mw.innerHTML = r
      ? 'Approx. wages (MRs × 15 days × ₹' + r + '): WL generated <b>₹' + nf(d.mr_wl * 15 * r) + '</b> · waiting for WL <b>₹' + nf(d.mr_wait * 15 * r) + '</b> · whole target <b>₹' + nf(target * r) + '</b>'
      : 'Enter the wage rate (₹/day) to see approximate amounts.';
    wl.appendChild(mw);

    // 3. MB & K-Desk jobs
    var mb = $('idMb'); mb.innerHTML = '';
    if (d.mb) {
      var cap = (d.mb.last_mb - d.mb.first_mb + 1) * Math.floor(d.mb.pages_per_mb / d.mb.pages_per_work);
      mb.appendChild(el('div', 'MB ' + d.mb.first_mb + '–' + d.mb.last_mb + ': ' + nf(d.mb.slots) + ' of ' + nf(cap) + ' work slots used · last MB used ' + (d.mb.last_used || '—') +
        (d.mb.waiting ? ' · ' + nf(d.mb.waiting) + ' new ongoing works get pages at the next payment job' : ''), 'idtx'));
      mb.appendChild(bar([[+d.mb.slots, '#7a3b00', 'Used'], [Math.max(0, cap - d.mb.slots), '#e2e8f0', 'Free']]));
    } else mb.appendChild(el('div', d.prefix ? 'MB books not set for this GP.' : 'Pick one GP to see its MB books.', 'idtx'));
    var j = d.jobs || {}, bk = j.by_kind || {};
    mb.appendChild(el('div', 'K-Desk jobs: ' + nf(j.open) + ' open' + (j.queued ? ' (' + nf(j.queued) + ' not picked up yet)' : '') +
      ' · today done ' + nf(j.today_ok) + (j.today_err ? ', errors ' + nf(j.today_err) : '') +
      (j.today_ok ? ' (demand ' + nf(bk.demand) + ', attendance ' + nf(bk.attend) + ', payment ' + nf(bk.pay) + ')' : ''), 'muted'));

    // 4. breakdown: village-wise for one GP, GP-wise for the block
    $('idBrkTitle').textContent = d.prefix ? 'Village-wise' : 'GP-wise';
    var tb = $('idBrk'); tb.innerHTML = '';
    (d.breakdown || []).forEach(function (b) {
      var tr = el('tr');
      var nm = el('td', b.name === '—' ? 'No village (approved, no MR yet)' : b.name, 'g');
      if (b.jc) { nm.style.cursor = 'pointer'; nm.style.color = '#1d4ed8'; nm.title = 'Open this GP'; nm.onclick = function () { $('idGp').value = b.jc; save(); fetch(); }; }
      tr.appendChild(nm);
      [b.works, b.avg_mrs, b.pend, b.gap, b.wl_wait, b.wl_done, b.done6].forEach(function (v, i) {
        var td = el('td', i === 1 ? String(v) : nf(v), 'n');
        if ((i === 2 || i === 3) && +v) td.className = 'n bad';
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    if (!(d.breakdown || []).length) { var t0 = el('tr'), c0 = el('td', 'No IAY data yet — upload / sync the Phase Report in the IAY Tracker.'); c0.colSpan = 8; t0.appendChild(c0); tb.appendChild(t0); }
  }
  function save() { try { if (!ctx.fixed) localStorage.setItem(GP_KEY, $('idGp').value); } catch (e) {} }

  document.addEventListener('DOMContentLoaded', function () {
    if (!$('iayDash')) return;
    $('idGp').addEventListener('change', function () { save(); fetch(); });
    $('idRefresh').addEventListener('click', function () { fetch(); });
    $('idRate').addEventListener('change', function () {
      var v = parseFloat(this.value); try { if (v > 0) localStorage.setItem(RATE_KEY, String(v)); else localStorage.removeItem(RATE_KEY); } catch (e) {}
      render();
    });
    $('idOpen').addEventListener('click', function () {
      // the Tracker remembers the Super Admin's GP under its own key
      try { if (!ctx.fixed) localStorage.setItem('gramg2.iay.gp', $('idGp').value); } catch (e) {}
    });
  });
  window.IayDash = { load: load };
})();
