/* =====================================================================
   Admin panel — "🏗 Works & Supervisors" tab (SQL v185).
   The Admin / GP Admin enters each GP's works (Work Name + Work Code) and
   supervisors (Name + ID). The phone app lets supervisors search and pick them.
   Kept in its own file so admin.js stays as it is.
   ===================================================================== */
(function () {
  'use strict';
  var SB = window.GramgSB;
  var XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  var CODE_RE = /^[^/\s]+\/[A-Za-z]{2,3}\/[^/\s]+/;
  var CODE_FIND = /[^\s,;|\t]+\/[A-Za-z]{2,3}\/[^\s,;|\t]+/;
  function $(id) { return document.getElementById(id); }
  if (!$('tab-masters') || !SB) return;

  var ms = { works: [], sups: [], prefix: '', wFile: [], sFile: [], wRows: [], sRows: [], setupMissing: false };

  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function loading(text) { $('loadingText').textContent = text || 'Loading...'; $('loading').classList.toggle('show', !!text); }
  function status(msg, kind) { var s = $('status'); s.textContent = msg || ''; s.className = 'status' + (msg ? ' show ' + (kind || 'info') : ''); }
  function errText(e) {
    if (e && e.status === 404) return 'Run supabase/2026-11-07_works_supervisors_v185.sql in Supabase → SQL Editor first.';
    var map = { NOT_AUTHORIZED: 'You are not allowed to do this.', BAD_INPUT: 'Too many rows at once.', NOT_FOUND: 'Not found. Refresh.',
                NETWORK: 'Could not reach the server. Check the internet connection.' };
    return map[e && e.code] || (e && e.message) || String(e);
  }
  function ask(msg, yes) {
    return new Promise(function (res) {
      var box = $('askBox'), y = $('askYes'), n = $('askNo');
      $('askMsg').textContent = msg; y.textContent = yes || 'Yes'; y.className = 'btn-danger';
      function done(v) { box.classList.remove('show'); y.onclick = n.onclick = box.onclick = null; res(v); }
      y.onclick = function () { done(true); }; n.onclick = function () { done(false); };
      box.onclick = function (e) { if (e.target === box) done(false); };
      box.classList.add('show'); y.focus();
    });
  }
  function gp() { return Number($('msGp').value) || null; }

  // ---------- tab: admin.js toggles its own 5 tabs; this one shows/hides itself ----------
  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () {
      var mine = b.dataset.tab === 'masters';
      $('tab-masters').classList.toggle('hidden', !mine);
      if (mine) { copyGps(); load(); }
    });
  });
  // GP choices = the same as the Account copy tab (admin.js fills them, already limited to the GP Admin's own GP)
  function copyGps() {
    var src = $('phGp'), dst = $('msGp'), keep = dst.value;
    dst.innerHTML = src.innerHTML; dst.disabled = src.disabled;
    dst.value = keep || src.value; if (!dst.value) dst.value = src.value;
  }
  $('msGp').addEventListener('change', load);

  function load() {
    var g = gp(); if (!g) return;
    loading('Loading works & supervisors...');
    SB.rpc('admin_get_masters', { p_gp_id: g }).then(function (r) {
      loading(''); ms.setupMissing = false; $('msSetup').textContent = '';
      ms.works = r.works || []; ms.sups = r.supervisors || []; ms.prefix = r.jc_prefix || '';
      $('msIdEx').textContent = 'S-' + (ms.prefix || '<job card prefix>') + '-01';
      renderWorks(); renderSups();
    }, function (e) {
      loading('');
      if (e && e.status === 404) { ms.setupMissing = true; $('msSetup').textContent = '⚠ ' + errText(e); return; }
      if (!e || !e.authLost) status(errText(e), 'err');
    });
  }

  // ---------- parsing ----------
  function cellsOf(line) { return line.indexOf('\t') >= 0 ? line.split('\t') : [line]; }
  // a row (array of cells) → {name, code}
  function workFromCells(cells) {
    cells = cells.map(function (c) { return String(c == null ? '' : c).trim(); });
    var code = '', name = '';
    for (var i = 0; i < cells.length; i++) {
      var m = cells[i].match(CODE_FIND);
      if (m && !code) { code = m[0]; var rest = cells[i].replace(m[0], '').replace(/^[\s,;|:-]+|[\s,;|:-]+$/g, ''); if (rest && !name) name = rest; }
      else if (!name && cells[i] && !/^\d+$/.test(cells[i])) name = cells[i];
    }
    name = name.replace(/\s+/g, ' ').replace(/[\s,;|:-]+$/, '').trim();
    return name ? { name: name, code: code } : null;
  }
  function supFromCells(cells) {
    cells = cells.map(function (c) { return String(c == null ? '' : c).trim(); }).filter(Boolean);
    if (cells.length === 1) {           // "Arup Roy, 01" / "Arup Roy 01" / "Arup Roy"
      var m = cells[0].match(/^(.*?)[\s,;|:-]+(S-[A-Z0-9-]+|\d{1,4})$/i);
      cells = m ? [m[1], m[2]] : [cells[0]];
    }
    var name = '', id = '';
    cells.forEach(function (c) {
      if (!id && /^(S-[A-Z0-9-]+|\d{1,4})$/i.test(c)) id = c;
      else if (!name && /[A-Za-z]/.test(c)) name = c;
    });
    name = name.replace(/[\s,;|:-]+$/, '').replace(/\s+/g, ' ').trim();
    return name ? { name: name, id: id } : null;
  }
  // header row with "work name"/"work code" or "name"/"id": use those columns
  function tableRows(aoa, kind) {
    var head = -1, ci = {};
    for (var r = 0; r < Math.min(aoa.length, 10) && head < 0; r++) {
      (aoa[r] || []).forEach(function (h, i) {
        var n = String(h || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (kind === 'w') { if (/^work ?name|^name of (the )?work|^work$/.test(n)) ci.name = i; if (/work ?code|^code$/.test(n)) ci.code = i; }
        else { if (/name/.test(n)) ci.name = i; if (/(^| )id$|^id|supervisor id|^sl.? ?id/.test(n)) ci.id = i; }
      });
      if (ci.name !== undefined) head = r; else ci = {};
    }
    var out = [];
    aoa.slice(head + 1).forEach(function (row) {
      if (!row || !row.some(function (c) { return String(c || '').trim(); })) return;
      var x;
      if (head >= 0) {
        x = kind === 'w' ? { name: String(row[ci.name] || '').replace(/\s+/g, ' ').trim(), code: ci.code !== undefined ? String(row[ci.code] || '').replace(/\s+/g, '') : '' }
                         : { name: String(row[ci.name] || '').replace(/\s+/g, ' ').trim(), id: ci.id !== undefined ? String(row[ci.id] || '').trim() : '' };
        if (!x.name) x = null;
      } else x = kind === 'w' ? workFromCells(row) : supFromCells(row);
      if (x) out.push(x);
    });
    return out;
  }
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
  function readTable(f, kind) {
    var isCsv = /\.csv$/i.test(f.name);
    return loadXlsx().then(function () { return isCsv ? f.text() : f.arrayBuffer(); }).then(function (data) {
      var wb = isCsv ? XLSX.read(String(data).replace(/^﻿/, ''), { type: 'string', raw: true }) : XLSX.read(data, { type: 'array', cellText: true });
      var out = [];
      wb.SheetNames.forEach(function (n) { out = out.concat(tableRows(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }), kind)); });
      return out;
    });
  }

  function parseWorks() {
    var lines = $('mwText').value.split(/\r?\n/).filter(function (l) { return l.trim(); });
    var all = lines.map(function (l) { return workFromCells(cellsOf(l)); }).filter(Boolean).concat(ms.wFile), seen = {};
    ms.wRows = all.filter(function (x) { var k = x.name.toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true; });
    var bad = ms.wRows.filter(function (x) { return x.code && !CODE_RE.test(x.code); }).length,
        noCode = ms.wRows.filter(function (x) { return !x.code; }).length;
    $('mwParsed').textContent = ms.wRows.length ? ms.wRows.length + ' work(s) found' + (noCode ? ' · ' + noCode + ' without a Work Code' : '') + (bad ? ' · ⚠ ' + bad + ' code(s) in a wrong format' : '') : '';
  }
  function parseSups() {
    var lines = $('msText').value.split(/\r?\n/).filter(function (l) { return l.trim(); });
    var all = lines.map(function (l) { return supFromCells(cellsOf(l)); }).filter(Boolean).concat(ms.sFile);
    ms.sRows = all;
    var noId = all.filter(function (x) { return !x.id; }).length;
    $('msParsed').textContent = all.length ? all.length + ' supervisor(s) found' + (noId ? ' · ' + noId + ' without ID (next number given)' : '') : '';
  }
  $('mwText').addEventListener('input', parseWorks);
  $('msText').addEventListener('input', parseSups);
  $('mwFile').addEventListener('change', function () {
    var f = this.files && this.files[0]; ms.wFile = [];
    if (!f) { parseWorks(); return; }
    readTable(f, 'w').then(function (rows) { ms.wFile = rows; parseWorks(); if (!rows.length) status('No works found in this file.', 'err'); },
      function (e) { status(errText(e), 'err'); });
  });
  $('msFile').addEventListener('change', function () {
    var f = this.files && this.files[0]; ms.sFile = [];
    if (!f) { parseSups(); return; }
    readTable(f, 's').then(function (rows) { ms.sFile = rows; parseSups(); if (!rows.length) status('No supervisors found in this file.', 'err'); },
      function (e) { status(errText(e), 'err'); });
  });

  // ---------- save ----------
  $('mwSave').addEventListener('click', function () {
    parseWorks();
    if (!ms.wRows.length) { status('Paste the works or choose the file first (Work Name + Work Code).', 'err'); return; }
    loading('Saving ' + ms.wRows.length + ' work(s)...');
    SB.rpc('admin_save_works', { p_gp_id: gp(), p_rows: ms.wRows }).then(function (r) {
      loading('');
      var msg = '✅ Added: ' + r.added + '   · updated: ' + r.updated;
      if ((r.bad || []).length) msg += '\n⚠ Not saved, Work Code format wrong (e.g. 3206003006/IF/93393042892327): ' + r.bad.map(function (x) { return x.name + ' — ' + x.code; }).join('; ');
      $('mwResult').textContent = msg; status(msg.split('\n')[0], 'ok');
      $('mwText').value = ''; $('mwFile').value = ''; ms.wFile = []; parseWorks(); load();
    }, function (e) { loading(''); if (!e || !e.authLost) status(errText(e), 'err'); });
  });
  $('msSave').addEventListener('click', function () {
    parseSups();
    if (!ms.sRows.length) { status('Paste the supervisors or choose the file first (Name + ID).', 'err'); return; }
    loading('Saving ' + ms.sRows.length + ' supervisor(s)...');
    SB.rpc('admin_save_supervisors', { p_gp_id: gp(), p_rows: ms.sRows }).then(function (r) {
      loading('');
      var msg = '✅ Added: ' + r.added + '   · updated: ' + r.updated;
      if ((r.bad || []).length) msg += '\n⚠ Not saved (no brackets ( ) in names / IDs): ' + r.bad.map(function (x) { return x.name; }).join(', ');
      $('msResult').textContent = msg; status(msg.split('\n')[0], 'ok');
      $('msText').value = ''; $('msFile').value = ''; ms.sFile = []; parseSups(); load();
    }, function (e) { loading(''); if (!e || !e.authLost) status(errText(e), 'err'); });
  });

  // ---------- tables ----------
  function td(tr, text, label, cls) { var c = el('td', text, cls); c.setAttribute('data-label', label); tr.appendChild(c); return c; }
  function delBtn(onClick) { var b = el('button', '🗑', 'btn-light btn-small'); b.title = 'Delete'; b.onclick = onClick; return b; }
  function renderWorks() {
    var body = $('mwBody'), q = $('mwFind').value.trim().toLowerCase(); body.innerHTML = '';
    var rows = ms.works.filter(function (w) { return !q || (w.name + ' ' + (w.code || '')).toLowerCase().indexOf(q) >= 0; });
    if (!rows.length) { var tr0 = el('tr'); var c0 = td(tr0, ms.works.length ? 'No match.' : 'No works yet — the phone app shows the typing boxes.', ''); c0.colSpan = 5; body.appendChild(tr0); return; }
    rows.forEach(function (w, i) {
      var tr = el('tr');
      td(tr, String(i + 1), '#'); td(tr, w.name, 'Work Name'); td(tr, w.code || '—', 'Work Code', 'mono'); td(tr, String(w.used || 0), 'Lists');
      td(tr, null, '').appendChild(delBtn(function () {
        ask('Delete the work "' + w.name + '" from the list? Lists already made with it stay as they are.', 'Delete').then(function (ok) {
          if (!ok) return;
          SB.rpc('admin_delete_work', { p_id: w.id }).then(load, function (e) { if (!e || !e.authLost) status(errText(e), 'err'); });
        });
      }));
      body.appendChild(tr);
    });
  }
  $('mwFind').addEventListener('input', renderWorks);
  function renderSups() {
    var body = $('msBody'); body.innerHTML = '';
    if (!ms.sups.length) { var tr0 = el('tr'); var c0 = td(tr0, 'No supervisors yet — the phone app shows the typing boxes.', ''); c0.colSpan = 4; body.appendChild(tr0); return; }
    ms.sups.forEach(function (s, i) {
      var tr = el('tr');
      td(tr, String(i + 1), '#'); td(tr, s.name, 'Name'); td(tr, s.sup_id, 'ID', 'mono');
      td(tr, null, '').appendChild(delBtn(function () {
        ask('Delete supervisor "' + s.name + ' (' + s.sup_id + ')" from the list? Lists that already name them stay as they are.', 'Delete').then(function (ok) {
          if (!ok) return;
          SB.rpc('admin_delete_supervisor', { p_id: s.id }).then(load, function (e) { if (!e || !e.authLost) status(errText(e), 'err'); });
        });
      }));
      body.appendChild(tr);
    });
  }
})();
