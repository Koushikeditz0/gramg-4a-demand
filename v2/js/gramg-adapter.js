/* =====================================================================
   G RAM-G 4A v2 — Supabase adapter.
   Provides the same google.script.run-style API the existing UI already
   calls (login, getVillages, getFamilies, saveSelection, getSavedWorkers,
   clearSavedSelection, getAccounts), so the proven UI logic stays unchanged.
   ===================================================================== */
(function () {
  'use strict';
  var SB = window.GramgSB;
  var EMAIL_DOMAIN = '@users.gramg.invalid';

  var BN = {
    NETWORK: 'Server-এর সঙ্গে যোগাযোগ হয়নি। Internet connection দেখে আবার চেষ্টা করুন।',
    TOO_MANY_JOB_CARDS: 'একবারে সর্বোচ্চ ৫০০টি Job Card search করা যায়। Range ছোট করুন।',
    QUERY_TOO_SHORT: 'নাম দিয়ে খুঁজতে কমপক্ষে ২টি অক্ষর লিখুন।',
    LIST_NOT_FOUND: 'আপনার list পাওয়া যায়নি। Page reload করে আবার চেষ্টা করুন।',
    VERSION_CONFLICT: 'অন্য একটি device-এ এই list এইমাত্র পরিবর্তন হয়েছে। সর্বশেষ list দেখানো হচ্ছে — দেখে নিয়ে প্রয়োজনে আবার Clear করুন।',
    NOT_AUTHORIZED: 'এই কাজের অনুমতি আপনার নেই।',
    TOO_MANY_CHANGES: 'একবারে অনেক বেশি পরিবর্তন। কয়েক ধাপে করুন।',
    BAD_INPUT: 'Search-এর তথ্য সঠিক নয়।'
  };
  function bnError(e) {
    var out = new Error(BN[e.code] || ('Server error: ' + (e.message || e)));
    out.code = e.code; out.authLost = !!e.authLost; out.network = !!e.network;
    return out;
  }

  var st = { listId: null, version: 0, server: new Set(), keyByWid: new Map(), ctx: null, workName: '' };

  function toMember(r) {
    var id = r.job_card_no + '|' + r.applicant_no;
    st.keyByWid.set(r.id, id);
    return {
      id: id, wid: r.id, jobCard: r.job_card_no, applicantNo: String(r.applicant_no),
      name: r.applicant_name, ekyc: !!r.ekyc, abps: !!r.abps,
      aadhaarSeeded: !!r.aadhaar_seeded, authenticationDone: !!r.authentication_done,
      eligible: !!r.eligible, active: r.active !== false
    };
  }
  function toFamilies(rows) {
    var order = [], fam = {};
    (rows || []).forEach(function (r) {
      var key = r.village_no + '/' + r.household_no;
      if (!fam[key]) {
        fam[key] = { key: key, village: r.village_no, household: r.household_no, jobCard: r.job_card_no, members: [] };
        order.push(key);
      }
      fam[key].members.push(toMember(r));
    });
    return order.map(function (k) { return fam[k]; });
  }

  // ---------------- session ----------------
  function startSession() {
    return SB.rpc('register_session', { p_user_agent: String(navigator.userAgent || '').slice(0, 300) })
      .then(function (reg) {
        return SB.rpc('get_my_context').then(function (ctx) {
          if (ctx.role !== 'gp_user') {
            return SB.signOut().then(function () {
              return { ok: false, message: 'এটি Super Admin account। Admin panel পরের ধাপে আসছে; এখন GP user দিয়ে Login করুন।' };
            });
          }
          st.ctx = ctx;
          return {
            ok: true, token: 'supabase', revoked: ((reg && reg.revoked) || []).length,
            user: { username: ctx.username, name: ctx.full_name, gp: ctx.gp_name,
                    gpCode: ctx.gp_code, jcPrefix: ctx.jc_prefix }
          };
        });
      });
  }

  function login(username, pin) {
    username = String(username || '').trim().toLowerCase();
    pin = String(pin || '').trim();
    if (!username || !pin) return Promise.resolve({ ok: false, message: 'Username এবং PIN দিন।' });
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) return Promise.resolve({ ok: false, message: 'Username সঠিক নয়।' });
    if (pin.length < 6) return Promise.resolve({ ok: false, message: 'PIN কমপক্ষে ৬ সংখ্যার। পুরনো ছোট PIN চলবে না — Administrator-এর কাছ থেকে নতুন PIN নিন।' });
    return SB.signIn(username + EMAIL_DOMAIN, pin).then(startSession, function (e) {
      if (e.network) return { ok: false, message: BN.NETWORK };
      return { ok: false, message: 'Username/PIN ভুল অথবা user inactive।' };
    }).catch(function (e) {
      if (e.code === 'USER_DISABLED') return { ok: false, message: 'আপনার account বন্ধ করা আছে। Administrator-এর সঙ্গে যোগাযোগ করুন।' };
      throw e;
    });
  }

  function restore() {
    if (!SB.hasSession()) return Promise.resolve(null);
    return startSession().catch(function () { return null; });
  }

  // ---------------- search ----------------
  function getVillages() {
    return SB.rpc('get_villages', {}, { retry: true }).then(function (rows) {
      return (rows || []).map(function (r) {
        return { v: r.village_no, families: r.families, workers: r.workers, eligible: r.eligible_workers };
      });
    });
  }
  function getFamilies(token, entries) {
    var list = Array.isArray(entries) ? entries : [];
    if (list.length > 500) return Promise.reject({ code: 'TOO_MANY_JOB_CARDS' });
    return SB.rpc('search_households', {
      p_villages: list.map(function (e) { return Number(e.v); }),
      p_households: list.map(function (e) { return Number(e.h); })
    }, { retry: true }).then(toFamilies);
  }
  function searchByName(token, query, village) {
    return SB.rpc('search_by_name', { p_query: String(query || ''), p_village: village ? Number(village) : null, p_limit: 100 },
                  { retry: true }).then(toFamilies);
  }

  // ---------------- saved list ----------------
  function getSavedWorkers() {
    return SB.rpc('get_active_list', {}, { retry: true }).then(function (r) {
      st.listId = r.list_id; st.version = r.version; st.workName = r.work_name || '';
      st.server = new Set((r.items || []).map(function (x) { return x.id; }));
      return (r.items || []).map(toMember);
    });
  }

  // One save at a time; while one runs, only the newest wanted state is kept.
  var wanted = null, waiters = [], running = false, idleWaiters = [];
  function whenIdle() {
    return running || wanted ? new Promise(function (r) { idleWaiters.push(r); }) : Promise.resolve();
  }
  function saveSelection(token, items) {
    return new Promise(function (resolve, reject) {
      wanted = new Set((items || []).map(function (x) { return x && x.wid; }).filter(Boolean));
      waiters.push({ resolve: resolve, reject: reject });
      if (!running) runSaves();
    });
  }
  function runSaves() {
    running = true;
    var want = wanted, ws = waiters;
    wanted = null; waiters = [];
    applyDiff(want).then(function (r) {
      ws.forEach(function (w) { w.resolve(r); });
    }, function (e) {
      ws.forEach(function (w) { w.reject(e); });
    }).then(function () {
      if (wanted) return runSaves();
      running = false;
      var iw = idleWaiters; idleWaiters = []; iw.forEach(function (f) { f(); });
    });
  }
  function applyDiff(want) {
    var ready = st.listId ? Promise.resolve() : getSavedWorkers();
    return ready.then(function () {
      var add = [], remove = [];
      want.forEach(function (w) { if (!st.server.has(w)) add.push(w); });
      st.server.forEach(function (w) { if (!want.has(w)) remove.push(w); });
      var result = { ok: true, count: st.server.size, rejected: [], serverChanged: false };
      var CH = 1000, steps = [];
      for (var i = 0; i < Math.max(add.length, remove.length); i += CH) steps.push([add.slice(i, i + CH), remove.slice(i, i + CH)]);
      return steps.reduce(function (p, s) {
        return p.then(function () {
          return SB.rpc('save_list_changes', { p_list_id: st.listId, p_base_version: st.version, p_add: s[0], p_remove: s[1] },
                        { retry: true }).then(function (r) {
            var bad = new Set((r.rejected || []).map(function (x) { return x.id; }));
            s[1].forEach(function (w) { st.server.delete(w); });
            s[0].forEach(function (w) { if (!bad.has(w)) st.server.add(w); });
            st.version = r.version;
            result.count = r.count;
            result.serverChanged = result.serverChanged || !!r.server_changed;
            (r.rejected || []).forEach(function (x) {
              result.rejected.push({ id: st.keyByWid.get(x.id) || String(x.id), wid: x.id, reason: x.reason });
            });
          });
        });
      }, Promise.resolve()).then(function () { return result; });
    });
  }
  function clearSavedSelection() {
    return whenIdle().then(function () {
      var ready = st.listId ? Promise.resolve() : getSavedWorkers();
      return ready.then(function () {
        return SB.rpc('clear_list', { p_list_id: st.listId, p_base_version: st.version });
      }).then(function (r) {
        st.server = new Set(); st.version = r.version;
        return { ok: true, count: 0 };
      });
    });
  }
  function setWorkName(name) {
    if (!st.listId) return Promise.resolve();
    st.workName = String(name || '');
    return SB.rpc('set_list_work_name', { p_list_id: st.listId, p_work_name: st.workName }).catch(function () {});
  }

  // Accounts only for workers already saved in this user's list.
  function getAccounts() {
    return whenIdle().then(function () {
      return SB.rpc('get_list_accounts', { p_list_id: st.listId }, { retry: true });
    }).then(function (rows) {
      var out = {};
      (rows || []).forEach(function (r) {
        var k = st.keyByWid.get(r.worker_id);
        if (k) out[k.toUpperCase()] = { accountNo: r.account_no || '', ifsc: r.ifsc || '' };
      });
      return out;
    });
  }

  function logout() {
    return whenIdle().catch(function () {}).then(function () { return SB.signOut(); }).then(function () {
      st = { listId: null, version: 0, server: new Set(), keyByWid: new Map(), ctx: null, workName: '' };
    });
  }

  var fns = {
    login: login, getVillages: getVillages, getFamilies: getFamilies, searchByName: searchByName,
    saveSelection: saveSelection, clearSavedSelection: clearSavedSelection,
    getSavedWorkers: getSavedWorkers, getAccounts: getAccounts
  };

  // google.script.run-compatible shim (keeps the existing UI code unchanged)
  window.google = window.google || {};
  window.google.script = window.google.script || {};
  Object.defineProperty(window.google.script, 'run', { configurable: true, get: function () {
    var success = function () {}, failure = function () {};
    var runner = {
      withSuccessHandler: function (f) { success = f; return runner; },
      withFailureHandler: function (f) { failure = f; return runner; }
    };
    Object.keys(fns).forEach(function (name) {
      runner[name] = function () {
        var s = success, f = failure, args = Array.prototype.slice.call(arguments);
        Promise.resolve().then(function () { return fns[name].apply(null, args); })
          .then(function (v) { s(v); }, function (e) { f(bnError(e || {})); });
      };
    });
    return runner;
  }});

  window.gramgAdapter = {
    restore: restore, logout: logout, setWorkName: setWorkName,
    workName: function () { return st.workName; },
    whenIdle: whenIdle
  };
})();
