import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { nodeFetch } from '../src/mcp-signin.js';

// L30 review 4941d45c (1): a connection that drops after the headers but before the body ends must fail, not hang, so a
// sign-in or refresh that loses its server gives up instead of waiting forever.
test('review 4941d45c (1): nodeFetch rejects when the server cuts the body', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
    response.write('{"partial":'); // headers and a partial body, then the socket is destroyed
    response.socket.destroy();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await assert.rejects(() => nodeFetch(`http://auth.example.test:${port}/token`, { method: 'POST', body: 'x=1', pin: { address: '127.0.0.1', family: 4 } }), /connection|socket|aborted|closed/i);
  } finally { server.close(); }
});
