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
      // A full web address (the Booking.com Extranet answer for a check-in time request): open it as it is.
      if(/^https:\/\//.test(url)){
        if(clients.openWindow) return clients.openWindow(url);
        return;
      }
      // Booking.com inbox alerts (/inbox#c/<booking number>): open that conversation, in the inbox window if one is open.
      if(/^\/inbox(?:[#?]|$)/.test(url)){
        // An admin window is open: hand it the conversation (it opens its Inbox tab, or the inbox page, by the admin setting).
        const m=url.match(/#c\/(.+)$/);
        const view=/#ai$/.test(url)?'ai':null;
        for(const client of clientList){
          if(client.url.includes('checkin-admin') && 'focus' in client){
            client.postMessage({type:'open-inbox',c:m?decodeURIComponent(m[1]):null,view});
            return client.focus();
          }
        }
        for(const client of clientList){
          if(/\/inbox(?:[#?]|$)/.test(client.url) && 'navigate' in client)return client.navigate(url).then(c => (c || client).focus());
        }
        if(clients.openWindow) return clients.openWindow(url);
        return;
      }
      for(const client of clientList){
        if(client.url.includes('checkin-admin') && 'focus' in client){
          // deep-link notifications (e.g. /checkin-admin?tab=damage) must change the open tab too
          if(/[?&](tab|hc)=/.test(url) && 'navigate' in client)return client.navigate(url).then(c => (c || client).focus());
          return client.focus();
        }
      }
      if(clients.openWindow) return clients.openWindow(url);
    })
  );
});
