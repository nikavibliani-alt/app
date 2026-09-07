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

// Push notifications — admin PWA only (see checkin-admin.html subscribeToPush()).
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Maxela';
  const options = {
    body: data.body || '',
    icon: '/assets/icons/icon-192.png',
    badge: '/assets/icons/icon-192.png',
    tag: data.tag || 'maxela-notification',
    renotify: true,
    data: { url: data.url || '/checkin-admin' }
  };
  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/checkin-admin';
  event.waitUntil(
    clients.matchAll({type:'window'}).then(clientList => {
      for(const client of clientList){
        if(client.url.includes('checkin-admin') && 'focus' in client)
          return client.focus();
      }
      if(clients.openWindow) return clients.openWindow(url);
    })
  );
});
