import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeRunner, cancelledByItself, cancelNote } from '../src/runners.js';

test('a step Claude Code cancelled by itself is recognised in either result shape', () => {
  const words = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";
  assert.ok(cancelledByItself(words));
  assert.ok(cancelledByItself([{ type: 'text', text: words }]));
  assert.ok(cancelledByItself(words.replace("'", '’')));
  assert.ok(!cancelledByItself('Permission denied by the hook.') && !cancelledByItself(''));
});

test('after a cancelled step the agent is told once to run it again, and past two cancels to stop what is still running', () => {
  const runner = new ClaudeRunner({});
  assert.equal(runner.takeCancelNote(), '', 'nothing to say before a cancel');
  runner.noteCancelled();
  const first = runner.takeCancelNote();
  assert.match(first, /cancelled by Claude Code itself/); assert.match(first, /Run the same step again/); assert.doesNotMatch(first, /TaskStop/);
  assert.equal(runner.takeCancelNote(), '', 'said once, not on every step');
  runner.noteCancelled();
  assert.match(runner.takeCancelNote(), /happened 2 times[\s\S]*TaskStop/);
  assert.match(cancelNote(3), /3 times/);
});
