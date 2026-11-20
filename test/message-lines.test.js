import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, keepLines } from '../src/store.js';
import { Desk } from '../src/coordinator.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));

test('the person\'s message keeps its line breaks, so Markdown and the Attached files block survive (L50)', async () => {
  assert.equal(keepLines('what is this?\r\n\r\n- one\n  - nested   \n\n\n\n\nAttached files (read them from these paths):\n- F:/up/image.png'),
    'what is this?\n\n- one\n  - nested\n\n\nAttached files (read them from these paths):\n- F:/up/image.png');
  const store = new Store(temporary('lines')), prompts = [];
  const desk = new Desk(store, { root: temporary('root'), memoryDirectory: temporary('memory'), runnerFactory: options => ({ start: async prompt => { prompts.push(prompt); options.event('agent-text', { text: 'ok' }); }, interrupt() {}, close() {} }) });
  const run = await desk.startMain({ prompt: 'Hello' });
  for (let tries = 0; tries < 200 && desk.run(run.id).state !== 'finished'; tries++) await new Promise(resolve => setTimeout(resolve, 25));
  const text = 'what are these messages?\n\n**bold** and a list:\n- a\n- b\n\nAttached files (read them from these paths):\n- F:/daraboth/uploads/x/image.png';
  await desk.say(run.id, text);
  const shown = store.events(run.id, { limit: 50 }).filter(event => event.kind === 'human-message').at(-1);
  assert.equal(shown.text, text, 'shown in the chat exactly as written');
  for (let tries = 0; tries < 200 && prompts.length < 2; tries++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(prompts.at(-1).includes('Attached files (read them from these paths):\n- F:/daraboth/uploads/x/image.png'), 'the agent gets the list on its own lines');
  desk.closed = true;
});
