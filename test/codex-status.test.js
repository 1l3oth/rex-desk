import test from 'node:test';
import assert from 'node:assert/strict';
import { codexStatus } from '../src/agents.js';

// Outputs of `codex login status` (codex-cli 0.169), from QA's sign-in check.
test('Codex counts as signed in with a ChatGPT account or an API key, and not when signed out', () => {
  assert.deepEqual(codexStatus({ stdout: 'Logged in using ChatGPT' }), { loggedIn: true, method: 'ChatGPT', account: '', plan: '' });
  const key = codexStatus({ stdout: 'API key configured - sk-test-***01234' });
  assert.equal(key.loggedIn, true); assert.equal(key.method, 'API key'); assert.ok(!JSON.stringify(key).includes('sk-'));
  assert.equal(codexStatus({ stdout: 'Logged in using an API key - sk-proj-***abc' }).loggedIn, true);
  assert.equal(codexStatus({ stdout: 'Not logged in' }).loggedIn, false);
  assert.equal(codexStatus({ code: 1, stdout: 'Logged in using ChatGPT' }).loggedIn, false);
});
