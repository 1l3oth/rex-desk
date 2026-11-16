// Rex Desk as an installed app. Everything comes live from the computer; the only thing kept is a small page that says the
// computer cannot be reached, shown when the phone is offline or the computer is off.
const OFFLINE = '/offline.html';
// A new name whenever the offline page changes, so phones and windows that saved the old one take the new one.
const CACHE = 'rexdesk-v4';
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([OFFLINE, '/icon-192.png', '/i18n-static.js']))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name !== CACHE).map(name => caches.delete(name)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  // The offline page's Khmer words come from this script: it is kept too, so the page can read it with the computer away.
  if (new URL(event.request.url).pathname === '/i18n-static.js') { event.respondWith(fetch(event.request).catch(() => caches.match('/i18n-static.js'))); return; }
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
});
