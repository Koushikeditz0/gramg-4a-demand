/* =====================================================================
   Admin panel — "📨 Supervisor requests / সেবা অনুরোধ" tab (SQL v234).
   Supervisors send tasks (Aadhaar Delink, name / gender correction,
   notes …) from the phone app; the Admin can also write one for
   a supervisor. The Admin sets the status with a remark, and makes the
   Block's Excel formats for ticked requests.
   All checks are in the database (admin_* functions use
   private.require_admin_gp: a GP Admin only reaches their own GP).

   Aadhaar numbers: only the Super Admin can store one, only for the Block
   formats. It is locked here in the browser (PBKDF2 → AES-GCM) with the
   Super Admin's own lock password BEFORE it is sent, so the database and
   the backups hold only locked text + the last 4 digits. The password and
   the key never leave this page; reloading the page locks it again.
   Kept in its own file so admin.js stays as it is.
   ===================================================================== */
(function () {
  'use strict';
  var SB = window.GramgSB;
  function $(id) { return document.getElementById(id); }
  if (!$('tab-sreq') || !SB) return;
  var XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';   // SheetJS + cell styles

  var KIND = {
    aadhaar_delink: ['🪪 Aadhaar Delink', 'আধার ডিলিংক'],
    aadhaar_wrong_seed: ['🪪 Aadhaar seeded to wrong applicant', 'ভুল applicant-এ আধার seed'],
    name_mismatch: ['🪪 Name mismatch (Soft vs Aadhaar)', 'নামের অমিল'],
    gender_hoh: ['⚧ Gender / HoH change', 'লিঙ্গ / HoH বদল'],
    applicant_add: ['➕ New applicant in Job Card', 'নতুন Applicant যোগ'],
    payment: ['💸 Payment problem', 'Payment সমস্যা'],
    other: ['📌 Other task', 'অন্য কাজ'],
    note: ['📝 Note', 'নোট / বার্তা']
  };
  var FORMAT_KINDS = ['aadhaar_delink', 'aadhaar_wrong_seed', 'name_mismatch', 'gender_hoh'];
  var ST = { new: 'New', working: 'Working', block: 'Sent to Block', district: 'Sent to District', done: 'Done', rejected: 'Rejected', cancelled: 'Cancelled', seen: 'Seen', ekyc: 'eKYC done' };
  var GENDER = [['', '—'], ['Male', 'Male'], ['Female', 'Female'], ['Transgender', 'Transgender']];
  var REASON = [['', '—'], ['dead', 'Death'], ['shifted', 'Shifted to another GP / Block'], ['duplicate', 'Duplicate'], ['wrong', 'Wrongly seeded'], ['other', 'Other']];
  var REASON_TXT = { dead: 'Death', shifted: 'Shifted', duplicate: 'Duplicate', wrong: 'Wrongly seeded', other: 'Other' };
  // format fields of each kind (never an Aadhaar number)
  var FIELDS = {
    aadhaar_delink: [
      { k: 'reason', l: 'Reason for removal / deletion', o: REASON },
      { k: 'reason_text', l: 'Reason in words (optional)' },
      { k: 'shift_block', l: 'Name of shifted Block', when: function (d) { return d.reason === 'shifted'; } },
      { k: 'shift_gp', l: 'Name of shifted GP', when: function (d) { return d.reason === 'shifted'; } },
      { k: 'shift_jc', l: 'New (shifted) Job Card No (as in MIS)', when: function (d) { return d.reason === 'shifted'; } },
      { k: 'aadhaar_name', l: 'Name as per Aadhaar' }],
    aadhaar_wrong_seed: [
      { k: 'aadhaar_name', l: 'Name recorded in Aadhaar Card' },
      { k: 'gender', l: 'Gender recorded in Aadhaar Card', o: GENDER },
      { k: 'seeded', l: 'Whether Aadhaar already seeded in MIS', o: [['', '—'], ['Yes', 'Yes'], ['No', 'No']] }],
    name_mismatch: [
      { k: 'aadhaar_name', l: 'Name as per Aadhaar Card' },
      { k: 'gender', l: 'Gender', o: GENDER },
      { k: 'remarks', l: 'Remarks (optional)' }],
    gender_hoh: [
      { k: 'old_hoh', l: 'Name of the existing HoH' },
      { k: 'new_hoh', l: 'Name of the new HoH (write "Same" if unchanged)' },
      { k: 'members', l: 'Every applicant in the Job Card: relationship with the new HoH + gender', members: true }]
  };
  var AA = {   // Aadhaar boxes (Super Admin only)
    aadhaar_delink: [['a1', 'Aadhaar No. (already frozen in MIS)']],
    aadhaar_wrong_seed: [['a1', 'Aadhaar No. seeded in MIS (wrongly)'], ['a2', 'Actual Aadhaar No. which needs to seed now']],
    name_mismatch: [['a1', 'Aadhaar Card Number']]
  };
  var REMARKS = {
    working: ['কাজ চলছে', 'Block-এ কথা বলছি', 'কাগজ দরকার: Aadhaar photocopy আনুন'],
    block: ['Block-এ পাঠানো হয়েছে', 'Block format জমা দেওয়া হয়েছে'],
    district: ['District-এ পাঠানো হয়েছে'],
    done: ['কাজ হয়ে গেছে', 'Portal-এ হয়ে গেছে। এবার eKYC করান।'],
    rejected: ['Block ফেরত দিয়েছে', 'কাগজ ঠিক নেই', 'এই কাজ GP থেকে হয় না'],
    cancelled: ['ভুল করে লেখা হয়েছিল']
  };

  var sr = { rows: [], meta: null, filter: 'open', sel: new Set(), all: false, key: null };

  // ---------------------------------------------------------------- small helpers
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function loading(text) { $('loadingText').textContent = text || 'Loading...'; $('loading').classList.toggle('show', !!text); }
  function status(msg, kind) { var s = $('status'); s.textContent = msg || ''; s.className = 'status' + (msg ? ' show ' + (kind || 'info') : ''); if (msg) window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function missing(e) { return e && (e.status === 404 || /admin_s(r_|ervice_requests)/.test(e.message || '')); }
  var SETUP = 'Run supabase/2026-11-21_service_requests_v234.sql in Supabase → SQL Editor first.';
  function errText(e) {
    if (missing(e)) return SETUP;
    var map = { NOT_AUTHORIZED: 'You are not allowed to do this.', NOT_FOUND: 'Request not found. Refresh.',
                ALREADY_OPEN: 'This worker already has an open request of this kind.', NEED_TITLE: 'Write what the task is.',
                NEED_NOTE: 'Write the note.', WORKER_NOT_FOUND: 'Pick the worker again.', COMMENT_NEEDED: 'Write the reason (remark) for Reject.',
                NO_AADHAAR: 'An Aadhaar number cannot be written in a note / remark / field. Use the 🪪 Aadhaar box (Super Admin only).',
                ALREADY_SET: 'The Aadhaar lock is already set. Refresh.', NO_LOCK: 'Set the Aadhaar lock password first.',
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
  function fmtDay(s) { return s ? new Date(s).toLocaleDateString('en-GB') : ''; }
  function vno(v) { return v == null ? '' : String(v).padStart(3, '0'); }
  function gp() { return Number($('srGp').value) || null; }
  function gpName() { return (sr.meta && sr.meta.gp_name) || ((($('srGp').selectedOptions[0] || {}).textContent) || '').replace(/\s*\(.*\)\s*$/, ''); }
  function blockName() { return (sr.meta && sr.meta.block_name) || ''; }
  function kindLabel(k) { return (KIND[k] || [k])[0]; }
  function isSuper() { return !!(sr.meta && sr.meta.super); }
  function copyGps() {
    var src = $('phGp'), dst = $('srGp'), keep = dst.value;
    dst.innerHTML = src.innerHTML; dst.disabled = src.disabled;
    dst.value = keep || src.value; if (!dst.value) dst.value = src.value;
  }

  // Verhoeff check digit: a real Aadhaar number passes, a typing mistake almost never does
  var VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],
            [5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
  var VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],
            [4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
  function aadhaarOk(s) {
    if (!/^[2-9]\d{11}$/.test(s)) return false;
    var c = 0; for (var i = 0; i < 12; i++) c = VD[c][VP[i % 8][Number(s.charAt(11 - i))]];
    return c === 0;
  }
  function hasAadhaar(text) {
    var re = /(^|\D)([2-9]\d{3}[ -]?\d{4}[ -]?\d{4})(?!\d)/g, m;
    while ((m = re.exec(String(text || '')))) if (aadhaarOk(m[2].replace(/\D/g, ''))) return true;
    return false;
  }
  function fmtAa(s) { return s ? s.replace(/(\d{4})(\d{4})(\d{4})/, '$1 $2 $3') : ''; }

  // ---------------------------------------------------------------- the lock (Super Admin)
  var CHECK = 'GRAMSETU-AADHAAR-LOCK-v1', ITER = 310000;
  function b64(buf) { var s = '', b = new Uint8Array(buf); for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function unb64(t) { var s = atob(t), b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
  function derive(pw, salt) {
    var te = new TextEncoder();
    return crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveKey']).then(function (base) {
      return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(salt), iterations: ITER, hash: 'SHA-256' }, base,
                                     { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    });
  }
  function seal(key, text) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(text)).then(function (ct) {
      var all = new Uint8Array(12 + ct.byteLength); all.set(iv, 0); all.set(new Uint8Array(ct), 12); return b64(all);
    });
  }
  function unseal(key, t) {
    var all = unb64(t);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12)).then(function (pt) { return new TextDecoder().decode(pt); });
  }
  function renderLock() {
    var box = $('srLock'); box.innerHTML = '';
    box.classList.toggle('hidden', !isSuper());
    if (!isSuper()) return;
    var L = sr.meta.lock;
    box.className = 'sr-lock ' + (sr.key ? 'on' : 'off');
    if (!window.crypto || !crypto.subtle) { box.appendChild(el('span', '⚠ This browser cannot lock Aadhaar numbers (needs https).')); return; }
    if (!L) {
      box.appendChild(el('span', '🔓 Aadhaar lock is not set. Only you (Super Admin) can store Aadhaar numbers for the Block formats, and only after you set your own lock password.'));
      var b = el('button', '🔒 Set lock password', 'btn-primary btn-small'); b.type = 'button'; b.onclick = setupLock; box.appendChild(b);
      return;
    }
    if (sr.key) {
      box.appendChild(el('span', '🔓 Aadhaar numbers are open on this page (until you lock or reload).'));
      var lk = el('button', '🔒 Lock now', 'btn-light btn-small'); lk.type = 'button'; lk.onclick = function () { sr.key = null; renderLock(); render(); }; box.appendChild(lk);
    } else {
      box.appendChild(el('span', '🔒 Aadhaar numbers are locked. Open them with your lock password to add or download them.'));
      var ub = el('button', '🔑 Open', 'btn-primary btn-small'); ub.type = 'button'; ub.onclick = function () { unlock().then(render, function () {}); }; box.appendChild(ub);
      var rs = el('button', 'Forgot password…', 'btn-light btn-small'); rs.type = 'button'; rs.onclick = resetLock; box.appendChild(rs);
    }
  }
  // generic little form modal → resolves with the values, or rejects on Cancel
  function aaModal(title, sub, build, okText, check) {
    return new Promise(function (res, rej) {
      var m = $('srAaModal'), body = $('srAaBody');
      $('srAaTitle').textContent = title; $('srAaSub').textContent = sub || ''; body.innerHTML = '';
      var get = build(body); $('srAaYes').textContent = okText || 'OK';
      function close() { m.classList.remove('show'); $('srAaYes').onclick = $('srAaNo').onclick = $('srAaClose').onclick = null; }
      $('srAaYes').onclick = function () {
        var v = get(), bad = check ? check(v) : '';
        if (bad) { status(bad, 'err'); return; }
        close(); res(v);
      };
      $('srAaNo').onclick = $('srAaClose').onclick = function () { close(); rej(new Error('cancel')); };
      m.classList.add('show');
      var f = body.querySelector('input'); if (f) f.focus();
    });
  }
  function pwBox(body, id, label) {
    var l = el('label', label, 'f'); l.htmlFor = id; body.appendChild(l);
    var i = el('input'); i.type = 'password'; i.id = id; i.autocomplete = 'off'; i.maxLength = 64; body.appendChild(i); return i;
  }
  function setupLock() {
    aaModal('🔒 Set the Aadhaar lock password', 'Only you need it. It is never sent to the server.', function (body) {
      body.appendChild(el('div', 'Write a password of at least 8 characters that only you know. Aadhaar numbers are locked with it in this browser before they are saved. If you forget it, the saved Aadhaar numbers cannot be opened again (you type them again).', 'sr-note-aa'));
      var a = pwBox(body, 'srPw1', 'Lock password'), b = pwBox(body, 'srPw2', 'Same password again');
      return function () { return { a: a.value, b: b.value }; };
    }, '🔒 Set password', function (v) {
      if (v.a.length < 8) return 'The password needs at least 8 characters.';
      if (v.a !== v.b) return 'The two passwords are not the same.';
      return '';
    }).then(function (v) {
      var salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      loading('Setting the lock...');
      return derive(v.a, salt).then(function (key) {
        return seal(key, CHECK).then(function (chk) {
          return SB.rpc('admin_sr_lock_set', { p_salt: salt, p_check: chk, p_reset: !!setupLock.reset }).then(function () {
            sr.key = key; sr.meta.lock = { salt: salt, check: chk };
            status('🔒 Aadhaar lock set. Keep the password safe: without it the saved numbers cannot be opened.', 'ok');
            renderLock(); render();
          });
        });
      });
    }).catch(function (e) { if (e && e.message !== 'cancel') status(errText(e), 'err'); })
      .then(function () { setupLock.reset = false; loading(''); });
  }
  async function resetLock() {
    if (!await ask('Forgot the lock password?\n\nA new password can be set, but EVERY Aadhaar number saved so far is deleted (you type them again). Requests and their history stay.', 'Delete numbers + set new password')) return;
    setupLock.reset = true; setupLock();
  }
  function unlock() {
    if (sr.key) return Promise.resolve(sr.key);
    var L = sr.meta && sr.meta.lock;
    if (!L) { setupLock(); return Promise.reject(new Error('cancel')); }
    return aaModal('🔑 Open Aadhaar numbers', 'Your lock password', function (body) {
      var a = pwBox(body, 'srPwU', 'Lock password');
      a.addEventListener('keydown', function (e) { if (e.key === 'Enter') $('srAaYes').click(); });
      return function () { return a.value; };
    }, 'Open').then(function (pw) {
      loading('Opening...');
      return derive(pw, L.salt).then(function (key) {
        return unseal(key, L.check).then(function (t) {
          if (t !== CHECK) throw new Error('bad');
          sr.key = key; renderLock(); return key;
        });
      }).catch(function (e) {
        if (e && e.message === 'cancel') throw e;
        status('Wrong lock password.', 'err'); throw new Error('cancel');
      }).then(function (k) { loading(''); return k; }, function (e) { loading(''); throw e; });
    });
  }
  // Aadhaar numbers of these requests, opened: { id: {a1, a2} }
  function openAadhaar(ids) {
    if (!isSuper() || !sr.key || !ids.length) return Promise.resolve({});
    return SB.rpc('admin_sr_aadhaar_get', { p_ids: ids }).then(function (rows) {
      var out = {};
      return Promise.all((rows || []).map(function (r) {
        return unseal(sr.key, r.ct).then(function (t) { try { out[r.id] = JSON.parse(t); } catch (_e) { out[r.id] = {}; } }, function () { out[r.id] = {}; });
      })).then(function () { return out; });
    });
  }
  function editAadhaar(r) {
    unlock().then(function () { return openAadhaar([r.id]); }).then(function (have) {
      var cur = have[r.id] || {};
      return aaModal('🪪 Aadhaar · ' + (r.applicant_name || ''), kindLabel(r.kind) + ' · ' + (r.job_card_no || ''), function (body) {
        body.appendChild(el('div', 'Only you can see these. They are locked before saving, appear only in the Block format Excel, and are deleted 30 days after the request is closed. Leave all boxes empty to delete.', 'sr-note-aa'));
        var ins = {};
        (AA[r.kind] || []).forEach(function (f) {
          var l = el('label', f[1], 'f'); l.htmlFor = 'srAa_' + f[0]; body.appendChild(l);
          var i = el('input'); i.type = 'text'; i.id = 'srAa_' + f[0]; i.inputMode = 'numeric'; i.maxLength = 14; i.autocomplete = 'off';
          i.className = 'mono'; i.value = fmtAa(cur[f[0]] || ''); i.placeholder = 'xxxx xxxx xxxx'; body.appendChild(i); ins[f[0]] = i;
        });
        return function () { var v = {}; Object.keys(ins).forEach(function (k) { v[k] = ins[k].value.replace(/\D/g, ''); }); return v; };
      }, '🔒 Save', function (v) {
        var bad = '';
        Object.keys(v).forEach(function (k) { if (v[k] && !aadhaarOk(v[k])) bad = 'Not a valid Aadhaar number: ' + fmtAa(v[k]) + ' (check the digits).'; });
        return bad;
      });
    }).then(function (v) {
      var keys = Object.keys(v).filter(function (k) { return v[k]; });
      var p = !keys.length ? SB.rpc('admin_sr_aadhaar_set', { p_id: r.id, p_ct: null, p_last4: null })
        : seal(sr.key, JSON.stringify(v)).then(function (ct) {
          return SB.rpc('admin_sr_aadhaar_set', { p_id: r.id, p_ct: ct, p_last4: keys.map(function (k) { return v[k].slice(-4); }).join('/') });
        });
      return p.then(function () { status(keys.length ? '🔒 Aadhaar saved (locked).' : 'Aadhaar deleted.', 'ok'); load(); });
    }).catch(function (e) { if (e && e.message !== 'cancel') status(errText(e), 'err'); });
  }

  // ---------------------------------------------------------------- tab + load
  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () {
      var mine = b.dataset.tab === 'sreq';
      $('tab-sreq').classList.toggle('hidden', !mine);
      if (mine) { copyGps(); load(); }
    });
  });
  $('srGp').addEventListener('change', function () { sr.sel.clear(); load(); });
  $('srRefresh').addEventListener('click', load);
  $('srOld').addEventListener('change', function () { sr.all = this.checked; load(); });
  $('srQ').addEventListener('input', render);
  $('srKindF').addEventListener('change', render);
  (function () {
    var s = $('srKindF'); s.appendChild(new Option('All kinds', ''));
    Object.keys(KIND).forEach(function (k) { s.appendChild(new Option(KIND[k][0], k)); });
  })();
  document.querySelectorAll('#srFilters button').forEach(function (b) {
    b.addEventListener('click', function () { sr.filter = b.dataset.f; sr.sel.clear(); render(); });
  });

  var seq = 0;
  function load() {
    var g = gp(); if (!g) return;
    var my = ++seq;
    loading('Loading requests...');
    Promise.all([SB.rpc('admin_sr_meta', { p_gp_id: g }), SB.rpc('admin_service_requests', { p_gp_id: g, p_all: sr.all })]).then(function (r) {
      if (my !== seq) return;
      $('srSetup').textContent = '';
      var keepLock = sr.meta && sr.meta.lock;
      sr.meta = r[0] || {}; if (!sr.meta.lock && keepLock && sr.key) sr.meta.lock = keepLock;
      sr.rows = r[1] || [];
      $('srBlock').value = blockName();
      renderLock(); render(); badge();
    }, function (e) {
      if (e.authLost || my !== seq) return;
      if (missing(e)) { $('srSetup').textContent = SETUP; sr.rows = []; sr.meta = null; render(); return; }
      status(errText(e), 'err');
    }).then(function () { loading(''); });
  }
  function badge() {
    var n = sr.rows.filter(function (r) { return r.status === 'new' && !r.by_admin; }).length;
    $('srBadge').textContent = n ? String(n) : ''; $('srBadge').classList.toggle('hidden', !n);
  }
  // badge of the first GP when the panel opens (Today page counts on its own)
  (function first() {
    var src = $('phGp');
    function go() {
      var g = Number(src.value); if (!g || first.done) return; first.done = true;
      SB.rpc('admin_sr_count', { p_gp_id: g }).then(function (n) {
        if (sr.meta) return; n = Number(n) || 0;
        $('srBadge').textContent = n ? String(n) : ''; $('srBadge').classList.toggle('hidden', !n);
      }, function () {});
    }
    if (src.options.length) go(); else if (window.MutationObserver) new MutationObserver(go).observe(src, { childList: true });
  })();

  $('srBlockSave').addEventListener('click', function () {
    var g = gp(); if (!g) return;
    SB.rpc('admin_sr_set_block', { p_gp_id: g, p_block: $('srBlock').value.trim() }).then(function () {
      if (sr.meta) sr.meta.block_name = $('srBlock').value.trim(); status('Block name saved.', 'ok');
    }, function (e) { if (!e.authLost) status(errText(e), 'err'); });
  });

  // ---------------------------------------------------------------- list
  function inFilter(r) {
    var f = sr.filter, open = ['new', 'working', 'block', 'district'].indexOf(r.status) >= 0;
    if (f === 'open') return open;
    if (f === 'new') return r.status === 'new';
    if (f === 'working') return r.status === 'working';
    if (f === 'sent') return r.status === 'block' || r.status === 'district';
    if (f === 'ekyc') return r.status === 'done' && r.ekyc_needed && !r.ekyc_done_at;
    if (f === 'closed') return !open;
    return true;
  }
  function visible() {
    var k = $('srKindF').value, q = $('srQ').value.trim().toLowerCase();
    return sr.rows.filter(function (r) {
      if (!inFilter(r)) return false;
      if (k && r.kind !== k) return false;
      if (q && [r.job_card_no, r.applicant_name, r.for_name, r.from_name, r.note, r.title].join(' ').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function detailText(r) {
    var d = r.details || {}, out = [];
    if (r.title) out.push(r.title);
    if (d.reason) out.push('Reason: ' + (REASON_TXT[d.reason] || d.reason) + (d.reason_text ? ' (' + d.reason_text + ')' : ''));
    else if (d.reason_text) out.push('Reason: ' + d.reason_text);
    if (d.shift_block || d.shift_gp || d.shift_jc) out.push('Shifted to: ' + [d.shift_block, d.shift_gp, d.shift_jc].filter(Boolean).join(' · '));
    if (d.aadhaar_name) out.push('Name in Aadhaar: ' + d.aadhaar_name);
    if (d.gender) out.push('Gender: ' + d.gender);
    if (d.seeded) out.push('Already seeded: ' + d.seeded);
    if (d.old_hoh || d.new_hoh) out.push('HoH: ' + (d.old_hoh || '?') + ' → ' + (d.new_hoh || '?'));
    if (d.members && d.members.length) out.push(d.members.map(function (m) { return m.name + (m.rel ? ' (' + m.rel + ')' : '') + (m.gender ? ' ' + m.gender : ''); }).join(', '));
    if (d.remarks) out.push(d.remarks);
    if (r.note) out.push('💬 ' + r.note);
    return out;
  }
  function render() {
    var counts = { open: 0, new: 0, working: 0, sent: 0, ekyc: 0, closed: 0, all: sr.rows.length };
    sr.rows.forEach(function (r) {
      var keep = sr.filter; ['open', 'new', 'working', 'sent', 'ekyc', 'closed'].forEach(function (f) { sr.filter = f; if (inFilter(r)) counts[f]++; }); sr.filter = keep;
    });
    document.querySelectorAll('#srFilters button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.f === sr.filter);
      if (!b.dataset.l) b.dataset.l = b.textContent;
      b.textContent = b.dataset.l + ' (' + (counts[b.dataset.f] || 0) + ')';
    });
    var rows = visible(), body = $('srBody'); body.innerHTML = '';
    var ids = {}; rows.forEach(function (r) { ids[r.id] = 1; });
    sr.sel.forEach(function (id) { if (!ids[id]) sr.sel.delete(id); });
    btns();
    $('srAll').checked = rows.length > 0 && rows.every(function (r) { return sr.sel.has(r.id); });
    if (!rows.length) { var tr0 = el('tr'), td0 = el('td', sr.meta ? 'Nothing here.' : '', 'muted'); td0.colSpan = 10; tr0.appendChild(td0); body.appendChild(tr0); return; }
    rows.forEach(function (r) {
      var tr = el('tr'), td = el('td'), cb = el('input'); cb.type = 'checkbox'; cb.checked = sr.sel.has(r.id);
      cb.onchange = function () { if (cb.checked) sr.sel.add(r.id); else sr.sel.delete(r.id); btns(); };
      td.appendChild(cb); tr.appendChild(td);
      var k = el('td'), kb = el('div', kindLabel(r.kind), 'sr-k'); kb.appendChild(el('small', (KIND[r.kind] || ['', ''])[1])); k.appendChild(kb); tr.appendChild(k);
      tr.appendChild(el('td', vno(r.village_no)));
      tr.appendChild(el('td', r.job_card_no || '—'));
      tr.appendChild(el('td', r.applicant_name ? r.applicant_name + (r.applicant_no ? ' (' + r.applicant_no + ')' : '') : '—'));
      var det = el('td'), dv = el('div', null, 'sr-det');
      detailText(r).forEach(function (t, i) { if (i) dv.appendChild(el('br')); dv.appendChild(document.createTextNode(t)); });
      if (isSuper() && AA[r.kind]) {
        var ab = el('button', r.has_aadhaar ? '🪪 ' + String(r.aadhaar_last4 || '').split('/').map(function (x) { return '••' + x; }).join(' / ') : '🪪 Add Aadhaar', 'aa btn-light btn-small');
        ab.type = 'button'; ab.title = 'Aadhaar number(s) for the Block format (only you can see them)'; ab.onclick = function () { editAadhaar(r); };
        dv.appendChild(el('br')); dv.appendChild(ab);
      }
      det.appendChild(dv); tr.appendChild(det);
      tr.appendChild(el('td', r.for_name ? r.for_name + (r.by_admin ? ' · by ' + (r.from_name || 'Admin') : '') : (r.by_admin ? '(Admin only)' : r.from_name || '')));
      tr.appendChild(el('td', fmtDate(r.created_at)));
      var st = el('td'); st.appendChild(el('span', ST[r.status] || r.status, 'pill st-' + r.status));
      if (r.status === 'done' && r.ekyc_needed) st.appendChild(el('span', r.ekyc_done_at ? ' eKYC ✓' : ' eKYC pending', 'pill ' + (r.ekyc_done_at ? 'on' : 'ek')));
      if (r.remark) st.appendChild(el('div', r.remark, 'sr-rm'));
      if (r.updated_at && r.updated_at !== r.created_at) st.appendChild(el('div', fmtDate(r.updated_at), 'muted'));
      tr.appendChild(st);
      var act = el('td'), eb = el('button', '✏', 'btn-light btn-small'); eb.type = 'button'; eb.title = 'Details, history, edit';
      eb.onclick = function () { openForm(r); }; act.appendChild(eb); tr.appendChild(act);
      body.appendChild(tr);
    });
  }
  function picked() { return sr.rows.filter(function (r) { return sr.sel.has(r.id); }); }
  function btns() {
    var none = !sr.sel.size;
    ['srSWorking', 'srSBlock', 'srSDistrict', 'srSDone', 'srSReject', 'srFormat'].forEach(function (id) { $(id).disabled = none; });
  }
  $('srAll').addEventListener('change', function () {
    var on = this.checked; visible().forEach(function (r) { if (on) sr.sel.add(r.id); else sr.sel.delete(r.id); }); render();
  });

  // ---------------------------------------------------------------- status
  function setStatus(st) {
    var rows = picked(); if (!rows.length) return;
    var m = $('srStModal'), t = $('srStText'), chips = $('srStChips');
    $('srStTitle').textContent = (st === 'done' ? '✅ ' : st === 'rejected' ? '✕ ' : '') + ST[st];
    $('srStSub').textContent = rows.length + ' request(s) · the supervisor sees this remark';
    $('srStNeed').textContent = st === 'rejected' ? '(needed)' : '(optional)';
    t.value = ''; chips.innerHTML = '';
    (REMARKS[st] || []).forEach(function (p) {
      var b = el('button', p, 'btn-light btn-small'); b.type = 'button'; b.style.fontSize = '11.5px';
      b.onclick = function () { t.value = p; t.focus(); }; chips.appendChild(b);
    });
    function close() { m.classList.remove('show'); $('srStYes').onclick = $('srStNo').onclick = $('srStClose').onclick = null; }
    $('srStYes').onclick = function () {
      var rm = t.value.trim();
      if (st === 'rejected' && !rm) { t.focus(); status('Write the reason for Reject.', 'err'); return; }
      if (hasAadhaar(rm)) { status(errText({ code: 'NO_AADHAAR' }), 'err'); return; }
      close(); loading('Saving...');
      SB.rpc('admin_sr_set_status', { p_ids: rows.map(function (r) { return r.id; }), p_status: st, p_remark: rm || null })
        .then(function (n) { sr.sel.clear(); status('✔ ' + n + ' request(s): ' + ST[st] + '.', 'ok'); load(); },
              function (e) { if (!e.authLost) status(errText(e), 'err'); })
        .then(function () { loading(''); });
    };
    $('srStNo').onclick = $('srStClose').onclick = close;
    m.classList.add('show'); t.focus();
  }
  $('srSWorking').addEventListener('click', function () { setStatus('working'); });
  $('srSBlock').addEventListener('click', function () { setStatus('block'); });
  $('srSDistrict').addEventListener('click', function () { setStatus('district'); });
  $('srSDone').addEventListener('click', function () { setStatus('done'); });
  $('srSReject').addEventListener('click', function () { setStatus('rejected'); });

  // ---------------------------------------------------------------- new / edit form
  function field(box, label, input) { var l = el('label', label, 'f'); if (input.id) l.htmlFor = input.id; box.appendChild(l); box.appendChild(input); return input; }
  function sel(id, opts, val) { var s = el('select'); s.id = id; opts.forEach(function (o) { s.appendChild(new Option(o[1], o[0])); }); s.value = val || ''; return s; }
  function txt(id, val, max, ph) { var i = el('input'); i.type = 'text'; i.id = id; i.maxLength = max || 200; i.value = val || ''; if (ph) i.placeholder = ph; return i; }

  function openForm(r) {
    var g = gp(); if (!g || !sr.meta) { status(SETUP, 'err'); return; }
    var edit = !!r, f = { kind: r ? r.kind : '', worker: r && r.worker_id ? { worker_id: r.worker_id, job_card_no: r.job_card_no, applicant_name: r.applicant_name, applicant_no: r.applicant_no, village_no: r.village_no, household_no: r.household_no } : null,
                          details: JSON.parse(JSON.stringify((r && r.details) || {})), family: [] };
    var m = $('srModal'), body = $('srMBody'); body.innerHTML = '';
    $('srMTitle').textContent = edit ? kindLabel(r.kind) : '＋ New request';
    $('srMSub').textContent = edit ? (r.applicant_name || '') + (r.job_card_no ? ' · ' + r.job_card_no : '') + ' · ' + (ST[r.status] || r.status) : 'Write a task or a note for a supervisor (e.g. one they told you by phone).';

    if (edit && (r.history || []).length) {
      var h = el('ul', null, 'sr-hist');
      r.history.forEach(function (x) { h.appendChild(el('li', fmtDate(x.at) + ' · ' + (ST[x.st] || x.st) + (x.by ? ' · ' + x.by : '') + (x.rm ? ' — ' + x.rm : ''))); });
      body.appendChild(el('b', '🕘 History')); body.appendChild(h);
    }
    // supervisor
    var sup = sel('srMFor', [['', '— Nobody (Admin only) —']].concat((sr.meta.supervisors || []).map(function (s) { return [s.user_id, s.name + ' (' + s.username + ')']; })),
                  r ? r.for_user || '' : '');
    field(body, 'Supervisor (they see this in the phone app)', sup);
    // kind
    var kinds = Object.keys(KIND).map(function (k) { return [k, KIND[k][0] + ' · ' + KIND[k][1]]; });
    var kindSel = sel('srMKind', [['', '— Pick the task —']].concat(kinds), f.kind); kindSel.disabled = edit;
    field(body, 'Task', kindSel);
    var titleIn = txt('srMTitleIn', r && r.title, 120, 'What is the task?');
    var titleWrap = el('div'); field(titleWrap, 'Task name (for "Other")', titleIn); body.appendChild(titleWrap);
    titleIn.disabled = edit;
    // worker
    var wWrap = el('div'); body.appendChild(wWrap);
    var picked0 = el('div', '', 'muted'), hits = el('div', null, 'sr-hits'), q = txt('srMQ', '', 60, 'Job Card (e.g. 2/118) or name');
    if (!edit) { field(wWrap, 'Worker', q); wWrap.appendChild(hits); }
    wWrap.appendChild(picked0);
    function showPicked() {
      picked0.textContent = f.worker ? '✔ ' + f.worker.applicant_name + ' · ' + f.worker.job_card_no + (f.worker.applicant_no ? ' · App ' + f.worker.applicant_no : '') : (edit ? '' : 'No worker picked yet.');
    }
    var qt = 0;
    q.addEventListener('input', function () {
      clearTimeout(qt); var v = q.value.trim(); if (v.length < 2) { hits.innerHTML = ''; return; }
      qt = setTimeout(function () {
        SB.rpc('admin_sr_find', { p_gp_id: g, p_q: v }).then(function (rows) {
          hits.innerHTML = '';
          (rows || []).forEach(function (w) {
            var b = el('button', vno(w.village_no) + ' · ' + w.job_card_no + ' · ' + w.applicant_no + ' · ' + w.applicant_name + (w.active ? '' : ' (inactive)'));
            b.type = 'button'; if (f.worker && f.worker.worker_id === w.worker_id) b.className = 'on';
            b.onclick = function () { f.worker = w; f.family = []; showPicked(); [].forEach.call(hits.children, function (x) { x.className = ''; }); b.className = 'on'; drawFields(); };
            hits.appendChild(b);
          });
          if (!hits.children.length) hits.appendChild(el('div', 'No worker found.', 'muted'));
        }, function (e) { if (!e.authLost) status(errText(e), 'err'); });
      }, 300);
    });
    showPicked();
    // kind fields
    var fWrap = el('div'); body.appendChild(fWrap);
    var noteIn = el('textarea'); noteIn.id = 'srMNote'; noteIn.rows = 3; noteIn.maxLength = 500; noteIn.value = (r && r.note) || '';
    noteIn.style.cssText = 'width:100%;border:1px solid #cbd5e1;border-radius:9px;padding:8px;font:inherit;';
    var noteLbl = field(body, 'Note', noteIn);
    body.appendChild(el('div', '⚠ Never write an Aadhaar number here. ' + (isSuper() ? 'Use the 🪪 button in the list (locked, only you).' : 'Only the Super Admin can add Aadhaar numbers.'), 'sr-note-aa'));

    function drawFields() {
      var k = kindSel.value; f.kind = k;
      titleWrap.style.display = k === 'other' ? '' : 'none';
      wWrap.style.display = (k === '' ) ? 'none' : '';
      noteLbl.previousSibling.textContent = k === 'note' ? 'Note (needed)' : 'Note (optional)';
      fWrap.innerHTML = '';
      (FIELDS[k] || []).forEach(function (d) {
        if (d.when && !d.when(f.details)) return;
        if (d.members) { drawMembers(fWrap, d.l); return; }
        var inp = d.o ? sel('srMF_' + d.k, d.o, f.details[d.k]) : txt('srMF_' + d.k, f.details[d.k], 200);
        inp.addEventListener(d.o ? 'change' : 'input', function () { f.details[d.k] = inp.value; if (d.k === 'reason') drawFields(); });
        field(fWrap, d.l, inp);
      });
    }
    function drawMembers(box, label) {
      box.appendChild(el('label', label, 'f'));
      var t = el('table', null, 'sr-mem'), tb = el('tbody'); t.appendChild(tb); box.appendChild(t);
      if (!f.details.members) f.details.members = [];
      function row(mm) {
        var tr = el('tr');
        var n = txt('', mm.name, 80, 'Name'), rl = txt('', mm.rel, 40, 'Relation'), gd = sel('', GENDER, mm.gender);
        n.oninput = function () { mm.name = n.value; }; rl.oninput = function () { mm.rel = rl.value; }; gd.onchange = function () { mm.gender = gd.value; };
        var x = el('button', '✕', 'btn-light btn-small'); x.type = 'button';
        x.onclick = function () { f.details.members.splice(f.details.members.indexOf(mm), 1); tr.remove(); };
        [n, rl, gd, x].forEach(function (c) { var td = el('td'); td.appendChild(c); tr.appendChild(td); });
        tb.appendChild(tr);
      }
      f.details.members.forEach(row);
      var add = el('button', '＋ Add applicant', 'btn-light btn-small'); add.type = 'button';
      add.onclick = function () { var mm = { name: '', rel: '', gender: '' }; f.details.members.push(mm); row(mm); };
      box.appendChild(add);
      // fill the Job Card's applicants once
      if (!f.details.members.length && f.worker && f.worker.village_no != null) {
        SB.rpc('admin_sr_find', { p_gp_id: g, p_q: f.worker.village_no + '/' + f.worker.household_no }).then(function (rows) {
          if (f.details.members.length) return;
          (rows || []).filter(function (w) { return w.active; }).forEach(function (w) { var mm = { name: w.applicant_name, rel: '', gender: '' }; f.details.members.push(mm); row(mm); });
        }, function () {});
      }
    }
    kindSel.addEventListener('change', function () { f.details = {}; drawFields(); });
    drawFields();

    function close() { m.classList.remove('show'); $('srMYes').onclick = $('srMNo').onclick = $('srMClose').onclick = null; }
    $('srMYes').textContent = edit ? '💾 Save' : '📤 Save request';
    $('srMYes').onclick = function () {
      var k = kindSel.value, note = noteIn.value.trim(), title = titleIn.value.trim();
      if (!k) { status('Pick the task.', 'err'); return; }
      if (!edit && k !== 'note' && !f.worker) { status('Search and pick the worker.', 'err'); return; }
      if (k === 'other' && !title) { status('Write what the task is.', 'err'); return; }
      if (k === 'note' && !note) { status('Write the note.', 'err'); return; }
      var det = {}; Object.keys(f.details).forEach(function (x) { det[x] = f.details[x]; });
      if (det.members) det.members = det.members.filter(function (mm) { return (mm.name || '').trim(); });
      if (hasAadhaar(note + ' ' + title + ' ' + JSON.stringify(det))) { status(errText({ code: 'NO_AADHAAR' }), 'err'); return; }
      loading('Saving...');
      var p = edit
        ? SB.rpc('admin_sr_edit', { p_id: r.id, p_note: note || null, p_details: det, p_for: sup.value || null, p_set_for: true })
        : SB.rpc('admin_sr_create', { p_gp_id: g, p_for: sup.value || null, p_worker_id: f.worker ? f.worker.worker_id : null, p_kind: k,
                                      p_title: title || null, p_note: note || null, p_details: det });
      p.then(function () { close(); status(edit ? '✔ Saved.' : '✔ Request saved' + (sup.value ? '. The supervisor sees it in the phone app.' : '.'), 'ok'); load(); },
             function (e) { if (!e.authLost) status(errText(e), 'err'); })
       .then(function () { loading(''); });
    };
    $('srMNo').onclick = $('srMClose').onclick = close;
    m.classList.add('show');
  }
  $('srNew').addEventListener('click', function () { openForm(null); });

  // ---------------------------------------------------------------- Excel
  var loadingXlsx = null;
  function loadXlsx() {
    if (window.XLSX && window.XLSX.__styled) return Promise.resolve();
    if (loadingXlsx) return loadingXlsx;
    loadingXlsx = new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = XLSX_URL;
      s.onload = function () { if (window.XLSX) window.XLSX.__styled = true; res(); };
      s.onerror = function () { loadingXlsx = null; rej(new Error('Excel library did not load. Check the internet.')); };
      document.head.appendChild(s);
    });
    return loadingXlsx;
  }
  var BORDER = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  // sheet from rows; marks: {title: row, head: [rows], body: [from, to]} get styles
  function sheet(aoa, merges, cols, marks) {
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = merges.map(function (m) { return XLSX.utils.decode_range(m); });
    ws['!cols'] = cols.map(function (w) { return { wch: w }; });
    var width = cols.length;
    function style(r, s) { for (var c = 0; c < width; c++) { var a = XLSX.utils.encode_cell({ r: r, c: c }); if (!ws[a]) ws[a] = { t: 's', v: '' }; ws[a].s = s; } }
    if (marks.title != null) style(marks.title, { font: { bold: true, sz: 12 }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } });
    (marks.head || []).forEach(function (r) { style(r, { font: { bold: true, sz: 10 }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border: BORDER, fill: { fgColor: { rgb: 'F1F5F9' } } }); });
    if (marks.body) for (var r = marks.body[0]; r <= marks.body[1]; r++) style(r, { font: { sz: 10 }, alignment: { vertical: 'center', wrapText: true }, border: BORDER });
    (marks.bold || []).forEach(function (r) { for (var c = 0; c < width; c++) { var a = XLSX.utils.encode_cell({ r: r, c: c }); if (ws[a] && ws[a].v !== '') ws[a].s = { font: { bold: true, sz: 10 }, alignment: { wrapText: true } }; } });
    var rowsH = []; if (marks.head) marks.head.forEach(function (r) { rowsH[r] = { hpt: 42 }; }); ws['!rows'] = rowsH;
    return ws;
  }
  function bdo(block) { return block ? block + ' Development Block' : '________________ Development Block'; }
  function gender(g) { return g || ''; }

  var FORMATS = {
    aadhaar_wrong_seed: function (rows, aa) {
      var aoa = [['Format for Update Aadhaar against different applicants within a same Jobcard seeded wrongly in earlier', '', '', '', '', '', '', '', ''],
                 ['Sl No', 'Gram Panchayat', 'Job Card No.', 'Name of the Applicant', 'Aadhaar No. seeded in MIS (Wrongly)', 'Actual Aadhaar No. which needs to seed now',
                  'Name of the applicant recorded in Aadhaar Card', 'Gender of the applicant recorded in Aadhaar Card', 'Whether Aadhaar already seeded in MIS (Yes/No)']];
      rows.forEach(function (r, i) { var d = r.details || {}, a = aa[r.id] || {};
        aoa.push([i + 1, gpName(), r.job_card_no, r.applicant_name, fmtAa(a.a1), fmtAa(a.a2), d.aadhaar_name || '', gender(d.gender), d.seeded || '']); });
      return { name: 'Update Aadhaar against differen', ws: sheet(aoa, ['A1:I1'], [6, 16, 26, 24, 20, 20, 24, 14, 14], { title: 0, head: [1], body: [2, aoa.length - 1] }) };
    },
    aadhaar_delink: function (rows, aa) {
      var aoa = [['De-link Aadhaar:', '', '', '', '', '', '', '', '', '', ''],
                 ['Sl. No.', 'Block Name', 'GP Name', 'Name of Worker', 'Job Card  No.', 'Aadhaar No.', 'Name as per Aadhaar', 'Annexure - A', '', '', ''],
                 ['', '', '', '(as per Job card)', '(as shown in MIS)', '(already frozen in MIS)', '', 'Reason for Removal/Deletion', 'Name of Shifted Block', 'Name of Shifted GP', 'New (shifted) Job card number (as shown in MIS)']];
      rows.forEach(function (r, i) { var d = r.details || {}, a = aa[r.id] || {};
        var why = (REASON_TXT[d.reason] || '') + (d.reason_text ? (d.reason ? ' – ' : '') + d.reason_text : '');
        aoa.push([i + 1, blockName(), gpName(), r.applicant_name, r.job_card_no, fmtAa(a.a1), d.aadhaar_name || '', why, d.shift_block || '', d.shift_gp || '', d.shift_jc || '']); });
      var end = aoa.length - 1;
      aoa.push([]); aoa.push(['Photocopy of Aadhaar cards attached herein.']); aoa.push([]);
      var s1 = aoa.length; aoa.push(['', '', '', '', '', '', '', '', '', 'Block Development Officer', '']);
      aoa.push(['', '', '', '', '', '', '', '', '', '& Programme Officer, VBGRAMG', '']);
      aoa.push(['', '', '', '', '', '', '', '', '', bdo(blockName()), '']);
      var merges = ['A1:K1', 'H2:K2', 'G2:G3', 'J' + (s1 + 1) + ':K' + (s1 + 1), 'J' + (s1 + 2) + ':K' + (s1 + 2), 'J' + (s1 + 3) + ':K' + (s1 + 3)];
      return { name: 'Delink Aadhar', ws: sheet(aoa, merges, [6, 14, 16, 24, 26, 18, 22, 22, 16, 16, 24], { title: 0, head: [1, 2], body: [3, end], bold: [end + 2] }) };
    },
    name_mismatch: function (rows, aa) {
      var aoa = [['Format for Mismatching name in VBGRAM G Soft and UIDAI-Aadhaar', '', '', '', '', '', '', '', ''],
                 ['SL No', 'Gram Panchayat', 'Jobcard No', 'Name of the Applicant \n(as per NREGASoft)', 'Gender (Male/Female)', 'Name of the Applicant (as per Aadhaar Card)', 'Aadhaar Card Number ', 'Photocopy of Aadhaar attached (Yes/No)', 'Remarks, if any']];
      rows.forEach(function (r, i) { var d = r.details || {}, a = aa[r.id] || {};
        aoa.push([i + 1, gpName(), r.job_card_no, r.applicant_name, gender(d.gender), d.aadhaar_name || '', fmtAa(a.a1), 'Yes', d.remarks || '']); });
      var end = aoa.length - 1; aoa.push([]);
      var dc = aoa.length; aoa.push(['I hereby declare that Aadhaar details entered here belongs to the same worker/applicant in the job card even though the workers/applicant name in job card and aadhaar card is mismatching.']);
      aoa.push(['Photocopy of Aadhaar card attached herein.']); aoa.push([]);
      aoa.push(['', '', '', '', '', 'Block Development Officer & Programme Officer, VBGRAM G', '', '', '']);
      var s2 = aoa.length; aoa.push(['', '', '', bdo(blockName()), '', '', '', '', '']);
      var merges = ['A1:I1', 'A' + (dc + 1) + ':I' + (dc + 1), 'A' + (dc + 2) + ':D' + (dc + 2), 'D' + (s2 + 1) + ':H' + (s2 + 1)];
      return { name: 'Mismatching name in VBGRAM G', ws: sheet(aoa, merges, [6, 16, 26, 24, 12, 24, 18, 14, 18], { title: 0, head: [1], body: [2, end] }) };
    },
    gender_hoh: function (rows) {
      var aoa = [['Format for Gender updation of Applicant', '', '', '', '', '', ''],
                 ['Gram Panchayat', 'Full Job Card No as per NREGASoft', 'Name of the Existing HoH', 'Name of the new HoH (If new HoH is same as the existing HoH, then write “Same” in the column',
                  'Write all Applicant name exist currently in the Job Card', "Applicant's Relationship with new HoH", 'Gender of the Applicant']];
      rows.forEach(function (r) { var d = r.details || {}, mem = (d.members && d.members.length) ? d.members : [{ name: r.applicant_name, rel: '', gender: d.gender || '' }];
        mem.forEach(function (mm, i) { aoa.push(i ? ['', '', '', '', mm.name, mm.rel, mm.gender] : [gpName(), r.job_card_no, d.old_hoh || '', d.new_hoh || '', mm.name, mm.rel, mm.gender]); }); });
      var end = aoa.length - 1; aoa.push([]);
      aoa.push(['', '', '', '', 'Block Development Officer & Programme Officer, VBGRAM G ', '', '']);
      var s = aoa.length; aoa.push(['', '', '', '', bdo(blockName()), '', '']);
      var merges = ['A1:G1', 'E' + s + ':G' + s, 'E' + (s + 1) + ':G' + (s + 1)];
      return { name: 'Gender updation of Applicant', ws: sheet(aoa, merges, [16, 26, 22, 26, 26, 18, 12], { title: 0, head: [1], body: [2, end] }) };
    }
  };
  $('srFormat').addEventListener('click', async function () {
    var rows = picked(); if (!rows.length) return;
    var kinds = rows.map(function (r) { return r.kind; }).filter(function (k, i, a) { return a.indexOf(k) === i; });
    if (kinds.length !== 1 || FORMAT_KINDS.indexOf(kinds[0]) < 0) {
      status('Tick requests of ONE kind that has a Block format: ' + FORMAT_KINDS.map(kindLabel).join(', ') + '. For other kinds use ⭳ Excel list.', 'err'); return;
    }
    var k = kinds[0];
    if (!blockName() && (k === 'aadhaar_delink')) status('Tip: write the Block name above and press Save — the format has a Block Name column.', 'info');
    var aaP = Promise.resolve({});
    if (AA[k]) {
      if (isSuper() && rows.some(function (r) { return r.has_aadhaar; })) {
        aaP = unlock().then(function () { return openAadhaar(rows.map(function (r) { return r.id; })); }, function () { return {}; });
      }
    }
    var aa = await aaP;
    loading('Making the Excel...');
    loadXlsx().then(function () {
      var sh = FORMATS[k](rows, aa), wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sh.ws, sh.name.slice(0, 31));
      XLSX.writeFile(wb, (KIND[k][0].replace(/^\S+\s/, '').replace(/[^A-Za-z0-9]+/g, '_') + '_' + gpName().replace(/[^A-Za-z0-9]+/g, '_') + '_' + new Date().toISOString().slice(0, 10) + '.xlsx'));
      loading('');
      var blank = AA[k] && rows.filter(function (r) { return !(aa[r.id] && aa[r.id].a1); }).length;
      status('📥 Block format downloaded (' + rows.length + ' row(s)).' + (blank ? ' Aadhaar No. is empty for ' + blank + ' — write it by hand or add it with 🪪.' : ''), 'ok');
      var open = rows.filter(function (r) { return r.status === 'new' || r.status === 'working'; });
      if (open.length) {
        ask('Mark these ' + open.length + ' request(s) as "Sent to Block" now? The supervisors see it.', '📤 Sent to Block', 'ok').then(function (y) {
          if (!y) return;
          SB.rpc('admin_sr_set_status', { p_ids: open.map(function (r) { return r.id; }), p_status: 'block', p_remark: 'Block-এ পাঠানো হয়েছে' })
            .then(function () { sr.sel.clear(); load(); }, function (e) { if (!e.authLost) status(errText(e), 'err'); });
        });
      }
    }, function (e) { loading(''); status(e.message || String(e), 'err'); });
  });
  $('srXlsx').addEventListener('click', function () {
    var rows = sr.sel.size ? picked() : visible(); if (!rows.length) { status('Nothing to download.', 'err'); return; }
    loadXlsx().then(function () {
      var aoa = [['Sl', 'Task', 'Status', 'Village', 'Job Card No', 'App', 'Name', 'Details', 'Supervisor', 'Written by', 'Sent on', 'Remark', 'Last change', 'eKYC']];
      rows.forEach(function (r, i) {
        aoa.push([i + 1, kindLabel(r.kind).replace(/^\S+\s/, ''), ST[r.status] || r.status, vno(r.village_no), r.job_card_no || '', r.applicant_no || '', r.applicant_name || '',
                  detailText(r).join(' | '), r.for_name || '', r.from_name || '', fmtDate(r.created_at), r.remark || '', fmtDate(r.updated_at),
                  r.ekyc_needed ? (r.ekyc_done_at ? 'Done ' + fmtDay(r.ekyc_done_at) : 'Pending') : '']);
      });
      var ws = sheet(aoa, [], [4, 26, 14, 7, 26, 5, 24, 50, 18, 18, 16, 30, 16, 12], { head: [0], body: [1, aoa.length - 1] });
      var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Requests');
      XLSX.writeFile(wb, 'Supervisor_requests_' + gpName().replace(/[^A-Za-z0-9]+/g, '_') + '_' + new Date().toISOString().slice(0, 10) + '.xlsx');
    }, function (e) { status(e.message || String(e), 'err'); });
  });

  window.AdminRequests = { reload: load };
})();
