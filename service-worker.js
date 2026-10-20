// The old app (v1) at this address has moved to ./v2/.
// This replacement service worker removes the old offline cache, unregisters
// itself and reloads open pages, so phones that still run the old version
// switch to the new app automatically.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.filter(function (k) { return /^gramg-4a-demand-v1/.test(k); }).map(function (k) { return caches.delete(k); }));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(function (c) { c.navigate(c.url); });
  })());
});
