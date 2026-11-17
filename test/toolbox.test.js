import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Toolbox, rank } from '../src/toolbox.js';
import { Store } from '../src/store.js';
import { Desk } from '../src/coordinator.js';
import { createMcp } from '../src/mcp.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const sdk = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm');
// A real MCP server, started as its own process the way Claude Code would start one from ~/.claude.json.
function fakeServer(folder) {
  const file = path.join(folder, 'bakery-server.mjs');
  writeFileSync(file, `import { McpServer } from ${JSON.stringify(`file://${sdk.replaceAll('\\', '/')}/server/mcp.js`)};
import { StdioServerTransport } from ${JSON.stringify(`file://${sdk.replaceAll('\\', '/')}/server/stdio.js`)};
import { z } from ${JSON.stringify(`file://${path.resolve(sdk, '..', '..', '..', '..', 'zod', 'index.js').replaceAll('\\', '/')}`)};
const server = new McpServer({ name: 'bakery', version: '1.0.0' });
server.registerTool('list_bread', { description: 'List the bread baked today with prices', inputSchema: { day: z.string().optional() }, annotations: { readOnlyHint: true } }, async ({ day }) => ({ content: [{ type: 'text', text: 'sourdough 4500, baguette 3000' + (day ? ' on ' + day : '') }] }));
server.registerTool('order_cake', { description: 'Place an order for a birthday cake', inputSchema: { name: z.string(), size: z.number() } }, async ({ name, size }) => ({ content: [{ type: 'text', text: 'ordered a ' + size + ' inch cake for ' + name }] }));
await server.connect(new StdioServerTransport());
`);
  return file;
}
function setup() {
  const home = temporary('toolbox-home'), folder = temporary('toolbox-srv');
  mkdirSync(path.join(home, '.claude', 'skills', 'studybook'), { recursive: true });
  writeFileSync(path.join(home, '.claude', 'skills', 'studybook', 'SKILL.md'), '---\nname: studybook\ndescription: Build a Korean study unit with picture cards, audio and a vocabulary list.\n---\n\n# Studybook\nMake the unit in 해요체 with English and Khmer glosses.\n');
  mkdirSync(path.join(home, '.claude', 'skills', 'brag'), { recursive: true });
  writeFileSync(path.join(home, '.claude', 'skills', 'brag', 'SKILL.md'), '---\nname: brag\ndescription: Turn a project website into a launch video.\n---\nRecord the site.\n');
  const servers = { bakery: { command: process.execPath, args: [fakeServer(folder)], cwd: folder }, rex_desk: { type: 'http', url: 'http://x' } };
  return new Toolbox({ home, mcpConfig: () => servers, bundled: '' });
}

test('search ranks by the words asked, names first', () => {
  const items = [{ name: 'send_message', server: 'slack', description: 'Post a message in a channel' }, { name: 'list_bread', server: 'bakery', description: 'List bread and prices' }, { name: 'make_video', description: 'Render a launch video', kind: 'skill' }];
  assert.equal(rank(items, 'send a slack message')[0].name, 'send_message');
  assert.equal(rank(items, 'bread prices')[0].name, 'list_bread');
  assert.deepEqual(rank(items, 'zzzz quantum'), []);
});

test('an agent finds a tool or skill by plain words and uses it; nothing else is loaded', async () => {
  const box = setup();
  try {
    const found = await box.find('what bread is there today');
    assert.equal(found.found[0].use, 'bakery/list_bread'); assert.ok(found.found[0].input?.properties?.day, 'the input shape comes with a top match');
    assert.equal(found.found[0].readOnly, true);
    assert.match(found.searched, /2 tools on 1 servers and 2 skills/);
    assert.ok(!JSON.stringify(found).includes('rex_desk'), 'Rex Desk itself is not in the toolbox');
    assert.match((await box.run('bakery/list_bread', { day: 'Monday' })).result, /sourdough 4500, baguette 3000 on Monday/);
    assert.match((await box.run('bakery/order_cake', { name: 'Dara', size: 8 })).result, /8 inch cake for Dara/);
    const skill = await box.find('korean study cards', { kind: 'skill' });
    assert.deepEqual(skill.found.map(item => item.use), ['skill:studybook']);
    const used = await box.run('skill:studybook');
    assert.match(used.instructions, /해요체 with English and Khmer/); assert.doesNotMatch(used.instructions, /^---/, 'the front matter is left out');
    await assert.rejects(box.run('bakery/nope'), /has no tool "nope"/);
    await assert.rejects(box.run('nowhere/x'), /No MCP server "nowhere"/);
    await assert.rejects(box.run('skill:missing'), /No skill "missing"/);
    assert.equal(box.clients.size, 1, 'one connection, kept for the next call');
  } finally { await box.closeAll(); }
});

test('agents get desk_find and desk_run, and a tool that changes things waits for a yes in a mode that asks', async () => {
  const store = new Store(temporary('toolbox-desk')), box = setup();
  const desk = new Desk(store, { root: temporary('toolbox-root'), memoryDirectory: temporary('toolbox-memory'), toolbox: box, runnerFactory: () => ({ async start() {}, async interrupt() {} }) });
  try {
    store.put('run', 'r1', { id: 'r1', role: 'specialist', state: 'running', permissionMode: 'manual', createdAt: new Date().toISOString() });
    const server = createMcp(desk, { role: 'specialist', runId: 'r1' }), tools = server._registeredTools;
    assert.ok(tools.desk_find && tools.desk_run);
    const call = (name, input) => tools[name].handler(input, {});
    const found = JSON.parse((await call('desk_find', { query: 'birthday cake order', kind: 'any', limit: 8 })).content[0].text);
    assert.equal(found.found[0].use, 'bakery/order_cake');
    // A read-only tool runs at once; one that changes things asks first.
    assert.match(JSON.parse((await call('desk_run', { use: 'bakery/list_bread', input: {} })).content[0].text).result, /sourdough/);
    const asking = call('desk_run', { use: 'bakery/order_cake', input: { name: 'Rex', size: 6 } });
    let card; for (let attempt = 0; attempt < 100 && !card; attempt++) { await new Promise(resolve => setTimeout(resolve, 20)); card = store.list('interaction').find(item => item.state === 'pending'); }
    assert.match(card.title, /Approve bakery\/order_cake/);
    desk.answer(card.id, { action: 'decline' });
    assert.equal(JSON.parse((await asking).content[0].text).declined, true);
    assert.match(desk.prompt({ id: 'x', role: 'coordinator', main: true, taskIds: [] }), /desk_find searches them by plain words/);
  } finally { await box.closeAll(); await desk.shutdown?.(); store.close(); }
});

test('the person adds and removes MCP servers (through Claude Code), skills and commands', async () => {
  const home = temporary('toolbox-admin'), calls = [], source = temporary('toolbox-skill-src');
  writeFileSync(path.join(source, 'SKILL.md'), '---\nname: khmer-voice\ndescription: Read text aloud in Khmer.\n---\nUse KiriTTS.\n');
  mkdirSync(path.join(home, '.claude', 'commands'), { recursive: true }); writeFileSync(path.join(home, '.claude', 'commands', 'ship.md'), '---\ndescription: Push and deploy\n---\nDo it.');
  writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'npm run lint' }] }] } }));
  const box = new Toolbox({ home, mcpConfig: () => ({}), cli: async args => { calls.push(args); return ''; } });
  await box.addServer({ name: 'slack', command: 'npx -y @scope/slack --team "My Team"' });
  await box.addServer({ name: 'docs', url: 'https://mcp.example.com/mcp' });
  await box.removeServer('slack');
  assert.deepEqual(calls, [['mcp', 'add', '--scope', 'user', 'slack', '--', 'npx', '-y', '@scope/slack', '--team', 'My Team'], ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'docs', 'https://mcp.example.com/mcp'], ['mcp', 'remove', '--scope', 'user', 'slack']]);
  await assert.rejects(box.addServer({ name: 'bad name!', command: 'x' }), /letters, numbers/);
  await assert.rejects(box.addServer({ name: 'x', url: 'ftp://nope' }), /command that starts it/);
  assert.equal((await box.addSkill(source)).added, 'khmer-voice');
  await assert.rejects(box.addSkill(source), /already there/);
  const seen = await box.overview();
  assert.deepEqual(seen.skills.map(item => [item.name, item.removable]), [['khmer-voice', true]]);
  assert.deepEqual(seen.commands, [{ name: 'ship', description: 'Push and deploy' }]);
  assert.deepEqual(seen.hooks, [{ event: 'PostToolUse', matcher: 'Edit', command: 'npm run lint' }]);
  box.removeSkill('khmer-voice'); box.removeCommand('ship');
  const after = await box.overview();
  assert.equal(after.skills.length + after.commands.length, 0);
});
