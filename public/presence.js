// Tells Rex Desk whether this window is the one the person is looking at, so notifications go out only when it is not.
(() => {
  const send = () => {
    const focused = document.visibilityState === 'visible' && document.hasFocus();
    fetch('/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rex-desk': '1' }, body: JSON.stringify({ focused, view: window.rexView || '' }), keepalive: true }).catch(() => {});
  };
  for (const name of ['focus', 'blur', 'visibilitychange', 'pagehide']) window.addEventListener(name, send);
  window.rexPresence = send;
  setInterval(send, 15000); send();
})();
