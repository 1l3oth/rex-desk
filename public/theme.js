(() => {
  const system = matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { preference = localStorage.getItem('rex-desk-theme') || 'system'; } catch {}
  // The Khmer themes (khmer.css) sit on a light or dark base, so everything made for light or dark still fits them.
  const khmer = { angkor: 'light', lacquer: 'dark', tonle: 'dark' };
  const known = ['light', 'dark', 'system', ...Object.keys(khmer)];
  if (!known.includes(preference)) preference = 'system';
  const apply = () => {
    const root = document.documentElement;
    root.dataset.theme = khmer[preference] || (preference === 'system' ? system.matches ? 'dark' : 'light' : preference);
    if (khmer[preference]) root.dataset.palette = preference; else delete root.dataset.palette;
    window.dispatchEvent(new Event('rex-theme'));
  };
  window.rexTheme = { get preference() { return preference; }, set(value) {
    if (!known.includes(value)) return;
    preference = value;
    try { localStorage.setItem('rex-desk-theme', value); } catch {}
    apply();
  } };
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  apply();
})();
