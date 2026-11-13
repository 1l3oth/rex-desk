import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeRunner } from '../src/runners.js';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const until = async (check, message) => {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(message);
};

// A stand-in for the Agent SDK: it answers every message it is given, and reports one written in the Claude app.
function fakeSdk(calls) {
  return {
    query({ prompt }) {
      let closed = false;
      const stream = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'session-1' };
        yield { type: 'user', message: { role: 'user', content: 'Hello from my phone' } };
        for await (const message of prompt) {
          if (closed) return;
          yield message; // Claude Code echoes what it was given
          yield { type: 'assistant', message: { content: [{ type: 'text', text: `Got: ${message.message.content}` }] } };
          yield { type: 'result', subtype: 'success', result: 'ok', usage: {} };
        }
      })();
      return Object.assign(stream, {
        async enableRemoteControl(enabled, name) { calls.push({ enabled, name }); return { session_url: 'https://claude.ai/code/session_abc', connect_url: 'https://claude.ai/code/connect' }; },
        async interrupt() { closed = true; }, close() { closed = true; },
      });
    },
  };
}

test('Continue in Claude app keeps the session open, connects Remote Control and passes messages both ways', async () => {
  const calls = [], events = [], inbox = ['Check the login page'], controller = new AbortController();
  const runner = new ClaudeRunner({ sdk: fakeSdk(calls), run: { id: 'r1', permissionMode: 'default' }, cwd: temporary('app-cwd'), token: 't', mcpUrl: 'http://127.0.0.1:1/mcp',
    remote: 'RexDesk_bot · rex-desk', controller, signal: controller.signal, agentEnv: {}, event: (kind, data) => events.push({ kind, ...data }), inbox: () => inbox.splice(0).join('\n\n') });
  const running = runner.start('');
  await until(() => events.some(event => event.kind === 'agent-text'), 'the message from Rex Desk was not answered');
  assert.deepEqual(calls, [{ enabled: true, name: 'RexDesk_bot · rex-desk' }]);
  assert.equal(events.find(event => event.kind === 'remote-control').url, 'https://claude.ai/code/session_abc');
  assert.deepEqual(events.filter(event => event.kind === 'app-message').map(event => event.text), ['Hello from my phone'], 'the echo of a Rex Desk message is not taken for one from the app');
  assert.equal(events.find(event => event.kind === 'agent-text').text, 'Got: Check the login page');
  controller.abort(); await runner.interrupt();
  assert.deepEqual(await running, { status: 'completed' });
});

test('a chat opens in the Claude app with no message of its own, shows its link, and comes back to Rex Desk on Close', async () => {
  const store = new Store(temporary('app-desk')), starts = [];
  let release;
  const desk = new Desk(store, { root: temporary('app-root'), runnerFactory: options => ({
    async start(prompt) { starts.push({ prompt, remote: options.remote }); options.event('remote-control', { url: 'https://claude.ai/code/session_xyz' }); await new Promise(resolve => { release = resolve; }); },
    async interrupt() { release?.(); }, close() {},
  }) });
  store.put('specialist', 'a1', { id: 'a1', name: 'RexDesk_bot', projectSlug: 'rex-desk' });
  store.put('run', 'r1', { id: 'r1', role: 'specialist', specialistId: 'a1', provider: 'claude', state: 'finished', sessionId: '', createdAt: new Date().toISOString() });
  await desk.continueInApp('r1');
  await until(() => store.get('run', 'r1').inApp?.url, 'the Claude app link was not saved');
  assert.deepEqual(starts, [{ prompt: '', remote: 'RexDesk_bot · rex-desk' }]);
  assert.equal(store.get('run', 'r1').inApp.url, 'https://claude.ai/code/session_xyz');
  await assert.rejects(desk.continueInApp('r1').then(() => { throw new Error('already open is fine'); }), /already open is fine/);
  await desk.continueInApp('r1', false);
  await until(() => !store.get('run', 'r1').inApp && !desk.live.has('r1'), 'the chat did not come back to Rex Desk');
  store.put('run', 'r2', { id: 'r2', role: 'specialist', specialistId: 'a1', provider: 'codex', state: 'finished', createdAt: new Date().toISOString() });
  await assert.rejects(desk.continueInApp('r2'), /works with Claude agents/);
  desk.close?.(); store.close();
});
