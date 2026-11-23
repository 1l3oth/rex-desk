// Learned notes (what agents learned about the person in user.md, and each project's workflow rules) are bullet lists that
// every computer adds to. They used to travel as one whole file where the newest won, so a note saved on the other computer
// was lost. Now both sides are merged line by line. A note someone removed (forgotten) stays removed on every computer:
// forgotten.json keeps, per file and note, whether it is gone and when, and the newest word on a note wins.

// The words of a note without its "- ", its date mark and case, so the same note saved twice is one note.
export const noteKey = line => String(line || '').replace(/^-\s+/, '').replace(/\s+\(\d{4}-\d{2}-\d{2}[^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();

// A page: the lines before the first list or section (title and intro), then sections of bullets ('' is the list without a heading).
export function parseNotes(text) {
  const head = [], sections = new Map(); let section = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) { section = heading[1].trim(); if (!sections.has(section)) sections.set(section, []); continue; }
    if (/^-\s+/.test(line)) { const name = section ?? ''; if (!sections.has(name)) sections.set(name, []); sections.get(name).push(line.trim()); continue; }
    if (section === null && !sections.size) head.push(line);
  }
  while (head.length && !head.at(-1).trim()) head.pop();
  return { head, sections };
}
export function writeNotes({ head, sections }) {
  const out = [...head, ''];
  for (const [name, items] of sections) { if (!items.length) continue; if (name) out.push(`## ${name}`, ''); out.push(...items, ''); }
  return out.join('\n');
}

// Both pages joined: this computer's notes in their order, then the other's notes it does not have yet. Forgotten notes go.
export function mergeNotes(local, remote, forgotten = {}) {
  const gone = key => forgotten[key]?.gone === true;
  const mine = parseNotes(local), theirs = parseNotes(remote), seen = new Set();
  const result = { head: mine.head.length ? mine.head : theirs.head, sections: new Map() };
  const add = (name, line) => { const key = noteKey(line); if (!key || seen.has(key) || gone(key)) return; seen.add(key); if (!result.sections.has(name)) result.sections.set(name, []); result.sections.get(name).push(line); };
  for (const [name, items] of mine.sections) for (const line of items) add(name, line);
  for (const [name, items] of theirs.sections) for (const line of items) add(name, line);
  return writeNotes(result);
}

// forgotten.json: { "<file>": { "<note key>": { gone, at } } }. Joined per note, the newest word wins.
export function mergeForgotten(left = {}, right = {}) {
  const out = {};
  for (const source of [left, right]) for (const [file, notes] of Object.entries(source || {})) {
    out[file] ||= {};
    for (const [key, mark] of Object.entries(notes || {})) if (!out[file][key] || String(mark?.at || '') > String(out[file][key].at || '')) out[file][key] = { gone: Boolean(mark?.gone), at: String(mark?.at || '') };
  }
  return out;
}
export const MERGED_FILES = name => name === 'user.md' || /^workflows\/[a-z0-9._-]+\.md$/.test(name);
