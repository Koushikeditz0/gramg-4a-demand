/* =====================================================================
   G RAM-G 4A List Builder: account copy photos on Cloudflare R2
   Cloudflare Worker "gramg-photo", R2 binding PHOTOS.

   Every request carries the user's Supabase login token
   (Authorization: Bearer ...). The Worker asks Supabase whether this user
   may touch the path (the same rule as the old Supabase bucket:
   public.account_photo_access → private.photo_access). No secret key is
   needed: the Supabase URL and publishable key below are public.

     PUT  /photo?path=<gp>/<user>/<file>.jpg   body = JPEG (max 600 KB)
     GET  /photo?path=...                      → the JPEG
     POST /delete   {"paths": [...]}           → {"deleted": n}
   ===================================================================== */
const SUPABASE_URL = 'https://wbzybizfpdalpukfzefk.supabase.co';
const SUPABASE_KEY = 'sb_publishable_fCY9paYMNTyepXdI7YRhkw_2u85P7bn';
const MAX_BYTES = 614400;
const PATH_RE = /^\d{1,5}\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{1,80}\.jpg$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',          // login token, not cookies: any origin is safe
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400'
};
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// Ask Supabase (with the user's own token) whether this path is allowed.
async function allowed(token, path, mode) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/account_photo_access', {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_path: path, p_mode: mode })
  });
  if (r.status === 401) return 'login';
  if (!r.ok) return false;
  return (await r.json()) === true;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'NOT_LOGGED_IN' }, 401);

    try {
      if (url.pathname === '/photo' && (req.method === 'PUT' || req.method === 'GET')) {
        const path = url.searchParams.get('path') || '';
        if (!PATH_RE.test(path)) return json({ error: 'BAD_PATH' }, 400);
        const ok = await allowed(token, path, req.method === 'PUT' ? 'insert' : 'read');
        if (ok === 'login') return json({ error: 'JWT expired' }, 401);
        if (!ok) return json({ error: 'NOT_AUTHORIZED' }, 403);

        if (req.method === 'PUT') {
          const body = await req.arrayBuffer();
          if (!body.byteLength) return json({ error: 'EMPTY' }, 400);
          if (body.byteLength > MAX_BYTES) return json({ error: 'PHOTO_TOO_BIG' }, 413);
          const b = new Uint8Array(body, 0, 3);
          if (b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return json({ error: 'NOT_JPEG' }, 415);
          if (await env.PHOTOS.head(path)) return json({ error: 'EXISTS' }, 409);
          await env.PHOTOS.put(path, body, { httpMetadata: { contentType: 'image/jpeg' } });
          return json({ ok: true, size: body.byteLength });
        }
        const obj = await env.PHOTOS.get(path);
        if (!obj) return json({ error: 'NOT_FOUND' }, 404);
        return new Response(obj.body, { headers: { ...CORS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' } });
      }

      if (url.pathname === '/delete' && req.method === 'POST') {
        const paths = ((await req.json().catch(() => ({}))).paths || []).filter((p) => PATH_RE.test(p)).slice(0, 100);
        let n = 0;
        for (const p of paths) {
          const ok = await allowed(token, p, 'read');
          if (ok === 'login') return json({ error: 'JWT expired' }, 401);
          if (ok) { await env.PHOTOS.delete(p); n++; }
        }
        return json({ deleted: n });
      }
      return json({ error: 'NOT_FOUND' }, 404);
    } catch (e) {
      return json({ error: 'WORKER_ERROR', message: String(e && e.message || e) }, 500);
    }
  }
};
