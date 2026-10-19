/* =====================================================================
   Minimal Supabase client (Auth + RPC) using the documented HTTP API.
   No external library: fewer downloads, nothing to break on a CDN outage.
     POST /auth/v1/token?grant_type=password|refresh_token
     POST /auth/v1/logout?scope=local          (this device only)
     POST /rest/v1/rpc/<function>
   ===================================================================== */
(function () {
  'use strict';
  var CFG = window.GRAMG_CONFIG || {};
  var STORE_KEY = 'gramg2.session';
  var AUTH_CODES = ['SESSION_REVOKED', 'NOT_LOGGED_IN', 'USER_DISABLED'];
  var session = readStore();
  var refreshing = null;

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { return null; }
  }
  function writeStore(s) {
    session = s;
    try { if (s) localStorage.setItem(STORE_KEY, JSON.stringify(s)); else localStorage.removeItem(STORE_KEY); } catch (e) {}
  }
  // Another tab of this browser refreshed the token: pick it up.
  window.addEventListener('storage', function (e) { if (e.key === STORE_KEY) session = readStore(); });

  function ApiError(code, message, extra) {
    var err = new Error(message);
    err.code = code;
    extra = extra || {};
    err.status = extra.status; err.hint = extra.hint; err.network = !!extra.network;
    return err;
  }

  function request(path, opts) {
    opts = opts || {};
    var headers = { 'apikey': CFG.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' };
    if (opts.auth !== false && session) headers['Authorization'] = 'Bearer ' + session.access_token;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, opts.timeout || 20000);
    return fetch(CFG.SUPABASE_URL + path, {
      method: 'POST', headers: headers, cache: 'no-store',
      body: JSON.stringify(opts.body === undefined ? {} : opts.body),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      clearTimeout(timer);
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
        if (!res.ok) {
          var msg = (data && (data.message || data.msg || data.error_description || data.error)) || ('HTTP ' + res.status);
          var code = (data && (data.error_code || data.code)) || String(res.status);
          // Our database functions raise short UPPER_CASE codes (LIST_LOCKED, VERSION_CONFLICT, ...).
          if (typeof msg === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(msg)) code = msg;
          throw ApiError(code, msg, { status: res.status, hint: data && data.hint });
        }
        return data;
      });
    }, function () {
      clearTimeout(timer);
      throw ApiError('NETWORK', 'Server-এর সঙ্গে যোগাযোগ হয়নি। Internet connection দেখে আবার চেষ্টা করুন।', { network: true });
    });
  }

  function storeSession(d) {
    writeStore({
      access_token: d.access_token, refresh_token: d.refresh_token,
      expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600),
      user_id: d.user && d.user.id
    });
  }

  function authLost(code) {
    writeStore(null);
    if (typeof api.onAuthLost === 'function') { try { api.onAuthLost(code); } catch (e) {} }
  }

  function refresh() {
    if (refreshing) return refreshing;
    var stored = readStore();                       // a sibling tab may already have refreshed
    if (stored && session && stored.refresh_token !== session.refresh_token &&
        stored.expires_at - Date.now() / 1000 > 60) { session = stored; return Promise.resolve(); }
    if (!session) return Promise.reject(ApiError('NOT_LOGGED_IN', 'NOT_LOGGED_IN'));
    refreshing = request('/auth/v1/token?grant_type=refresh_token',
                         { auth: false, body: { refresh_token: session.refresh_token } })
      .then(storeSession, function (e) {
        if (!e.network) {
          // Supabase sessions do not expire on their own here; a refresh token whose session
          // no longer exists means the session was ended elsewhere (device limit / admin).
          var gone = ['refresh_token_not_found', 'session_not_found', 'refresh_token_already_used'].indexOf(e.code) >= 0;
          authLost(gone ? 'SESSION_REVOKED' : 'SESSION_ENDED'); e.authLost = true;
        }
        throw e;
      })
      .then(function () { refreshing = null; }, function (e) { refreshing = null; throw e; });
    return refreshing;
  }

  function ensureFresh() {
    if (!session) return Promise.reject(ApiError('NOT_LOGGED_IN', 'NOT_LOGGED_IN'));
    if (session.expires_at - Date.now() / 1000 < 90) return refresh();
    return Promise.resolve();
  }

  function rpc(fn, args, opts) {
    opts = opts || {};
    var attempt = 0;
    function once() {
      return ensureFresh().then(function () {
        return request('/rest/v1/rpc/' + fn, { body: args || {} });
      }).catch(function (e) {
        if (e.authLost) throw e;
        if (e.status === 401 && /JWT expired/i.test(e.message) && attempt === 0) {
          attempt++; return refresh().then(once);
        }
        if (AUTH_CODES.indexOf(e.code) >= 0) { authLost(e.code); e.authLost = true; throw e; }
        // Safe retries for transient failures (only for idempotent calls)
        if (opts.retry && (e.network || e.status >= 500) && attempt < 3) {
          attempt++;
          return new Promise(function (r) { setTimeout(r, 1000 * Math.pow(2, attempt - 1)); }).then(once);
        }
        throw e;
      });
    }
    return once();
  }

  function signIn(email, password) {
    return request('/auth/v1/token?grant_type=password', { auth: false, body: { email: email, password: password } })
      .then(storeSession);
  }

  function signOut() {
    var had = !!session;
    // direct request (not rpc) so a voluntary logout never triggers the "session lost" message
    var p = had ? request('/rest/v1/rpc/logout_session', {}).catch(function () {}) : Promise.resolve();
    return p.then(function () {
      return had && session ? request('/auth/v1/logout?scope=local', {}).catch(function () {}) : null;
    }).then(function () { writeStore(null); });
  }

  var api = {
    signIn: signIn, signOut: signOut, rpc: rpc,
    hasSession: function () { return !!session; },
    onAuthLost: null
  };
  window.GramgSB = api;
})();
