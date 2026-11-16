// Languages. Every screen text goes through t('English text'): the English sentence is the key, so the code stays readable and a
// text with no translation yet simply shows in English. A language is one file, /i18n/<code>.json: { "English text": "Translation" }.
// {name} marks a value that is put in at that place, so a language can move it where its own word order needs it.
// The catalog is loaded before any screen is drawn (top-level await below), so a module may call t() while it loads.
export const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English', locale: 'en-US' },
  { code: 'km', name: 'Khmer', native: 'ខ្មែរ', locale: 'km-KH' },
];
const KEY = 'rex-lang';
const known = code => LANGUAGES.some(item => item.code === code);

function choose() {
  try {
    const asked = new URLSearchParams(location.search).get('lang');
    if (known(asked)) { localStorage.setItem(KEY, asked); return asked; }
    const saved = localStorage.getItem(KEY);
    if (known(saved)) return saved;
  } catch { /* storage blocked: fall through to the browser's language */ }
  const browser = String((typeof navigator !== 'undefined' && navigator.language) || 'en').slice(0, 2).toLowerCase();
  return known(browser) ? browser : 'en';
}

let current = 'en';
let catalog = Object.create(null);

async function load(code) {
  if (code === 'en') return Object.create(null);
  try {
    const response = await fetch(`/i18n/${code}.json`);
    if (!response.ok) return Object.create(null);
    return Object.assign(Object.create(null), await response.json());
  } catch { return Object.create(null); }
}

// Chooses the language and its catalog (the page does it once at start; the tests do it to try a language without a page).
export function useLanguage(code, map = {}) {
  current = code;
  catalog = Object.assign(Object.create(null), map);
  if (typeof document !== 'undefined') document.documentElement.lang = code;
}

if (typeof document !== 'undefined') {
  const code = choose();
  useLanguage(code, await load(code));
}

export const language = () => current;
export const locale = () => (LANGUAGES.find(item => item.code === current) || LANGUAGES[0]).locale;

// Two ways to call it, and both give back exactly the English text when there is no translation:
//   t('Save')                          a plain text (add { name } values for a text with {name} in it)
//   t`Moves to ${folder} on restart.`  a sentence with values in it; its key is "Moves to {0} on restart."
const squash = text => text.replace(/\s+/g, ' ').trim();
const keys = new WeakMap();
const keyOf = strings => {
  let key = keys.get(strings);
  if (key === undefined) { key = squash(strings.reduce((out, part, index) => out + (index ? `{${index - 1}}` : '') + part, '')); keys.set(strings, key); }
  return key;
};

export function t(first, ...rest) {
  const tagged = Array.isArray(first) && 'raw' in first;
  const named = !tagged && rest[0] && typeof rest[0] === 'object' ? rest[0] : null;
  let out = tagged ? first.reduce((text, part, index) => text + (index ? rest[index - 1] : '') + part, '') : String(first);
  if (current !== 'en') {
    const key = tagged ? keyOf(first) : squash(String(first));
    if (key in catalog) out = catalog[key].replace(/\{(\w+)\}/g, (whole, name) => (tagged ? (name in rest ? String(rest[name]) : whole) : named && name in named ? String(named[name]) : whole));
    else if (named) out = out.replace(/\{(\w+)\}/g, (whole, name) => (name in named ? String(named[name]) : whole));
    return out;
  }
  return named ? out.replace(/\{(\w+)\}/g, (whole, name) => (name in named ? String(named[name]) : whole)) : out;
}

// Picks a language for good and redraws the page in it.
export function setLanguage(code) {
  if (!known(code)) return;
  try { localStorage.setItem(KEY, code); } catch { /* the page still reloads in the browser's language */ }
  location.reload();
}

// A two-button choice, "English" and "ខ្មែរ" (each in its own language), for Settings, the welcome tour and the sign-in page.
export function languagePicker(label) {
  return `<div class="lang-pick" role="radiogroup" aria-label="${label}">${LANGUAGES.map(item => `<button type="button" role="radio" class="${item.code === current ? 'on' : ''}" aria-checked="${item.code === current}" data-lang="${item.code}" lang="${item.code}">${item.native}</button>`).join('')}</div>`;
}
if (typeof document !== 'undefined') {
  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-lang]');
    if (button && button.dataset.lang !== current) setLanguage(button.dataset.lang);
  });
}
