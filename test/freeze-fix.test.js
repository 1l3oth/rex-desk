import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

function open() { const dir = mkdtempSync(path.join(tmpdir(), 'freeze-')); return { dir, store: new Store(dir) }; }

test('store.list is patched by put and delete instead of read again, and keeps the database order', () => {
  const { dir, store } = open();
  try {
    for (const id of ['b', 'd']) store.put('notice', id, { id, n: 1 });
    assert.deepEqual(store.list('notice').map(item => item.id), ['b', 'd']);
    const reads = [];
    const original = store.db.prepare.bind(store.db);
    store.db.prepare = sql => { if (/FROM records WHERE kind=\?$/.test(sql.trim())) reads.push(sql); return original(sql); };
    store.put('notice', 'c', { id: 'c', n: 2 });
    store.put('notice', 'b', { id: 'b', n: 3 });
    store.put('notice', 'a', { id: 'a', n: 4 });
    store.delete('notice', 'd');
    assert.deepEqual(store.list('notice').map(item => `${item.id}${item.n}`), ['a4', 'b3', 'c2']);
    assert.equal(reads.length, 0, 'no re-read of the kind');
    assert.deepEqual(store.list('notice'), store.db.prepare('SELECT value FROM records WHERE kind=? ORDER BY id').all('notice').map(row => JSON.parse(row.value)));
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a rolled back transaction does not leave a record in the list cache', () => {
  const { dir, store } = open();
  try {
    store.put('notice', 'a', { id: 'a' });
    store.list('notice');
    assert.throws(() => store.transaction(() => { store.put('notice', 'z', { id: 'z' }); throw new Error('no'); }));
    assert.deepEqual(store.list('notice').map(item => item.id), ['a']);
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the unsent-messages check uses the small index and still finds this computer\'s unsent visible messages', () => {
  const { dir, store } = open();
  try {
    store.event('run1', 'agent-text', { text: 'x'.repeat(20000) }, true);
    store.event('run1', 'agent-operation', { text: 'hidden' }, false);
    store.db.prepare("INSERT INTO events(run_id,kind,visible,value,created_at,uid) VALUES('run1','agent-text',1,'{}','2026-01-01','other.1')").run();
    const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM events INDEXED BY event_unsent WHERE run_id=? AND visible=1 AND pushed IS NULL AND uid LIKE ? || '.%' ORDER BY sequence LIMIT 2000").all('run1', store.nodeId).map(row => row.detail).join(' ');
    assert.match(plan, /event_unsent/);
    assert.deepEqual(store.unsentEvents('run1').map(row => row.kind), ['agent-text']);
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
