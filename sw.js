/* Repd Fitness service worker.
   Strategy: NETWORK-FIRST for our own assets so updates always show when online;
   the cache is only an offline fallback. (Cache-first caused stale PWAs on iOS.)
   GitHub API calls are never touched here; data lives in localStorage + Git. */
var CACHE = 'repd-shell-v20';
var SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './data/seed.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) { return caches.delete(k); }
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') { return; }
  var url = new URL(e.request.url);
  // Never cache GitHub API calls: those must always hit the network.
  if (url.hostname === 'api.github.com') { return; }
  // Only manage our own origin's assets.
  if (url.origin !== self.location.origin) { return; }
  // Network-first: fresh when online, cached copy as offline fallback.
  e.respondWith(
    fetch(e.request).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (hit) {
        return hit || caches.match('./index.html');
      });
    })
  );
});
