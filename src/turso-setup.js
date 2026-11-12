import http from 'node:http';
import { randomBytes } from 'node:crypto';

// One-click cloud backup: the person signs in to Turso in the browser, and Rex Desk makes their own database and its key.
// The sign-in is the same browser page the Turso CLI uses: Turso sends a sign-in key back to a small local address.
// That key is used once to make the database and is then dropped; only the database's own key is kept (encrypted, by TursoSync).
const API = 'https://api.turso.tech';
const DONE_PAGE = '<!doctype html><meta charset="utf-8"><title>Rex Desk</title><body style="font:18px system-ui;padding:40px">Signed in to Turso. You can close this tab and go back to Rex Desk.</body>';

export function tursoSignIn({ timeoutMs = 270000, base = API } = {}) {
  const state = randomBytes(16).toString('hex');
  let finish, fail; const result = new Promise((resolve, reject) => { finish = resolve; fail = reject; }); result.catch(() => {});
  const server = http.createServer((request, response) => {
    const query = new URL(request.url, 'http://localhost').searchParams;
    // Turso's newer sign-in page can drop the state on its way back, so a missing one is accepted; a wrong one never is.
    // The address is a random port on this computer that lives only for this one sign-in.
    const back = query.get('state');
    if ((back && back !== state) || !query.get('jwt')) { response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><body style="font:18px system-ui;padding:40px">This Turso sign-in is not the one Rex Desk is waiting for. Start it again from Rex Desk.</body>'); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DONE_PAGE);
    finish(query.get('jwt'));
  });
  const timer = setTimeout(() => fail(new Error('The Turso sign-in took too long. Try again.')), timeoutMs);
  const close = () => { clearTimeout(timer); server.close(); };
  result.then(close, close);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const url = new URL(base); url.search = new URLSearchParams({ port: String(server.address().port), redirect: 'true', type: 'cli', state }).toString();
      resolve({ url: url.toString(), token: result, cancel: () => { fail(new Error('The Turso sign-in was cancelled.')); } });
    });
  });
}

async function call(fetcher, token, method, path, body) {
  const response = await fetcher(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, data };
}
const failed = (what, answer) => new Error(`Turso could not ${what}: ${answer.data?.error || `HTTP ${answer.status}`}`);

// Makes (or finds) the "rex-desk" database in the person's own Turso account and returns its address and a key for it.
// With create false (a new computer opening an existing backup) nothing is made: the database must already be there.
export async function provisionDatabase(platformToken, { fetcher = fetch, name = 'rex-desk', create = true } = {}) {
  const orgs = await call(fetcher, platformToken, 'GET', '/v1/organizations');
  if (!orgs.ok) throw failed('read your account', orgs);
  const list = Array.isArray(orgs.data) ? orgs.data : orgs.data.organizations || [];
  const org = list.find(item => item.type === 'personal') || list[0];
  if (!org?.slug) throw new Error('Turso did not return an account to put the database in.');
  const at = `/v1/organizations/${encodeURIComponent(org.slug)}`;
  // The backup can be in any organization the person belongs to, not only their personal one.
  if (!create) {
    for (const each of [org, ...list.filter(item => item !== org)].filter(item => item?.slug)) {
      const where = `/v1/organizations/${encodeURIComponent(each.slug)}`;
      const found = await call(fetcher, platformToken, 'GET', `${where}/databases/${name}`);
      if (found.ok) return keyFor(fetcher, platformToken, where, each.slug, name, found.data.database);
      if (found.status !== 404) throw failed('find your Rex Desk backup', found);
    }
    const names = list.map(item => item.slug).filter(Boolean).join(', ') || 'this account';
    throw new Error(`No Rex Desk backup in the Turso account you signed in with (${names}). Sign out of Turso in the browser and sign in with the Turso account your other computer uses, or turn on cloud backup there first.`);
  }
  // A database lives in a group. A new account may have none yet, so one is made near this computer.
  const groups = await call(fetcher, platformToken, 'GET', `${at}/groups`);
  if (!groups.ok) throw failed('read your groups', groups);
  let group = (groups.data.groups || [])[0]?.name;
  if (!group) {
    const near = await fetcher('https://region.turso.io').then(response => response.json()).catch(() => ({}));
    const made = await call(fetcher, platformToken, 'POST', `${at}/groups`, { name: 'default', location: near.server || near.client || 'aws-us-east-1' });
    if (!made.ok && made.status !== 409) throw failed('make a group for the database', made);
    group = 'default';
  }
  let database = await call(fetcher, platformToken, 'POST', `${at}/databases`, { name, group });
  if (database.status === 409) database = await call(fetcher, platformToken, 'GET', `${at}/databases/${name}`);
  if (!database.ok) throw failed('make the database', database);
  return keyFor(fetcher, platformToken, at, org.slug, name, database.data.database);
}
async function keyFor(fetcher, platformToken, at, organization, name, database) {
  const hostname = database?.Hostname || database?.hostname;
  if (!hostname) throw new Error('Turso did not say where the database is.');
  const key = await call(fetcher, platformToken, 'POST', `${at}/databases/${name}/auth/tokens?authorization=full-access`);
  if (!key.ok || !key.data.jwt) throw failed('make a key for the database', key);
  return { url: `libsql://${hostname}`, authToken: key.data.jwt, organization, database: name };
}
