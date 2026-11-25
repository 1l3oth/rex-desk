import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

test('a server whose port is still held by the old one waits for it instead of stopping (EADDRINUSE)', async () => {
  const old = net.createServer();
  await new Promise(resolve => old.listen(0, '127.0.0.1', resolve));
  const port = old.address().port;
  setTimeout(() => old.close(), 1200);
  const app = await createApp({ dataDirectory: mkdtempSync(path.join(os.tmpdir(), 'rex-port-wait-')), port });
  try { assert.equal(app.address, `http://127.0.0.1:${port}`); } finally { await app.close(); }
});
