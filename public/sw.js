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
// Only the files on that list are ever saved: an image of an agent's chat (/artifacts/...) or any other signed-in file is
// never kept on the phone, whatever its name ends in.
const APP_FILES = new Set(PRECACHE);
// A copy is kept only when it is the file itself: a redirect (to sign in, or anywhere else) is never saved in its place.
const keepable = response => Boolean(response) && response.status === 200 && response.type === 'basic' && !response.redirected;
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => Promise.allSettled(PRECACHE.map(file => fetch(file, { cache: 'reload' }).then(response => keepable(response) ? cache.put(file, response) : null)))));
  self.skipWaiting();
});
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name !== CACHE).map(name => caches.delete(name)))).then(() => self.clients.claim())); });
// The app's own files, by the list above, with no query. Not the data API, not language files, not pages.
function isAppFile(url) { return url.origin === self.location.origin && !url.search && APP_FILES.has(url.pathname); }
// The build of each open page, from its X-Rex-Build header. While a new release installs, this worker can still be the one
// answering a page of the new build; that page's files then come from the computer, not from this build's saved copies.
// A page this worker did not see load (it was stopped in between) is not known, so its files come from the computer too.
const pageBuild = new Map();
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // A page open always asks the computer, so a signed-out phone is sent to sign in and a new release's page loads. Only
  // when the computer cannot be reached does the saved offline page show.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => { if (event.resultingClientId) { if (pageBuild.size > 100) pageBuild.clear(); pageBuild.set(event.resultingClientId, response.headers.get('X-Rex-Build') || ''); } return response; })
      .catch(() => { if (event.resultingClientId) pageBuild.set(event.resultingClientId, BUILD); return caches.match(OFFLINE); }));
    return;
  }
  if (!isAppFile(url)) return; // data and everything else: straight to the computer, never saved.
  if (pageBuild.get(event.clientId) !== BUILD) return; // another build's page, or one not seen: straight to the computer.
  // An app file never changes within a build, so a saved copy is served without touching the relay; a new build has a new
  // cache, so nothing stale survives a release.
  event.respondWith(caches.match(url.pathname).then(saved => saved || fetch(request).then(response => {
    if (keepable(response)) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(url.pathname, copy)); }
    return response;
  })));
});
