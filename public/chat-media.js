// What was shared in a chat, like a messenger's chat info: pictures and videos, files, and links, newest first.
// Built from the messages themselves: files attached through the + button, pictures and links written in messages,
// file paths an agent mentioned, and the evidence (screenshots, recordings) an agent saved during the run.
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i, VIDEO = /\.(mp4|webm|mov)$/i;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>()"'`\]]+[^\s<>()"'`\].,;:!?]/g;
const WINDOWS_PATH = /(?:^|[\s`'"(])([A-Za-z]:\\(?:[^\\/:*?"<>|\r\n`]+\\)*[^\\/:*?"<>|\r\n`\s]+\.[A-Za-z0-9]{1,6})(?=$|[\s`'").,;:])/g;
const baseName = file => String(file).split(/[\\/]/).pop();
const uploadUrl = file => `/api/uploads/file?path=${encodeURIComponent(file)}`;
const isUpload = file => /[\\/]uploads[\\/][0-9a-f-]{36}[\\/]/i.test(file);
const local = url => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/(api|artifacts)\//.test(url);

// entries: [{ from, at, text }]; artifacts: Rex Desk evidence records for the runs in this chat.
export function collectShared(entries, artifacts = []) {
  const media = [], files = [], links = [], seen = new Set();
  const add = (list, key, item) => { if (seen.has(key)) return; seen.add(key); list.push(item); };
  for (const entry of entries) {
    const text = String(entry.text || ''), meta = { from: entry.from, at: entry.at };
    const attached = /Attached files \(read them from these paths\):\n((?:- .+\n?)+)/.exec(text);
    for (const line of attached ? attached[1].split('\n') : []) {
      const file = line.replace(/^- /, '').trim(); if (!file) continue;
      const item = { ...meta, name: baseName(file), path: file, url: isUpload(file) ? uploadUrl(file) : '' };
      if ((IMAGE.test(file) || VIDEO.test(file)) && item.url) add(media, `m:${file}`, { ...item, video: VIDEO.test(file) });
      add(files, `f:${file}`, item);
    }
    for (const match of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) add(media, `m:${match[1]}`, { ...meta, name: baseName(match[1]), url: match[1], video: VIDEO.test(match[1]) });
    for (const match of text.matchAll(URL_PATTERN)) { const url = match[0]; if (local(url)) continue; add(links, `l:${url}`, { ...meta, url, host: (() => { try { return new URL(url).host; } catch { return url; } })() }); }
    for (const match of (attached ? text.slice(0, attached.index) : text).matchAll(WINDOWS_PATH)) { const file = match[1]; add(files, `f:${file}`, { ...meta, name: baseName(file), path: file, url: isUpload(file) ? uploadUrl(file) : '' }); }
  }
  for (const artifact of artifacts) {
    const url = `/artifacts/${artifact.runId}/${encodeURIComponent(artifact.file)}`, meta = { from: artifact.from || 'Agent', at: artifact.createdAt || '' };
    if (/^(image|video)\//.test(artifact.type || '') || IMAGE.test(artifact.file) || VIDEO.test(artifact.file)) add(media, `m:${url}`, { ...meta, name: artifact.file, url, video: /^video\//.test(artifact.type || '') || VIDEO.test(artifact.file) });
    else add(files, `f:${url}`, { ...meta, name: artifact.file, path: '', url });
  }
  const newest = (left, right) => String(right.at).localeCompare(String(left.at));
  return { media: media.sort(newest), files: files.sort(newest), links: links.sort(newest) };
}

export function sharedTabsHtml(ctx, shared, tab) {
  const { esc, hhmm } = ctx, when = at => at ? `${new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hhmm(at)}` : '';
  if (tab === 'media') return shared.media.length ? `<div class="sh-grid">${shared.media.map(item => `<a class="sh-thumb" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" title="${esc(item.name)} · ${esc(item.from)} · ${esc(when(item.at))}">${item.video ? `<span class="sh-video" aria-hidden="true">▶</span><span class="sh-cap">${esc(item.name)}</span>` : `<img src="${esc(item.url)}" alt="${esc(item.name)}" loading="lazy">`}</a>`).join('')}</div>` : '<p class="sh-empty">No pictures or videos yet. Attach one with + in the message box.</p>';
  if (tab === 'files') return shared.files.length ? `<ul class="sh-list">${shared.files.map(item => `<li><span class="sh-icon" aria-hidden="true">${esc((item.name.split('.').pop() || 'file').slice(0, 4).toUpperCase())}</span><span class="sh-text"><b title="${esc(item.path || item.name)}">${esc(item.name)}</b><small>${esc(item.from)} · ${esc(when(item.at))}</small>${item.url ? '' : `<code title="${esc(item.path)}">${esc(item.path)}</code>`}</span><button type="button" class="btn small" data-file-open="${esc(item.url || item.path)}">Open</button></li>`).join('')}</ul>` : '<p class="sh-empty">No files yet.</p>';
  return shared.links.length ? `<ul class="sh-list">${shared.links.map(item => `<li><span class="sh-icon link" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8M9 7a3 3 0 0 0-4.2 0l-2 2A3 3 0 0 0 7 13.2l.8-.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span><span class="sh-text"><a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer"><b>${esc(item.host)}</b></a><small>${esc(item.from)} · ${esc(when(item.at))}</small><code title="${esc(item.url)}">${esc(item.url)}</code></span></li>`).join('')}</ul>` : '<p class="sh-empty">No links yet.</p>';
}

export const sharedCount = shared => ({ media: shared.media.length, files: shared.files.length, links: shared.links.length });
