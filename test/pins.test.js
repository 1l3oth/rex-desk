import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, shared } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

test('a file, picture or link is pinned in a personal or group chat, shows once, newest first, and is unpinned', () => {
  const store = new Store(temporary('pins')), desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory') });
  const agent = desk.specialists.create({ name: 'Dara', purpose: 'Helps with tests.' }), room = desk.rooms.create('Team', [agent.id]);
  const chat = `agent:${agent.id}`;
  const picture = desk.pins.add({ chat, kind: 'media', url: '/api/uploads/file?path=D%3A%5Cshot.png', name: 'shot.png', from: 'You', at: '2026-11-20T01:00:00.000Z' });
  const file = desk.pins.add({ chat, kind: 'file', path: 'D:\\dev\\app\\README.md', from: 'Dara' });
  const link = desk.pins.add({ chat: `room:${room.id}`, kind: 'link', url: 'https://rexdesk.app/pricing', name: 'Pricing', from: 'You' });
  assert.equal(file.name, 'README.md', 'a file is named after its path');
  assert.equal(desk.pins.add({ chat, kind: 'media', url: picture.url }).id, picture.id, 'pinning the same thing again keeps one pin');
  assert.deepEqual(desk.pins.list(chat).map(pin => pin.id).sort(), [picture.id, file.id].sort());
  assert.deepEqual(desk.pins.list(`room:${room.id}`).map(pin => pin.name), ['Pricing']);
  assert.ok(desk.snapshot().pins.some(pin => pin.id === link.id), 'the app gets the pins with the rest');
  // Pins go to the account's other computers, like the chat itself.
  assert.equal(shared('pin', picture.id), true);
  assert.throws(() => desk.pins.add({ chat, kind: 'link', url: 'javascript:alert(1)' }), /cannot be pinned/);
  assert.throws(() => desk.pins.add({ chat, kind: 'link', url: '/artifacts/x/y.png' }), /http/);
  assert.throws(() => desk.pins.add({ chat: 'agent:nobody', kind: 'file', path: 'D:\\a.txt' }), /no longer here/);
  assert.throws(() => desk.pins.add({ chat: 'run:1', kind: 'file', path: 'D:\\a.txt' }), /from a chat/);
  assert.deepEqual(desk.pins.remove(picture.id), { removed: true, id: picture.id });
  assert.deepEqual(desk.pins.list(chat).map(pin => pin.id), [file.id]);
  assert.equal(desk.pins.remove(picture.id).removed, false);
  store.close();
});
