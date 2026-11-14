/* =====================================================================
   Admin panel — "🙋 Requests" tab (SQL v212).
   Per GP request link (+ QR) for supervisors; their account requests are
   accepted / rejected here. All checks are in the database
   (admin_* functions use private.require_admin_gp: a GP Admin only reaches
   their own GP). Kept in its own file so admin.js stays as it is.
   ===================================================================== */
(function () {
  'use strict';
  var SB = window.GramgSB;
  function $(id) { return document.getElementById(id); }
  if (!$('tab-signup') || !SB) return;

  var su = { link: null, rows: [], setupMissing: false };

  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function loading(text) { $('loadingText').textContent = text || 'Loading...'; $('loading').classList.toggle('show', !!text); }
  function status(msg, kind) { var s = $('status'); s.textContent = msg || ''; s.className = 'status' + (msg ? ' show ' + (kind || 'info') : ''); if (msg) window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function missing(e) { return e && (e.status === 404 || /admin_(get_signup_link|list_account_requests|count_account_requests)/.test(e.message || '')); }
  function errText(e) {
    if (missing(e)) return 'Run supabase/2026-11-14_supervisor_signup_requests_v212.sql in Supabase → SQL Editor first.';
    var map = { NOT_AUTHORIZED: 'You are not allowed to do this.', NOT_FOUND: 'Request not found. Refresh.',
                ALREADY_DONE: 'This request was already accepted or rejected. Refresh.',
                USERNAME_TAKEN: 'A user with this mobile number already exists. Reject this request.',
                BAD_INPUT: 'The input is not valid.', NETWORK: 'Could not reach the server. Check the internet connection.' };
    return map[e && e.code] || (e && e.hint) || (e && e.message) || String(e);
  }
  function ask(msg, yes, kind) {
    return new Promise(function (res) {
      var box = $('askBox'), y = $('askYes'), n = $('askNo');
      $('askMsg').textContent = msg; y.textContent = yes || 'Yes'; y.className = kind === 'ok' ? 'btn-success' : 'btn-danger';
      function done(v) { box.classList.remove('show'); y.onclick = n.onclick = box.onclick = null; res(v); }
      y.onclick = function () { done(true); }; n.onclick = function () { done(false); };
      box.onclick = function (e) { if (e.target === box) done(false); };
      box.classList.add('show'); y.focus();
    });
  }
  function fmtDate(s) { if (!s) return '—'; var d = new Date(s); return d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function gp() { return Number($('suGp').value) || null; }
  function gpName() { var o = $('suGp').selectedOptions[0]; return o ? o.textContent.replace(/\s*\(.*\)\s*$/, '') : ''; }
  function linkUrl(code) { return location.origin + location.pathname.replace(/[^/]*$/, '') + 'join.html#' + code; }

  // ---------- tab: admin.js toggles its own tabs; this one shows/hides itself ----------
  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () {
      var mine = b.dataset.tab === 'signup';
      $('tab-signup').classList.toggle('hidden', !mine);
      if (mine) { copyGps(); load(); }
    });
  });
  // GP choices = the same as the Account copy tab (admin.js fills them, limited to a GP Admin's own GP)
  function copyGps() {
    var src = $('phGp'), dst = $('suGp'), keep = dst.value;
    dst.innerHTML = src.innerHTML; dst.disabled = src.disabled;
    dst.value = keep || src.value; if (!dst.value) dst.value = src.value;
  }
  $('suGp').addEventListener('change', load);
  $('suRefresh').addEventListener('click', load);

  function load() {
    var g = gp(); if (!g) return;
    loading('Loading requests...');
    Promise.all([SB.rpc('admin_get_signup_link', { p_gp_id: g }), SB.rpc('admin_list_account_requests', { p_gp_id: g })])
      .then(function (r) {
        su.setupMissing = false; $('suSetup').textContent = '';
        su.link = r[0]; su.rows = r[1] || [];
        renderLink(); renderRows(); badge();
      }, function (e) {
        if (e.authLost) return;
        if (missing(e)) { su.setupMissing = true; $('suSetup').textContent = errText(e); return; }
        status(errText(e), 'err');
      }).then(function () { loading(''); });
  }

  // ---------- link + QR ----------
  function renderLink() {
    var L = su.link, on = !!(L && L.active), box = $('suLinkBox');
    box.innerHTML = '';
    if (!L) box.textContent = 'No link yet. Press "Make new link".';
    else if (!on) box.textContent = 'The link is OFF (turned off or expired). Press "Make new link" to send a new one.';
    else {
      var a = el('a', linkUrl(L.code)); a.href = linkUrl(L.code); a.target = '_blank'; a.rel = 'noopener';
      a.style.wordBreak = 'break-all'; a.style.fontWeight = '700';
      box.appendChild(el('span', '🟢 ON · works until ' + fmtDate(L.expires_at) + ' · ')); box.appendChild(a);
    }
    $('suCopy').disabled = $('suQrDl').disabled = $('suOff').disabled = !on;
    $('suQrWrap').classList.toggle('hidden', !on);
    if (on) drawQr(linkUrl(L.code));
  }

  function drawQr(text) {
    var cv = $('suQr');
    if (typeof window.qrcode !== 'function') { $('suQrWrap').classList.add('hidden'); return; }
    var q = window.qrcode(0, 'M'); q.addData(text); q.make();
    var n = q.getModuleCount(), cell = 8, pad = 4 * cell, size = n * cell + pad * 2, foot = 70;
    cv.width = size; cv.height = size + foot;
    var c = cv.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
    c.fillStyle = '#000';
    for (var r = 0; r < n; r++) for (var k = 0; k < n; k++) if (q.isDark(r, k)) c.fillRect(pad + k * cell, pad + r * cell, cell, cell);
    c.fillStyle = '#0f172a'; c.textAlign = 'center';
    c.font = 'bold 20px system-ui, sans-serif'; c.fillText('Gram Setu · ' + gpName(), size / 2, size + 22);
    c.font = '15px system-ui, sans-serif'; c.fillText('Supervisor account request', size / 2, size + 46);
  }

  $('suNew').addEventListener('click', async function () {
    var g = gp(); if (!g) return;
    if (su.link && su.link.active && !await ask('Make a new link? The old link and QR stop working at once.', 'Make new link', 'ok')) return;
    SB.rpc('admin_set_signup_link', { p_gp_id: g, p_action: 'new', p_days: Number($('suDays').value) || 7 })
      .then(function (L) { su.link = L; renderLink(); status('🔗 New request link ready. Copy it or download the QR and send it to the supervisors.', 'ok'); })
      .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
  });
  $('suOff').addEventListener('click', async function () {
    var g = gp(); if (!g) return;
    if (!await ask('Turn off the request link? Nobody can send a new request with it. Requests already sent stay.', 'Turn off')) return;
    SB.rpc('admin_set_signup_link', { p_gp_id: g, p_action: 'off', p_days: null })
      .then(function (L) { su.link = L; renderLink(); status('⛔ Request link turned off.', 'ok'); })
      .catch(function (e) { if (!e.authLost) status(errText(e), 'err'); });
  });
  $('suCopy').addEventListener('click', function () {
    if (!su.link) return;
    var t = linkUrl(su.link.code);
    var done = function () { status('📋 Link copied. Paste it in the WhatsApp group.', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, function () { window.prompt('Copy this link:', t); });
    else window.prompt('Copy this link:', t);
  });
  $('suQrDl').addEventListener('click', function () {
    var a = document.createElement('a');
    a.href = $('suQr').toDataURL('image/png');
    a.download = 'GramSetu_request_QR_' + gpName().replace(/[^A-Za-z0-9]+/g, '_') + '.png';
    document.body.appendChild(a); a.click(); a.remove();
  });

  // ---------- requests ----------
  var ST = { pending: ['⏳ Waiting', 'neutral'], accepted: ['✔ Accepted', 'on'], rejected: ['✖ Rejected', 'off'], expired: ['Expired', 'off'] };
  function td(label, text) { var c = el('td', text); c.setAttribute('data-label', label); return c; }
  function renderRows() {
    var tb = $('suBody'); tb.innerHTML = '';
    if (!su.rows.length) { var tr0 = el('tr'); var c0 = el('td', 'No requests.'); c0.colSpan = 6; c0.className = 'muted'; tr0.appendChild(c0); tb.appendChild(tr0); return; }
    su.rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(td('Supervisor', r.name));
      tr.appendChild(td('ID', r.sup_id));
      tr.appendChild(td('Mobile / Username', r.username));
      var sent = td('Sent', fmtDate(r.created_at)); if (r.device) sent.title = r.device; tr.appendChild(sent);
      var s = ST[r.status] || [r.status, 'neutral'], sc = td('Status'); sc.appendChild(el('span', s[0], 'pill ' + s[1])); tr.appendChild(sc);
      var act = td('');
      if (r.status === 'pending') {
        var ok = el('button', '✔ Accept', 'btn-success btn-small');
        ok.addEventListener('click', function () { decide(r, true); });
        var no = el('button', '✖ Reject', 'btn-danger btn-small'); no.style.marginLeft = '4px';
        no.addEventListener('click', function () { decide(r, false); });
        act.appendChild(ok); act.appendChild(no);
      }
      tr.appendChild(act);
      tb.appendChild(tr);
    });
  }

  async function decide(r, accept) {
    var q = accept
      ? 'Accept ' + r.name + ' (' + r.sup_id + ')?\nUsername: ' + r.username + '\nThey can log in with this mobile number and the PIN they chose.'
      : 'Reject the request of ' + r.name + ' (' + r.username + ')? The request and its login are deleted.';
    if (!await ask(q, accept ? '✔ Accept' : '✖ Reject', accept ? 'ok' : 'danger')) return;
    loading(accept ? 'Accepting...' : 'Rejecting...');
    SB.rpc(accept ? 'admin_accept_account_request' : 'admin_reject_account_request', { p_id: r.id })
      .then(function () {
        status(accept ? '✅ ' + r.name + ' can now log in with username ' + r.username + '.' : '✖ Request of ' + r.name + ' rejected.', 'ok');
        load();
      }).catch(function (e) { if (!e.authLost) status(errText(e), 'err'); })
      .then(function () { loading(''); });
  }

  // ---------- badge (pending requests of the GPs this admin sees) ----------
  function badge() {
    if (su.setupMissing) return;
    var ids = Array.prototype.map.call($('phGp').options, function (o) { return Number(o.value); }).filter(Boolean);
    if (!ids.length) return;
    Promise.all(ids.map(function (g) { return SB.rpc('admin_count_account_requests', { p_gp_id: g }).catch(function () { return 0; }); }))
      .then(function (ns) {
        var n = ns.reduce(function (a, b) { return a + (Number(b) || 0); }, 0);
        $('suBadge').textContent = n ? String(n) : ''; $('suBadge').classList.toggle('hidden', !n);
      });
  }
  // admin.js fills the GP lists after login; check the badge once they are there
  var tries = 0, t = setInterval(function () {
    if ($('phGp').options.length || ++tries > 30) { clearInterval(t); badge(); }
  }, 1000);
})();
