// Lets the phone install Rex Desk like an app. Service workers only run on https (or this computer), so on plain http the
// phone can still add it to the home screen, it just has no offline page.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // A tapped phone notification opens its chat in the page that is already open (sw.js notificationclick).
  navigator.serviceWorker.addEventListener('message', event => {
    const hash = event.data?.type === 'rex-open' ? String(event.data.hash || '') : '';
    if (/^#\/[a-z]+(\/[^\s]*)?$/.test(hash) && location.hash !== hash) location.hash = hash;
  });
}
