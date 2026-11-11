// Markdown for chat messages. The text is escaped first, so nothing in a message can become markup; only what is built here is.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const LINK = 'target="_blank" rel="noopener noreferrer"';
const CODE = '\u0000';

function inline(text, mentions = [], tasks = {}) {
  const codes = [];
  let html = esc(text).replace(/`([^`\n]+)`/g, (_, code) => { codes.push(code); return `${CODE}${codes.length - 1}${CODE}`; });
  // Evidence and uploads kept by Rex Desk itself show in place: a picture, or a video that plays in the chat.
  html = html.replace(/!\[([^\]\n]*)\]\((\/(?:artifacts|api\/uploads)\/[^\s)"'<>]+)\)/g, (_, alt, src) => /\.(webm|mp4|mov)$/i.test(src.split('?')[0])
    ? `<video class="md-media" src="${src}" controls preload="metadata" aria-label="${alt}"></video>` : `<a class="md-media-link" href="${src}" ${LINK}><img class="md-media" src="${src}" alt="${alt}" loading="lazy"></a>`);
  html = html.replace(/\[([^\]\n]+)\]\((\/(?:artifacts|api\/uploads)\/[^\s)"'<>]+)\)/g, `<a href="$2" ${LINK}>$1</a>`);
  html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, `<a href="$2" ${LINK}>$1</a>`);
  html = html.replace(/(^|[\s(])(https?:\/\/[^\s<)]*[^\s<).,;:!?])/g, `$1<a href="$2" ${LINK}>$2</a>`);
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?![_\w])/g, '$1<em>$2</em>');
  html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  // Highlighted wherever the mention sits (in bold, after a bracket) and when a full stop or colon follows it.
  for (const name of mentions) html = html.replace(new RegExp(`(^|[^\\p{L}\\p{N}_@])@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, 'giu'), `$1<span class="mention">@${esc(name)}</span>`);
  html = html.replace(/(^|[\s(])#(\d{2,})(?![\w])/g, (match, before, number) => (tasks[number] ? `${before}<span class="taskref" title="${esc(tasks[number])}">#${number} ${esc(tasks[number])}</span>` : match));
  return html.replace(new RegExp(`${CODE}(\\d+)${CODE}`, 'g'), (_, index) => `<code>${codes[Number(index)]}</code>`);
}

const cells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
const isDivider = line => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
const isRule = line => /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);
const listMarker = line => /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/.exec(line);
const blockStart = line => /^\s*```/.test(line) || /^#{1,6}\s/.test(line) || /^\s*>/.test(line) || isRule(line) || listMarker(line);

function renderList(items) {
  let index = 0;
  const build = indent => {
    const ordered = items[index].ordered; let html = '';
    while (index < items.length && items[index].indent >= indent) {
      if (items[index].indent > indent && html) { const nested = build(items[index].indent); html = html.replace(/<\/li>$/, `${nested}</li>`); continue; }
      html += `<li>${items[index].html}</li>`; index += 1;
    }
    return `<${ordered ? 'ol' : 'ul'}>${html}</${ordered ? 'ol' : 'ul'}>`;
  };
  return build(items[0].indent);
}

export function markdown(source, { mentions = [], tasks = {} } = {}) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n'), out = [];
  const inl = text => inline(text, mentions, tasks);
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    if (/^\s*```/.test(line)) {
      const code = []; i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i += 1; out.push(`<pre class="md-code"><code>${esc(code.join('\n'))}</code></pre>`); continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isDivider(lines[i + 1])) {
      const head = cells(line), align = cells(lines[i + 1]).map(cell => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : ''));
      const rows = []; i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
      const cell = (tag, text, column) => `<${tag}${align[column] ? ` class="a-${align[column]}"` : ''}>${inl(text)}</${tag}>`;
      out.push(`<div class="md-table"><table><thead><tr>${head.map((text, column) => cell('th', text, column)).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${head.map((_, column) => cell('td', row[column] ?? '', column)).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { const level = Math.min(6, heading[1].length + 2); out.push(`<h${level} class="md-h">${inl(heading[2])}</h${level}>`); i += 1; continue; }
    if (isRule(line)) { out.push('<hr>'); i += 1; continue; }
    if (/^\s*>/.test(line)) {
      const quote = []; while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${markdown(quote.join('\n'), { mentions, tasks })}</blockquote>`); continue;
    }
    if (listMarker(line)) {
      const items = [];
      while (i < lines.length) {
        const match = listMarker(lines[i]);
        if (match) { items.push({ indent: match[1].replace(/\t/g, '  ').length, ordered: /\d/.test(match[2]), html: inl(match[3]) }); i += 1; }
        else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) { items.at(-1).html += `<br>${inl(lines[i].trim())}`; i += 1; }
        else break;
      }
      out.push(renderList(items)); continue;
    }
    const paragraph = [line]; i += 1;
    while (i < lines.length && lines[i].trim() && !blockStart(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isDivider(lines[i + 1]))) paragraph.push(lines[i++]);
    out.push(`<p>${paragraph.map(inl).join('<br>')}</p>`);
  }
  return out.join('');
}
