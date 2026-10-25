// =====================================================================
// G RAM-G 4A — Edge Function "admin-users"
// Lets the Super Admin and GP Admins create logins and reset PINs from the
// Admin panel, without opening the Supabase dashboard.
//
// Why a function: creating users / changing passwords needs Supabase's
// SECRET key, which must never be in the browser. The key stays here, on
// Supabase's server. The browser only sends the admin's own login token.
//
// Security:
//   * Every request is checked against the database first: the caller's
//     token must belong to an active Super Admin or GP Admin on a
//     non-revoked device session (public.get_my_context, the same check the
//     app uses).
//   * A GP Admin can create / reset only supervisors (gp_user) and K-Desk
//     logins (kdesk) of their own GP. Only the Super Admin can create a GP
//     Admin or reset a GP Admin's PIN. The database checks this again.
//   * The profile is created through public.admin_create_profile (validated
//     and audited in the database). If that fails, the new login is deleted.
//   * PIN reset ends every device session of that user (audited).
//
// Deploy (Supabase dashboard): Edge Functions → admin-users → Code →
// paste this file → Deploy. "Verify JWT" stays OFF (this function checks
// the login itself, as Supabase recommends for the new API keys).
//
// No imports: uses only fetch / Request / Response, so the local test server
// can run the same file (after stripping the type annotations).
// =====================================================================

const EMAIL_DOMAIN = '@users.gramg.invalid';
// deno-lint-ignore-file no-explicit-any
const env = (k: string): string => (typeof Deno !== 'undefined' ? Deno.env.get(k) : undefined) || '';

function pickKey(jsonName: string, legacyName: string): string {
  try {
    const d = JSON.parse(env(jsonName) || '{}');
    if (d && typeof d === 'object') {
      if (d.default) return d.default;
      const first = Object.values(d)[0];
      if (first) return String(first);
    }
  } catch (_e) { /* fall back to the legacy variable */ }
  return env(legacyName);
}

function corsHeaders(req: Request): Record<string, string> {
  const allowed = env('ALLOWED_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('origin') || '';
  const allow = !allowed.length ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function reply(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

// Secret-key headers: new sb_secret_ keys go on apikey only; a legacy
// service_role JWT also needs the Authorization header.
function secretHeaders(secret: string): Record<string, string> {
  const h: Record<string, string> = { apikey: secret, 'Content-Type': 'application/json' };
  if (!String(secret).startsWith('sb_secret_')) h.Authorization = 'Bearer ' + secret;
  return h;
}

async function asJson(res: Response): Promise<any> {
  const t = await res.text();
  try { return t ? JSON.parse(t) : null; } catch (_e) { return t; }
}

// Call a database function AS THE ADMIN (their token): the database applies
// all its own permission checks and audit logging.
async function rpcAsUser(url: string, publishable: string, token: string, fn: string, args?: Record<string, unknown>): Promise<any> {
  const res = await fetch(url + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { apikey: publishable, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {}),
  });
  const data = await asJson(res);
  if (!res.ok) {
    const msg = (data && (data.message || data.msg)) || ('HTTP ' + res.status);
    const err: any = new Error(msg); err.code = /^[A-Z][A-Z0-9_]{2,40}$/.test(msg) ? msg : 'DB_ERROR';
    err.hint = data && data.hint; throw err;
  }
  return data;
}

const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;
function pinProblem(pin: string): string | null {
  if (!/^[0-9]{6,12}$/.test(pin)) return 'PIN_FORMAT';
  if (/^(\d)\1+$/.test(pin)) return 'WEAK_PIN';                 // 111111
  const asc = '01234567890123456789', desc = '98765432109876543210';
  if (asc.includes(pin) || desc.includes(pin)) return 'WEAK_PIN';  // 123456, 654321
  return null;
}

// Roles the caller may create / reset.
function rolesFor(callerRole: string): string[] {
  return callerRole === 'super_admin' ? ['gp_user', 'kdesk', 'gp_admin'] : ['gp_user', 'kdesk'];
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return reply(req, 405, { error: 'METHOD_NOT_ALLOWED' });

  const url = env('SUPABASE_URL');
  const publishable = pickKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
  const secret = pickKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !publishable || !secret) return reply(req, 500, { error: 'SERVER_NOT_CONFIGURED' });

  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || token.split('.').length !== 3) return reply(req, 401, { error: 'NOT_LOGGED_IN' });

  let body: any;
  try { body = await req.json(); } catch (_e) { return reply(req, 400, { error: 'BAD_INPUT' }); }

  try {
    // 1. Who is calling? (database check: active admin, live device session)
    const ctx = await rpcAsUser(url, publishable, token, 'get_my_context', {});
    if (!ctx || (ctx.role !== 'super_admin' && ctx.role !== 'gp_admin')) return reply(req, 403, { error: 'NOT_AUTHORIZED' });
    const allowedRoles = rolesFor(ctx.role);

    if (body.action === 'create_user') {
      const username = String(body.username || '').trim().toLowerCase();
      const fullName = String(body.full_name || '').trim();
      const pin = String(body.pin || '').trim();
      const role = String(body.role || 'gp_user');
      // a GP Admin always creates in their own GP
      const gpId = ctx.role === 'gp_admin' ? Number(ctx.gp_id) : Number(body.gp_id);
      if (!USERNAME_RE.test(username)) return reply(req, 400, { error: 'BAD_USERNAME' });
      if (!fullName || fullName.length > 100) return reply(req, 400, { error: 'BAD_NAME' });
      if (!Number.isInteger(gpId) || gpId <= 0) return reply(req, 400, { error: 'BAD_GP' });
      if (!allowedRoles.includes(role)) return reply(req, 403, { error: 'BAD_ROLE' });
      const pp = pinProblem(pin); if (pp) return reply(req, 400, { error: pp });

      const users = await rpcAsUser(url, publishable, token, 'admin_list_users', {});
      if ((users || []).some((u: any) => u.username === username)) return reply(req, 409, { error: 'USERNAME_TAKEN' });

      // 2. Create the login (secret key, server side only)
      const cr = await fetch(url + '/auth/v1/admin/users', {
        method: 'POST', headers: secretHeaders(secret),
        body: JSON.stringify({ email: username + EMAIL_DOMAIN, password: pin, email_confirm: true }),
      });
      const created = await asJson(cr);
      if (!cr.ok) {
        const code = created && (created.error_code || created.code);
        if (code === 'email_exists' || cr.status === 422) return reply(req, 409, { error: 'USERNAME_TAKEN' });
        if (code === 'weak_password') return reply(req, 400, { error: 'WEAK_PIN' });
        return reply(req, 502, { error: 'AUTH_ERROR', detail: (created && (created.msg || created.message)) || cr.status });
      }
      const userId = (created && (created.id || (created.user && created.user.id))) || '';

      // 3. Profile through the database (validated + audited). Undo the login if it fails.
      try {
        await rpcAsUser(url, publishable, token, 'admin_create_profile', {
          p_user_id: userId, p_username: username, p_full_name: fullName, p_role: role, p_gp_id: gpId,
        });
      } catch (e: any) {
        await fetch(url + '/auth/v1/admin/users/' + userId, { method: 'DELETE', headers: secretHeaders(secret) });
        return reply(req, 400, { error: e.code || 'PROFILE_ERROR', detail: e.hint || e.message });
      }
      return reply(req, 200, { ok: true, user_id: userId, username, role });
    }

    if (body.action === 'reset_pin') {
      const userId = String(body.user_id || '');
      const pin = String(body.pin || '').trim();
      const pp = pinProblem(pin); if (pp) return reply(req, 400, { error: pp });
      // a GP Admin's list holds only their own GP's people
      const users = await rpcAsUser(url, publishable, token, 'admin_list_users', {});
      const target = (users || []).find((u: any) => u.user_id === userId);
      if (!target) return reply(req, 404, { error: 'USER_NOT_FOUND' });
      if (!allowedRoles.includes(target.role)) return reply(req, 403, { error: 'NOT_AUTHORIZED' });

      const up = await fetch(url + '/auth/v1/admin/users/' + userId, {
        method: 'PUT', headers: secretHeaders(secret), body: JSON.stringify({ password: pin }),
      });
      if (!up.ok) {
        const d = await asJson(up);
        if (d && (d.error_code || d.code) === 'weak_password') return reply(req, 400, { error: 'WEAK_PIN' });
        return reply(req, 502, { error: 'AUTH_ERROR', detail: (d && (d.msg || d.message)) || up.status });
      }
      const r = await rpcAsUser(url, publishable, token, 'admin_after_pin_reset', { p_user_id: userId });
      return reply(req, 200, { ok: true, username: target.username, sessions_revoked: r && r.sessions_revoked });
    }

    return reply(req, 400, { error: 'BAD_ACTION' });
  } catch (e: any) {
    const code = e.code || 'SERVER_ERROR';
    const status = ['SESSION_REVOKED', 'NOT_LOGGED_IN', 'USER_DISABLED'].includes(code) ? 401
                 : code === 'NOT_AUTHORIZED' ? 403 : 500;
    return reply(req, status, { error: code });
  }
}

Deno.serve(handler);
