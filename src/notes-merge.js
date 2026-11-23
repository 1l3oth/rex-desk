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

// Both pages joined: this computer's page stays as it is, byte for byte (text under headings, spacing, line ends), less its
// forgotten note lines; the other's notes it does not have yet go in after the last note of the same section (a section it
// does not have goes at the end). With no page here yet, the other's page is the start.
export function mergeNotes(local, remote, forgotten = {}) {
  const gone = key => forgotten[key]?.gone === true;
  const base = String(local || '') || String(remote || ''), eol = /\r\n/.test(base) ? '\r\n' : '\n';
  const kept = [], seen = new Set(), after = new Map();
  let section = '', firstHeading = -1;
  for (const line of base.split(/(?<=\n)/)) {
    const bare = line.replace(/\r?\n$/, ''), heading = /^##\s+(.+)$/.exec(bare);
    if (heading) { section = heading[1].trim(); if (firstHeading < 0) firstHeading = kept.length; kept.push(line); after.set(section, kept.length); continue; }
    if (/^-\s+/.test(bare)) {
      const key = noteKey(bare.trim());
      if (key && gone(key)) continue;
      if (key) seen.add(key);
      kept.push(line); after.set(section, kept.length); continue;
    }
    kept.push(line);
  }
  const adds = new Map();
  for (const [name, items] of parseNotes(remote).sections) for (const line of items) {
    const key = noteKey(line); if (!key || seen.has(key) || gone(key)) continue;
    seen.add(key); if (!adds.has(name)) adds.set(name, []); adds.get(name).push(line);
  }
  if (!adds.size) return kept.join('');
  const ended = index => { if (index > 0 && !/\n$/.test(kept[index - 1])) kept[index - 1] += eol; };
  // Into sections this page has, from the bottom up so earlier places do not move.
  const inserts = [];
  for (const [name, lines] of adds) {
    if (after.has(name)) inserts.push([after.get(name), lines.map(line => line + eol)]);
    else if (name === '' && firstHeading >= 0) inserts.push([firstHeading, [...lines.map(line => line + eol), eol]]);
  }
  for (const [index, lines] of inserts.sort((left, right) => right[0] - left[0])) { ended(index); kept.splice(index, 0, ...lines); }
  // Sections this page does not have yet, at the end.
  for (const [name, lines] of adds) {
    if (after.has(name) || (name === '' && firstHeading >= 0)) continue;
    ended(kept.length);
    if (kept.length && kept.join('').trim()) kept.push(eol);
    if (name) kept.push(`## ${name}${eol}`, eol);
    kept.push(...lines.map(line => line + eol));
  }
  return kept.join('');
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
