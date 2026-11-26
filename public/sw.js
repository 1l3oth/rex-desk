// Rex Desk as an installed app. On a phone the app is loaded through the relay from the home computer, so every script,
// style and icon would otherwise cross the relay on each open. This worker keeps the app's own files saved on the phone,
// so only data (messages, lists, photos) still goes through the relay. The cache is named after the running build; the
// server writes it in when it serves this file, so a new release makes a new worker and a new cache and the old one is
// dropped. Nothing private is saved: only code, styles and icons are cached, and a page open always goes to the computer,
// so a signed-out phone is sent to sign in instead of showing a saved page.
const BUILD = '__REX_BUILD__';
const CACHE = `rexdesk-app-${BUILD}`;
const OFFLINE = '/offline.html';
// The app's own files, written in by the server (public scripts and styles, fonts, icons, the offline page and the vendor
// bundles). Saved at install so the next open needs none of them from the relay. Saved one by one, so one file that fails
// to come (a slow relay) does not throw the whole save away; the rest are still kept and the missing one is fetched later.
const PRECACHE = ['__REX_PRECACHE__'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => Promise.allSettled(PRECACHE.map(file => cache.add(file))))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name !== CACHE).map(name => caches.delete(name)))).then(() => self.clients.claim())); });
// The app's own files: scripts, styles, icons, fonts and the three.js / driver vendor bundles. Not the data API, not the
// language files (a word may be fixed mid-release), and not pages (handled as a navigation).
function isAppFile(url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  if (p.startsWith('/api/') || p.startsWith('/i18n/') || p.endsWith('.html') || p === '/') return false;
  return /\.(?:js|mjs|css|woff2|png|svg|ico|webmanifest|jpg|jpeg|webp|gif)$/.test(p) || p.startsWith('/vendor/') || p.startsWith('/fonts/');
}
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // A page open always asks the computer, so a signed-out phone is sent to sign in and a new release's page loads. Only
  // when the computer cannot be reached does the saved offline page show.
  if (request.mode === 'navigate') { event.respondWith(fetch(request).catch(() => caches.match(OFFLINE))); return; }
  if (!isAppFile(url)) return; // data and everything else: straight to the computer, never saved.
  // An app file never changes within a build, so a saved copy is served without touching the relay; a new build has a new
  // cache, so nothing stale survives a release.
  event.respondWith(caches.match(request).then(saved => saved || fetch(request).then(response => {
    if (response && response.status === 200 && response.type === 'basic') { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(request, copy)); }
    return response;
  })));
});
