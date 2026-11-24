// Explain it simply: a spec (JSON) in, one self-contained picture page out. A few numbered steps, each with a simple
// drawing and one or two plain sentences. Inline CSS and SVG only: the page works offline, in light and dark.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const plain = value => String(value ?? '').replace(/\s*—\s*/g, ', ');

// An agent's own drawing keeps shapes and text only: no scripts, links, images, event handlers or anything fetched.
export function cleanSvg(markup) {
  let svg = String(markup || '').trim();
  if (!/^<svg[\s>]/i.test(svg)) return '';
  svg = svg.replace(/<(script|style|foreignObject|iframe)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<\/?(script|style|foreignObject|iframe|image|use)\b[^>]*>/gi, '')
    // A link keeps its drawing, without the link.
    .replace(/<\/?a\b[^>]*>/gi, '')
    .replace(/\s(on\w+|href|xlink:href|src|xmlns(:\w+)?)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/url\(\s*['"]?\s*(https?:|data:|\/\/)[^)]*\)/gi, 'none');
  return /https?:\/\//i.test(svg) ? '' : svg.replace(/^<svg/i, '<svg class="own"');
}

// 1 to 4 short labels in boxes, joined by arrows. mark colours the last box (good or bad).
export function boxesSvg(labels, mark = '') {
  const items = (Array.isArray(labels) ? labels : [labels]).map(item => plain(item).trim()).filter(Boolean).slice(0, 4);
  if (!items.length) return '';
  const box = 124, gap = 36, height = 84, width = items.length * box + (items.length - 1) * gap;
  const parts = items.map((label, index) => {
    const x = index * (box + gap), lines = [];
    for (const word of label.split(/\s+/)) { const last = lines.at(-1); if (last && `${last} ${word}`.length <= 16) lines[lines.length - 1] = `${last} ${word}`; else lines.push(word); }
    const shown = lines.slice(0, 3), top = height / 2 - (shown.length - 1) * 9;
    const kind = index === items.length - 1 && ['good', 'bad'].includes(mark) ? mark : '';
    const text = shown.map((line, row) => `<text x="${x + box / 2}" y="${top + row * 18 + 5}" text-anchor="middle">${esc(line)}</text>`).join('');
    const arrow = index < items.length - 1 ? `<path class="arrow" d="M${x + box + 8} ${height / 2} H${x + box + gap - 10} M${x + box + gap - 17} ${height / 2 - 7} L${x + box + gap - 9} ${height / 2} L${x + box + gap - 17} ${height / 2 + 7}" />` : '';
    return `<rect x="1" y="1" width="${box - 2}" height="${height - 2}" rx="14" transform="translate(${x} 0)" class="box ${kind}" />${text}${arrow}`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" style="max-width:${width}px" role="img" aria-label="${esc(items.join(', then '))}">${parts}</svg>`;
}

export function render(spec) {
  const steps = (spec.steps || []).slice(0, 8).map((step, index) => {
    const picture = step.svg ? cleanSvg(step.svg) : boxesSvg(step.picture, step.mark);
    return `<li class="step"><div class="num">${index + 1}</div><div class="pic">${picture}</div><p>${esc(plain(step.text))}</p></li>`;
  }).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(plain(spec.title || 'Explained simply'))}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--panel:#fff;--ink:#1d2127;--muted:#5d6672;--line:#dde1e6;--accent:#2563eb;--box:#eef3fd;--good:#e6f4ea;--goodk:#1a7f37;--bad:#fbe9ea;--badk:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#15171b;--panel:#1d2025;--ink:#e6e8eb;--muted:#9aa3ad;--line:#2e333a;--accent:#6ea0ff;--box:#1f2a3d;--good:#16301f;--goodk:#4ac26b;--bad:#3a1d1f;--badk:#f47067}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,"Segoe UI",system-ui,sans-serif}
main{padding:28px 32px 48px}h1{font-size:22px;margin:0 0 20px}
ol{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(440px,1fr));gap:16px}
.step{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px 14px}
.num{position:absolute;top:12px;left:14px;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font:600 13px system-ui,sans-serif;color:var(--accent);border:1.5px solid var(--accent)}
.pic{display:grid;place-items:center;min-height:110px;padding:10px 0 6px 28px}.pic svg{width:100%;max-height:120px;height:auto}
.pic text{fill:var(--ink);font-size:14px}.pic .box{fill:var(--box);stroke:var(--accent);stroke-width:1.5}.pic .box.good{fill:var(--good);stroke:var(--goodk)}.pic .box.bad{fill:var(--bad);stroke:var(--badk)}
.pic .arrow{fill:none;stroke:var(--muted);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.step p{margin:8px 0 0}
@media (max-width:760px){main{padding:18px 14px}ol{grid-template-columns:1fr}}
</style></head><body><main>
<h1>${esc(plain(spec.title || 'Explained simply'))}</h1>
<ol>${steps}</ol>
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
