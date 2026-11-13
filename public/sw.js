// Rex Desk as an installed app. Everything comes live from the computer; the only thing kept is a small page that says the
// computer cannot be reached, shown when the phone is offline or the computer is off.
const OFFLINE = '/offline.html';
// A new name whenever the offline page changes, so phones and windows that saved the old one take the new one.
const CACHE = 'rexdesk-v3';
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([OFFLINE, '/icon-192.png']))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name !== CACHE).map(name => caches.delete(name)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
});
