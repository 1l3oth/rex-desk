import { t, locale } from './i18n.js';
// Pins: the person pins a file, a picture or video, or a link in a chat, and finds it again in the chat's Pinned tab
// (beside Media, Files and Links). Pins are kept per chat and shared with the account's other computers.
// A chat is "agent:<id>" (a personal chat) or "room:<id>" (a group chat); ui.pinChat names the one on screen.

const PIN_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 5 3 3v2H7v-2l3-3z"/><path d="M12 14v6"/></svg>';
const UNPIN_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 5 3 3v2H7v-2l3-3z"/><path d="M12 14v6M4 4l16 16"/></svg>';
const SHOW_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/><path d="M9 10.5h6"/></svg>';
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i, VIDEO = /\.(mp4|webm|mov)(\?|$)/i;
export const pinTarget = item => item.url || item.path || '';
export const chatPins = (ui, chat) => (ui.snap?.pins || []).filter(pin => pin.chat === chat).sort((left, right) => String(right.pinnedAt).localeCompare(String(left.pinnedAt)));
const pinOf = (ui, chat, target) => chatPins(ui, chat).find(pin => pinTarget(pin) === target);

// The Pin (or Unpin) button for one thing in the Media, Files or Links lists.
export function pinButton(ctx, chat, kind, item) {
  const { esc, ui } = ctx, target = pinTarget(item); if (!chat || !target) return '';
  const pin = pinOf(ui, chat, target);
  if (pin) return `<button type="button" class="cpin on" data-action="pin-remove" data-pin-id="${esc(pin.id)}" title="${t`Unpin`}" aria-label="${t`Unpin ${esc(item.name || item.host || target)}`}">${PIN_ICON}</button>`;
  return `<button type="button" class="cpin" data-action="pin-add" data-pin-chat="${esc(chat)}" data-pin-kind="${kind}" data-pin-url="${esc(item.url || '')}" data-pin-path="${esc(item.path || '')}" data-pin-name="${esc(item.name || item.host || '')}" data-pin-from="${esc(item.from || '')}" data-pin-at="${esc(item.at || '')}" data-pin-video="${item.video ? '1' : ''}" title="${t`Pin`}" aria-label="${t`Pin ${esc(item.name || item.host || target)}`}">${PIN_ICON}</button>`;
}

// The Pinned tab: newest first; a thumbnail or icon, the name, who sent it and when; open, show in chat, unpin.
export function pinnedHtml(ctx, chat) {
  const { esc, hhmm } = ctx, pins = chatPins(ctx.ui, chat);
  if (!pins.length) return `<p class="sh-empty">${t`Nothing pinned yet. Pin a file, picture or link from the chat.`}</p>`;
  const when = at => at ? `${new Date(at).toLocaleDateString(locale(), { month: 'short', day: 'numeric' })} ${hhmm(at)}` : '';
  const host = url => { try { return new URL(url).host; } catch { return url; } };
  return `<ul class="sh-list pin-list">${pins.map(pin => {
    const target = pinTarget(pin), picture = pin.kind === 'media' && !pin.video && pin.url;
    const thumb = picture ? `<img class="pin-thumb" src="${esc(pin.url)}" alt="" loading="lazy">`
      : pin.kind === 'media' ? '<span class="sh-icon pin-video" aria-hidden="true">▶</span>'
      : pin.kind === 'link' ? '<span class="sh-icon link" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8M9 7a3 3 0 0 0-4.2 0l-2 2A3 3 0 0 0 7 13.2l.8-.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>'
      : `<span class="sh-icon" aria-hidden="true">${esc((String(pin.name).split('.').pop() || 'file').slice(0, 4).toUpperCase())}</span>`;
    const title = pin.kind === 'link' ? (pin.name && pin.name !== pin.url ? pin.name : host(pin.url)) : pin.name;
    const open = pin.kind === 'link' ? `<a class="pin-open" href="${esc(pin.url)}" target="_blank" rel="noopener noreferrer" title="${esc(pin.url)}">` : `<a class="pin-open" href="${esc(pin.url || '#')}" data-file-open="${esc(pin.path || pin.url)}" title="${esc(target)}">`;
    return `<li class="pin-row">${open}${thumb}<span class="sh-text"><b>${esc(title)}</b><small>${esc([pin.from, when(pin.at || pin.pinnedAt)].filter(Boolean).join(' · '))}</small></span></a>
      <span class="pin-acts"><button type="button" class="cpin" data-action="pin-show" data-pin-id="${esc(pin.id)}" data-pin-target="${esc(target)}" title="${t`Show in chat`}" aria-label="${t`Show in chat`}">${SHOW_ICON}</button><button type="button" class="cpin on" data-action="pin-remove" data-pin-id="${esc(pin.id)}" title="${t`Unpin`}" aria-label="${t`Unpin ${esc(title)}`}">${UNPIN_ICON}</button></span></li>`;
  }).join('')}</ul>`;
}

// The thing under the pointer in a message: a picture or video, a file, or a link. Null for anything else.
function messageThing(element) {
  if (!element?.closest?.('.msg .md')) return null;
  const media = element.closest('.md-media, .md-media-link');
  if (media) { const node = media.matches('a') ? media.querySelector('img, video') || media : media, url = node.getAttribute('src') || media.getAttribute('href') || ''; return url ? { element: media, kind: 'media', url, name: nameOf(url), video: node.tagName === 'VIDEO' || VIDEO.test(url) } : null; }
  const file = element.closest('[data-file-open]');
  if (file) { const value = file.dataset.fileOpen, name = value.split(/[\\/]/).pop(), upload = /[\\/]uploads[\\/][0-9a-f-]{36}[\\/]/i.test(value), url = /^\/(api|artifacts)\//.test(value) ? value : upload ? `/api/uploads/file?path=${encodeURIComponent(value)}` : ''; return { element: file, kind: IMAGE.test(value) || VIDEO.test(value) ? 'media' : 'file', url, path: url && !upload ? '' : value, name, video: VIDEO.test(value) }; }
  const link = element.closest('a[href]'), href = link?.getAttribute('href') || '';
  if (link && /^https?:\/\//i.test(href)) return { element: link, kind: 'link', url: href, name: link.textContent.trim() !== href ? link.textContent.trim() : '' };
  if (link && /^\/(api\/uploads|artifacts)\//.test(href)) return { element: link, kind: IMAGE.test(href) || VIDEO.test(href) ? 'media' : 'file', url: href, name: link.textContent.trim(), video: VIDEO.test(href) };
  return null;
}
// A readable name for an address: the file of an uploaded picture (/api/uploads/file?path=...), else its last part.
const nameOf = url => { const path = /[?&]path=([^&]+)/.exec(url); return decodeURIComponent(path ? path[1] : url.split('?')[0]).split(/[\\/]/).pop(); };
const senderOf = element => {
  const message = element.closest('.msg');
  return { from: message?.querySelector('.who strong, .rname, .who b')?.textContent.trim() || '', at: message?.dataset.at || '' };
};

// A small Pin button floats over a picture, file or link in a message while the pointer is on it.
export function watchMessagePins(ctx) {
  const float = document.createElement('button');
  float.type = 'button'; float.className = 'pin-float'; float.hidden = true; document.body.append(float);
  let current = null, hide = 0;
  const place = thing => {
    const { ui, esc } = ctx, chat = ui.pinChat; if (!chat) return;
    current = { ...thing, ...senderOf(thing.element), chat };
    const pin = pinOf(ui, chat, current.url || current.path);
    float.innerHTML = `${pin ? UNPIN_ICON : PIN_ICON}<span>${pin ? t('Unpin') : t('Pin')}</span>`;
    float.dataset.pinId = pin?.id || '';
    float.setAttribute('aria-label', pin ? t`Unpin ${esc(current.name || current.url || current.path)}` : t`Pin ${esc(current.name || current.url || current.path)}`);
    const box = thing.element.getBoundingClientRect();
    float.style.top = `${Math.max(4, box.top - 30)}px`; float.style.left = `${Math.min(window.innerWidth - 90, Math.max(4, box.right - 70))}px`;
    float.hidden = false;
  };
  document.addEventListener('mouseover', event => {
    if (event.target === float || float.contains(event.target)) { clearTimeout(hide); return; }
    const thing = messageThing(event.target);
    if (thing) { clearTimeout(hide); place(thing); return; }
    clearTimeout(hide); hide = setTimeout(() => { float.hidden = true; current = null; }, 350);
  });
  // Keyboard: focusing a link or file in a message shows the button too.
  document.addEventListener('focusin', event => { const thing = messageThing(event.target); if (thing) place(thing); });
  document.addEventListener('scroll', () => { float.hidden = true; }, true);
  float.addEventListener('click', async () => {
    if (!current) return;
    const thing = current; float.hidden = true;
    if (float.dataset.pinId) await unpin(ctx, float.dataset.pinId);
    else await pin(ctx, { chat: thing.chat, kind: thing.kind, url: thing.url || '', path: thing.path || '', name: thing.name || '', from: thing.from, at: thing.at, video: thing.video });
  });
}

async function pin(ctx, data) {
  try { await ctx.api('/pins', { method: 'POST', data }); ctx.toast(t('Pinned. Find it in the Pinned tab.')); await ctx.refresh(); }
  catch (error) { ctx.toast(error.message, true); }
}
async function unpin(ctx, id) {
  try { await ctx.api(`/pins/${encodeURIComponent(id)}`, { method: 'DELETE' }); ctx.toast(t('Unpinned.')); await ctx.refresh(); }
  catch (error) { ctx.toast(error.message, true); }
}

// Loads older messages of the chat on screen. False when there is nothing more to load.
const STEPS = [2000, 5000, 10000, 20000, 20000];
async function loadOlder(ctx, step) {
  const { ui } = ctx, [type, id] = String(ui.pinChat || '').split(':');
  const earlier = document.querySelector('[data-action="show-earlier"]');
  if (earlier) { earlier.click(); await new Promise(resolve => setTimeout(resolve, 300)); return true; }
  if (type === 'room') {
    const before = (ui.roomHistory?.[id] || []).length, list = await ctx.api(`/rooms/${encodeURIComponent(id)}/messages?limit=${STEPS[step]}`).catch(() => null);
    if (!list || (step && list.length <= before)) return false;
    ui.roomHistory = { ...(ui.roomHistory || {}), [id]: list }; ctx.render(); return true;
  }
  const runId = ui.view?.type === 'main' ? ctx.mainRun()?.id : ui.view?.id; if (!runId) return false;
  const had = (ui.events.get(runId) || []).length;
  if ((ui.historyLimit?.[runId] || 500) >= STEPS[step] || had < (ui.historyLimit?.[runId] || 500)) return false;
  ui.historyLimit = { ...(ui.historyLimit || {}), [runId]: STEPS[step] };
  await ctx.refresh(); return (ui.events.get(runId) || []).length > had;
}

// The pin-* actions of the side panel.
export async function pinsAction(ctx, action, target) {
  if (action === 'pin-add') {
    const data = target.dataset;
    return pin(ctx, { chat: data.pinChat, kind: data.pinKind, url: data.pinUrl, path: data.pinPath, name: data.pinName, from: data.pinFrom, at: data.pinAt, video: data.pinVideo === '1' });
  }
  if (action === 'pin-remove') return unpin(ctx, target.dataset.pinId);
  if (action === 'pin-show') {
    // The message that holds it: the picture, file or link with the same address in the chat on screen.
    // A file attached with + shows as its plain path in the message, so the path is looked for in the text too.
    const pin = (ctx.ui.snap?.pins || []).find(item => item.id === target.dataset.pinId) || {};
    const wants = [target.dataset.pinTarget, pin.url, pin.path].filter(Boolean);
    const path = pin.path || (/[?&]path=([^&]+)/.exec(pin.url || '') ? decodeURIComponent(/[?&]path=([^&]+)/.exec(pin.url)[1]) : '');
    const find = () => {
      const found = [...document.querySelectorAll('.msg .md [href], .msg .md [src], .msg .md [data-file-open], .msg .md [data-file-path]')]
        .find(node => [node.getAttribute('href'), node.getAttribute('src'), node.dataset.fileOpen, node.dataset.filePath].some(value => value && (wants.includes(value) || (path && value === path))));
      return found?.closest('.msg') || (path ? [...document.querySelectorAll('.msg .md')].find(node => node.textContent.includes(path))?.closest('.msg') : null);
    };
    // Not among the newest messages: older ones are loaded, more each time, until the message turns up.
    let row = find();
    for (let step = 0; !row && step < 5; step += 1) {
      if (!(await loadOlder(ctx, step))) break;
      await new Promise(resolve => setTimeout(resolve, 150)); row = find();
    }
    if (!row) return ctx.toast(t('That message is no longer in this chat.'), true);
    row.scrollIntoView({ block: 'center', behavior: 'smooth' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1600);
  }
}
