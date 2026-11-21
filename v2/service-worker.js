// v2 service worker: caches only the app shell (same origin). Data requests go to
// Supabase (another origin) and are never cached, so offline never shows stale data
// as if it were saved.
const CACHE_NAME = 'gramg-4a-demand-v2.53.0';
const APP_SHELL = ['./', './index.html', './manifest.json', './js/config.js?v=20261106b', './js/sb-client.js?v=20261120a', './js/gramg-adapter.js?v=20261121a', './js/sup-requests.js?v=20261121c', './admin.html', './js/iay-dash.js?v=20261112a', './js/admin.js?v=20261120m', './js/admin-masters.js?v=20261107e', './js/admin-villages.js?v=20261114a', './js/admin-signup.js?v=20261114a', './js/admin-aadhaar.js?v=20261116r', './js/admin-wlcaste.js?v=20261115a', './js/admin-pipeline.js?v=20261120t', './js/admin-shell.js?v=20261121c', './js/admin-requests.js?v=20261121c', './js/admin-bankqueue.js?v=20261121a', './js/admin-dbver.js?v=20261121c', './js/admin-search.js?v=20261118a', './js/vendor/qrcode-1.4.4.js', './join.html', './js/import-map.js?v=20261020a', './js/i18n.js?v=20261121d', './iay.html', './report.html', './js/report.js?v=20261120a', './js/iay.js?v=20261110a', './js/iay-summary.js?v=20261110c', './icon-192.png', './icon-512.png', './icon-maskable-192.png', './icon-maskable-512.png', './apple-touch-icon.png', './favicon-32.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const fresh = () => fetch(req).then(res => {
    if (res && res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then(c => c.put(req, copy)); }
    return res;
  });
  // Speed (2026-11-20): scripts with a ?v= version, vendor libraries and icons open from the cache
  // at once and are refreshed in the background for the next visit. A changed script gets a new
  // ?v=, so it is a new address and always comes from the network. Pages (HTML) stay network-first.
  const versioned = /[?&]v=/.test(url.search) || /\/js\/vendor\//.test(url.pathname) || /\.(png|svg)$/.test(url.pathname);
  if (versioned) {
    e.respondWith(caches.match(req).then(hit => {
      const net = fresh().catch(() => hit);
      if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
      return net;
    }));
    return;
  }
  e.respondWith(fresh().catch(() => caches.match(req).then(c => c || caches.match('./index.html'))));
});
