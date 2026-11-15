import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aboutRexDesk } from '../src/about.js';

// Settings > About counts what Rex Desk holds and the room it takes.
test('About adds up the data folder and counts agents, chats, rooms, tasks and files', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'about-'));
  mkdirSync(path.join(directory, 'artifacts')); writeFileSync(path.join(directory, 'a.bin'), Buffer.alloc(1000)); writeFileSync(path.join(directory, 'artifacts', 'b.bin'), Buffer.alloc(500));
  const items = { specialist: [{ kind: 'main' }, { id: 's1' }, { id: 's2' }], run: [{ id: 'r1', specialistId: 's1' }, { id: 'r2', specialistId: 's1' }, { id: 'r3', roomId: 'room1' }], task: [{}, {}], artifact: [{}] };
  const store = { directory, list: kind => items[kind] || [], config: () => ({}) };
  const about = await aboutRexDesk({ store, rooms: [{}], update: { current: '0.0.28', supported: true }, fresh: true });
  assert.equal(about.version, '0.0.28');
  assert.deepEqual(about.counts, { agents: 2, chats: 2, conversations: 3, rooms: 1, tasks: 2, files: 1 });
  assert.equal(about.storage.data, 1500);
  assert.equal(about.storage.dataFiles, 2);
});
