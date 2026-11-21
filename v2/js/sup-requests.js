/* =====================================================================
   Supervisor app — "📨 অনুরোধ ও নোট" (SQL v234).
   The supervisor asks the Admin for a task (Aadhaar Delink, name / gender
   correction, new applicant, payment problem, other) or sends a note, and
   sees every status change the Admin makes (New → কাজ চলছে → Block /
   District-এ পাঠানো → হয়ে গেছে / হবে না) with the Admin's remark.
   Notes the Admin sends to this supervisor show here too ("দেখেছি").
   When an Aadhaar related task is done the worker's eKYC must be done again.
   NEVER asks for an Aadhaar number: any text with one is refused here and
   again by the database.
   Uses the main page's helpers (setSection, showStatus, escapeHtml, vLabel,
   shortJobCard, askYesNo, gsTask, gramgAdapter).
   ===================================================================== */
/* global gramgAdapter, currentUser, setSection, showStatus, escapeHtml, vLabel, shortJobCard, askYesNo, gsTask, renderGsBar, renderHome, curSection */
(function () {
  'use strict';
  var KIND = {
    aadhaar_delink: { t: 'Aadhaar Delink', i: '🪪', s: 'Job Card থেকে Aadhaar সরানো' },
    aadhaar_wrong_seed: { t: 'ভুল applicant-এ Aadhaar', i: '🪪', s: 'একই Job Card-এ অন্যজনের Aadhaar বসে গেছে' },
    name_mismatch: { t: 'নামের অমিল', i: '🪪', s: 'Job Card আর Aadhaar-এ নাম আলাদা' },
    gender_hoh: { t: 'লিঙ্গ / HoH বদল', i: '⚧', s: 'লিঙ্গ ভুল বা পরিবারের প্রধান বদল' },
    applicant_add: { t: 'নতুন Applicant যোগ', i: '➕', s: 'Job Card-এ নতুন সদস্য' },
    payment: { t: 'Payment সমস্যা', i: '💸', s: 'টাকা আসেনি, Rejected ইত্যাদি' },
    other: { t: 'অন্য কাজ', i: '📌', s: 'নিজে লিখুন' },
    note: { t: 'Admin-কে নোট', i: '📝', s: 'যেকোনো কথা লিখে পাঠান' }
  };
  var ORDER = ['aadhaar_delink', 'aadhaar_wrong_seed', 'name_mismatch', 'gender_hoh', 'applicant_add', 'payment', 'other', 'note'];
  var ST = { new: 'নতুন', working: 'কাজ চলছে', block: 'Block-এ পাঠানো', district: 'District-এ পাঠানো', done: 'হয়ে গেছে ✓',
             rejected: 'হবে না', cancelled: 'বাতিল', seen: 'দেখেছি', ekyc: 'eKYC হয়েছে' };
  var GENDER = [['', '— বাছুন —'], ['Male', 'পুরুষ (Male)'], ['Female', 'মহিলা (Female)'], ['Transgender', 'Transgender']];
  var FIELDS = {
    aadhaar_delink: [
      { k: 'reason', l: 'কেন সরাতে হবে', o: [['', '— বাছুন —'], ['dead', 'মৃত্যু হয়েছে'], ['shifted', 'অন্য GP / Block-এ চলে গেছে'], ['duplicate', 'ডুপ্লিকেট'], ['wrong', 'ভুল করে seed হয়েছে'], ['other', 'অন্য কারণ']] },
      { k: 'reason_text', l: 'কারণ লিখুন (ইচ্ছা হলে)' },
      { k: 'shift_block', l: 'কোন Block-এ গেছে', when: function (d) { return d.reason === 'shifted'; } },
      { k: 'shift_gp', l: 'কোন GP-তে গেছে', when: function (d) { return d.reason === 'shifted'; } },
      { k: 'shift_jc', l: 'নতুন Job Card নম্বর (জানা থাকলে)', when: function (d) { return d.reason === 'shifted'; } },
      { k: 'aadhaar_name', l: 'Aadhaar-এ লেখা নাম (ইংরেজিতে)' }],
    aadhaar_wrong_seed: [
      { k: 'aadhaar_name', l: 'Aadhaar card-এ লেখা নাম (ইংরেজিতে)' },
      { k: 'gender', l: 'Aadhaar card-এ লেখা লিঙ্গ', o: GENDER },
      { k: 'seeded', l: 'Portal-এ (MIS) Aadhaar আগে থেকে seed আছে?', o: [['', '— বাছুন —'], ['Yes', 'হ্যাঁ (Yes)'], ['No', 'না (No)']] }],
    name_mismatch: [
      { k: 'aadhaar_name', l: 'Aadhaar card-এ লেখা নাম (ইংরেজিতে)' },
      { k: 'gender', l: 'লিঙ্গ', o: GENDER },
      { k: 'remarks', l: 'আর কিছু বলার থাকলে' }],
    gender_hoh: [
      { k: 'old_hoh', l: 'এখনকার HoH (পরিবারের প্রধান)-এর নাম' },
      { k: 'new_hoh', l: 'নতুন HoH-এর নাম (একই থাকলে লিখুন Same)' },
      { k: 'members', l: 'Job Card-এর সবার নতুন HoH-এর সঙ্গে সম্পর্ক আর লিঙ্গ', members: true }]
  };
  var AA_KINDS = ['aadhaar_delink', 'aadhaar_wrong_seed', 'name_mismatch', 'gender_hoh'];

  var rq = { rows: null, at: 0, busy: false, view: 'list', open: {}, f: null, setup: false };
  window.reqRows = function () { return rq.rows || []; };

  // ---------- Aadhaar check (Verhoeff): a typed Aadhaar number is refused before sending ----------
  var VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],
            [5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
  var VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],
            [4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
  function hasAadhaar(text) {
    var re = /(^|\D)([2-9]\d{3}[ -]?\d{4}[ -]?\d{4})(?!\d)/g, m;
    while ((m = re.exec(String(text || '')))) {
      var s = m[2].replace(/\D/g, ''), c = 0;
      for (var i = 0; i < 12; i++) c = VD[c][VP[i % 8][Number(s.charAt(11 - i))]];
      if (c === 0) return true;
    }
    return false;
  }

  function esc(s) { return escapeHtml(s == null ? '' : String(s)); }
  function dt(s) {
    if (!s) return '';
    try { return new Date(s).toLocaleDateString('bn-IN', { day: 'numeric', month: 'short' }) + ' ' + new Date(s).toLocaleTimeString('bn-IN', { hour: 'numeric', minute: '2-digit' }); }
    catch (e) { return String(s).slice(0, 10); }
  }
  function body() { return document.getElementById('reqBody'); }
  function isUnreadNote(r) { return r.kind === 'note' && r.by_admin && ['done', 'rejected', 'cancelled'].indexOf(r.status) < 0; }
  function ekycLeft(r) { return r.status === 'done' && r.ekyc_needed && !r.ekyc_done_at; }
  function badgeN() { return (rq.rows || []).filter(function (r) { return r.unseen || isUnreadNote(r) || ekycLeft(r); }).length; }

  // ---------- load ----------
  window.loadReqs = function (force) {
    if (!currentUser || !gramgAdapter.srMy || rq.busy) return;
    if (!force && rq.rows && Date.now() - rq.at < 2 * 60000) return;
    rq.busy = true;
    gramgAdapter.srMy().then(function (rows) {
      rq.busy = false; rq.at = Date.now(); rq.setup = rows === null; rq.rows = rows || [];
      paintBadge();
      if (curSection === 'req' && rq.view === 'list') renderList();
      if (curSection === 'home' && typeof renderHome === 'function') renderHome();
    }, function () { rq.busy = false; rq.at = Date.now(); });
  };
  function paintBadge() {
    var n = badgeN(), b = document.getElementById('gsNReq'); if (b) b.textContent = n ? String(n) : '';
  }

  // ---------- Home: eKYC to do + Admin notes in "আজকের কাজ" ----------
  window.reqHomeTasks = function (tk) {
    paintBadge();
    (rq.rows || []).filter(ekycLeft).slice(0, 2).forEach(function (r) {
      tk.appendChild(gsTask('t-req', 'eKYC আবার করুন · ' + esc(KIND[r.kind] ? KIND[r.kind].t : ''),
        esc(r.applicant_name || '') + ' <small>(' + esc(shortJobCard(r.job_card_no || '')) + ')</small>', '<span class="nh-btn">দেখুন</span>', function () { openReq(r.id); }));
    });
    (rq.rows || []).filter(isUnreadNote).slice(0, 2).forEach(function (r) {
      tk.appendChild(gsTask('t-req', '📝 Admin-এর নোট', esc((r.note || '').slice(0, 80)), '<span class="nh-btn">পড়ুন</span>', function () { openReq(r.id); }));
    });
  };
  function openReq(id) { rq.view = 'list'; if (id) rq.open[id] = true; setSection('req'); }

  // ---------- page ----------
  window.reqTitle = function () {
    if (rq.view === 'form') return { t: '📨 নতুন অনুরোধ', sub: rq.f && rq.f.kind ? KIND[rq.f.kind].t : 'কী কাজ বাছুন' };
    var open = (rq.rows || []).filter(function (r) { return ['new', 'working', 'block', 'district'].indexOf(r.status) >= 0; }).length;
    return { t: '📨 অনুরোধ ও নোট', sub: open ? open + 'টা চলছে' : 'Admin-এর কাছে কাজ পাঠান' };
  };
  window.reqBack = function () { if (rq.view === 'form') { rq.view = 'list'; renderList(); renderGsBar(); return true; } return false; };
  window.openReqPage = function () {
    if (rq.view !== 'form') renderList();
    window.loadReqs(true);
    // the supervisor has looked: Admin changes are seen (the red number goes after a moment)
    setTimeout(function () {
      if (curSection !== 'req' || !(rq.rows || []).some(function (r) { return r.unseen; })) return;
      gramgAdapter.srSeen().then(function () { (rq.rows || []).forEach(function (r) { r.unseen = false; }); paintBadge(); });
    }, 4000);
  };

  function renderList() {
    var b = body(); if (!b) return;
    b.innerHTML = '';
    var add = document.createElement('button'); add.type = 'button'; add.className = 'rq-add';
    add.innerHTML = '<b>＋ নতুন অনুরোধ / নোট</b><small>Aadhaar Delink, নামের অমিল, লিঙ্গ বদল, Payment সমস্যা, নোট…</small>';
    add.onclick = startForm; b.appendChild(add);
    if (rq.setup) { b.insertAdjacentHTML('beforeend', '<div class="selected-empty">এই অংশ এখনো চালু হয়নি। Admin-কে বলুন (SQL v234)।</div>'); return; }
    if (!rq.rows) { b.insertAdjacentHTML('beforeend', '<div class="ac-hint">আনছি...</div>'); return; }
    var rows = rq.rows.slice();
    var groups = [
      ['⚠ eKYC আবার করাতে হবে', rows.filter(ekycLeft)],
      ['📝 Admin-এর নোট', rows.filter(isUnreadNote)],
      ['⏳ চলছে', rows.filter(function (r) { return !ekycLeft(r) && !isUnreadNote(r) && ['new', 'working', 'block', 'district'].indexOf(r.status) >= 0; })],
      ['✓ শেষ (৩০ দিন)', rows.filter(function (r) { return !ekycLeft(r) && !isUnreadNote(r) && ['done', 'rejected', 'cancelled'].indexOf(r.status) >= 0; })]
    ];
    if (!rows.length) b.insertAdjacentHTML('beforeend', '<div class="selected-empty">এখনো কোনো অনুরোধ নেই। উপরের "＋ নতুন অনুরোধ" চাপুন।</div>');
    groups.forEach(function (g) {
      if (!g[1].length) return;
      b.insertAdjacentHTML('beforeend', '<div class="rq-gh">' + g[0] + ' <span>' + g[1].length + '</span></div>');
      g[1].forEach(function (r) { b.appendChild(card(r)); });
    });
  }
  function card(r) {
    var k = KIND[r.kind] || { t: r.kind, i: '📌' }, c = document.createElement('div');
    c.className = 'rq-card st-' + r.status + (r.unseen ? ' unseen' : '') + (ekycLeft(r) ? ' ek' : '');
    var who = r.applicant_name ? esc(r.applicant_name) + ' <small>' + esc(shortJobCard(r.job_card_no || '')) + (r.applicant_no ? ' · ' + esc(r.applicant_no) : '') + '</small>' : '';
    var h = '<button type="button" class="rq-top"><span class="rq-k">' + k.i + ' ' + esc(r.kind === 'other' && r.title ? r.title : r.kind === 'note' && r.by_admin ? 'Admin-এর নোট' : k.t) + '</span><span class="rq-st st-' + r.status + '">' + esc(ST[r.status] || r.status) + '</span></button>';
    if (who) h += '<div class="rq-who">' + who + '</div>';
    if (r.note) h += '<div class="rq-note">' + (r.by_admin ? '' : '💬 ') + esc(r.note) + '</div>';
    if (r.remark) h += '<div class="rq-rm"><b>Admin:</b> ' + esc(r.remark) + '</div>';
    if (ekycLeft(r)) h += '<div class="rq-ek">⚠ কাজ হয়ে গেছে। এখন ' + esc(r.applicant_name || 'worker') + '-এর eKYC আবার করান।</div>';
    h += '<div class="rq-when">' + esc(dt(r.updated_at || r.created_at)) + (r.by_admin && r.kind !== 'note' ? ' · Admin লিখেছেন' : '') + '</div>';
    c.innerHTML = h;
    var more = document.createElement('div'); more.className = 'rq-more'; more.style.display = rq.open[r.id] ? '' : 'none';
    var hist = '<ul class="rq-hist">' + (r.history || []).map(function (x) {
      return '<li><b>' + esc(ST[x.st] || x.st) + '</b> · ' + esc(dt(x.at)) + (x.by ? ' · ' + esc(x.by) : '') + (x.rm ? '<br>' + esc(x.rm) : '') + '</li>';
    }).join('') + '</ul>';
    more.innerHTML = detailHtml(r) + hist;
    var acts = document.createElement('div'); acts.className = 'rq-acts';
    function act(label, cls, fn) { var x = document.createElement('button'); x.type = 'button'; x.className = cls; x.textContent = label; x.onclick = fn; acts.appendChild(x); }
    if (ekycLeft(r)) act('✓ eKYC করানো হয়েছে', 'btn-success', function () { doAct(gramgAdapter.srEkycDone(r.id), 'ধন্যবাদ, Admin জানতে পারবেন।'); });
    if (isUnreadNote(r)) act('✓ দেখেছি', 'btn-primary', function () { doAct(gramgAdapter.srAck(r.id), 'Admin জানতে পারবেন যে আপনি দেখেছেন।'); });
    if (r.status === 'new' && !r.by_admin) act('বাতিল করুন', 'btn-light', function () {
      askYesNo({ icon: '🗑', title: 'অনুরোধ বাতিল করবেন?', msg: (k.t) + (r.applicant_name ? ' · ' + r.applicant_name : ''), yes: 'বাতিল করুন', no: 'না' }).then(function (y) {
        if (y) doAct(gramgAdapter.srCancel(r.id), 'অনুরোধ বাতিল হয়েছে।');
      });
    });
    if (acts.children.length) more.appendChild(acts);
    if (rq.open[r.id] && acts.children.length) more.style.display = '';
    c.appendChild(more);
    c.querySelector('.rq-top').onclick = function () { rq.open[r.id] = !rq.open[r.id]; more.style.display = rq.open[r.id] ? '' : 'none'; };
    if (ekycLeft(r) || isUnreadNote(r)) more.style.display = '';
    return c;
  }
  function detailHtml(r) {
    var d = r.details || {}, out = [], F = FIELDS[r.kind] || [];
    F.forEach(function (f) {
      if (f.members) { if (d.members && d.members.length) out.push('<b>সদস্য:</b> ' + d.members.map(function (m) { return esc(m.name) + (m.rel ? ' (' + esc(m.rel) + ')' : '') + (m.gender ? ' ' + esc(m.gender) : ''); }).join(', ')); return; }
      if (!d[f.k]) return;
      var v = d[f.k]; if (f.o) f.o.forEach(function (o) { if (o[0] === v) v = o[1]; });
      out.push('<b>' + esc(f.l) + ':</b> ' + esc(v));
    });
    return out.length ? '<div class="rq-det">' + out.join('<br>') + '</div>' : '';
  }
  function doAct(p, ok) {
    p.then(function () { showStatus(ok, 'success'); window.loadReqs(true); }, function (e) { if (e && e.authLost) return; showStatus((e && e.message) || String(e), 'error'); window.loadReqs(true); });
  }

  // ---------- new request form (one page, three parts) ----------
  function startForm() { rq.view = 'form'; rq.f = { kind: '', worker: null, details: {}, note: '', title: '' }; renderForm(); renderGsBar(); window.scrollTo(0, 0); }
  function renderForm() {
    var b = body(), f = rq.f; if (!b) return;
    b.innerHTML = '';
    b.insertAdjacentHTML('beforeend', '<div class="rq-step">① কী কাজ?</div>');
    if (f.kind) {   // picked: one line with "বদলান", so the rest of the form is near the top
      var kp = document.createElement('div'); kp.className = 'rq-picked';
      kp.innerHTML = '<span><b>' + KIND[f.kind].i + ' ' + esc(KIND[f.kind].t) + '</b><small>' + esc(KIND[f.kind].s) + '</small></span>';
      var kc = document.createElement('button'); kc.type = 'button'; kc.className = 'btn-light btn-small'; kc.textContent = 'বদলান';
      kc.onclick = function () { f.kind = ''; f.details = {}; renderForm(); renderGsBar(); };
      kp.appendChild(kc); b.appendChild(kp);
    } else renderKinds(b, f);
    if (!f.kind) return;
    renderRest(b, f);
  }
  function renderKinds(b, f) {
    var grid = document.createElement('div'); grid.className = 'rq-kinds';
    ORDER.forEach(function (k) {
      var x = document.createElement('button'); x.type = 'button'; x.className = 'rq-kind' + (f.kind === k ? ' on' : '');
      x.innerHTML = '<i>' + KIND[k].i + '</i><b>' + esc(KIND[k].t) + '</b><small>' + esc(KIND[k].s) + '</small>';
      x.onclick = function () { f.kind = k; f.details = {}; renderForm(); renderGsBar(); };
      grid.appendChild(x);
    });
    b.appendChild(grid);
    // the two tasks that already have their own place
    var other = document.createElement('div'); other.className = 'rq-elsewhere';
    other.innerHTML = '<div><b>🗑 Applicant / Job Card Delete?</b> মৃত, স্থায়ী Migrant বা ডুপ্লিকেট হলে eKYC / ABPS পাতায় worker-এর পাশে "⋯ মৃত / Migrant" চাপুন।</div>' +
      '<button type="button" class="btn-light btn-small" data-go="abps">eKYC / ABPS খুলুন</button>' +
      '<div style="margin-top:8px;"><b>🏦 Bank Account বদল?</b> Bank Account পাতা থেকে passbook-এর ছবি পাঠান।</div>' +
      '<button type="button" class="btn-light btn-small" data-go="acc">Bank Account খুলুন</button>';
    [].forEach.call(other.querySelectorAll('[data-go]'), function (x) { x.onclick = function () { rq.view = 'list'; setSection(x.dataset.go); }; });
    b.appendChild(other);
  }
  function renderRest(b, f) {
    // ② worker
    b.insertAdjacentHTML('beforeend', '<div class="rq-step">② কোন worker?' + (f.kind === 'note' ? ' <small>(না বাছলেও চলবে)</small>' : '') + '</div>');
    var wbox = document.createElement('div'); b.appendChild(wbox);
    if (f.worker) {
      var pk = document.createElement('div'); pk.className = 'rq-picked';
      pk.innerHTML = '<span><b>' + esc(f.worker.applicant_name) + '</b><small>' + esc(shortJobCard(f.worker.job_card_no || '')) + ' · ' + esc(vLabel(f.worker.village_no, 'Village')) + '</small></span>';
      var ch = document.createElement('button'); ch.type = 'button'; ch.className = 'btn-light btn-small'; ch.textContent = 'বদলান';
      ch.onclick = function () { f.worker = null; f.details.members = undefined; renderForm(); };
      pk.appendChild(ch); wbox.appendChild(pk);
    } else {
      var q = document.createElement('input'); q.type = 'search'; q.className = 'ac-search'; q.placeholder = '🔎 নাম বা Job Card (যেমন 16/98)'; q.autocomplete = 'off';
      var res = document.createElement('div'); wbox.appendChild(q); wbox.appendChild(res);
      var t = 0;
      q.addEventListener('input', function () {
        clearTimeout(t); var v = q.value.trim(); if (v.length < 2) { res.innerHTML = ''; return; }
        t = setTimeout(function () {
          res.innerHTML = '<div class="ac-hint">খুঁজছি...</div>';
          gramgAdapter.searchAccountWorker(v).then(function (rows) {
            res.innerHTML = '';
            if (!rows.length) { res.innerHTML = '<div class="ac-hint">কাউকে পাওয়া যায়নি।</div>'; return; }
            rows.forEach(function (w) {
              var x = document.createElement('button'); x.type = 'button'; x.className = 'rq-hit';
              x.innerHTML = '<b>' + esc(w.applicant_name) + '</b><small>' + esc(shortJobCard(w.job_card_no || '')) + ' · App ' + esc(w.applicant_no) + ' · ' + esc(vLabel(w.village_no)) + '</small>';
              x.onclick = function () { f.worker = w; renderForm(); };
              res.appendChild(x);
            });
          }, function (e) { res.innerHTML = '<div class="ph-err">' + esc((e && e.message) || String(e)) + '</div>'; });
        }, 400);
      });
      setTimeout(function () { q.focus(); }, 50);
    }
    if (!f.worker && f.kind !== 'note') return;

    // ③ details + note
    b.insertAdjacentHTML('beforeend', '<div class="rq-step">③ বিবরণ</div>');
    var form = document.createElement('div'); form.className = 'rq-form'; b.appendChild(form);
    if (f.kind === 'other') form.appendChild(inp('title', 'কী কাজ (ছোট করে)', f.title, function (v) { f.title = v; }));
    (FIELDS[f.kind] || []).forEach(function (d) {
      if (d.when && !d.when(f.details)) return;
      if (d.members) { form.appendChild(members(d.l)); return; }
      if (d.o) {
        var w = document.createElement('label'); w.textContent = d.l;
        var s = document.createElement('select'); d.o.forEach(function (o) { s.appendChild(new Option(o[1], o[0])); }); s.value = f.details[d.k] || '';
        s.onchange = function () { f.details[d.k] = s.value; if (d.k === 'reason') renderForm(); };
        w.appendChild(s); form.appendChild(w); return;
      }
      form.appendChild(inp(d.k, d.l, f.details[d.k], function (v) { f.details[d.k] = v; }));
    });
    var nl = document.createElement('label'); nl.textContent = f.kind === 'note' ? 'নোট লিখুন' : 'Admin-কে কিছু বলার থাকলে (ইচ্ছা হলে)';
    var ta = document.createElement('textarea'); ta.rows = 3; ta.maxLength = 500; ta.value = f.note || ''; ta.oninput = function () { f.note = ta.value; };
    nl.appendChild(ta); form.appendChild(nl);
    form.insertAdjacentHTML('beforeend', '<div class="rq-warn">⚠ কোথাও Aadhaar নম্বর লিখবেন না। Aadhaar card-এর photocopy সরাসরি Admin-কে দিন।' +
      (AA_KINDS.indexOf(f.kind) >= 0 ? ' কাজ হয়ে গেলে worker-এর eKYC আবার করাতে হবে।' : '') + '</div>');
    var send = document.createElement('button'); send.type = 'button'; send.className = 'rq-send'; send.textContent = '📤 Admin-কে পাঠান';
    send.onclick = submit; b.appendChild(send);
  }
  function inp(k, label, val, set) {
    var w = document.createElement('label'); w.textContent = label;
    var i = document.createElement('input'); i.type = 'text'; i.maxLength = 200; i.value = val || ''; i.autocomplete = 'off';
    i.oninput = function () { set(i.value); }; w.appendChild(i); return w;
  }
  function members(label) {
    var f = rq.f, box = document.createElement('div'); box.className = 'rq-mem';
    box.innerHTML = '<div class="rq-ml">' + esc(label) + '</div>';
    var list = document.createElement('div'); box.appendChild(list);
    function draw() {
      list.innerHTML = '';
      (f.details.members || []).forEach(function (m, idx) {
        var r = document.createElement('div'); r.className = 'rq-mrow';
        r.innerHTML = '<b>' + esc(m.name) + '</b>';
        var rel = document.createElement('input'); rel.type = 'text'; rel.maxLength = 40; rel.placeholder = 'সম্পর্ক (যেমন Self, Wife, Son)'; rel.value = m.rel || '';
        rel.oninput = function () { m.rel = rel.value; };
        var g = document.createElement('select'); GENDER.forEach(function (o) { g.appendChild(new Option(o[1], o[0])); }); g.value = m.gender || '';
        g.onchange = function () { m.gender = g.value; };
        var x = document.createElement('button'); x.type = 'button'; x.className = 'btn-light btn-small'; x.textContent = '✕';
        x.onclick = function () { f.details.members.splice(idx, 1); draw(); };
        r.appendChild(rel); r.appendChild(g); r.appendChild(x); list.appendChild(r);
      });
    }
    if (!f.details.members) {
      f.details.members = [];
      list.innerHTML = '<div class="ac-hint">Job Card-এর সদস্য আনছি...</div>';
      gramgAdapter.searchAccountWorker(f.worker.village_no + '/' + f.worker.household_no).then(function (rows) {
        f.details.members = (rows || []).map(function (w) { return { name: w.applicant_name, rel: '', gender: '' }; });
        draw();
      }, function () { draw(); });
    } else draw();
    return box;
  }
  function submit() {
    var f = rq.f;
    if (f.kind === 'other' && !(f.title || '').trim()) { showStatus('কী কাজ, সেটা লিখুন।', 'error'); return; }
    if (f.kind === 'note' && !(f.note || '').trim()) { showStatus('নোট লিখুন।', 'error'); return; }
    var det = JSON.parse(JSON.stringify(f.details || {}));
    if (det.members) det.members = det.members.filter(function (m) { return (m.name || '').trim(); });
    if (hasAadhaar((f.note || '') + ' ' + (f.title || '') + ' ' + JSON.stringify(det))) {
      showStatus('Aadhaar নম্বর লেখা যাবে না। নম্বরটা মুছে আবার পাঠান।', 'error'); return;
    }
    var btn = document.querySelector('#reqBody .rq-send'); if (btn) { btn.disabled = true; btn.textContent = 'পাঠানো হচ্ছে...'; }
    gramgAdapter.srCreate(f.worker ? Number(f.worker.worker_id) : null, f.kind, f.title, f.note, det).then(function () {
      showStatus('✅ Admin-এর কাছে পাঠানো হয়েছে। কাজ এগোলে এখানেই দেখতে পাবেন।', 'success');
      rq.view = 'list'; rq.f = null; renderList(); renderGsBar(); window.loadReqs(true); window.scrollTo(0, 0);
    }, function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '📤 Admin-কে পাঠান'; }
      if (e && e.authLost) return;
      showStatus((e && e.message) || String(e), 'error');
    });
  }
})();
