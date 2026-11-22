import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// L84: a project added in Settings > Projects (saved through PUT /api/config) must also land in memory, because the
// New agent picker lists only memory's projects. Before, it showed none and scanned the whole drive instead.
test('a project added in Settings shows in the New agent list at once, without a drive scan', async () => {
  const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-l84-'));
  process.env.REX_DESK_MEMORY = path.join(dir, 'memory');
  const repo = path.join(dir, 'code', 'shop-site'); mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'shop-site', description: 'A small shop website' }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  // A second Git folder next to it that nobody added: it must not be picked up.
  const other = path.join(dir, 'code', 'not-added'); mkdirSync(other, { recursive: true }); execFileSync('git', ['init', '-q'], { cwd: other });
  const plain = path.join(dir, 'notes'); mkdirSync(plain, { recursive: true });
  const { createApp } = await import('../src/server.js');
  const app = await createApp({ dataDirectory: path.join(dir, 'data'), port: 0, requireAccount: false, runnerFactory: () => ({ async start() {}, async interrupt() {}, close() {} }) });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const call = async (url, options = {}) => (await fetch(base + url, { ...options, headers: { 'content-type': 'application/json', 'x-rex-desk': '1' } })).json();
    const current = (await call('/api/state')).config;
    assert.equal((await call('/api/memory')).projects.length, 0, 'memory starts empty');
    await call('/api/config', { method: 'PUT', body: JSON.stringify({ ...current, repositories: [...current.repositories, { name: 'shop-site', path: repo, baseBranch: 'main', targetBranch: 'main' }, { name: 'notes', path: plain, plain: true }] }) });
    const projects = (await call('/api/memory')).projects;
    assert.deepEqual(projects.map(item => path.resolve(item.path).toLowerCase()).sort(), [plain, repo].map(item => path.resolve(item).toLowerCase()).sort(), 'both added folders, and nothing else');
    // Saving Settings again (any other change) does not scan again or change the list.
    const again = (await call('/api/state')).config;
    await call('/api/config', { method: 'PUT', body: JSON.stringify({ ...again, name: 'Rex' }) });
    assert.equal((await call('/api/memory')).projects.length, 2);
  } finally { await app.close?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ } }
});
