// Pins: a file, a picture or video, or a link the person pinned in a chat, shown in that chat's Pinned tab.
// One record per chat and thing (kind "pin"), shared like the chat itself, so every computer of the account shows the same.
// A chat is "agent:<agent id>" (a personal chat: one chat on every computer) or "room:<room id>" (a group chat).
import { createHash } from 'node:crypto';

const KINDS = new Set(['media', 'file', 'link']);
const text = (value, size) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, size);
const now = () => new Date().toISOString();

export function pinId(chat, target) { return `pin:${createHash('sha256').update(`${chat}\n${target}`).digest('hex').slice(0, 32)}`; }

export class Pins {
  constructor(store) { this.store = store; }
  list(chat = '') { return this.store.list('pin').filter(pin => !chat || pin.chat === chat).sort((left, right) => String(right.pinnedAt).localeCompare(String(left.pinnedAt))); }
  // What can be pinned: an address the app opens (/api/uploads, /artifacts, an https link) or a file path on this computer.
  add(input = {}, { by = 'you' } = {}) {
    const chat = text(input.chat, 200), kind = text(input.kind, 10), url = text(input.url, 2000), path = text(input.path, 1000);
    const [type, id] = chat.split(':');
    if (!['agent', 'room'].includes(type) || !id) throw new Error('Pin from a chat.');
    if (type === 'agent' && !this.store.get('specialist', id)) throw new Error('That chat is no longer here.');
    if (type === 'room' && !this.store.get('room', id)) throw new Error('That group chat is no longer here.');
    if (!KINDS.has(kind)) throw new Error('Only a file, a picture or video, or a link can be pinned.');
    if (url && !/^(https?:\/\/|\/api\/uploads\/|\/artifacts\/)/i.test(url)) throw new Error('That address cannot be pinned.');
    if (kind === 'link' && !/^https?:\/\//i.test(url)) throw new Error('A link starts with http:// or https://.');
    if (!url && !path) throw new Error('Nothing to pin.');
    const target = url || path, key = pinId(chat, target), known = this.store.get('pin', key);
    if (known) return known;
    return this.store.put('pin', key, {
      id: key, chat, kind, url, path, video: Boolean(input.video) && kind === 'media',
      name: text(input.name, 200) || (kind === 'link' ? url.replace(/^https?:\/\//i, '').replace(/\/$/, '') : target.split(/[\\/]/).pop()) || target, from: text(input.from, 80), at: text(input.at, 40),
      ...(type === 'agent' ? { agentId: id } : { roomId: id }), by: text(by, 80), pinnedAt: now(),
    });
  }
  remove(id) {
    const pin = this.store.get('pin', String(id || ''));
    if (!pin) return { removed: false };
    this.store.delete('pin', pin.id); return { removed: true, id: pin.id };
  }
}
