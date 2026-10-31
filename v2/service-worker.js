// v2 service worker: caches only the app shell (same origin). Data requests go to
// Supabase (another origin) and are never cached, so offline never shows stale data
// as if it were saved.
const CACHE_NAME = 'gramg-4a-demand-v2.11.0';
const APP_SHELL = ['./', './index.html', './manifest.json', './js/config.js?v=20261020a', './js/sb-client.js?v=20261031p', './js/gramg-adapter.js?v=20261031p', './admin.html', './js/admin.js?v=20261031p', './js/import-map.js?v=20261020a', './js/i18n.js?v=20261031p', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(fetch(req).then(res => {
    if (res && res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then(c => c || caches.match('./index.html'))));
});
