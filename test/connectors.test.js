import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { CONNECTORS, CONNECTOR_TYPES, catalog, connectionOf, sourceOf, connections, promptHints, connectorModule } from '../src/connectors.js';
import { createApp } from '../src/server.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

test('every connector has the same shape, a known type, and a logo file or a letter tile', async () => {
  const { existsSync } = await import('node:fs');
  const types = new Set(CONNECTOR_TYPES.map(item => item.id));
  for (const item of CONNECTORS) {
    for (const key of ['id', 'name', 'type', 'icon', 'auth', 'gives', 'fields']) assert.ok(item[key] !== undefined, `${item.id} has ${key}`);
    assert.ok(types.has(item.type), `${item.id} has a known type`);
    if (item.icon.startsWith('letter:')) assert.equal(item.icon.length, 8);
    else assert.ok(existsSync(new URL(`../public/connectors/${item.icon}`, import.meta.url)), `${item.icon} is bundled`);
  }
  assert.equal(new Set(CONNECTORS.map(item => item.id)).size, CONNECTORS.length);
  assert.ok(JSON.stringify(catalog()).indexOf('fetchTasks') < 0, 'the catalog has no code');
  // Orbit is the first connector on the shared interface.
  for (const call of ['test', 'fetchTasks', 'pushStatus', 'pushComment', 'promptHint']) assert.equal(typeof connectorModule('orbit')[call], 'function', `Orbit has ${call}`);
});

test('an old source row reads as a connection, the old report switch moves onto Orbit, and it writes back the same row', () => {
  const old = { id: 'o1', type: 'orbit', name: 'Launch', baseUrl: 'https://orbitkh.vercel.app', projectIds: [], statusFilter: 'active', hasKey: true };
  const connection = connectionOf(old, { reportToOrbit: true });
  assert.deepEqual(Object.keys(connection), ['id', 'connectorId', 'name', 'enabled', 'secretRef', 'options']);
  assert.equal(connection.connectorId, 'orbit'); assert.equal(connection.enabled, true); assert.equal(connection.secretRef, 'secret:o1'); assert.equal(connection.options.sendReport, true);
  assert.equal(connectionOf(old, { reportToOrbit: false }).options.sendReport, false);
  assert.deepEqual(sourceOf(connection), { baseUrl: old.baseUrl, projectIds: [], statusFilter: 'active', sendReport: true, id: 'o1', type: 'orbit', name: 'Launch' });
  assert.equal(connectionOf({ id: 'f1', type: 'flow', name: 'Flow' }).options.sendReport, undefined, 'only Orbit sends reports');
});

test('the store keeps report on the Orbit row, refuses connectors that bring no tasks, and the run prompt names no app that is not connected', () => {
  const store = new Store(temporary('connectors-store'));
  assert.deepEqual(promptHints(store.config()), [], 'nothing connected: nothing said');
  // A desk from before: the global switch was on.
  store.saveConfig({ ...store.publicConfig(), reportToOrbit: true, sources: [{ type: 'orbit', name: 'Launch', baseUrl: 'https://orbitkh.vercel.app', projectIds: [] }] });
  const [orbit] = store.config().sources;
  assert.equal(orbit.sendReport, true); assert.equal(store.config().reportToOrbit, true);
  assert.match(promptHints(store.config()).join(' '), /Orbit MCP/);
  store.saveConnection({ ...orbit, sendReport: false });
  assert.equal(store.config().reportToOrbit, false); assert.deepEqual(promptHints(store.config()), []);
  store.saveConnection({ ...store.config().sources[0], sendReport: true, enabled: false });
  assert.deepEqual(promptHints(store.config()), [], 'a switched-off connection says nothing');
  assert.throws(() => store.saveConnection({ type: 'slack', name: 'Slack', baseUrl: 'https://slack.com' }), /Unknown source type/);
  assert.equal(connections(store.config()).length, 1);
});

test('the Connectors API lists the picker and what is connected; the old Orbit routes still answer', async () => {
  const app = await createApp({ dataDirectory: temporary('connectors-api'), port: 0, runnerFactory: () => ({}) });
  const call = async (route, method = 'GET', data) => { const response = await fetch(app.address + route, { method, headers: { 'x-rex-desk': '1', 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) }); return { status: response.status, body: await response.json() }; };
  try {
    const empty = await call('/api/connectors');
    assert.equal(empty.status, 200); assert.deepEqual(empty.body.connections, []); assert.deepEqual(empty.body.accounts, []);
    assert.ok(empty.body.connectors.some(item => item.id === 'orbit'));
    assert.equal((await call('/api/orbit/account')).body.connected, false, 'the old account route forwards');
    assert.equal((await call('/api/sources/orbit', 'POST', { apiKey: 'nope' })).status, 400, 'the old key route forwards and checks the key');
    const source = app.store.saveConnection({ type: 'orbit', name: 'Launch', baseUrl: 'https://orbitkh.vercel.app', projectIds: [] });
    const listed = await call('/api/connectors');
    assert.equal(listed.body.connections[0].connectorId, 'orbit');
    const changed = await call(`/api/connectors/${source.id}`, 'PATCH', { options: { sendReport: true }, enabled: false });
    assert.equal(changed.body.connection.options.sendReport, true); assert.equal(changed.body.connection.enabled, false);
    assert.equal((await call('/api/connectors/missing', 'DELETE')).status, 404);
    assert.equal((await call(`/api/connectors/${source.id}`, 'DELETE')).body.removed, true);
    assert.deepEqual((await call('/api/connectors')).body.connections, []);
  } finally { await app.close(); }
});
