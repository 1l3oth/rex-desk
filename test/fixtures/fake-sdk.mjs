// A stand-in for the Agent SDK in tests: says one thing, asks once when the prompt says so, waits for a release file, then finishes.
import { existsSync } from 'node:fs';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export function query({ prompt, options }) {
  let stop = false;
  const release = /release=(\S+)/.exec(prompt)?.[1];
  async function* run() {
    yield { type: 'system', subtype: 'init', session_id: '11111111-2222-3333-4444-555555555555' };
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'step one' }] } };
    if (/please-ask-first/.test(prompt)) { const answer = await options.canUseTool('Bash', { command: 'echo hi' }, {}); yield { type: 'assistant', message: { content: [{ type: 'text', text: `answer was ${answer.behavior}` }] } }; }
    while (release && !existsSync(release) && !stop) await wait(50);
    if (stop) throw new Error('Interrupted');
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'step two' }] } };
    yield { type: 'result', subtype: 'success', result: 'done', usage: {}, num_turns: 2 };
  }
  const iterator = run();
  iterator.interrupt = async () => { stop = true; };
  iterator.close = () => { stop = true; };
  return iterator;
}
