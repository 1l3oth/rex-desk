import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeRunner, trimTestCommand } from '../src/runners.js';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

test('L64: an agent starts with no background spend, sub-agents on Sonnet at medium, and long test output trimmed', async () => {
  let seen = null;
  const sdk = { query({ options }) { seen = options; return (async function* () { yield { type: 'result', subtype: 'success', result: 'ok', usage: {} }; })(); } };
  const controller = new AbortController();
  const runner = new ClaudeRunner({ sdk, run: { id: 'r1', permissionMode: 'bypassPermissions', effort: 'low' }, cwd: temporary('cost-cwd'), token: 't', mcpUrl: 'http://127.0.0.1:1/mcp',
    controller, signal: controller.signal, agentEnv: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }, event: () => {} });
  await runner.start('hi');
  assert.deepEqual(seen.settings, { promptSuggestionEnabled: false, idleCompaction: false, awaySummaryEnabled: false, crossSessionInbound: 'hold' });
  assert.equal(seen.env.CLAUDE_CODE_GOAL_CHECKIN_MINUTES, '0');
  assert.equal(seen.env.CLAUDE_CODE_SUBAGENT_EFFORT, 'medium');
  assert.equal(seen.env.CLAUDE_CODE_SUBAGENT_MODEL, 'haiku', 'the person\'s own choice wins');
  assert.equal(seen.effort, 'low');
  const hook = seen.hooks.PreToolUse[0].hooks[0];
  const out = await hook({ tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(out.hookSpecificOutput.updatedInput.command, 'set -o pipefail; npm test 2>&1 | tail -n 100');
  assert.deepEqual(await hook({ tool_name: 'Bash', tool_input: { command: 'git status' } }), {});
  assert.equal(trimTestCommand('Bash', { command: 'npm test | grep fail' }), null, 'a command that already pipes is left alone');
  assert.equal(trimTestCommand('PowerShell', { command: 'npm test' }), null);
});

test('L64: an agent\'s own effort is used when the chat has none, and is checked', async () => {
  const projects = temporary('cost-projects'), directory = path.join(projects, 'shop');
  mkdirSync(path.join(directory, '.git'), { recursive: true }); writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'shop' }));
  const options = [];
  const store = new Store(temporary('cost-store')), desk = new Desk(store, { root: temporary('cost-root'), memoryDirectory: temporary('cost-memory'), runnerFactory: given => { options.push(given); return { async start() {}, async interrupt() {} }; } });
  try {
    desk.memory.scan({ roots: [projects] });
    const agent = desk.specialists.create({ name: 'Shopkeeper', projectSlug: 'shop' });
    assert.throws(() => desk.specialists.update(agent.id, { effort: 'huge' }), /Choose low, medium/);
    assert.equal(desk.specialists.update(agent.id, { effort: 'Low' }).effort, 'low');
    await desk.specialistTurn(agent.id, { prompt: 'hi' });
    for (let i = 0; i < 100 && !options.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(options[0].run.effort, 'low');
  } finally { desk.closed = true; }
});
