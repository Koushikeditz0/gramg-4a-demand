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
    BAD_INPUT: 'Search-এর তথ্য সঠিক নয়।',
    LIST_LOCKED: 'এই list জমা দেওয়া বা lock করা আছে, তাই এখন বদলানো যাবে না।',
    LIST_EMPTY: 'খালি list জমা দেওয়া যায় না। আগে worker select করুন।',
    NO_LIST: 'আগে একটা list খুলুন: উপরে "➕ নতুন list" চাপুন।',
    NEED_WORK_NAME: 'Work Name লিখুন।',
    NEED_SUPERVISORS: 'যথেষ্ট Supervisor-এর নাম দেওয়া হয়নি।',
    TOO_MANY_LISTS: 'একসঙ্গে সর্বোচ্চ ৫টা চলতি list রাখা যায়। পুরনো list শেষ হলে নতুন খুলুন।',
    DUPLICATE_WORK_NAME: 'এই Work Name-এ আপনার আরেকটা list আছে। অন্য নাম দিন।',
    BAD_WORK_CODE: 'Work Code-এর format মেলেনি (যেমন 3206003006/IF/93393042892327)।',
    LIST_NOT_EMPTY: 'List-এ worker আছে। মোছার আগে Clear Selected করুন।',
    PHOTO_NOT_FOUND: 'Photo upload শেষ হয়নি। আবার তুলুন।',
    PHOTO_SETUP: 'Account copy-র ব্যবস্থা এখনো চালু হয়নি (Admin SQL চালাননি)।',
    PHOTO_TOO_BIG: 'Photo খুব বড়। আবার তুলুন।'
  };
  function bnError(e) {
    var out = new Error(BN[e.code] || ('Server error: ' + (e.message || e)));
    out.code = e.code; out.authLost = !!e.authLost; out.network = !!e.network;
    return out;
  }

  function freshState(ctx) {
    return { listId: null, version: 0, server: new Set(), keyByWid: new Map(), ctx: ctx || null, workName: '', workCode: '',
             submitState: 'draft', submittedAt: null, supervisors: [], lists: [] };
  }
  var st = freshState();
  function notifyState() {
    if (typeof window.gramgOnListState === 'function') {
      try {
        window.gramgOnListState({ state: st.submitState, submittedAt: st.submittedAt, listId: st.listId,
                                  workName: st.workName, workCode: st.workCode, gpCode: (st.ctx && st.ctx.gp_code) || '',
                                  supervisors: st.supervisors.slice(), lists: st.lists.slice(),
                                  noList: !st.listId });
      } catch (e) {}
    }
  }
  // the list the supervisor last worked on is remembered per device
  function memKey() { return 'GramG2_ListSel_' + ((st.ctx && st.ctx.username) || ''); }
  function remember(id) { try { if (id) localStorage.setItem(memKey(), id); else localStorage.removeItem(memKey()); } catch (e) {} }
  var NO_LIST = 'none';             // remembered "blank screen" (after a submit)
  function remembered() { try { return localStorage.getItem(memKey()); } catch (e) { return null; } }

  function toMember(r) {
    var id = r.job_card_no + '|' + r.applicant_no;
    st.keyByWid.set(r.id, id);
    return {
      id: id, wid: r.id, jobCard: r.job_card_no, applicantNo: String(r.applicant_no),
      name: r.applicant_name, ekyc: !!r.ekyc, abps: !!r.abps,
      aadhaarSeeded: !!r.aadhaar_seeded, authenticationDone: !!r.authentication_done,
      eligible: !!r.eligible, active: r.active !== false,
      takenListId: r.taken_list_id || null, takenWork: r.taken_work || '', takenOther: !!r.taken_other
    };
  }
  function toFamilies(rows) {
    var order = [], fam = {};
    (rows || []).forEach(function (r) {
      var key = r.job_card_no;                       // '483' and '483-A' are different families
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
          if (ctx.role === 'super_admin' || ctx.role === 'gp_admin') {
            location.href = './admin.html';
            return { ok: false, message: 'Admin panel খুলছে...' };
          }
          if (ctx.role === 'kdesk') return SB.signOut().then(function () { return { ok: false, message: 'এটা K-Desk login, শুধু অফিসের K-Desk extension-এ চলে।' }; });
          if (ctx.role !== 'gp_user') return { ok: false, message: 'এই account-এর অনুমতি নেই।' };
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
  function refreshLists() {
    return SB.rpc('get_my_lists', {}, { retry: true }).then(function (lists) {
      st.lists = lists || [];
      var ids = st.lists.map(function (l) { return l.list_id; });
      if (!st.listId || ids.indexOf(st.listId) < 0) {
        // picked before on this device > blank screen after a submit > first draft > blank
        var m = remembered(), draft = st.lists.filter(function (l) { return l.submit_state === 'draft'; })[0];
        st.listId = ids.indexOf(m) >= 0 ? m : (m === NO_LIST ? null : (draft ? draft.list_id : null));
      }
    });
  }
  function applyList(r) {
    if (!r) {
      st.listId = null; st.version = 0; st.server = new Set(); st.workName = ''; st.workCode = ''; st.supervisors = [];
      st.submitState = 'draft'; st.submittedAt = null;
      notifyState(); return [];
    }
    st.listId = r.list_id; st.version = r.version; st.workName = r.work_name || ''; st.workCode = r.work_code || '';
    st.supervisors = r.supervisors || [];
    st.submitState = r.submit_state || 'draft'; st.submittedAt = r.submitted_at || null;
    st.server = new Set((r.items || []).map(function (x) { return x.id; }));
    st.lists.forEach(function (l) {
      if (l.list_id === r.list_id) { l.workers = (r.items || []).length; l.work_name = st.workName; l.submit_state = st.submitState; l.supervisors = st.supervisors; }
    });
    remember(st.listId);
    notifyState();
    return (r.items || []).map(toMember);
  }
  // Loads the current list (the one picked before on this device, else the first).
  function getSavedWorkers() {
    return refreshLists().then(function () {
      if (!st.listId) return applyList(null);
      return SB.rpc('get_list', { p_list_id: st.listId }, { retry: true }).then(applyList, function (e) {
        if (e.code !== 'LIST_NOT_FOUND') throw e;
        st.listId = null; remember(null);                 // e.g. the admin marked it "work complete"
        return refreshLists().then(function () {
          return st.listId ? SB.rpc('get_list', { p_list_id: st.listId }, { retry: true }).then(applyList) : applyList(null);
        });
      });
    });
  }
  // Blank screen: no list open, the supervisor starts a new one or picks an old one.
  function closeList() {
    return whenIdle().then(function () { st.listId = null; remember(NO_LIST); return applyList(null); });
  }
  function switchList(id) {
    return whenIdle().then(function () { st.listId = id; remember(id); return getSavedWorkers(); });
  }
  function createList(name) {
    return whenIdle().then(function () {
      return SB.rpc('create_list', { p_work_name: String(name || '') });
    }).then(function (r) {
      st.listId = r.list_id; remember(r.list_id);
      return refreshLists().then(function () { return applyList(r); });
    }, function (e) { throw bnError(e || {}); });
  }
  function setMeta(name, supervisors) {
    if (!st.listId) return Promise.reject(bnError({ code: 'NO_LIST' }));
    return whenIdle().then(function () {
      return SB.rpc('set_list_meta', { p_list_id: st.listId, p_work_name: String(name || ''), p_supervisors: supervisors || [] });
    }).then(function (r) {
      st.workName = r.work_name || ''; st.supervisors = r.supervisors || []; st.version = r.version;
      st.lists.forEach(function (l) { if (l.list_id === st.listId) { l.work_name = st.workName; l.supervisors = st.supervisors; } });
      notifyState(); return r;
    }, function (e) { throw bnError(e || {}); });
  }
  // Supervisor's own Work Code (database: set_list_work_code, needs the 2026-10-31 SQL)
  function setWorkCode(code) {
    if (!st.listId) return Promise.reject(bnError({ code: 'NO_LIST' }));
    return whenIdle().then(function () {
      return SB.rpc('set_list_work_code', { p_list_id: st.listId, p_work_code: String(code || '') });
    }).then(function (r) {
      st.workCode = r.work_code || ''; if (r.version) st.version = r.version;
      st.lists.forEach(function (l) { if (l.list_id === st.listId) l.work_code = st.workCode; });
      notifyState(); return r;
    }, function (e) { throw bnError(e || {}); });
  }
  function deleteList() {
    if (!st.listId) return Promise.resolve([]);
    return whenIdle().then(function () { return SB.rpc('delete_list', { p_list_id: st.listId }); })
      .then(function () { st.listId = null; remember(null); return getSavedWorkers(); }, function (e) { throw bnError(e || {}); });
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
      if (!st.listId) throw { code: 'NO_LIST' };
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

  // Supervisor hands the list to the admin (read-only afterwards) / takes it back.
  function changeSubmit(fn) {
    return whenIdle().then(function () {
      return st.listId ? null : getSavedWorkers();
    }).then(function () {
      return SB.rpc(fn, { p_list_id: st.listId });
    }).then(function (r) {
      st.submitState = r.submit_state; st.submittedAt = r.submitted_at || null;
      if (r.version) st.version = r.version;
      st.lists.forEach(function (l) { if (l.list_id === st.listId) { l.submit_state = st.submitState; l.workers = st.server.size; } });
      notifyState();
      return r;
    }, function (e) { throw bnError(e || {}); });
  }

  function logout() {
    return whenIdle().catch(function () {}).then(function () { return SB.signOut(); }).then(function () {
      st = freshState();
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
    submitList: function () { return changeSubmit('submit_list'); },
    switchList: switchList, closeList: closeList, createList: createList, setMeta: setMeta, setWorkCode: setWorkCode, deleteList: deleteList,
    listId: function () { return st.listId; },
    supervisors: function () { return st.supervisors.slice(); },
    lists: function () { return st.lists.slice(); },
    unsubmitList: function () { return changeSubmit('unsubmit_list'); },
    dataStatus: function () { return SB.rpc('get_data_status', {}, { retry: true }); },
    listResults: function () {
      if (!st.listId) return Promise.resolve([]);
      return SB.rpc('get_list_results', { p_list_id: st.listId }, { retry: true }).catch(function (e) { throw bnError(e || {}); });
    },
    listState: function () { return st.submitState; },
    // ---- account copy (passbook) photos ----
    photoStates: function (wids) {
      if (!wids || !wids.length) return Promise.resolve([]);
      return SB.rpc('get_account_photos', { p_worker_ids: wids }, { retry: true }).catch(function (e) {
        if (e && (e.status === 404 || /get_account_photos/.test(e.message || ''))) return [];   // SQL not run yet
        throw bnError(e || {});
      });
    },
    uploadPhoto: function (wid, blob) {
      var gp = st.ctx && st.ctx.gp_id, uid = SB.userId();
      if (!gp || !uid) return Promise.reject(bnError({ code: 'NOT_AUTHORIZED' }));
      var path = gp + '/' + uid + '/w' + wid + '_' + Date.now().toString(36) + '.jpg';
      return SB.storage.upload('account-copies', path, blob, 'image/jpeg').catch(function (e) {
        e = e || {}; var m = e.message || '';
        if (/bucket not found/i.test(m)) e.code = 'PHOTO_SETUP';
        else if (/exceeded|too large|payload/i.test(m)) e.code = 'PHOTO_TOO_BIG';
        else if (/row-level security|unauthorized/i.test(m)) e.code = 'NOT_AUTHORIZED';
        e.stage = 'upload'; throw e;
      }).then(function () {
        return SB.rpc('add_account_photo', { p_worker_id: wid, p_list_id: st.listId, p_path: path, p_size: blob.size });
      }).then(function (r) {
        var old = (r && r.old_paths) || [];
        SB.storage.remove('account-copies', old).catch(function () {});   // the admin clean-up catches any left over
        return r;
      }).catch(function (e) {
        e = e || {};
        if (e.status === 404 && /add_account_photo/.test(e.message || '')) e.code = 'PHOTO_SETUP';
        throw bnError(e);
      });
    },
    workName: function () { return st.workName; },
    whenIdle: whenIdle
  };
})();
