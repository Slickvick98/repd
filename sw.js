/* Repd Fitness service worker: caches the app shell so the PWA opens offline.
   Data is NOT cached here on purpose: data lives in localStorage + Git. */
var CACHE = 'repd-shell-v10';
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
  var url = new URL(e.request.url);
  // Never cache GitHub API calls: those must always hit the network.
  if (url.hostname === 'api.github.com') { return; }
  // App shell: cache-first, fall back to network.
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request);
    })
  );
});
