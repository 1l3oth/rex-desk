(() => {
  const system = matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { preference = localStorage.getItem('rex-desk-theme') || 'system'; } catch {}
  if (!['light', 'dark', 'system'].includes(preference)) preference = 'system';
  const apply = () => {
    document.documentElement.dataset.theme = preference === 'system' ? system.matches ? 'dark' : 'light' : preference;
    window.dispatchEvent(new Event('rex-theme'));
  };
  // The colour theme (Midnight, Cyberpunk, Gojo, Crayon, Forest, Sunset), on top of light or dark.
  let skin = 'midnight'; try { skin = localStorage.getItem('rex-desk-skin') || 'midnight'; } catch {}
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
