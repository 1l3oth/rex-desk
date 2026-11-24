// Explain my changes: a spec (JSON) in, one self-contained HTML page out. The changed lines sit on the left with a plain note
// beside each block, and a small picture of the idea sits on top. Inline CSS and SVG only: the page works offline.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
// Em dashes read as machine-written: the page uses plain commas instead.
const plain = value => String(value ?? '').replace(/\s*—\s*/g, ', ');

// Short labels in boxes, joined by arrows, wrapping to a second row when there are many.
export function flowSvg(labels) {
  const items = (Array.isArray(labels) ? labels : []).map(item => plain(item).trim()).filter(Boolean).slice(0, 5);
  if (!items.length) return '';
  const box = 150, gap = 46, height = 64, width = items.length * box + (items.length - 1) * gap;
  const parts = items.map((label, index) => {
    const x = index * (box + gap), words = label.split(/\s+/), lines = [];
    for (const word of words) { const last = lines.at(-1); if (last && `${last} ${word}`.length <= 18) lines[lines.length - 1] = `${last} ${word}`; else lines.push(word); }
    const shown = lines.slice(0, 3), top = height / 2 - (shown.length - 1) * 8;
    const text = shown.map((line, row) => `<text x="${x + box / 2}" y="${top + row * 16 + 5}" text-anchor="middle">${esc(line)}</text>`).join('');
    const arrow = index < items.length - 1 ? `<path class="arrow" d="M${x + box + 8} ${height / 2} H${x + box + gap - 10}" /><path class="head" d="M${x + box + gap - 16} ${height / 2 - 6} L${x + box + gap - 8} ${height / 2} L${x + box + gap - 16} ${height / 2 + 6}" />` : '';
    return `<rect x="${x + 1}" y="1" width="${box - 2}" height="${height - 2}" rx="10" class="${index === items.length - 1 ? 'box end' : 'box'}" />${text}${arrow}`;
  }).join('');
  return `<svg class="flow" viewBox="0 0 ${width} ${height}" style="max-width:${width}px" role="img" aria-label="${esc(items.join(', then '))}">${parts}</svg>`;
}

function blockHtml(block) {
  let line = Number.isInteger(block.start) ? block.start : null;
  const rows = String(block.code ?? '').replace(/\r/g, '').split('\n').map(raw => {
    const sign = raw[0] === '+' || raw[0] === '-' ? raw[0] : ' ', text = raw[0] === '+' || raw[0] === '-' || raw[0] === ' ' ? raw.slice(1) : raw;
    const number = line === null || sign === '-' ? '' : line++;
    return `<div class="ln ${sign === '+' ? 'add' : sign === '-' ? 'del' : ''}"><span class="no">${number}</span><span class="sg">${sign === ' ' ? '' : sign}</span><code>${esc(text) || ' '}</code></div>`;
  }).join('');
  return `<div class="block"><div class="code">${rows}</div><div class="note">${esc(plain(block.note))}</div></div>`;
}

export function render(spec) {
  const files = (spec.files || []).map(file => `<section class="file"><h2>${esc(file.path)}</h2>${(file.blocks || []).map(blockHtml).join('')}</section>`).join('');
  const idea = flowSvg(spec.idea);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(plain(spec.title || 'What changed'))}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--panel:#fff;--ink:#1d2127;--muted:#5d6672;--line:#dde1e6;--add:#e6f4ea;--addk:#1a7f37;--del:#fbe9ea;--delk:#b42318;--accent:#2563eb;--box:#eef3fd}
@media (prefers-color-scheme:dark){:root{--bg:#15171b;--panel:#1d2025;--ink:#e6e8eb;--muted:#9aa3ad;--line:#2e333a;--add:#16301f;--addk:#4ac26b;--del:#3a1d1f;--delk:#f47067;--accent:#6ea0ff;--box:#1f2a3d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,"Segoe UI",system-ui,sans-serif}
main{padding:28px 32px 48px}h1{font-size:22px;margin:0 0 6px}.summary{color:var(--muted);margin:0 0 20px;max-width:70ch}
.idea{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:24px}
.flow{width:100%;max-width:900px;height:auto;display:block}.flow text{fill:var(--ink);font-size:13px}.flow .box{fill:var(--box);stroke:var(--accent);stroke-width:1.5}.flow .box.end{fill:var(--add);stroke:var(--addk)}
.flow .arrow,.flow .head{fill:none;stroke:var(--muted);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.file{margin-bottom:24px}.file h2{font:600 13px ui-monospace,Consolas,monospace;color:var(--muted);margin:0 0 8px}
.block{display:grid;grid-template-columns:minmax(0,3fr) minmax(220px,2fr);border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--panel);margin-bottom:12px}
.code{font:13px/1.5 ui-monospace,Consolas,monospace;overflow-x:auto;padding:8px 0;border-right:1px solid var(--line)}
.ln{display:grid;grid-template-columns:44px 16px 1fr;white-space:pre}.ln .no{color:var(--muted);text-align:right;padding-right:8px;user-select:none}.ln .sg{user-select:none}
.ln.add{background:var(--add)}.ln.add .sg{color:var(--addk)}.ln.del{background:var(--del)}.ln.del .sg{color:var(--delk)}
.note{padding:12px 16px;color:var(--ink)}
@media (max-width:760px){main{padding:18px 14px}.block{grid-template-columns:1fr}.code{border-right:0;border-bottom:1px solid var(--line)}}
</style></head><body><main>
<h1>${esc(plain(spec.title || 'What changed'))}</h1>
${spec.summary ? `<p class="summary">${esc(plain(spec.summary))}</p>` : ''}
${idea ? `<div class="idea">${idea}</div>` : ''}
${files}
</main></body></html>
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, ...rest] = process.argv.slice(2), at = rest.indexOf('--out');
  if (!input || at < 0 || !rest[at + 1]) { console.error('Usage: node render.mjs <spec.json> --out <page.html>'); process.exit(2); }
  const out = path.resolve(rest[at + 1]);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, render(JSON.parse(readFileSync(input, 'utf8').replace(/^﻿/, ''))));
  console.log(out);
}
