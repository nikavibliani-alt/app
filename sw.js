// sw.js — minimal service worker, no caching yet.
// Only purpose right now: exist, so the pages can register a SW for
// future PWA/offline work. It deliberately does NOT cache anything —
// this app has already hit real staleness bugs from GitHub Pages CDN
// caching, and an aggressive SW cache would make that worse. Add a
// real caching strategy later, once explicitly requested.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// No fetch handler — every request passes straight to the network.
