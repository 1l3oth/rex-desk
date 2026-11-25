// Loaded as a file, not inline: the page CSP (script-src 'self') blocks inline scripts.
// If a page file is broken or missing (often someone's edit in progress), say so instead of a blank "Opening" screen, and try again by itself.
// The logo is drawn here, not loaded: these screens show when the server is down, and an image from it would be broken.
(() => {
  // This script runs before the page can load its words, and while the server is away, so its few sentences are here, in both languages.
  let km = false; try { km = (localStorage.getItem('rex-lang') || (navigator.language || '').slice(0, 2)) === 'km'; } catch { km = /^km/i.test(navigator.language || ''); }
  const L = (english, khmer) => (km ? khmer : english);
  const MARK = '<svg class="boot-mark" viewBox="0 0 64 64" width="44" height="44" aria-hidden="true"><defs><linearGradient id="rex-mark-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5a97ff"/><stop offset="1" stop-color="#3a72e8"/></linearGradient></defs><rect x="2" y="2" width="60" height="60" rx="14" fill="url(#rex-mark-g)"/><g fill="#fff"><rect x="16" y="16" width="14" height="14" rx="3"/><rect x="34" y="16" width="14" height="14" rx="3"/><rect x="16" y="34" width="14" height="14" rx="3"/><rect x="34" y="34" width="14" height="14" rx="3" opacity=".47"/></g></svg>';
  let reason = '';
  // A page script that fails to load is asked for again twice (after 1 s, then 3 s) under a new address, so a slow or failed first answer
  // (the phone relay can take 30 s to answer) is not cached as a failure. Only a script that still fails is shown as the reason.
  // A retry counts as pending from the moment it is planned until the new script loads or fails, and the could not open
  // screen waits while any is pending, so it never shows (and reloads) over a script that may still arrive.
  const RETRY_AFTER = [1000, 3000];
  let retrying = 0;
  function retryScript(el) {
    const url = new URL(el.src, location.href), tries = Number(url.searchParams.get('rex-retry')) || 0;
    if (tries >= RETRY_AFTER.length || !el.src.startsWith(location.origin)) return false;
    url.searchParams.set('rex-retry', String(tries + 1));
    retrying++;
    setTimeout(() => {
      const again = document.createElement('script'); if (el.type) again.type = el.type;
      again.onload = again.onerror = () => { retrying = Math.max(0, retrying - 1); };
      again.src = url.href; document.head.append(again);
    }, RETRY_AFTER[tries]);
    return true;
  }
  addEventListener('error', event => { if (event.target?.tagName === 'SCRIPT' && event.target.src && retryScript(event.target)) return; reason ||= event.message ? `${event.message}${event.filename ? ` in ${event.filename.replace(location.origin, '')}${event.lineno ? `:${event.lineno}` : ''}` : ''}` : (event.target?.src ? `Could not load ${event.target.src.replace(location.origin, '')}` : ''); }, true);
  const showFailed = () => {
    // The page script started (chat.js marks the screen) and is only waiting for a slow first answer: that is not a broken page.
    const boot = document.querySelector('#app > .boot'); if (!boot || boot.querySelector('h2') || boot.dataset.started) return;
    // A script retry is still on its way: look again once it has loaded or failed.
    if (retrying) { setTimeout(showFailed, 500); return; }
    boot.innerHTML = MARK + '<h2>' + L('Rex Desk could not open', 'Rex Desk មិនអាចបើកបានទេ') + '</h2><p class="boot-why"></p><p>' + L('A page file may be mid-edit, or the server may be updating.', 'ឯកសារទំព័រប្រហែលជាកំពុងត្រូវបានកែ ឬម៉ាស៊ីនមេកំពុងធ្វើបច្ចុប្បន្នភាព។') + '</p><div class="boot-actions"><button type="button" class="btn primary">' + L('Reload now', 'ផ្ទុកឡើងវិញឥឡូវនេះ') + '</button><span class="boot-count"></span></div>';
    boot.querySelector('.boot-why').textContent = reason || L('The page script did not start.', 'ស្គ្រីបទំព័រមិនបានចាប់ផ្ដើមទេ។');
    boot.querySelector('button').onclick = () => location.reload();
    // Reload only when it can help: a fresh page file, or a server that answers again. Reloading into a stopped server
    // would leave an error page that never tries again.
    const count = boot.querySelector('.boot-count'), why = boot.querySelector('.boot-why');
    let left = 10;
    // A script that fails after this screen showed is retried too: the countdown pauses while any retry is pending, and stops
    // if a retried script started the page.
    const gone = () => document.querySelector('#app > .boot') !== boot || boot.dataset.started;
    const waitRetry = () => { count.textContent = L('Trying the page file again…', 'កំពុងសាកល្បងឯកសារទំព័រម្ដងទៀត…'); setTimeout(tick, 500); };
    const tick = async () => {
      if (gone()) return;
      if (retrying) return waitRetry();
      if (left-- > 0) { count.textContent = L(`Checking again in ${left + 1}s`, `នឹងពិនិត្យម្ដងទៀតក្នុង ${left + 1} វិនាទី`); setTimeout(tick, 1000); return; }
      count.textContent = L('Checking…', 'កំពុងពិនិត្យ…');
      const up = await serverUp();
      if (gone()) return;
      // A retry may have been planned while the server was being asked: never reload over it.
      if (retrying) { left = 0; return waitRetry(); }
      if (up) location.reload();
      else { why.textContent = L('The Rex Desk server is not running. The desktop app starts it again by itself; in a browser, run Start-RexDesk.ps1.', 'ម៉ាស៊ីនមេ Rex Desk មិនកំពុងដំណើរការទេ។ កម្មវិធីលើកុំព្យូទ័របើកវាម្ដងទៀតដោយខ្លួនឯង។ ក្នុងកម្មវិធីរុករក សូមដំណើរការ Start-RexDesk.ps1។'); left = 5; setTimeout(tick, 1000); }
    };
    tick();
  };
  setTimeout(showFailed, 8000);
  // While Rex Desk opens, the loading screen says what it is doing (unlocking, opening chats, restoring a backup).
  const stageTimer = setInterval(async () => {
    const label = document.querySelector('#app > .boot:not(.boot-failed) span'); if (!label) { clearInterval(stageTimer); return; }
    try { const boot = await (await fetch('/api/boot', { cache: 'no-store' })).json(); if (boot.stage) label.textContent = `${boot.stage}…`; } catch { /* the server is still starting */ }
  }, 800);
  // While the page is open: if the server stops answering, say so over the page and reload once it is back.
  async function serverUp() { try { return (await fetch('/api/auth', { cache: 'no-store' })).ok; } catch { return false; } }
  let misses = 0, cover = null;
  setInterval(async () => {
    // The first load failed (the server was restarting for an update): reload once it answers instead of staying on the error.
    // The page is already trying again in place (chat.js): a reload would only start over the same slow first load.
    if (document.querySelector('#app > .boot-failed[data-retrying]')) return;
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
    cover.innerHTML = MARK + '<h2>' + L('Rex Desk server stopped', 'ម៉ាស៊ីនមេ Rex Desk បានឈប់') + '</h2><p>' + L('Reconnecting by itself when it is back. The desktop app restarts it for you.', 'នឹងតភ្ជាប់ឡើងវិញដោយខ្លួនឯងនៅពេលវាត្រឡប់មកវិញ។ កម្មវិធីលើកុំព្យូទ័រចាប់ផ្ដើមវាឡើងវិញឱ្យអ្នក។') + '</p><i class="boot-bar"></i>';
    cover.style.zIndex = '9999'; document.body.append(cover);
  }, 4000);
})();
