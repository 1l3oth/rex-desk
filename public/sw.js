// Rex Desk as an installed app. Everything comes live from the computer; the only thing kept is a small page that says the
// computer cannot be reached, shown when the phone is offline or the computer is off.
const OFFLINE = '/offline.html';
self.addEventListener('install', event => { event.waitUntil(caches.open('rexdesk-v2').then(cache => cache.addAll([OFFLINE, '/login.css', '/icon-192.png']))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
});
