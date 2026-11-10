// Lets the phone install Rex Desk like an app. Service workers only run on https (or this computer), so on plain http the
// phone can still add it to the home screen, it just has no offline page.
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
