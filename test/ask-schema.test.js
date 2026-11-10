import test from 'node:test';
import assert from 'node:assert/strict';
import { askSchema } from '../src/mcp.js';
import { validateAnswer } from '../src/coordinator.js';

test('a question with its own fields can be submitted without an "answer" field', () => {
  const fields = { run: { type: 'string', title: 'How do you run it?' }, branch: { type: 'string', title: 'Which branch?' } };
  const schema = askSchema({ kind: 'question', fields });
  assert.deepEqual(schema.required, []);
  assert.doesNotThrow(() => validateAnswer({ request: { requestedSchema: schema } }, { action: 'accept', content: { run: 'docker compose up', branch: 'develop' } }));
});

test('the agent can still name which of its fields are required, and a plain question still needs an answer', () => {
  const fields = { run: { type: 'string' }, branch: { type: 'string' } };
  const schema = askSchema({ kind: 'question', fields, required: ['branch'] });
  assert.throws(() => validateAnswer({ request: { requestedSchema: schema } }, { action: 'accept', content: { run: 'x' } }), /branch is required/);
  assert.deepEqual(askSchema({ kind: 'question' }).required, ['answer']);
  assert.deepEqual(askSchema({ kind: 'approval' }).required, []);
});
