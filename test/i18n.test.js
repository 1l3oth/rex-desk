import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectKeys, loadLanguage, serverText } from '../scripts/i18n-keys.mjs';
import { t, useLanguage, LANGUAGES, languagePicker } from '../public/i18n.js';

const pages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const holes = text => (text.match(/\{\w+\}/g) || []).sort().join(',');

test('with no translation t() gives back exactly the English text, in every way it is called', () => {
  useLanguage('en');
  const folder = 'D:\\data';
  assert.equal(t('Save'), 'Save');
  assert.equal(t`Moves to ${folder} when Rex Desk restarts.`, 'Moves to D:\\data when Rex Desk restarts.');
  assert.equal(t`${3} agents
    working`, '3 agents\n    working', 'the text is not changed, even across lines');
  assert.equal(t('Hello {name}', { name: 'Rex' }), 'Hello Rex');
  assert.equal(t('Hello {name}'), 'Hello {name}', 'a value nobody gave stays as it is');
});

test('a language puts each value where its own word order needs it, and a text it does not know stays English', () => {
  useLanguage('km', { 'Save': 'រក្សាទុក', '{0} of {1} lights': '{1} ពន្លឺ មាន {0}', 'Hello {name}': 'សួស្ដី {name}', 'Extra words': 'ពាក្យបន្ថែម' });
  assert.equal(t('Save'), 'រក្សាទុក');
  assert.equal(t`${2} of ${9} lights`, '9 ពន្លឺ មាន 2', 'values can swap places');
  assert.equal(t('Hello {name}', { name: 'Rex' }), 'សួស្ដី Rex');
  assert.equal(t('Not translated'), 'Not translated');
  assert.equal(t`Not translated ${1}`, 'Not translated 1');
  assert.equal(t('Extra   words'), 'ពាក្យបន្ថែម', 'extra spaces in a text are squashed, like in the key');
  useLanguage('en');
});

test('the language picker lists every language by its own name and marks the one in use', () => {
  useLanguage('km');
  const html = languagePicker('Language');
  for (const language of LANGUAGES) assert.ok(html.includes(`data-lang="${language.code}"`) && html.includes(`>${language.native}<`), language.code);
  assert.match(html, /data-lang="km"[^>]*>|class="on"[^>]*data-lang="km"/);
  assert.ok(/class="on" aria-checked="true" data-lang="km"/.test(html), 'Khmer is marked as the one in use');
  useLanguage('en');
});

for (const { code } of LANGUAGES.filter(language => language.code !== 'en')) {
  test(`every text in the page scripts has a ${code} translation, and the file holds nothing that is not used`, () => {
    const keys = collectKeys(), catalog = loadLanguage(code);
    const missing = [...keys.keys()].filter(key => !(key in catalog));
    assert.deepEqual(missing.slice(0, 15), [], `${missing.length} texts have no ${code} translation yet. List them: node scripts/i18n-keys.mjs ${code} --missing. Add them to public/i18n/${code}.json (see docs/i18n/khmer-glossary.md for the words to use).`);
    const stale = Object.keys(catalog).filter(key => !keys.has(key) && !serverText(key));
    assert.deepEqual(stale.slice(0, 15), [], `${stale.length} entries in ${code}.json are no longer used by any page script or server message`);
  });

  test(`every ${code} translation keeps the same {values} as its English text, and is clean`, () => {
    const catalog = loadLanguage(code), problems = [];
    for (const [english, translated] of Object.entries(catalog)) {
      if (typeof translated !== 'string' || !translated.trim()) problems.push(`${english}: empty`);
      else {
        if (holes(english) !== holes(translated)) problems.push(`${english}: values ${holes(english) || '-'} become ${holes(translated) || '-'}`);
        if (/[\u200B\u200C\u200D\u2060]/.test(translated)) problems.push(`${english}: has a zero-width space (the browser breaks lines by itself)`);
        if (translated !== translated.trim() || /  /.test(translated)) problems.push(`${english}: extra spaces`);
        if (english !== english.replace(/\s+/g, ' ').trim()) problems.push(`${english}: the English key has extra spaces`);
      }
    }
    assert.deepEqual(problems.slice(0, 15), [], `${problems.length} problems in ${code}.json`);
  });
}

test('every page script that calls t() imports it, so no screen breaks with "t is not a function"', () => {
  const broken = [];
  for (const name of readdirSync(pages).filter(file => file.endsWith('.js') && file !== 'i18n.js')) {
    const source = readFileSync(path.join(pages, name), 'utf8');
    if (/(^|[^\w.$])t(`|\('| *\(`)/.test(source) && !/import \{[^}]*\bt\b[^}]*\} from '\.\/i18n\.js'/.test(source)) broken.push(name);
  }
  assert.deepEqual(broken, []);
});

