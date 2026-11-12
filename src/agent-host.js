// One agent reply, in a process of its own, so Rex Desk can restart (for an update) while the agent keeps working.
// Rex Desk starts it with a one-time spec file, which this process reads and deletes at once (it holds the run's key).
// Everything the agent does goes, in order and numbered, into a journal file that Rex Desk reads, so a restarted Rex Desk
// misses nothing. Rex Desk sends answers, new messages and Stop over a small local HTTP port guarded by a key.
// The process ends as soon as the reply is done; the journal keeps the end for Rex Desk to read.
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const specPath = process.argv[2];
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
try { unlinkSync(specPath); } catch { /* already gone */ }

let seq = 0;
const write = entry => appendFileSync(spec.journal, `${JSON.stringify({ seq: ++seq, at: Date.now(), ...entry })}\n`);
const asks = new Map(), inbox = [], controller = new AbortController();
const keyOk = value => { const a = Buffer.from(String(value || '')), b = Buffer.from(spec.key); return a.length === b.length && timingSafeEqual(a, b); };
const body = request => new Promise(resolve => { let text = ''; request.on('data', chunk => { text += chunk; }); request.on('end', () => { try { resolve(JSON.parse(text || '{}')); } catch { resolve({}); } }); });
let runner = null;

const server = http.createServer(async (request, response) => {
  const send = (code, data) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
  if (!keyOk(request.headers['x-host-key'])) return send(401, { error: 'Wrong key.' });
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/ping') return send(200, { pid: process.pid, seq });
  if (request.method !== 'POST') return send(404, { error: 'Not found.' });
  const input = await body(request);
  if (url.pathname === '/answer') { const waiter = asks.get(input.id); if (!waiter) return send(404, { error: 'No such question.' }); asks.delete(input.id); waiter(input.answer || { action: 'cancel' }); return send(200, { ok: true }); }
  if (url.pathname === '/inbox') { if (input.text) inbox.push(String(input.text)); return send(200, { ok: true }); }
  if (url.pathname === '/stop') { controller.abort(); void runner?.interrupt?.().catch(() => {}); return send(200, { ok: true }); }
  return send(404, { error: 'Not found.' });
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(spec.stateFile, JSON.stringify({ pid: process.pid, port: server.address().port }), { mode: 0o600 });
  const { ClaudeRunner } = await import('./runners.js');
  const { CodexRunner } = await import('./codex.js');
  const { AntigravityRunner } = await import('./antigravity.js');
  const Runner = spec.options.run.provider === 'codex' ? CodexRunner : spec.options.run.provider === 'gemini' ? AntigravityRunner : ClaudeRunner;
  // Tests hand in a stand-in for the Agent SDK as a module path.
  const sdk = spec.sdkModule ? await import(pathToFileURL(spec.sdkModule).href) : undefined;
  runner = new Runner({ ...spec.options, ...(sdk ? { sdk } : {}), controller, signal: controller.signal,
    event: (kind, data) => write({ type: 'event', kind, data }),
    ask: request => new Promise(resolve => { const id = randomUUID(); asks.set(id, resolve); write({ type: 'ask', id, request }); }),
    inbox: () => inbox.splice(0).join('\n\n') });
  try { await runner.start(spec.prompt); write({ type: 'done' }); }
  catch (error) { write({ type: 'error', message: String(error?.message || error), aborted: controller.signal.aborted }); }
}
main().catch(error => { try { write({ type: 'error', message: String(error?.message || error) }); } catch { /* journal folder gone */ } })
  .finally(() => { server.close(); setTimeout(() => process.exit(0), 200).unref(); });
