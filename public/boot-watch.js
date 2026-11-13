// Loaded as a file, not inline: the page CSP (script-src 'self') blocks inline scripts.
// If a page file is broken or missing (often someone's edit in progress), say so instead of a blank "Opening" screen, and try again by itself.
// The logo is drawn here, not loaded: these screens show when the server is down, and an image from it would be broken.
(() => {
  const MARK = '<svg class="boot-mark" viewBox="0 0 64 64" width="44" height="44" aria-hidden="true"><defs><linearGradient id="rex-mark-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5a97ff"/><stop offset="1" stop-color="#3a72e8"/></linearGradient></defs><rect x="2" y="2" width="60" height="60" rx="14" fill="url(#rex-mark-g)"/><g fill="#fff"><rect x="16" y="16" width="14" height="14" rx="3"/><rect x="34" y="16" width="14" height="14" rx="3"/><rect x="16" y="34" width="14" height="14" rx="3"/><rect x="34" y="34" width="14" height="14" rx="3" opacity=".47"/></g></svg>';
  let reason = '';
  addEventListener('error', event => { reason ||= event.message ? `${event.message}${event.filename ? ` in ${event.filename.replace(location.origin, '')}${event.lineno ? `:${event.lineno}` : ''}` : ''}` : (event.target?.src ? `Could not load ${event.target.src.replace(location.origin, '')}` : ''); }, true);
  setTimeout(() => {
    const boot = document.querySelector('#app > .boot'); if (!boot || boot.querySelector('h2')) return;
    boot.innerHTML = MARK + '<h2>Rex Desk could not open</h2><p class="boot-why"></p><p>A page file may be mid-edit, or the server may be updating.</p><div class="boot-actions"><button type="button" class="btn primary">Reload now</button><span class="boot-count"></span></div>';
    boot.querySelector('.boot-why').textContent = reason || 'The page script did not start.';
    boot.querySelector('button').onclick = () => location.reload();
    // Reload only when it can help: a fresh page file, or a server that answers again. Reloading into a stopped server
    // would leave an error page that never tries again.
    const count = boot.querySelector('.boot-count'), why = boot.querySelector('.boot-why');
    let left = 10;
    const tick = async () => {
      if (left-- > 0) { count.textContent = `Checking again in ${left + 1}s`; setTimeout(tick, 1000); return; }
      count.textContent = 'Checking…';
      if (await serverUp()) location.reload();
      else { why.textContent = 'The Rex Desk server is not running. The desktop app starts it again by itself; in a browser, run Start-RexDesk.ps1.'; left = 5; setTimeout(tick, 1000); }
    };
    tick();
  }, 8000);
  // While the page is open: if the server stops answering, say so over the page and reload once it is back.
  async function serverUp() { try { return (await fetch('/api/auth', { cache: 'no-store' })).ok; } catch { return false; } }
  let misses = 0, cover = null;
  setInterval(async () => {
    // The first load failed (the server was restarting for an update): reload once it answers instead of staying on the error.
    if (document.querySelector('#app > .boot-failed')) {
      // At most 5 tries in a row, so a server that answers but cannot open the page does not reload it forever.
      let tries = 0; try { tries = Number(sessionStorage.getItem('rex-boot-retries')) || 0; } catch {}
      if (tries < 5 && await serverUp()) { try { sessionStorage.setItem('rex-boot-retries', String(tries + 1)); } catch {} location.reload(); }
      return;
    }
    if (document.querySelector('#app > .boot')) return;
    try { sessionStorage.removeItem('rex-boot-retries'); } catch {}
    if (await serverUp()) { misses = 0; if (cover) location.reload(); return; }
    if (++misses < 2 || cover) return;
    cover = document.createElement('div'); cover.className = 'boot';
    cover.innerHTML = MARK + '<h2>Rex Desk server stopped</h2><p>Reconnecting by itself when it is back. The desktop app restarts it for you.</p><i class="boot-bar"></i>';
    cover.style.zIndex = '9999'; document.body.append(cover);
  }, 4000);
})();
