(() => {
  const system = matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { preference = localStorage.getItem('rex-desk-theme') || 'system'; } catch {}
  if (!['light', 'dark', 'system'].includes(preference)) preference = 'system';
  const apply = () => {
    document.documentElement.dataset.theme = preference === 'system' ? system.matches ? 'dark' : 'light' : preference;
    window.dispatchEvent(new Event('rex-theme'));
  };
  window.rexTheme = { get preference() { return preference; }, set(value) {
    if (!['light', 'dark', 'system'].includes(value)) return;
    preference = value;
    try { localStorage.setItem('rex-desk-theme', value); } catch {}
    apply();
  } };
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  apply();
})();
