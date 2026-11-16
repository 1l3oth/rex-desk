// For the small pages that cannot load /i18n.js (the offline page has no server to ask): an element with data-km takes its Khmer text
// when the person chose Khmer (the same choice the app saved), a placeholder with data-km-placeholder likewise.
(function () {
  var km = false;
  try { km = (localStorage.getItem('rex-lang') || (navigator.language || '').slice(0, 2)) === 'km'; } catch (e) { km = /^km/i.test(navigator.language || ''); }
  if (!km) return;
  document.documentElement.lang = 'km';
  document.querySelectorAll('[data-km]').forEach(function (node) { node.innerHTML = node.getAttribute('data-km'); });
  document.querySelectorAll('[data-km-placeholder]').forEach(function (node) { node.setAttribute('placeholder', node.getAttribute('data-km-placeholder')); });
  document.querySelectorAll('[data-km-aria]').forEach(function (node) { node.setAttribute('aria-label', node.getAttribute('data-km-aria')); });
  if (document.documentElement.dataset.kmTitle) document.title = document.documentElement.dataset.kmTitle;
})();
