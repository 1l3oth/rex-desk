# Languages

Rex Desk shows in English and Khmer (ខ្មែរ). The person picks the language in Settings, General, in the welcome tour, or on the
sign-in page. The choice is saved in the browser (`rex-lang`), and a browser set to Khmer starts in Khmer.

## How it works

- Every text a person reads goes through `t()` from `public/i18n.js`. The English sentence is the key, so the code stays readable and
  a text with no translation shows in English.
  - `t('Save')` for a plain text.
  - ``t`Moves to ${folder} on restart.` `` for a sentence with values in it. Its key is `Moves to {0} on restart.`
  - Never glue a plural onto a word (`file${s}`). Write both sentences: `n === 1 ? t`${n} file` : t`${n} files``.
  - Never build a sentence from pieces around a value. Put the value in the sentence (`{0}`), so a language can move it.
- A language is one file, `public/i18n/<code>.json`: `{ "English text": "Translation" }`. `{0}`, `{1}` stand for the values in
  order; a translation may swap them.
- The server sends plain English messages (errors, hints). The page translates them with `t(message)` when it shows them, so they
  are in the same file under their English text. Messages that only agents read stay English.
- Text sent to an agent (prompts) is never translated.
- Dates and times use the language's locale (`locale()`).
- `login.html` and `offline.html` cannot load the catalog (the offline page has no server to ask): their Khmer words are in
  `data-km` attributes, put in by `public/i18n-static.js`.

## Adding or changing a text

1. Write the English with `t()` in the page script.
2. Run `node scripts/i18n-keys.mjs km --missing`. It lists every text that has no Khmer yet.
3. Add the Khmer to `public/i18n/km.json`, using the words in [khmer-glossary.md](khmer-glossary.md).
4. `npm test` fails (test/i18n.test.js) while a text has no translation, a `{value}` is lost, or an entry is no longer used.

## Adding a language

Add it to `LANGUAGES` in `public/i18n.js`, create `public/i18n/<code>.json`, and add its font if it needs one. The tests then
require every text to be translated.
