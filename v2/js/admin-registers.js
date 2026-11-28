/* =====================================================================
   Admin panel — "📚 Registers" page (2026-11-28).
   Gram Setu does NOT read the government report pages (the browser would not allow it, and nothing
   should load Gram Setu / Supabase for it). This page only collects the choice (year, period, registers)
   and hands it to the K-Desk extension on this PC, which reads the public report pages itself.
   The login is never sent in the message: K-Desk takes it from this page's own storage and checks the
   role + GP with Gram Setu (get_my_context). GP Admin = own GP only, Super Admin = any GP.
   ===================================================================== */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  if (!$('tab-regs')) return;
  var O = location.origin, kd = { ready: false, version: '' }, built = false;

  var REGS = [
    ['I', 'Job Card register', 'Part A–D: job cards, applications, households that worked'],
    ['II', 'Gram Sabha register', 'Prioritised works + minutes format'],
    ['III', 'Demand, allocation and wages', 'Each demand with its allocation and wages'],
    ['IV', 'Work register', "Index of works (+ each work's page)"],
    ['V', 'Fixed asset register', 'Works with an Asset ID'],
    ['VI', 'Complaint register', 'Ready format to fill by hand'],
    ['VII', 'Material register', 'Bills and materials of each work']];

  function fyList() {
    var d = new Date(), y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1, out = [];
    for (var i = y; i >= 2005; i--) out.push(i + '-' + (i + 1));
    return out;
  }
  function periods(fy) {
    var y = +fy.slice(0, 4), M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var out = [['year', 'Whole year'], ['q1', 'Q1 (Apr–Jun)'], ['q2', 'Q2 (Jul–Sep)'], ['q3', 'Q3 (Oct–Dec)'], ['q4', 'Q4 (Jan–Mar)']];
    for (var i = 0; i < 12; i++) { var m = ((i + 3) % 12) + 1, yy = m >= 4 ? y : y + 1; out.push(['m:' + yy + '-' + (m < 10 ? '0' : '') + m, M[m - 1] + ' ' + yy]); }
    return out;
  }
  function opt(v, t) { var o = document.createElement('option'); o.value = v; o.textContent = t; return o; }
  function build() {
    if (built) return; built = true;
    fyList().forEach(function (f) { $('rgFy').appendChild(opt(f, f.slice(0, 4) + '-' + f.slice(7))); });
    fillPd();
    $('rgFy').addEventListener('change', fillPd);
    REGS.forEach(function (r) {
      var l = document.createElement('label'); l.className = 'rg-tile';
      var c = document.createElement('input'); c.type = 'checkbox'; c.value = r[0]; c.checked = true;
      var n = document.createElement('span'); n.className = 'n'; n.textContent = r[0];
      var t = document.createElement('span'), b = document.createElement('b'), s = document.createElement('small');
      b.textContent = r[1]; s.textContent = r[2]; t.appendChild(b); t.appendChild(s);
      l.appendChild(c); l.appendChild(n); l.appendChild(t); $('rgTiles').appendChild(l);
    });
    $('rgGo').addEventListener('click', go);
    window.postMessage({ type: 'KDESK_PING' }, O);
    setTimeout(status, 1200);
  }
  function fillPd() {
    $('rgPd').innerHTML = '';
    periods($('rgFy').value).forEach(function (p) { $('rgPd').appendChild(opt(p[0], p[1])); });
  }
  function status() {
    var b = $('rgKd');
    b.className = 'rg-kd' + (kd.ready ? ' ok' : '');
    b.textContent = kd.ready ? 'K-Desk ' + kd.version + ' found on this PC.'
      : 'K-Desk was not found on this page. Install or update K-Desk (v1.29.0 or newer) in Chrome on this PC, then reload this page.';
    $('rgGo').disabled = !kd.ready;
  }
  function who() {
    var s = null; try { s = JSON.parse(localStorage.getItem('gramg2.session') || 'null'); } catch (e) { /* none */ }
    var t = $('rgWho'), lbl = $('roleLbl');
    t.textContent = (lbl && lbl.textContent ? lbl.textContent + ': ' : '') + (/GP Admin/.test((lbl || {}).textContent || '') ? 'registers only for this GP.' : 'registers for any GP.');
    void s;
  }
  function go() {
    var regs = [].map.call(document.querySelectorAll('#rgTiles input:checked'), function (x) { return x.value; });
    if (!regs.length) { alert('Tick at least one register.'); return; }
    $('rgGo').disabled = true;
    window.postMessage({ type: 'KDESK_REGISTERS', fy: $('rgFy').value, period: $('rgPd').value, regs: regs, details: $('rgDet').checked }, O);
  }
  window.addEventListener('message', function (e) {
    if (e.source !== window || e.origin !== O || !e.data) return;
    if (e.data.type === 'KDESK_HERE') { kd.ready = true; kd.version = String(e.data.version || ''); status(); }
    if (e.data.type === 'KDESK_REGISTERS_ACK') {
      $('rgGo').disabled = !kd.ready;
      var b = $('rgKd'); b.className = 'rg-kd' + (e.data.ok ? ' ok' : '');
      b.textContent = e.data.ok ? 'Opened in K-Desk (new tab). Choose the Gram Panchayat there and press Read.' : (e.data.error || 'K-Desk could not open the registers.');
    }
  });
  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () {
      var on = b.dataset.tab === 'regs';
      $('tab-regs').classList.toggle('hidden', !on);
      if (on) { build(); who(); window.postMessage({ type: 'KDESK_PING' }, O); setTimeout(status, 600); }
    });
  });
})();
