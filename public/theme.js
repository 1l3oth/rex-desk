(() => {
  const system = matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { preference = localStorage.getItem('rex-desk-theme') || 'system'; } catch {}
  if (!['light', 'dark', 'system'].includes(preference)) preference = 'system';
  const apply = () => {
    document.documentElement.dataset.theme = preference === 'system' ? system.matches ? 'dark' : 'light' : preference;
    window.dispatchEvent(new Event('rex-theme'));
  };
  // The colour theme (Midnight, Cyberpunk, Gojo, Crayon, Forest, Sunset, the Khmer skins, Water Festival), on top of
  // light or dark. A saved choice always wins. With no saved choice, only the first launch of a brand-new install opens
  // on Water Festival and saves it so it sticks; everyone else starts on Midnight. Whether this is a new install is
  // decided by the desk server from its own data folder and carried in the <html data-rex-new> attribute (not an inline
  // script, which the CSP blocks), never browser storage, so an existing person on a fresh browser profile or on their
  // phone keeps Midnight, or whatever look they chose.
  let skin = null; try { skin = localStorage.getItem('rex-desk-skin'); } catch {}
  if (!skin) {
    if (document.documentElement.dataset.rexNew === 'true') { skin = 'waterfest'; try { localStorage.setItem('rex-desk-skin', 'waterfest'); } catch {} }
    else skin = 'midnight';
  }
  document.documentElement.dataset.skin = skin;
  window.rexSkin = { get value() { return document.documentElement.dataset.skin; }, set(value) { document.documentElement.dataset.skin = value; try { localStorage.setItem('rex-desk-skin', value); } catch {} } };
  if (new URLSearchParams(location.search).get('embed') === '1') document.documentElement.classList.add('embed');
  // Text size for the whole app: compact shows more of every chat; it is the default.
  let size = 'compact'; try { size = localStorage.getItem('rex-desk-size') || 'compact'; } catch {}
  document.documentElement.dataset.size = size;
  window.rexSize = { get value() { return document.documentElement.dataset.size; }, set(value) { document.documentElement.dataset.size = value; try { localStorage.setItem('rex-desk-size', value); } catch {} } };
  window.rexTheme = { get preference() { return preference; }, set(value) {
    if (!['light', 'dark', 'system'].includes(value)) return;
    preference = value;
    try { localStorage.setItem('rex-desk-theme', value); } catch {}
    apply();
  } };
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  apply();
})();
