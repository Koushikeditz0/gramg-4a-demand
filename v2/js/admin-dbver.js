// Admin header: "DB v224" badge + red warning when the database is older than
// this app needs. When you add a new SQL file, bump NEEDED_DB to its number
// (and end the SQL with: select private.schema_mark(<number>, '<title>');).
(function () {
  'use strict';
  var NEEDED_DB = 237;
  window.AdminDbVer = { need: NEEDED_DB };   // Today page → System health uses the same number
  var SB = window.GramgSB;
  if (!SB) return;

  function badge(text, bad, tip) {
    var host = document.querySelector('.side .header-title');
    if (!host) return;
    var b = document.getElementById('dbVer');
    if (!b) {
      b = document.createElement('span');
      b.id = 'dbVer';
      b.style.cssText = 'margin-left:6px;font-size:11px;font-weight:600;padding:2px 7px;border-radius:999px;vertical-align:middle;';
      host.appendChild(b);
    }
    b.textContent = text;
    b.title = tip || '';
    b.style.background = bad ? '#fee2e2' : 'rgba(255,255,255,.18)';
    b.style.color = bad ? '#991b1b' : 'inherit';
  }

  function warn(have) {
    var line = document.getElementById('dataLine');
    if (!line || !line.parentNode || document.getElementById('dbWarn')) return;
    var w = document.createElement('div');
    w.id = 'dbWarn';
    w.className = 'dataline old';
    w.textContent = '⚠ Database is at ' + (have ? 'v' + have : 'an unknown version') + ' but this app needs v' + NEEDED_DB +
      '. Run the missing SQL file(s) from the repo folder supabase/ in the Supabase SQL Editor (oldest first).';
    line.parentNode.insertBefore(w, line);
  }

  function check(tries) {
    if (!SB.hasSession()) { if (tries < 20) setTimeout(function () { check(tries + 1); }, 500); return; }
    SB.rpc('db_version').then(function (d) {
      var have = d && d.version;
      var tip = (d && d.recent || []).map(function (r) { return 'v' + r.v + ' · ' + r.t; }).join('\n');
      badge('DB v' + (have || '?'), !have || have < NEEDED_DB, tip);
      if (!have || have < NEEDED_DB) warn(have);
    }).catch(function () {
      // db_version() missing = SQL v224 not run yet
      badge('DB < v224', true, 'Run supabase/2026-11-16_schema_versions_v224.sql');
      warn(0);
    });
  }
  setTimeout(function () { check(0); }, 1500);
})();
