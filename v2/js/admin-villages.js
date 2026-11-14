/* =====================================================================
   Admin panel — "🏘 Village names (local)" card in the Works & Supervisors
   tab (SQL v212). The Admin / GP Admin writes a local name for each village
   number; the phone app shows "002 · <local name>".
   Kept in its own file so admin.js / admin-masters.js stay as they are.
   ===================================================================== */
(function () {
  'use strict';
  var SB = window.GramgSB;
  function $(id) { return document.getElementById(id); }
  if (!$('vnCard') || !SB) return;

  var vn = { gp: null, rows: [], edits: {} };   // edits[v] = typed name (may be '')

  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function loading(text) { $('loadingText').textContent = text || 'Loading...'; $('loading').classList.toggle('show', !!text); }
  function status(msg, kind) { var s = $('status'); s.textContent = msg || ''; s.className = 'status' + (msg ? ' show ' + (kind || 'info') : ''); }
  function errText(e) {
    if (e && e.status === 404) return 'Run supabase/2026-11-14_village_local_names_v212.sql in Supabase → SQL Editor first.';
    var map = { NOT_AUTHORIZED: 'You are not allowed to do this.', BAD_INPUT: 'Too many rows at once.',
                NETWORK: 'Could not reach the server. Check the internet connection.' };
    return map[e && e.code] || (e && e.message) || String(e);
  }
  function vno(v) { return String(v).padStart(3, '0'); }
  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60); }
  function gp() { return Number($('msGp').value) || null; }

  function changed() {
    var out = [];
    vn.rows.forEach(function (r) {
      if (!(r.v in vn.edits)) return;
      var now = clean(vn.edits[r.v]);
      if (now !== clean(r.name)) out.push({ v: r.v, name: now });
    });
    return out;
  }
  function paintSave() {
    var n = changed().length;
    $('vnSave').disabled = !n;
    $('vnChanged').textContent = n ? n + ' change(s) not saved yet' : '';
  }

  function load() {
    var g = gp(); if (!g) return;
    if (g !== vn.gp) { vn.edits = {}; }
    vn.gp = g;
    SB.rpc('admin_get_village_names', { p_gp_id: g }).then(function (rows) {
      if (vn.gp !== g) return;
      $('vnSetup').textContent = '';
      vn.rows = (rows || []).map(function (r) { return { v: Number(r.v), name: r.name || '', workers: r.workers || 0, families: r.families || 0 }; });
      render();
    }, function (e) {
      vn.rows = []; render();
      if (e && e.status === 404) { $('vnSetup').textContent = '⚠ ' + errText(e); return; }
      if (!e || !e.authLost) status(errText(e), 'err');
    });
  }

  function td(tr, text, label, cls) { var c = el('td', text, cls); c.setAttribute('data-label', label); tr.appendChild(c); return c; }
  function render() {
    var body = $('vnBody'); body.innerHTML = '';
    var q = $('vnFind').value.trim().toLowerCase();
    var rows = vn.rows.filter(function (r) {
      var name = (r.v in vn.edits) ? vn.edits[r.v] : r.name;
      return !q || (vno(r.v) + ' ' + r.v + ' ' + name).toLowerCase().indexOf(q) >= 0;
    });
    if (!rows.length) {
      var tr0 = el('tr'); var c0 = td(tr0, vn.rows.length ? 'No match.' : 'No villages yet — import the workers first.', ''); c0.colSpan = 4; body.appendChild(tr0);
      paintSave(); return;
    }
    rows.forEach(function (r) {
      var tr = el('tr');
      td(tr, 'Village ' + vno(r.v), 'Village', 'mono');
      td(tr, String(r.families), 'Families'); td(tr, String(r.workers), 'Workers');
      var inp = document.createElement('input');
      inp.type = 'text'; inp.maxLength = 60; inp.placeholder = 'Local name (empty = number only)';
      inp.value = (r.v in vn.edits) ? vn.edits[r.v] : r.name;
      inp.style.cssText = 'width:100%;min-width:160px;border:1px solid #cbd5e1;border-radius:8px;padding:6px 8px;';
      inp.addEventListener('input', function () { vn.edits[r.v] = inp.value; paintSave(); });
      td(tr, null, 'Local name').appendChild(inp);
      body.appendChild(tr);
    });
    paintSave();
  }

  $('vnFind').addEventListener('input', render);
  $('vnSave').addEventListener('click', function () {
    var rows = changed(); if (!rows.length) return;
    loading('Saving ' + rows.length + ' village name(s)...');
    SB.rpc('admin_save_village_names', { p_gp_id: vn.gp, p_rows: rows }).then(function (r) {
      loading(''); vn.edits = {};
      status('✅ Village names saved: ' + r.saved + (r.cleared ? ' · cleared: ' + r.cleared : '') + '. Supervisors see them after they reopen the app.', 'ok');
      load();
    }, function (e) { loading(''); if (!e || !e.authLost) status(errText(e), 'err'); });
  });

  // Load with the tab (admin-masters.js copies the GP choices first) and when the GP changes.
  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () { if (b.dataset.tab === 'masters') setTimeout(load, 0); });
  });
  $('msGp').addEventListener('change', load);
})();
