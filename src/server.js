import { watchStalls, doing } from './stall-watch.js';
import { aiProvider } from './codex.js';
import { agyCommand } from './antigravity.js';
import http from 'node:http';
import { tailscaleAddresses } from './peers.js';
import QRCode from 'qrcode';
import { agentTools } from './agent-tools.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, openSync, createReadStream, createWriteStream, rmSync, statSync } from 'node:fs';
import { Store } from './store.js';
import { Accounts, cleanEmail } from './accounts.js';
import { findCloudWorkspace } from './turso.js';
import { Updates } from './updates.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Desk } from './coordinator.js';
import { aboutRexDesk } from './about.js';
import { handleMcp } from './mcp.js';
import { git, resolveCommand } from './processes.js';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectRepository, pickRepositoryFolder, cloneRepository, discoverRepositories } from './repositories.js';
import { githubAccounts, startGithubLogin, cancelGithubLogin, switchGithubAccount } from './github.js';
import { autostartStatus, setAutostart } from './autostart.js';
import { issueBranch } from './branches.js';
import { profileEnvironment, discoverProfiles } from './agents.js';
import { kindOf, mimeOf } from './files.js';
import { NEURAL_VOICES } from './voice-out.js';
import { Speaker } from './tts.js';
import { readyLines } from '../public/voice-phrases.js';
import { setupPrompt } from './setup-prompt.js';
import { handleA2aHttp, a2aSettings, setA2a } from './a2a.js';
import { handoffPrompt } from './handoff.js';
import { cachedTaskImage, cachedTaskMedia } from './images.js';
import { weeklyReport } from './report.js';
import { Computer } from './computer.js';
import { Voice } from './voice.js';
import { transcribeGemini, transcribeElevenLabs } from './cloud-voice.js';
import { orbitDeviceStart, orbitDevicePoll } from './orbit.js';
import { Anywhere } from './anywhere.js';
import { Commander } from './command.js';
import { Awake, keepInMemory } from './awake.js';
import { scanRoots } from './placement.js';
import { tursoSignIn, provisionDatabase } from './turso-setup.js';
import { followDataMove, followMemoryMove, planDataMove, moveMedia, folderStatus, memoryFolder } from './folders.js';
import { readdirSync } from 'node:fs';
import { knowledgeGraph } from './knowledge.js';
import { accountSignIn, accountDatabase, accountMe, accountReachable, billingCheckout, billingPortal, billingPack, billingDetails } from './rexdesk-account.js';
import { bridge } from './local-ai.js';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The commit this server runs. A pull or a commit from another session changes it; the server then restarts itself and the page reloads.
// The installed app is not a Git checkout: it never asks Git (a program run while the server loads) and never updates this way.
const startedCode = process.env.REX_DESK_VERSION ? '' : readCode();
function readCode() { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } }
function codeVersion() { return startedCode; }
const mime = { '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const json = (response, code, data) => { response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); };
// Recorded speech for transcription arrives as raw WAV bytes, not JSON.
async function rawBody(request, limit = 20 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error('Recording is too long.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function body(request, limit = 2 * 1024 * 1024) {
  let input = '';
  for await (const chunk of request) { input += chunk; if (Buffer.byteLength(input) > limit) throw new Error(`Request exceeds ${Math.round(limit / 1048576)} MB.`); }
  try { return input ? JSON.parse(input) : {}; } catch { throw new Error('Request body must be JSON.'); }
}
function serveFile(request, response, file, { sandbox = false, download = false, cache = 'no-store', frame = false, type: forced = '' } = {}) {
  const stat = statSync(file), type = forced || mime[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': cache, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
  // A page an agent made to explain its work may run its own inline script, but stays in a sandbox with no origin: it cannot reach Rex Desk or the network.
  if (sandbox === 'scripts') headers['Content-Security-Policy'] = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src data:;";
  else if (sandbox) headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self';";
  // The file window shows PDFs and media in a frame of this page; the dashboard's own pages may not be framed.
  else if (frame) headers['Content-Security-Policy'] = "frame-ancestors 'self'";
  if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(file).replaceAll('"', '')}"`;
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (range) {
    const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : stat.size - 1, stat.size - 1);
    if (start > end || start >= stat.size) { response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); response.end(); return; }
    response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(response); return;
  }
  response.writeHead(200, { ...headers, 'Content-Length': stat.size }); createReadStream(file).pipe(response);
}

// The installed app (it sets REX_DESK_VERSION) is the real Rex Desk on 4317. A server run from a source checkout is
// development and listens on 4318, so the real app never opens a development server by mistake. PORT overrides both.
// A server taking over from an earlier one (REX_RESTART_AFTER) without a port is a checkout that updated itself from a version
// that did not pass its port on: it was on 4317 and stays there, so a computer using a checkout as its real app keeps its address.
export const defaultPort = () => Number(process.env.PORT || (process.env.REX_DESK_VERSION || process.env.REX_RESTART_AFTER ? 4317 : 4318));

// How long one "is the browser sign-in done?" question may be held open. A Mac's webview (WebKit) gives up on a request that
// waits about 60 seconds ("Load failed"), which used to show an error and start the browser sign-in again, round and round.
// Asked short and repeated, the same wait works everywhere.
const WAITING = Symbol('waiting');
const SIGN_IN_POLL_MS = Number(process.env.REX_SIGNIN_POLL_MS) || 20000;
const settled = (promise, ms = SIGN_IN_POLL_MS) => Promise.race([promise, new Promise(resolve => { const timer = setTimeout(() => resolve(WAITING), ms); timer.unref?.(); })]);

export async function createApp({ dataDirectory, port = defaultPort(), runnerFactory, fetcher, agentCommand, imageFetcher = fetch, jevFetcher, namingFetcher, cloudClientFactory, accountFetcher, accountApi, requireAccount = !process.env.NODE_TEST_CONTEXT, ownDatabase = process.env.REX_DESK_OWN_DATABASE === '1', updateOptions, catchUp = false, computerFactory, voiceFactory, anywhereFactory, awakeFactory } = {}) {
  // Cloud backup comes with a Rex Desk account (a paid plan later): a database address and key typed by hand, or a Turso
  // account of the person's own, are turned off unless this copy is started with REX_DESK_OWN_DATABASE=1.
  const ACCOUNT_ONLY = 'Cloud backup comes with your Rex Desk account. Turn it on in Settings, Backup and updates.';
  const ownDatabaseOnly = () => { if (!ownDatabase) throw Object.assign(new Error(ACCOUNT_ONLY), { status: 403 }); };
  let dataRoot = dataDirectory || process.env.REX_DATA_DIR || path.join(root, '.local');
  // The real app follows a data folder the person moved, or finishes a move they asked for, before anything opens it.
  // The AI memory moves the same way. Tests pass their own folder and never move anything.
  if (!dataDirectory && existsSync(dataRoot)) {
    const lock = path.join(dataRoot, 'runtime.lock');
    const waitForOld = async () => { const owner = Number(existsSync(lock) ? readFileSync(lock, 'utf8') : 0); const alive = () => { try { process.kill(owner, 0); return true; } catch { return false; } }; for (let i = 0; owner > 0 && owner !== process.pid && i < 240 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 250)); };
    // A move copies the whole folder, which can take a minute. Meanwhile a small stand-in answers on the port with how far the
    // copy is, so the window shows progress instead of a black screen, and the desktop app does not take the busy server for
    // a stopped one and start a second server over it. It opens once the old server has let go of the port.
    let moveStage = 'Moving your Rex Desk data to its new folder', standIn = null;
    const holdPort = () => new Promise(resolve => {
      const item = http.createServer((request, response) => {
        if (new URL(request.url, 'http://local').pathname === '/api/boot') return json(response, 200, { stage: moveStage, ready: false });
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2"><title>Rex Desk</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#0a0e19;color:#cbd5e1;font:16px/1.5 system-ui,sans-serif"><p>${moveStage.replace(/[<>&]/g, '')}…<br><small style="color:#64748b">Rex Desk opens by itself when the move is done. Keep this window open.</small></p></body>`);
      });
      item.once('error', () => resolve(null)); item.listen(port, '127.0.0.1', () => resolve(item));
    });
    dataRoot = await followDataMove(dataRoot, { waitForOld: async () => { await waitForOld(); standIn = await holdPort(); }, log: message => console.log(message),
      progress: (done, total) => { moveStage = `Moving your Rex Desk data to its new folder: ${done} of ${total} files`; } });
    if (standIn) { standIn.closeAllConnections(); await new Promise(resolve => standIn.close(resolve)); }
  }
  if (!dataDirectory) await followMemoryMove({ log: message => console.log(message) });
  // A folder that exists already (even a drive root such as F:\, where mkdir fails with EPERM) is used as it is.
  if (!existsSync(dataRoot)) mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dataRoot, 'runtime.lock');
  if (existsSync(lockPath)) {
    const owner = Number(readFileSync(lockPath, 'utf8'));
    let alive = false;
    const isAlive = () => { try { process.kill(owner, 0); return true; } catch { return false; } };
    // A server restarting itself for new code starts this one first, then exits: wait for it to let go.
    if (Number.isInteger(owner) && owner > 0 && owner === Number(process.env.REX_RESTART_AFTER)) { for (let i = 0; i < 240 && isAlive(); i++) await new Promise(resolve => setTimeout(resolve, 250)); }
    if (Number.isInteger(owner) && owner > 0) alive = isAlive();
    if (alive) throw new Error('Rex Desk is already running with this data folder. Open its existing dashboard.');
    unlinkSync(lockPath);
  }
  writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
  // One workspace is open at a time. A plain data folder (tests, scripts) opens immediately; account mode waits for sign-in.
  const accounts = dataDirectory ? null : new Accounts(dataRoot);
  // A copy started with its own data folder (a test, a screenshot script) never updates itself. Agents run inside the
  // installed app and their shells carry its version and path, so every such copy took itself for the app and downloaded
  // the 31 MB installer into its temporary folder: hundreds of them filled drive C:.
  const updates = new Updates(dataRoot, updateOptions || (dataDirectory ? { version: '' } : undefined));
  // One computer and one voice engine for every account on it: the models are large, so they live beside the accounts.
  const computer = computerFactory ? computerFactory() : new Computer({ directory: path.join(dataRoot, 'screens') });
  // A plain data folder (tests, scripts) never holds the computer awake.
  const awake = awakeFactory ? awakeFactory() : new Awake(dataDirectory ? { platform: 'none' } : {});
  const voice = voiceFactory ? voiceFactory() : new Voice(process.env.REX_VOICE_DIR || path.join(dataRoot, 'voice'));
  const anywhere = anywhereFactory ? anywhereFactory() : new Anywhere({ root, dataRoot });
  const clients = new Set();
  const notify = () => { for (const client of clients) client.write('event: change\ndata: {}\n\n'); };
  // An update downloading tells the page how far it is, at most twice a second.
  let progressAt = 0;
  updates.onProgress = () => { if (Date.now() - progressAt > 500) { progressAt = Date.now(); notify(); } };
  // updateWhenIdle: the person chose "Update when it finishes"; the update installs once no agent is working.
  let updateWhenIdle = false;
  // What Rex Desk is doing while it opens, for the loading screen (GET /api/boot). Empty once the workspace is open.
  let bootStage = 'Starting Rex Desk';
  let restartWanted = false, session = null, address = '', tursoPending = null, tursoFound = null, accountPending = null, accountFound = null;
  // The Rex Desk account service (tests pass a pretend one).
  const accountOptions = { ...(accountFetcher ? { fetcher: accountFetcher } : {}), ...(accountApi ? { base: accountApi } : {}) };
  const cloud = cloudClientFactory || accountFetcher || accountApi ? { ...(cloudClientFactory ? { clientFactory: cloudClientFactory, retryMs: 50 } : {}), ...(accountFetcher ? { accountFetcher } : {}), ...(accountApi ? { accountApi } : {}) } : undefined;
  async function openSession(entry, vaultKey, { staySignedIn = false, remembered = false } = {}) {
    if (bootStage) bootStage = 'Opening your chats and agents';
    const store = accounts ? new Store(accounts.directory(entry), { key: vaultKey, auth: { name: entry.email, kdf: entry.kdf, sealedKey: entry.sealedKey }, cloud }) : new Store(dataRoot, { cloud });
    const desk = new Desk(store, { root, runnerFactory, fetcher, agentCommand, jevFetcher, namingFetcher, imageFetcher });
    if (address) startDesk(desk, store);
    desk.computer = computer;
    desk.commander = new Commander(computer, { apiKey: () => desk.jev.apiKey(), model: () => store.config().jev?.model, settings: () => store.config().control || {},
      env: () => desk.agents.environment(store.config().provider), cwd: path.join(store.directory, 'coordinator'), webTask: text => desk.startWebTask(text) });
    // The real app (not tests) scans this computer's checkouts for Jev and catches up with tracker moves made while it was off.
    if (catchUp) {
      // The freeze log: when the server is stuck, server-error.log says for how long and what it was doing.
      watchStalls({ logFile: path.join(dataRoot, 'server-error.log') });
      // Windows must not move the server's memory to the page file (a black window for minutes on a hard drive).
      keepInMemory();
      // Files from agents (screenshots, recordings, attachments) stay in the data folder unless the person moves them: they are
      // important, and Downloads is a folder people clear out.
      void desk.scanRepositories().catch(error => store.event('', 'repository-scan-error', { message: error.message }));
      if (store.config().sources.length) void desk.sources.sync().catch(error => store.event('', 'sync-error', { message: error.message }));
    }
    store.on('change', notify);
    // An agent's words as they are written, for read-aloud to speak live (see chat-speak.js speakLive).
    store.on('partial', data => { const line = `event: partial\ndata: ${JSON.stringify(data)}\n\n`; for (const client of clients) client.write(line); });
    session = { id: entry?.id, email: entry?.email || '', store, desk, cookie: randomBytes(32).toString('base64url'), staySignedIn, cloud: null };
    if (accounts) {
      accounts.touch(entry.id);
      // A start that just opened the remembered key does not save it again (another PowerShell start, seconds at each open).
      if (staySignedIn && !remembered) await accounts.remember(entry.id, vaultKey).catch(error => { session.staySignedIn = false; console.error(`Stay signed in failed: ${error.message}`); });
      // Bring this computer up to date with the cloud: upload leftovers, then merge in what changed elsewhere. It runs after the
      // workspace opens, from what is on this computer, so Rex Desk shows at once instead of after minutes of network work
      // (and the window's watchdog no longer restarts a server that is only syncing). A new computer restoring from the cloud
      // has nothing to show yet, so it waits for the restore.
      const opened = session, sync = async () => {
        const status = await store.cloud.open();
        if (status.state === 'connected' && !store.fresh) opened.cloud = await store.cloud.pullLatest({ live: new Set(desk.live?.keys?.() || []) }).catch(error => ({ pulled: false, reason: error.message }));
        else if (store.cloud.enabled) opened.cloud = { pulled: false, reason: status.error || 'Cloud backup is offline; working from this computer’s copy.' };
        // No cloud backup at all (or a development copy): nothing to sync, so the "syncing" note goes away.
        else opened.cloud = { pulled: false, reason: 'No cloud backup.' };
        if (session === opened) notify();
      };
      if (store.fresh) { if (bootStage) bootStage = 'Bringing your desk back from your cloud backup'; await sync(); }
      else { opened.cloud = { pulled: false, syncing: true }; void sync().catch(error => { opened.cloud = { pulled: false, reason: error.message }; }); }
    } else void store.cloud.open();
    notify(); return session;
  }
  // Once the server has its address: reconnect agents' terminals, resume interrupted runs, and get the agents ready.
  let listenPort = 0, remoteAt = '', remoteOpen = () => {}; const remoteServers = [];
  function startDesk(desk, store) {
    if (desk.started) return; desk.started = true;
    desk.port = listenPort; desk.peers.port = listenPort;
    // Agents on the internet use the person's Rex Desk account sign-in, and look in their inbox while any of them is reachable.
    desk.net.token = () => session?.account?.token || store.cloud?.account?.saved?.token || ''; if (accountOptions.base) desk.net.base = accountOptions.base; if (accountOptions.fetcher) desk.net.fetcher = accountOptions.fetcher;
    desk.net.start();
    // Agents from before avatars each get their own picture (this computer's agents only; the others get theirs at home).
    try { desk.specialists.ensureAvatars(store.nodeId); } catch (error) { store.event('', 'avatar-error', { message: error.message }); }
    desk.peers.onRemoteChange = () => { remoteAt = '-'; remoteOpen(); }; remoteOpen();
    if (!process.env.NODE_TEST_CONTEXT) desk.peers.start();
    desk.mcpUrl = `${address}/mcp`; desk.reattachHosts(); desk.projectRules.watch(); void desk.findPullRequests();
    void desk.resumeInterrupted(); desk.notifier.start(); void desk.fillEnglishNames(); desk.memory.ensure(); desk.rooms.cleanup(); desk.specialists.normalizeModels(); desk.specialists.ensureMain();
    if (!process.env.NODE_TEST_CONTEXT) void desk.refreshModels().catch(error => store.event('', 'models-error', { message: error.message }));
    // Antigravity's models fill its pickers when it is installed and signed in; otherwise this fails quietly.
    if (!process.env.NODE_TEST_CONTEXT && store.config().provider !== 'gemini') void desk.refreshModels({ provider: 'gemini' }).catch(() => {});
    // The models on this computer (Local AI), for the Claude Code model pickers.
    if (!process.env.NODE_TEST_CONTEXT) void desk.localAi.status().catch(() => {});
  }
  async function closeSession({ forget = false } = {}) {
    if (!session) return;
    const { desk, store, id } = session; session = null;
    if (forget) accounts?.forget(id);
    await desk.shutdown(); await store.cloud.close(); store.close(); notify();
  }
  const speakerOf = () => (session.speaker ||= new Speaker(session.store));
  const role = () => accounts ? accounts.role(session?.email) : 'superadmin';
  const cookieOf = request => /(?:^|;\s*)rex_session=([^;]+)/.exec(request.headers.cookie || '')?.[1];
  // Lasts 30 days, so the webview keeps it on disk: a cookie with no lifetime is dropped whenever macOS restarts WebKit's network
  // process (memory pressure, sleep), which signed the person out in the middle of work.
  const sessionCookie = value => `rex_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;
  const signedIn = request => Boolean(session) && (!accounts || cookieOf(request) === session.cookie);
  // "Stay signed in" opens Rex Desk without the passphrase only in a window that proves it is this person's: it holds the
  // window key, a random value kept in a file in their own data folder (other Windows users cannot read it). The desktop app
  // and the start script read the file and open /?window=<key>; a browser that signed in with the passphrase gets the key as a
  // cookie too. Any other program or user on this computer asking /api/auth gets the sign-in screen, not the session.
  let windowKeyValue = '';
  const windowKey = () => {
    if (windowKeyValue) return windowKeyValue;
    const file = path.join(dataRoot, 'window.key');
    try { windowKeyValue = readFileSync(file, 'utf8').trim(); } catch {}
    if (windowKeyValue.length < 32) { windowKeyValue = randomBytes(32).toString('base64url'); try { mkdirSync(dataRoot, { recursive: true }); writeFileSync(file, windowKeyValue, { mode: 0o600 }); } catch (error) { console.error(`Could not write the window key: ${error.message}`); } }
    return windowKeyValue;
  };
  const windowCookie = () => `rex_window=${windowKey()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
  const sameSecret = (left, right) => { const a = Buffer.from(String(left || '')), b = Buffer.from(String(right || '')); return a.length === b.length && a.length > 0 && timingSafeEqual(a, b); };
  const holdsWindowKey = request => sameSecret(/(?:^|;\s*)rex_window=([^;]+)/.exec(request.headers.cookie || '')?.[1], windowKey());
  // What this computer holds for the signed-in Rex Desk account: its workspace (here), one from before accounts to claim,
  // a backup in the account's cloud database, or nothing yet (new).
  async function workspaceFor(email, database) {
    if (!accounts || !email) return 'new';
    if (accounts.workspaces.some(item => item.email && item.email.toLowerCase() === email.toLowerCase())) return 'here';
    if (database) { try { await findCloudWorkspace({ url: database.url, authToken: database.authToken, name: email }, cloudClientFactory); return 'backup'; } catch {} }
    return accounts.workspaces.some(item => !item.email) ? 'claim' : 'new';
  }
  const accountView = () => ({ email: accountFound.session.user?.email || '', name: accountFound.session.user?.name || '', image: accountFound.session.user?.image || '', workspace: accountFound.workspace });
  // One account, many devices: a computer signed in to the account joins the account's shared database by itself, so every
  // device shows the same agents, chats and tasks, and they reach each other through it. It never mixes two different desks:
  // when the account's database already holds another desk, this computer keeps its own and says so in Devices.
  const joinAccount = () => {
    const opened = session, store = opened?.store, signedIn = opened?.account || store?.cloud?.account?.saved;
    if (!requireAccount || !store || store.cloud.enabled || !signedIn?.token) return;
    // Written only while the same desk is still open: a sign-out or a closed workspace ends it quietly.
    const note = value => { try { if (session === opened) store.put('meta', 'account-join', value); } catch { /* the desk closed meanwhile */ } };
    void (async () => {
      try {
        const database = await accountDatabase(signedIn.token, accountOptions);
        if (session !== opened) return;
        const found = await findCloudWorkspace({ url: database.url, authToken: database.authToken, name: signedIn.user?.email || opened.email || '' }, cloudClientFactory).catch(() => null);
        if (session !== opened) return;
        if (found && found.id !== store.cloud.workspace) { note({ state: 'other-desk', at: new Date().toISOString() }); return; }
        if (store.cloud.enabled) return;
        store.cloud.account.save({ token: signedIn.token, expiresAt: signedIn.expiresAt, user: signedIn.user }, database);
        await store.cloud.connect({ url: database.url, authToken: database.authToken });
        note({ state: 'joined', at: new Date().toISOString() });
      } catch (error) { note(error.code === 'needs_plan' ? { state: 'no-plan', at: new Date().toISOString() } : { state: 'failed', error: String(error.message || error).slice(0, 300), at: new Date().toISOString() }); }
    })();
  };
  // After the payment page opens: look at the plan every 5 seconds for up to 20 minutes. Paid: join the account's cloud space
  // (or, on a desk with its own database, just show the new plan) and tell the window.
  let billingWatch = null;
  const watchPlan = token => {
    clearInterval(billingWatch); const until = Date.now() + 20 * 60000;
    billingWatch = setInterval(() => {
      if (Date.now() > until || !session) { clearInterval(billingWatch); billingWatch = null; return; }
      void accountMe(token, accountOptions).then(me => {
        if (!me.space?.paid || !billingWatch) return;
        clearInterval(billingWatch); billingWatch = null;
        const store = session?.store; if (!store) return;
        store.event('', 'billing-paid', { plan: me.plan }); joinAccount();
        if (store.cloud.checkSpace) { store.cloud.spaceAt = 0; void store.cloud.checkSpace(); }
        notify();
      }, () => {});
    }, 5000);
    billingWatch.unref?.();
  };
  async function handleAuth(request, response, url, peerSignedIn = false) {
    if (url.pathname === '/api/auth' && request.method === 'GET') {
      // A session that chose to stay signed in on this computer hands its cookie to the person's own window (it holds the window
      // key) or to their phone or other computer signed in with the device key.
      if (session && accounts && session.staySignedIn && !signedIn(request) && (holdsWindowKey(request) || peerSignedIn)) {
        response.setHeader('Set-Cookie', sessionCookie(session.cookie));
        return json(response, 200, { mode: 'accounts', workspaces: accounts.summary(), current: { id: session.id, email: session.email, role: role(), staySignedIn: true, cloud: session.cloud } });
      }
      return json(response, 200, { mode: accounts ? 'accounts' : 'single', workspaces: accounts?.summary() || [], current: signedIn(request) ? { id: session.id, email: session.email, role: role(), staySignedIn: session.staySignedIn, cloud: session.cloud } : null, occupied: Boolean(session && !signedIn(request)) && session?.email,
        requireAccount: Boolean(accounts && requireAccount), account: accountFound ? accountView() : null });
    }
    if (!accounts) return json(response, 400, { error: 'This Rex Desk opens a single data folder without accounts.' });
    if (request.method !== 'POST') return json(response, 405, { error: 'Use POST.' });
    const input = await body(request);
    const describe = () => ({ id: session.id, email: session.email, role: role(), staySignedIn: session.staySignedIn, cloud: session.cloud });
    // Open (or re-enter) the account, then answer with a fresh cookie for this window.
    const activate = async ({ entry, vaultKey }) => {
      if (session?.id === entry.id) {
        session.cookie = randomBytes(32).toString('base64url');
        if (input.staySignedIn && !session.staySignedIn) session.staySignedIn = await accounts.remember(entry.id, vaultKey).then(() => true, error => { console.error(`Stay signed in failed: ${error.message}`); return false; });
      } else { await closeSession(); await openSession(entry, vaultKey, { staySignedIn: Boolean(input.staySignedIn) }); }
    };
    // Signing in with the passphrase also gives this browser the window key, so "stay signed in" works in it from then on.
    const respond = () => { response.setHeader('Set-Cookie', [sessionCookie(session.cookie), windowCookie()]); return json(response, 200, { current: describe() }); };
    const slow = async error => { await new Promise(resolve => setTimeout(resolve, 700)); throw error; };
    // The front door: the Rex Desk account signs in first, and its email names the workspace the passphrase opens.
    // Only when the account service cannot be reached does a workspace already on this computer open with its passphrase alone.
    const gated = requireAccount && ['/api/auth/create', '/api/auth/login', '/api/auth/cloud'].includes(url.pathname);
    if (gated && !accountFound) {
      if (!(url.pathname === '/api/auth/login' && input.offline && !await accountReachable(accountOptions))) throw new Error('Sign in with Rex Desk first.');
    } else if (gated) input.email = accountFound.session.user?.email || '';
    // The account sign-in is also kept on disk, locked with the workspace, so a restart (an update) does not lose it: Agents
    // online and the welcome answers use it. A sign-in that already carries a cloud backup database is left as it is.
    const linked = () => { if (requireAccount && accountFound) { session.account = accountFound.session; accountFound = null; const link = session.store?.cloud?.account; if (link && !link.signedIn && session.account?.token) { try { link.save(session.account, {}); } catch (error) { session.store.event('', 'account-save-error', { message: error.message }); } } } };
    if (url.pathname === '/api/auth/create') { await activate(accounts.create(input.email, input.passphrase)); linked(); joinAccount(); return respond(); }
    if (url.pathname === '/api/auth/login') { await activate(await accounts.signIn(input.email, input.passphrase, { claimId: input.claimId }).catch(slow)); linked(); joinAccount(); return respond(); }
    // A new computer, from the sign-in screen: Turso's browser sign-in finds the person's existing Rex Desk backup, so they never type its address or key.
    if (url.pathname === '/api/auth/turso-start' || url.pathname === '/api/auth/turso-finish') ownDatabaseOnly();
    if (url.pathname === '/api/auth/turso-start') { tursoPending?.cancel(); tursoFound = null; tursoPending = await tursoSignIn(); return json(response, 200, { url: tursoPending.url }); }
    if (url.pathname === '/api/auth/turso-finish') {
      if (!tursoPending) throw new Error('Start the Turso sign-in first.');
      const pending = tursoPending;
      try { tursoFound = await provisionDatabase(await pending.token, { create: false }); return json(response, 200, { found: true }); }
      finally { if (tursoPending === pending) tursoPending = null; }
    }
    // The same, with a Rex Desk account: the account service knows which database is this person's and hands over a key.
    if (url.pathname === '/api/auth/account-start') { accountPending?.cancel(); accountFound = null; accountPending = await accountSignIn({ ...accountOptions, provider: String(input.provider || '') }); return json(response, 200, { url: accountPending.url }); }
    if (url.pathname === '/api/auth/account-finish') {
      if (!accountPending) throw new Error('Start the Rex Desk sign-in first.');
      const pending = accountPending;
      let done = true;
      try {
        const signedIn = await settled(pending.session);
        // The browser sign-in is not finished: answer now; the window asks again.
        if (signedIn === WAITING) { done = false; return json(response, 200, { waiting: true }); }
        // Ask for the database only when the account already has one: signing in must not make a cloud database by itself.
        const me = requireAccount ? await accountMe(signedIn.token, accountOptions).catch(() => null) : null;
        const database = !requireAccount || me?.sync?.on ? await accountDatabase(signedIn.token, accountOptions) : null;
        accountFound = { session: signedIn, database, workspace: await workspaceFor(signedIn.user?.email || '', database) };
        return json(response, 200, requireAccount ? { found: Boolean(database), ...accountView() } : { found: true, email: signedIn.user?.email || '' });
      }
      finally { if (done && accountPending === pending) accountPending = null; }
    }
    if (url.pathname === '/api/auth/account-forget') { accountPending?.cancel(); accountPending = null; accountFound = null; return json(response, 200, { ok: true }); }
    if (url.pathname === '/api/auth/cloud' && input.account) { if (!accountFound?.database) throw new Error('Sign in with Rex Desk first.'); input.url = accountFound.database.url; input.authToken = accountFound.database.authToken; }
    if (url.pathname === '/api/auth/cloud' && !input.account) ownDatabaseOnly();
    if (url.pathname === '/api/auth/cloud' && input.turso) { if (!tursoFound) throw new Error('Sign in with Turso first.'); input.url = tursoFound.url; input.authToken = tursoFound.authToken; }
    if (url.pathname === '/api/auth/cloud') {
      // A new computer: find the account in the person's own Turso database, unseal its key, then restore everything before answering.
      const found = await findCloudWorkspace({ url: input.url, authToken: input.authToken, name: cleanEmail(input.email) }, cloudClientFactory);
      let opened;
      try { opened = accounts.workspaces.some(item => item.id === found.id) ? await accounts.signIn(found.name, input.passphrase) : accounts.create(found.name, input.passphrase, { id: found.id, sealed: found.sealed }); }
      catch (error) { return slow(error); }
      await activate(opened);
      // The account sign-in is kept before connecting, so the restore knows the files are in the account's private folder.
      if (input.account && !session.store.cloud.enabled) session.store.cloud.account.save(accountFound.session, accountFound.database);
      if (!session.store.cloud.enabled) { await session.store.cloud.connect({ url: input.url, authToken: input.authToken }); session.cloud = { pulled: !session.store.fresh, restored: true }; }
      if (input.turso) tursoFound = null;
      // Keep the account sign-in in the restored workspace, so this computer can renew the database key by itself.
      if (input.account) { session.store.cloud.account.save(accountFound.session, accountFound.database); accountFound = null; }
      linked();
      return respond();
    }
    if (url.pathname === '/api/auth/logout') {
      if (!signedIn(request)) return json(response, 401, { error: 'Not signed in.' });
      await closeSession({ forget: true }); accountFound = null;
      response.setHeader('Set-Cookie', 'rex_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(response, 200, { signedOut: true });
    }
    return json(response, 404, { error: 'Unknown sign-in action.' });
  }
  if (!accounts) await openSession(null, null);
  // A remembered sign-in opens while the server already listens: opening it can take a while (it pulls the newest cloud
  // backup first), and the desktop app and start script count a server that does not answer as one that failed to start.
  // Requests wait for it, so nobody sees the sign-in page or works on an out-of-date copy meanwhile.
  let opening = Promise.resolve();
  if (!accounts) await openSession(null, null);
  else { bootStage = 'Opening your desk'; opening = accounts.rememberedSession().then(remembered => remembered && openSession(remembered.entry, remembered.vaultKey, { staySignedIn: true, remembered: true })).catch(() => { session = null; }); }
  void opening.finally(() => { bootStage = ''; });
  // Agents working right now, by name: an update restarts Rex Desk and would cut them off.
  function busyAgents(store) {
    if (!store) return [];
    // A chat open in the Claude app is a session waiting for the person, not work in progress: it does not hold an update back.
    // Nor does an agent running from Rex Desk's private copy (host.outside): the update leaves it running and the new server attaches to it.
    const names = store.list('run').filter(run => ['running', 'waiting', 'starting', 'queued'].includes(run.state) && !run.inApp && !run.host?.outside)
      .map(run => { const id = run.roomAgent || run.specialistId; return (id && id !== 'main' ? store.get('specialist', id)?.name : '') || (run.main || run.role === 'coordinator' ? 'Rex Agent' : run.title) || 'An agent'; });
    return [...new Set(names)];
  }
  function installNow() {
    updateWhenIdle = false;
    updates.install(process.pid);
    // The helper waits for this process to exit before the installer replaces its files.
    setTimeout(() => void handle.close().finally(() => process.exit(0)), 300);
  }
  const handler = async (request, response) => {
    doing(`${request.method} ${String(request.url || '').split('?')[0].slice(0, 120)}`);
    // While Rex Desk opens, this computer's window gets its page and files at once, and the page asks /api/boot what is
    // happening and shows it. Everything else (data, agents, other devices) waits until the workspace is open.
    const early = (() => { try { const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.localAddress), page = new URL(request.url, 'http://local').pathname; return local && request.method === 'GET' && (page === '/api/boot' || (!page.startsWith('/api/') && page !== '/mcp' && !page.startsWith('/artifacts/'))); } catch { return false; } })();
    if (early && new URL(request.url, 'http://local').pathname === '/api/boot') return json(response, 200, { stage: bootStage, ready: !bootStage });
    if (!early) await opening;
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://lh3.googleusercontent.com https://avatars.githubusercontent.com; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'");
    try {
      const host = request.headers.host;
      const hostname = host ? new URL(`http://${host}`).hostname : '';
      const localHost = ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
      const publicMcp = process.env.REX_PUBLIC_MCP_HOST && hostname === process.env.REX_PUBLIC_MCP_HOST && request.url?.split('?')[0] === '/mcp';
      // A request that came in over Tailscale (the person's other computers and phone) needs the shared key, or a browser signed in with it.
      // Tailscale's https address (https://<computer>.<tailnet>.ts.net, made with "tailscale serve") reaches this server from this
      // computer itself, but it is the phone or another device asking: it needs the key the same way.
      const remoteSocket = !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.localAddress) || (/\.ts\.net$/i.test(hostname) && !publicMcp);
      if (!localHost && !publicMcp && !remoteSocket) return json(response, 403, { error: 'Use the local dashboard address.' });
      const url = new URL(request.url, `http://${host}`);
      // A2A: other agents reach this desk with the A2A key alone (it is off until the person turns it on), here or over Tailscale.
      if (session?.desk && await handleA2aHttp(session.desk, request, response, url, request => body(request, 1024 * 1024))) return;
      let peerSignedIn = false;
      if (remoteSocket) {
        const desk = session?.desk;
        if (!desk) return json(response, 503, { error: 'Rex Desk on this computer is locked. Sign in on it first.' });
        if (url.pathname === '/mcp') return json(response, 403, { error: 'Agents connect on this computer only.' });
        if (url.pathname === '/login.css') return serveFile(request, response, path.join(root, 'public', 'login.css'));
        // What installing Rex Desk on the phone needs: the app's name and icons, and the page shown when the computer can't be reached.
        if (['/manifest.webmanifest', '/icon-180.png', '/icon-192.png', '/icon-512.png', '/favicon.svg', '/sw.js', '/offline.html'].includes(url.pathname)) return serveFile(request, response, path.join(root, 'public', url.pathname.slice(1)));
        // The phone's QR code carries the key, so scanning it signs in at once.
        if (url.pathname === '/login' && request.method === 'GET' && url.searchParams.get('key')) {
          if (!desk.peers.checkKey(url.searchParams.get('key').trim())) { response.writeHead(303, { Location: '/login?wrong=1' }); return response.end(); }
          response.writeHead(303, { Location: '/', 'Set-Cookie': `rexdesk=${desk.peers.session()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` }); return response.end();
        }
        if (url.pathname === '/login' && request.method === 'GET') { const page = readFileSync(path.join(root, 'public', 'login.html'), 'utf8'); response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return response.end(url.searchParams.has('wrong') ? page.replace('class="wrong"', 'class="wrong show"') : page); }
        if (url.pathname === '/login' && request.method === 'POST') {
          let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 4096) break; }
          const key = new URLSearchParams(raw).get('key') || '';
          if (!desk.peers.checkKey(key.trim())) { response.writeHead(303, { Location: '/login?wrong=1' }); return response.end(); }
          response.writeHead(303, { Location: '/', 'Set-Cookie': `rexdesk=${desk.peers.session()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` }); return response.end();
        }
        if (!desk.peers.checkKey(request.headers['x-rex-peer-key']) && !desk.peers.checkSession(request.headers.cookie)) {
          if (request.method === 'GET' && !url.pathname.startsWith('/api/')) { response.writeHead(303, { Location: '/login' }); return response.end(); }
          return json(response, 401, { error: 'Sign in with the key from your Rex Desk first.' });
        }
        peerSignedIn = true;
      }
      // Local AI's bridge: an agent's Claude Code sends its model requests here, with its own Rex Desk token, and they go on to
      // the person's local server in the OpenAI format (see local-ai.js).
      if (url.pathname.startsWith('/local-ai/')) {
        if (remoteSocket) return json(response, 403, { error: 'Agents connect on this computer only.' });
        const token = request.headers['x-api-key'] || request.headers.authorization?.replace(/^Bearer /i, '');
        if (!session?.desk?.scope(token)) return json(response, 401, { type: 'error', error: { type: 'authentication_error', message: 'Supply the Rex Desk run token.' } });
        const [, , serverId, ...rest] = url.pathname.split('/');
        await bridge(session.desk.localAi, serverId, `/${rest.join('/')}`, request, response, request.method === 'POST' ? await body(request, 50 * 1024 * 1024) : undefined); return;
      }
      if (url.pathname === '/mcp') {
        const token = request.headers.authorization?.replace(/^Bearer /i, '');
        if (!session) return json(response, 401, { error: 'Rex Desk is locked. Sign in to the dashboard first.' });
        const desk = session.desk, scope = desk.scope(token);
        if (!scope) return json(response, 401, { error: 'Supply the Rex Desk bearer token.' });
        if (!['POST', 'GET', 'DELETE'].includes(request.method)) return json(response, 405, { error: 'Use Streamable HTTP.' });
        await handleMcp(desk, scope, request, response, request.method === 'POST' ? await body(request) : undefined); return;
      }
      const origin = request.headers.origin;
      if (origin && origin !== `http://${host}` && origin !== `https://${host}`) return json(response, 403, { error: 'Cross-origin dashboard requests are blocked.' });
      if (request.method !== 'GET' && request.headers['x-rex-desk'] !== '1') return json(response, 403, { error: 'Missing dashboard request header.' });
      // The desktop app and the start script open /?window=<key>: the key becomes this window's cookie and leaves the address.
      if (request.method === 'GET' && url.searchParams.has('window') && !url.pathname.startsWith('/api/')) {
        const given = url.searchParams.get('window'); url.searchParams.delete('window');
        response.writeHead(303, { Location: url.pathname + url.search, 'Cache-Control': 'no-store', ...(sameSecret(given, windowKey()) ? { 'Set-Cookie': windowCookie() } : {}) });
        return response.end();
      }
      if (url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')) return await handleAuth(request, response, url, peerSignedIn);
      // Everything else that touches a workspace needs this window's sign-in.
      if ((url.pathname.startsWith('/api/') || url.pathname.startsWith('/artifacts/')) && !signedIn(request) && !peerSignedIn) return json(response, 401, { error: 'Sign in to Rex Desk.', signIn: true });
      const store = session?.store, desk = session?.desk;
      // Every account backs up its own workspace to its own Turso database: the key is kept in that account's locked workspace,
      // so one account never sees or changes another account's backup.
      if (url.pathname === '/api/events' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        response.write('event: connected\ndata: {}\n\n'); clients.add(response);
        const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 25000);
        request.on('close', () => { clients.delete(response); clearInterval(heartbeat); }); return;
      }
      if (url.pathname.startsWith('/api/peer/')) {
        if (!desk.peers.checkKey(request.headers['x-rex-peer-key'])) return json(response, 401, { error: 'Wrong key.' });
        const node = String(request.headers['x-rex-peer-node'] || ''), peerUrl = String(request.headers['x-rex-peer-url'] || '');
        if (node && /^http:\/\/100\.\d+\.\d+\.\d+:\d+$/.test(peerUrl)) desk.peers.remember({ id: node, name: decodeURIComponent(String(request.headers['x-rex-peer-name'] || '')).slice(0, 40), url: peerUrl });
        if (url.pathname === '/api/peer/hello') return json(response, 200, desk.peers.self);
        if (url.pathname === '/api/peer/pull') return json(response, 200, desk.peers.serve({ since: Number(url.searchParams.get('since')) || 0, filesSince: Number(url.searchParams.get('files')) || 0 }));
        return json(response, 404, { error: 'API route not found.' });
      }
      if (url.pathname === '/api/devices/qr' && request.method === 'GET') {
        const address = desk.peers.status(desk.port).self?.addresses?.[0]; if (!address) return json(response, 404, { error: 'Turn on connecting from other devices first.' });
        const svg = await QRCode.toString(`${address.replace(/\/$/, '')}/login?key=${encodeURIComponent(desk.peers.key())}`, { type: 'svg', margin: 2, color: { dark: '#111418', light: '#ffffff' } });
        response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }); return response.end(svg);
      }
      if (url.pathname === '/api/peers' && request.method === 'GET') return json(response, 200, desk.peers.status(desk.port));
      if (url.pathname === '/api/peers' && request.method === 'POST') {
        const input = await body(request);
        if (input.action === 'rename') return json(response, 200, desk.peers.rename(input.name));
        if (input.action === 'remote') return json(response, 200, desk.peers.setRemote(input.on));
        if (input.action === 'join') return json(response, 200, desk.peers.join(input.key));
        if (input.action === 'add') return json(response, 200, await desk.peers.add(input.url));
        if (input.action === 'remove') return json(response, 200, desk.peers.remove(input.id));
        throw new Error('Unknown action.');
      }
      // Settings › About: version, counts and storage.
      if (url.pathname === '/api/about' && request.method === 'GET') return json(response, 200, await aboutRexDesk({ store, rooms: desk.rooms.list(), update: updates.status(), install: process.env.REX_DESK_EXE ? path.dirname(process.env.REX_DESK_EXE) : root, fresh: url.searchParams.has('fresh') }));
      if (url.pathname === '/api/state') { const snapshot = desk.snapshot(); return json(response, 200, { ...snapshot, update: { ...updates.status(), whenIdle: updateWhenIdle, busy: busyAgents(store) }, cloudSync: session.cloud || null, account: { email: session.email, role: role() }, code: codeVersion() }); }
      // One-click cloud backup: start opens Turso's sign-in page in the browser; finish waits for it, makes the database and connects it.
      if (['/api/database/turso-start', '/api/database/turso-finish', '/api/database/connect'].includes(url.pathname)) ownDatabaseOnly();
      if (url.pathname === '/api/database/turso-start' && request.method === 'POST') { tursoPending?.cancel(); tursoPending = await tursoSignIn(); return json(response, 200, { url: tursoPending.url }); }
      if (url.pathname === '/api/database/turso-finish' && request.method === 'POST') {
        if (!tursoPending) throw new Error('Start the Turso sign-in first.');
        const pending = tursoPending;
        try { const made = await provisionDatabase(await pending.token); return json(response, 200, { ...await store.cloud.connect({ url: made.url, authToken: made.authToken }), database: made.database }); }
        finally { if (tursoPending === pending) tursoPending = null; }
      }
      // The same with a Rex Desk account: one browser sign-in, and the account service makes the person's private database and its key.
      // Signed in at the front door already: that sign-in turns backup on, with no second trip to the browser.
      if (url.pathname === '/api/database/account-start' && request.method === 'POST') {
        accountPending?.cancel(); accountPending = null;
        if (session.account) return json(response, 200, { url: '' });
        accountPending = await accountSignIn(accountOptions); return json(response, 200, { url: accountPending.url });
      }
      if (url.pathname === '/api/database/account-finish' && request.method === 'POST') {
        if (!accountPending && !session.account) throw new Error('Start the Rex Desk sign-in first.');
        const started = accountPending, pending = started ? started.session : Promise.resolve(session.account);
        let done = true;
        try {
          const waited = await settled(pending);
          if (waited === WAITING) { done = false; return json(response, 200, { waiting: true }); }
          const signedIn = waited, made = await accountDatabase(signedIn.token, accountOptions);
          const status = await store.cloud.connect({ url: made.url, authToken: made.authToken });
          store.cloud.account.save(signedIn, made); session.account = null;
          return json(response, 200, { ...status, ...store.cloud.status(), created: Boolean(made.created) });
        } catch (error) { if (error.status === 401) session.account = null; throw error; }
        finally { if (done && started && accountPending === started) accountPending = null; }
      }
      // Agents online: sign in to the Rex Desk account for it alone (no cloud backup is made). The browser opens, and the sign-in
      // is kept locked on this computer.
      if (url.pathname === '/api/net/sign-in' && request.method === 'POST') {
        accountPending?.cancel(); accountPending = await accountSignIn(accountOptions);
        const started = accountPending;
        void started.session.then(signedIn => { if (!store.cloud.account.signedIn) store.cloud.account.save(signedIn, {}); else session.account = signedIn; store.event('', 'net-thread', { signedIn: true }); })
          .catch(() => {}).finally(() => { if (accountPending === started) accountPending = null; });
        return json(response, 200, { url: started.url });
      }
      // Cloud backup bought from inside the app, with the account this computer is signed in to. After the payment page opens, the
      // plan is checked every few seconds; once Stripe confirms it, this computer joins the account's cloud space by itself.
      if (url.pathname.startsWith('/api/billing') && (request.method === 'POST' || request.method === 'GET')) {
        const token = session.account?.token || store.cloud.account?.saved?.token;
        const who = session.account?.user || store.cloud.account?.saved?.user || null;
        if (url.pathname === '/api/billing' && request.method === 'GET') {
          if (!token) return json(response, 200, { signedIn: false });
          const me = await accountMe(token, accountOptions).catch(error => ({ error: error.message }));
          const details = me.space?.paid ? await billingDetails(token, accountOptions).catch(() => null) : null;
          return json(response, 200, { signedIn: true, email: who?.email || me.user?.email || '', plan: me.plan || '', space: me.space || null, card: details?.card || null, invoices: details?.invoices || [], error: me.error || '', watching: Boolean(billingWatch) });
        }
        if (!token) throw new Error('Sign in with your Rex Desk account first (Settings, Backup and updates).');
        const input = await body(request);
        if (url.pathname === '/api/billing/checkout') { const result = await billingCheckout(token, input.offer === 'year' ? 'year' : 'month', accountOptions); watchPlan(token); return json(response, 200, result); }
        if (url.pathname === '/api/billing/portal') return json(response, 200, await billingPortal(token, accountOptions));
        if (url.pathname === '/api/billing/pack') { const result = await billingPack(token, accountOptions); if (store.cloud.checkSpace) { store.cloud.spaceAt = 0; void store.cloud.checkSpace(); } return json(response, 200, result); }
      }
      // Signing the account out stops key renewal. The backup keeps working until its current key runs out (about a month).
      if (url.pathname === '/api/database/account-signout' && request.method === 'POST') { await store.cloud.account.signOut(); notify(); return json(response, 200, store.cloud.status()); }
      if (url.pathname === '/api/database/disconnect' && request.method === 'POST') { const status = await store.cloud.disconnect(); notify(); return json(response, 200, status); }
      if (url.pathname === '/api/database/connect' && request.method === 'POST') return json(response, 200, await store.cloud.connect(await body(request)));
      // What goes to the cloud backup; each switch saves at once.
      if (url.pathname === '/api/database/parts' && request.method === 'PUT') { const parts = store.cloud.setParts(await body(request)); notify(); return json(response, 200, { parts, status: store.cloud.status() }); }
      // A large backup on a busy cloud can take minutes: after a minute the answer is "still going", and the work carries on by itself.
      if (url.pathname === '/api/database/sync' && request.method === 'POST') { const check = store.cloud.retry().then(() => store.cloud.verify()); check.catch(() => {}); const done = await Promise.race([check, new Promise(resolve => { const timer = setTimeout(() => resolve(null), 60000); timer.unref?.(); })]); return json(response, 200, done ? { ...done, status: store.cloud.status() } : { stillGoing: true, status: store.cloud.status() }); }
      if (url.pathname === '/api/repositories/inspect' && request.method === 'POST') return json(response, 200, await inspectRepository((await body(request)).path));
      if (url.pathname === '/api/repositories/pick' && request.method === 'POST') return json(response, 200, await pickRepositoryFolder());
      // Checkouts beside the ones already configured, and beside Rex Desk itself, so other projects are one click away.
      if (url.pathname === '/api/repositories/discover' && request.method === 'GET') {
        const configured = store.config().repositories.map(item => item.path).filter(Boolean);
        return json(response, 200, { repositories: discoverRepositories([...configured.map(item => path.dirname(item)), path.dirname(root)], configured) });
      }
      if (url.pathname === '/api/report' && request.method === 'GET') return json(response, 200, await weeklyReport(store, { from: url.searchParams.get('from'), to: url.searchParams.get('to'), detail: taskId => desk.sources.taskDetail(taskId, { refresh: true }) }));
      // Speech to text, for the chat and the Jev bar. It works whether or not computer control is on.
      // The engine is the on-computer model, or (when the person chose one) Gemini through their OpenRouter key, or ElevenLabs Scribe.
      if (url.pathname.startsWith('/api/voice/')) {
        const control = store.config().control || {}, language = url.searchParams.get('language') || control.language || 'en';
        const elevenKey = () => { const saved = store.get('secret', 'elevenlabs'); return saved ? store.decrypt(saved) : ''; };
        const engines = () => ({ local: voice.status().installed, gemini: Boolean(desk.jev.apiKey()), elevenlabs: Boolean(elevenKey()) });
        const chosen = () => store.get('voice', 'engine')?.engine || 'local';
        const run = (engine, audio) => engine === 'gemini' ? transcribeGemini(audio, language, desk.jev.apiKey()) : engine === 'elevenlabs' ? transcribeElevenLabs(audio, language, elevenKey()) : voice.transcribe(audio, language);
        if (url.pathname === '/api/voice/engines' && request.method === 'GET') return json(response, 200, { engine: chosen(), available: engines(), local: voice.status() });
        if (url.pathname === '/api/voice/engine' && request.method === 'POST') {
          const engine = String((await body(request)).engine || '');
          if (!['local', 'gemini', 'elevenlabs'].includes(engine)) return json(response, 400, { error: 'Choose local, gemini or elevenlabs.' });
          if (!engines()[engine]) return json(response, 400, { error: engine === 'local' ? 'Install the voice model first.' : engine === 'gemini' ? 'Add your OpenRouter key first (Settings → Jev and voice).' : 'Add your ElevenLabs key first.' });
          store.put('voice', 'engine', { id: 'engine', engine }); return json(response, 200, { engine });
        }
        if (url.pathname === '/api/voice/key' && request.method === 'POST') {
          const key = String((await body(request)).key || '').trim();
          if (!key) { store.delete('secret', 'elevenlabs'); if (chosen() === 'elevenlabs') store.put('voice', 'engine', { id: 'engine', engine: 'local' }); return json(response, 200, { saved: false }); }
          if (key.length < 20) return json(response, 400, { error: 'That does not look like an ElevenLabs API key.' });
          store.put('secret', 'elevenlabs', store.encrypt(key)); return json(response, 200, { saved: true });
        }
        if (url.pathname === '/api/voice/install' && request.method === 'POST') { void voice.install().then(notify, notify); return json(response, 202, voice.status()); }
        if (url.pathname === '/api/voice/prepare' && request.method === 'POST') return json(response, 200, { ready: chosen() === 'local' ? await voice.prepare(language) : true });
        if (url.pathname === '/api/voice/transcribe' && request.method === 'POST') {
          const audio = await rawBody(request), wanted = url.searchParams.get('engine') || chosen(), ready = engines();
          // The chosen engine is not ready (like "On this computer" before its model is installed): use one that is, and say so.
          const engine = ready[wanted] ? wanted : ['gemini', 'elevenlabs', 'local'].find(name => ready[name]) || wanted;
          const switched = engine !== wanted ? `${wanted === 'local' ? 'The on-computer voice model is not installed' : 'The chosen voice engine is not set up'}, so ${engine === 'gemini' ? 'Gemini' : engine === 'elevenlabs' ? 'ElevenLabs' : 'the on-computer model'} was used.` : '';
          if (!ready[engine]) return json(response, 400, { error: 'No voice engine is ready. Install the on-computer model, or add an OpenRouter key, in Settings → Jev and voice.' });
          if (switched && engine !== 'local') { const started = Date.now(); return json(response, 200, { ...await run(engine, audio), ms: Date.now() - started, fallback: switched }); }
          // An online engine that fails falls back to the on-computer model, and the answer says so.
          if (engine !== 'local') try { const started = Date.now(); return json(response, 200, { ...await run(engine, audio), ms: Date.now() - started }); } catch (error) { if (!engines().local) throw error; return json(response, 200, { ...await voice.transcribe(audio, language), fallback: `${error.message} Used the voice model on this computer instead.` }); }
          return json(response, 200, await voice.transcribe(audio, language));
        }
        // One recording through every engine that is ready, side by side, so the person can hear which one understands them.
        if (url.pathname === '/api/voice/compare' && request.method === 'POST') {
          const audio = await rawBody(request), ready = Object.entries(engines()).filter(([, on]) => on).map(([engine]) => engine);
          const results = await Promise.all(ready.map(async engine => { const started = Date.now(); try { const result = await run(engine, audio); return { engine, text: result.text, model: result.model || '', ms: Date.now() - started }; } catch (error) { return { engine, error: error.message, ms: Date.now() - started }; } }));
          return json(response, 200, { language, results });
        }
        return json(response, 404, { error: 'Unknown voice request.' });
      }
      if (url.pathname.startsWith('/api/computer') || url.pathname.startsWith('/api/voice')) {
        const control = store.config().control || {};
        if (url.pathname === '/api/computer' && request.method === 'GET') return json(response, 200, { platform: computer.key, catalog: computer.catalog(), control, voice: { ...voice.status(), sizeMB: voice.size() }, anywhere: await anywhere.status() });
        if (control.enabled === false) return json(response, 403, { error: 'Computer control is off. Turn it on in Settings → Jev and voice → Controlling this computer.' });
        if (url.pathname === '/api/computer/anywhere' && request.method === 'POST') return json(response, 200, await anywhere.set((await body(request)).on === true));
        if (url.pathname === '/api/computer/do' && request.method === 'POST') return json(response, 200, await desk.commander.perform((await body(request)).text));
        // "Yes, always": these actions stop asking. Only actions that normally ask can be added.
        if (url.pathname === '/api/computer/allow' && request.method === 'POST') {
          const input = await body(request), config = store.config(), allow = new Set(config.control?.allow || []);
          for (const action of [].concat(input.actions || [])) { if (!desk.commander.actionOf(action)?.confirm) continue; if (input.on === false) allow.delete(action); else allow.add(action); }
          store.saveConfig({ ...config, control: { ...config.control, allow: [...allow] } }); return json(response, 200, { allow: [...allow] });
        }
        if (url.pathname === '/api/computer/run' && request.method === 'POST') {
          const input = await body(request), steps = (Array.isArray(input.steps) ? input.steps : []).slice(0, 8).map(step => ({ action: String(step.action), params: step.params || {} }));
          return json(response, 200, await desk.commander.runSteps(steps));
        }
        if (url.pathname === '/api/voice/install' && request.method === 'POST') { void voice.install().then(notify, notify); return json(response, 202, voice.status()); }
        if (url.pathname === '/api/voice/prepare' && request.method === 'POST') return json(response, 200, { ready: await voice.prepare(url.searchParams.get('language') || control.language || 'en') });
        if (url.pathname === '/api/voice/transcribe' && request.method === 'POST') return json(response, 200, await voice.transcribe(await rawBody(request), url.searchParams.get('language') || control.language || 'en'));
        return json(response, 404, { error: 'Unknown computer request.' });
      }
      if (url.pathname === '/api/query' && request.method === 'POST') return json(response, 200, await desk.query.ask((await body(request)).text));
      if (url.pathname === '/api/repositories/scan' && request.method === 'POST') { await desk.scanRepositories(); return json(response, 200, desk.snapshot().catalog); }
      if (url.pathname === '/api/repositories/catalog' && request.method === 'GET') return json(response, 200, store.list('repository'));
      // Folders: where data, AI memory and files from agents are kept, and moving them.
      // The sidebar's order and pins, as the person dragged them: { kind: 'agents' | 'rooms', order: [ids], pins: [ids] }.
      if (url.pathname === '/api/sidebar' && request.method === 'POST') {
        const input = await body(request), kind = input.kind;
        if (!['agents', 'rooms'].includes(kind)) throw new Error('Say which list: agents or rooms.');
        const ids = list => Array.isArray(list) ? [...new Set(list.map(String).filter(id => /^[A-Za-z0-9_-]{1,80}$/.test(id)))].slice(0, 500) : undefined;
        const saved = store.get('sidebar', 'main') || {}, order = ids(input.order), pins = ids(input.pins);
        const next = { ...saved, [kind]: { ...(saved[kind] || {}), ...(order ? { order } : {}), ...(pins ? { pins } : {}) } };
        store.put('sidebar', 'main', next); notify(); return json(response, 200, next);
      }
      if (url.pathname === '/api/folders' && request.method === 'GET') return json(response, 200, folderStatus({ dataRoot, store, memory: memoryFolder() }));
      if (url.pathname === '/api/folders/files' && request.method === 'POST') { await moveMedia(store, (await body(request)).to); return json(response, 200, folderStatus({ dataRoot, store, memory: memoryFolder() })); }
      if (url.pathname === '/api/folders/move' && request.method === 'POST') {
        const input = await body(request);
        if (dataDirectory) throw new Error('This copy of Rex Desk runs with a fixed data folder, so it cannot move it.');
        if ((desk.live?.size || 0) > 0) throw new Error('Agents are working. Wait until they finish, then move the folder.');
        // The AI memory stays in the home folder, shared by every account on this computer.
        if (input.kind === 'memory') throw new Error('The AI memory stays in your home folder, where every account on this computer reads it.');
        planDataMove(dataRoot, input.to);
        if (input.restart) { restartWanted = true; return json(response, 200, { restarting: true }); }
        return json(response, 200, folderStatus({ dataRoot, store, memory: memoryFolder() }));
      }
      if (url.pathname === '/api/folders/pick' && request.method === 'POST') return json(response, 200, await pickRepositoryFolder());
      if (url.pathname === '/api/folders/open' && request.method === 'POST') {
        const status = folderStatus({ dataRoot, store, memory: memoryFolder() }), folder = { data: status.data, memory: status.memory, files: status.files }[(await body(request)).kind];
        if (!folder) throw new Error('Unknown folder.');
        mkdirSync(folder, { recursive: true });
        spawn(process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', [folder], { detached: true, stdio: 'ignore' }).unref();
        return json(response, 200, { opened: folder });
      }
      if (url.pathname === '/api/schedule/run' && request.method === 'POST') return json(response, 200, await desk.runSchedule());
      if (url.pathname === '/api/update/check' && request.method === 'POST') { const status = await updates.check(); notify(); return json(response, 200, status); }
      if (url.pathname === '/api/update/install' && request.method === 'POST') {
        const input = await body(request), busy = busyAgents(store);
        // The update window takes the colours of the theme the person sees (sent by the page).
        if (input.theme) updates.theme = input.theme;
        if (input.cancel) { updateWhenIdle = false; notify(); return json(response, 200, { whenIdle: false }); }
        if (busy.length) {
          // Installing restarts Rex Desk and would cut the working agents off: it can wait for them instead.
          if (input.whenIdle) { updateWhenIdle = true; notify(); return json(response, 200, { whenIdle: true, busy }); }
          throw new Error(`${busy.join(', ')} ${busy.length === 1 ? 'is' : 'are'} still working. Update when ${busy.length === 1 ? 'it finishes' : 'they finish'}, or stop ${busy.length === 1 ? 'it' : 'them'} first.`);
        }
        installNow(); return json(response, 200, { restarting: true });
      }
      if (url.pathname === '/api/autostart' && request.method === 'GET') return json(response, 200, autostartStatus());
      if (url.pathname === '/api/autostart' && request.method === 'POST') return json(response, 200, await setAutostart(Boolean((await body(request)).enabled), root));
      if (url.pathname === '/api/github' && request.method === 'GET') return json(response, 200, await githubAccounts());
      if (url.pathname === '/api/github/login' && request.method === 'POST') return json(response, 200, await startGithubLogin());
      if (url.pathname === '/api/github/login' && request.method === 'DELETE') return json(response, 200, cancelGithubLogin());
      if (url.pathname === '/api/github/switch' && request.method === 'POST') return json(response, 200, await switchGithubAccount((await body(request)).user));
      if (url.pathname === '/api/repositories/clone' && request.method === 'POST') return json(response, 200, await cloneRepository((await body(request)).repository, process.env.REX_CLONE_DIR || path.dirname(root)));
      if (url.pathname === '/api/repositories/branch-preview' && request.method === 'POST') {
        const input = await body(request);
        return json(response, 200, { branch: issueBranch(input.pattern, { prefix: input.prefix || 'temp/rex' }) });
      }
      // The welcome questions (age range, where the person heard about Rex Desk): kept here, and sent to the Rex Desk account
      // service when this person is signed in to it, so the owner sees them. Only the listed answers are kept.
      if (url.pathname === '/api/survey' && request.method === 'POST') {
        const input = await body(request), clean = value => String(value || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
        const answer = { age: clean(input.age).slice(0, 40), heard: (Array.isArray(input.heard) ? input.heard : []).map(item => clean(item).slice(0, 30)).filter(Boolean).slice(0, 20), other: clean(input.other), at: new Date().toISOString() };
        store.put('survey', 'main', answer);
        const token = session.account?.token || store.cloud.account?.saved?.token;
        if (token) void (accountOptions.fetcher || fetch)(`${accountOptions.base || ACCOUNT_API}/v1/survey`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(answer), signal: AbortSignal.timeout(15000) }).catch(() => {});
        return json(response, 200, { saved: true });
      }
      if (url.pathname === '/api/config' && request.method === 'PUT') { const saved = store.saveConfig(await body(request)); desk.agents.invalidate(); void desk.refreshModels().catch(() => {}); return json(response, 200, saved); }
      // The skills, commands and MCP servers an agent has (or Rex Agent, with agent=main), for the / menu and its profile.
      // Local AI: the servers on this computer and their models, downloads into Ollama, and Hugging Face search.
      if (url.pathname === '/api/local-ai' && request.method === 'GET') return json(response, 200, await desk.localAi.status());
      if (url.pathname === '/api/local-ai/servers' && request.method === 'POST') { const input = await body(request); desk.localAi.addServer(input); return json(response, 200, await desk.localAi.status()); }
      if (url.pathname === '/api/local-ai/servers' && request.method === 'DELETE') { desk.localAi.removeServer(String(url.searchParams.get('id') || '')); return json(response, 200, await desk.localAi.status()); }
      if (url.pathname === '/api/local-ai/servers' && request.method === 'PUT') { const input = await body(request); desk.localAi.updateServer(String(input.id || ''), input); return json(response, 200, await desk.localAi.status()); }
      if (url.pathname === '/api/local-ai/setup' && request.method === 'POST') return json(response, 200, desk.localAi.setup());
      if (url.pathname === '/api/local-ai/pull' && request.method === 'POST') return json(response, 200, desk.localAi.pull((await body(request)).model));
      if (url.pathname === '/api/local-ai/models' && request.method === 'DELETE') { const status = await desk.localAi.remove(String(url.searchParams.get('model') || '')); desk.specialists.normalizeModels(); return json(response, 200, status); }
      if (url.pathname === '/api/local-ai/huggingface' && request.method === 'GET') return json(response, 200, { items: await desk.localAi.searchHuggingFace(url.searchParams.get('q')) });
      if (url.pathname === '/api/agents/tools' && request.method === 'GET') {
        const id = url.searchParams.get('agent') || 'main', agent = id === 'main' ? null : store.get('specialist', id);
        return json(response, 200, agentTools({ profile: agent?.profile || desk.agents.selected('claude') || '', projectPath: agent?.projectPath || '', extra: desk.orbitAccountMcp() }));
      }
      if (url.pathname === '/api/agents/login' && request.method === 'POST') { const input = await body(request); return json(response, 200, desk.agents.login(aiProvider(input.provider || 'claude'), String(input.profile || ''))); }
      if (url.pathname === '/api/agents/add' && request.method === 'POST') { const input = await body(request), provider = aiProvider(input.provider || 'claude'); const created = desk.agents.addProfile(provider, input.name); return json(response, 200, { ...created, ...desk.agents.login(provider, created.profile) }); }
      if (url.pathname === '/api/accounts/auto' && request.method === 'GET') return json(response, 200, { on: !store.get('accounts', 'auto')?.off });
      if (url.pathname === '/api/accounts/auto' && request.method === 'POST') { const on = (await body(request)).on !== false; store.put('accounts', 'auto', { id: 'auto', off: !on }); return json(response, 200, { on }); }
      if (url.pathname === '/api/agents' && request.method === 'GET') { void desk.refreshClaudeUsage().then(notify, () => {}); return json(response, 200, await desk.agents.overview({ refresh: url.searchParams.has('refresh') })); }
      if (url.pathname === '/api/agents/profile' && request.method === 'POST') {
        const input = await body(request);
        input.provider = aiProvider(input.provider || 'claude');
        const config = store.publicConfig();
        store.saveConfig({ ...config, agentProfiles: { ...config.agentProfiles, [input.provider]: input.profile ?? null } });
        // Picked by the person: an old "limited" mark does not keep the automatic switch away from it.
        if (input.profile) desk.agents.clearLimited(input.profile);
        desk.agents.invalidate(input.provider);
        return json(response, 200, await desk.agents.overview());
      }
      if (url.pathname === '/api/agents/mcp' && request.method === 'POST') {
        const { provider } = await body(request);
        aiProvider(provider);
        const command = provider === 'gemini' ? { command: agyCommand(), args: [] } : resolveCommand(provider), proxy = path.join(root, 'src', 'stdio.js');
        // Antigravity takes the server command right after its name; the others want -- before it.
        const args = [...command.args, 'mcp', 'add', ...(provider === 'claude' ? ['--scope', 'user'] : []), 'rex_desk', ...(provider === 'gemini' ? [] : ['--']), process.execPath, proxy];
        // An agent started from any profile folder, in any directory, must be able to read tasks, so every profile
        // this computer has gets the entry, not only the one Rex Desk's own runs use.
        const profiles = discoverProfiles(provider, { configured: desk.agents.selected(provider) });
        const results = [];
        for (const item of profiles) {
          if (desk.agents.mcpInstalled(provider, item.profile)) { results.push({ label: item.label, installed: true, already: true }); continue; }
          try {
            await exec(command.command, args, { env: profileEnvironment(provider, item.profile), windowsHide: true, timeout: 30000 });
            results.push({ label: item.label, installed: desk.agents.mcpInstalled(provider, item.profile) });
          } catch (error) { results.push({ label: item.label, installed: false, error: String(error.stderr || error.message).trim().split('\n').at(-1) }); }
        }
        desk.agents.invalidate(provider);
        return json(response, 200, { installed: desk.agents.mcpInstalled(provider), everywhere: results.every(item => item.installed), profiles: results });
      }
      // The text a person pastes into any agent session so it can take the issue over with its full context.
      if (url.pathname === '/api/handoff' && request.method === 'POST') {
        const input = await body(request);
        const run = input.runId ? store.get('run', input.runId) : store.list('run').filter(item => item.taskId === input.taskId && item.role === 'worker').sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
        const task = store.get('task', input.taskId || run?.taskId);
        if (!task) return json(response, 404, { error: 'Issue not found.' });
        const repository = store.config().repositories.find(item => item.id === run?.repositoryId);
        const messages = run ? store.events(run.id, { visible: true }).filter(event => event.kind === 'message') : [];
        return json(response, 200, { prompt: handoffPrompt({ task, run, repository, messages }) });
      }
      // Settings, Connect another AI: turn A2A on or off, or make a new key. The addresses are this computer's and its Tailscale ones.
      // The Team tab: the person answers a worker's question or cancels a task, in the manager's place.
      const teamTask = url.pathname.match(/^\/api\/team\/([^/]+)$/);
      if (teamTask && request.method === 'POST') {
        const input = await body(request), task = store.get('team-task', decodeURIComponent(teamTask[1]));
        if (!task || task.foreign) return json(response, 404, { error: 'That task is not on this computer.' });
        const managerRun = task.managerRunId;
        return json(response, 200, input.action === 'cancel' ? await desk.team.cancel(managerRun, { id: task.id }) : await desk.team.answer(managerRun, { id: task.id, text: String(input.text || '') }));
      }
      // Agents online: the person's agents that other people's agents can reach, who they are linked with, and every conversation.
      if (url.pathname === '/api/net' && request.method === 'GET') return json(response, 200, desk.net.overview());
      if (url.pathname === '/api/net/directory' && request.method === 'GET') return json(response, 200, { agents: await desk.net.directory(url.searchParams.get('q') || '') });
      const netAgent = url.pathname.match(/^\/api\/net\/agents\/([^/]+)(?:\/(pair-code|pair|request|links))?$/);
      if (netAgent) {
        const agentId = decodeURIComponent(netAgent[1]), part = netAgent[2] || '', input = request.method === 'POST' ? await body(request) : {};
        if (!part && request.method === 'POST') return json(response, 200, input.on === false ? await desk.net.unpublish(agentId) : await desk.net.publish(agentId, input));
        if (part === 'pair-code' && request.method === 'POST') return json(response, 200, await desk.net.pairCode(agentId));
        if (part === 'pair' && request.method === 'POST') return json(response, 200, await desk.net.pair(agentId, input.code));
        if (part === 'request' && request.method === 'POST') return json(response, 200, await desk.net.request(agentId, input.handle));
        if (part === 'links' && request.method === 'GET') return json(response, 200, { links: await desk.net.links(agentId) });
        if (part === 'links' && request.method === 'POST') return json(response, 200, await desk.net.linkAction(agentId, String(input.link || ''), String(input.action || '')));
      }
      const netThread = url.pathname.match(/^\/api\/net\/threads\/([^/]+)$/);
      if (netThread && request.method === 'GET') return json(response, 200, desk.net.thread(decodeURIComponent(netThread[1])));
      if (netThread && request.method === 'POST') { const input = await body(request); return json(response, 200, await desk.net.act(decodeURIComponent(netThread[1]), String(input.action || ''), input.text)); }
      if (url.pathname === '/api/a2a') {
        const input = request.method === 'POST' ? await body(request) : null;
        const settings = input ? setA2a(store, { enabled: input.enabled, newKey: Boolean(input.newKey) }) : a2aSettings(store);
        const addresses = [`http://127.0.0.1:${desk.port}`, ...desk.peers.addresses(desk.port)].map(base => `${base}/.well-known/agent-card.json`);
        return json(response, 200, { enabled: settings.enabled, token: settings.enabled ? settings.token : '', addresses });
      }
      // Settings, Tools and skills: the MCP servers, skills, commands and hooks on this computer.
      if (url.pathname === '/api/toolbox' && request.method === 'GET') return json(response, 200, await desk.toolbox.overview());
      if (url.pathname === '/api/toolbox' && request.method === 'POST') {
        const input = await body(request), what = String(input.what || '');
        const result = what === 'install' ? await desk.toolbox.install(input.text) : what === 'add-server' ? await desk.toolbox.addServer(input) : what === 'remove-server' ? await desk.toolbox.removeServer(input.name)
          : what === 'add-skill' ? await desk.toolbox.addSkill(input.source) : what === 'remove-skill' ? desk.toolbox.removeSkill(input.name) : what === 'remove-command' ? desk.toolbox.removeCommand(input.name) : null;
        if (!result) return json(response, 400, { error: 'Unknown change.' });
        return json(response, 200, { ...result, ...(await desk.toolbox.overview()) });
      }
      if (url.pathname === '/api/setup-prompt' && request.method === 'POST') {
        const input = await body(request);
        return json(response, 200, { prompt: setupPrompt({ target: input.target, root, dataDirectory: store.directory, mcpUrl: desk.mcpUrl, profiles: { claude: desk.agents.selected('claude') } }) });
      }
      if (url.pathname === '/api/orbit/account' && request.method === 'GET') { const account = desk.orbitAccount(); return json(response, 200, { connected: Boolean(account?.token), base: account?.base || 'https://orbitkh.vercel.app', since: account?.at || '' }); }
      if (url.pathname === '/api/orbit/account' && request.method === 'DELETE') { store.delete('secret', 'orbit-account'); return json(response, 200, { connected: false }); }
      if (url.pathname === '/api/orbit/account/start' && request.method === 'POST') {
        const base = String((await body(request)).base || 'https://orbitkh.vercel.app').replace(/\/$/, '');
        if (!/^https:\/\//.test(base)) return json(response, 400, { error: 'Orbit must be an https address.' });
        const login = await orbitDeviceStart(base);
        desk.orbitLogin = { ...login, base, until: Date.now() + login.expiresIn * 1000 };
        return json(response, 200, { userCode: login.userCode, url: login.url, expiresIn: login.expiresIn, interval: login.interval });
      }
      if (url.pathname === '/api/orbit/account/poll' && request.method === 'POST') {
        const login = desk.orbitLogin; if (!login || login.until < Date.now()) return json(response, 400, { error: 'The sign-in code expired. Start again.' });
        const result = await orbitDevicePoll(login.deviceCode, login.base);
        if (result.pending) return json(response, 200, { connected: false });
        store.put('secret', 'orbit-account', store.encrypt(JSON.stringify({ token: result.token, base: login.base, at: new Date().toISOString() }))); desk.orbitLogin = null;
        return json(response, 200, { connected: true });
      }
      // Orbit: the key is checked first, then the goal's tasks are brought in at once. Flow and Morningmate continue below.
      if (url.pathname === '/api/sources/orbit' && request.method === 'POST') {
        const input = await body(request), name = String(input.name || 'Orbit').trim().slice(0, 80) || 'Orbit', key = String(input.apiKey || '').trim();
        const existing = input.id ? store.config().sources.find(item => item.id === input.id && item.type === 'orbit') : null;
        if (!existing && !/^dgm_\S{8,}$/.test(key)) return json(response, 400, { error: 'Paste an Orbit project key. It starts with dgm_ (Orbit: Goal → Settings → API → Generate Project Key).' });
        const draft = { ...(existing || {}), id: existing?.id, name, type: 'orbit', baseUrl: input.baseUrl || existing?.baseUrl || 'https://orbitkh.vercel.app', projectIds: [], userId: '', statusFilter: ['active', 'unfinished', 'all'].includes(input.statusFilter) ? input.statusFilter : existing?.statusFilter || 'active', statuses: [], statusMap: {} };
        if (key) await desk.sources.testOrbit(draft, key);
        const source = store.saveConnection({ ...draft, ...(key ? { apiKey: key } : {}) });
        return json(response, 200, { source: store.publicConfig().sources.find(item => item.id === source.id), sync: await desk.sources.syncSource(source).catch(error => ({ error: error.message })) });
      }
      const sourceMatch = url.pathname.match(/^\/api\/sources\/([^/]+)$/);
      if (sourceMatch && request.method === 'DELETE') {
        const config = store.publicConfig();
        store.saveConfig({ ...config, sources: config.sources.filter(item => item.id !== decodeURIComponent(sourceMatch[1])) });
        return json(response, 200, { removed: true });
      }
      if (url.pathname === '/api/sources/connect' && request.method === 'POST') {
        const source = store.saveConnection(await body(request));
        return json(response, 200, { source, directory: await desk.sources.directory(source.id) });
      }
      if (url.pathname === '/api/sources/setup-agent' && request.method === 'POST') {
        const input = await body(request), source = store.saveConnection(input.source);
        return json(response, 200, { source, run: await desk.startConnectionAgent({ sourceId: source.id, provider: input.provider }) });
      }
      if (url.pathname === '/api/sync' && request.method === 'POST') { const input = await body(request).catch(() => ({})); return json(response, 200, await desk.sources.sync({ only: String(input.sourceId || '') })); }
      if (url.pathname === '/api/jev/prioritize' && request.method === 'POST') return json(response, 200, await (async () => { const input = await body(request); return desk.jev.prioritize({ force: Boolean(input.force), taskId: String(input.taskId || '') }); })());
      if (url.pathname === '/api/runs' && request.method === 'POST') return json(response, 200, await desk.startTask(await body(request)));
      if (url.pathname === '/api/demo' && request.method === 'POST') return json(response, 200, desk.demo());
      if (url.pathname === '/api/demo' && request.method === 'DELETE') { for (const task of store.list('task')) if (task.demo) store.delete('task', task.id); return json(response, 200, { removed: true }); }
      if (url.pathname === '/api/mcp-config' && request.method === 'POST') {
        return json(response, 200, { url: desk.mcpUrl, token: store.token,
          claude: { mcpServers: { rex_desk: { type: 'http', url: desk.mcpUrl, headers: { Authorization: 'Bearer ${REX_DESK_TOKEN}' } } } } });
      }
      if (url.pathname === '/api/diagnostics') {
        const results = await Promise.all(['claude', 'codex', 'agy', 'git', 'gh'].map(async name => {
          const command = name === 'agy' ? { command: agyCommand(), args: [] } : resolveCommand(name);
          try { const { stdout } = await exec(command.command, [...command.args, '--version'], { windowsHide: true, timeout: 10000 }); return { name, available: true, version: stdout.split('\n')[0] }; }
          catch (error) { return { name, available: false, error: error.message }; }
        })); return json(response, 200, { node: process.version, tools: results });
      }
      const branchMatch = url.pathname.match(/^\/api\/repositories\/([^/]+)\/branches$/);
      if (branchMatch) {
        const repository = store.config().repositories.find(item => item.id === decodeURIComponent(branchMatch[1]));
        if (!repository) return json(response, 404, { error: 'Project not found.' });
        const branches = (await git(repository.path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'])).split('\n').filter(Boolean);
        return json(response, 200, { branches });
      }
      const terminalMatch = url.pathname.match(/^\/api\/interactions\/([^/]+)\/terminal$/);
      if (terminalMatch && request.method === 'POST') return json(response, 200, desk.openSignInTerminal(terminalMatch[1]));
      const fileMatch = url.pathname.match(/^\/api\/interactions\/([^/]+)\/file$/);
      const sealedMatch = url.pathname.match(/^\/api\/interactions\/([^/]+)\/sealed$/);
      if (sealedMatch && request.method === 'POST') { const copy = desk.peers.askCopy(sealedMatch[1]); if (!copy) return json(response, 404, { error: 'This file is no longer waiting to be filled in.' }); return json(response, 200, desk.peers.sealFileAnswer(copy, sealedMatch[1], (await body(request)).values)); }
      if (fileMatch && request.method === 'GET') return json(response, 200, desk.fileForPerson(fileMatch[1]));
      if (fileMatch && request.method === 'POST') return json(response, 200, desk.saveFileForPerson(fileMatch[1], (await body(request)).content));
      const interactionMatch = url.pathname.match(/^\/api\/interactions\/([^/]+)\/answer$/);
      if (url.pathname === '/api/local-tasks' && request.method === 'POST') return json(response, 200, desk.localTasks.create(await body(request), { by: 'you' }));
      const localMatch = url.pathname.match(/^\/api\/local-tasks\/([^/]+)(\/comments)?$/);
      if (localMatch && !localMatch[2] && request.method === 'PUT') { const input = await body(request); return json(response, 200, desk.localTasks.update(decodeURIComponent(localMatch[1]), input, { by: 'you', force: Boolean(input.force) })); }
      if (localMatch && !localMatch[2] && request.method === 'DELETE') return json(response, 200, desk.localTasks.remove(decodeURIComponent(localMatch[1])));
      if (localMatch && localMatch[2] && request.method === 'POST') return json(response, 200, desk.localTasks.comment(decodeURIComponent(localMatch[1]), (await body(request)).text, { by: 'you' }));
      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch && request.method === 'GET') return json(response, 200, await desk.sources.taskDetail(decodeURIComponent(taskMatch[1]), { refresh: url.searchParams.has('refresh') }));
      if (taskMatch && request.method === 'POST') { const input = await body(request); return json(response, 200, desk.setDeskStatus(decodeURIComponent(taskMatch[1]), { status: input.deskStatus, note: input.deskNote, by: 'you' })); }
      if (url.pathname === '/api/task-file' && request.method === 'GET') {
        const media = await cachedTaskMedia(store, url.searchParams.get('task') || '', url.searchParams.get('url') || '', { fetcher: imageFetcher });
        return serveFile(request, response, media, { cache: 'private, max-age=604800' });
      }
      if (url.pathname === '/api/task-image' && request.method === 'GET') {
        const image = await cachedTaskImage(store, url.searchParams.get('task') || '', url.searchParams.get('url') || '', { fetcher: imageFetcher });
        return serveFile(request, response, image, { cache: 'private, max-age=604800' });
      }
      if (interactionMatch && request.method === 'POST' && desk.peers.askCopy(interactionMatch[1])) return json(response, 200, desk.peers.answerAsk(desk.peers.askCopy(interactionMatch[1]), interactionMatch[1], await body(request)));
      if (interactionMatch && request.method === 'POST') { const owner = !store.get('interaction', interactionMatch[1]) && desk.peers.interactionOwner(interactionMatch[1]); return json(response, 200, owner ? await desk.peers.forward(owner, 'POST', url.pathname, await body(request)) : desk.answer(interactionMatch[1], await body(request))); }
      const unsendMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/messages\/(\d+)$/);
      if (unsendMatch && request.method === 'DELETE') return json(response, 200, desk.unsend(unsendMatch[1], unsendMatch[2]));
      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/(messages|stop|resume|verify|publish|say|fresh|app|voice))?$/);
      if (runMatch) {
        const [, runId, action] = runMatch;
        // The agent comes to the computer you type on (unless its project runs only on its own computer): it moves here
        // before the message would be passed on to the other computer, so the chat carries on here.
        if (request.method === 'POST' && ['say', 'resume'].includes(action)) {
          const agentId = store.get('run', runId)?.specialistId || store.get('chatcopy', runId)?.run?.specialistId || store.list('specialist').find(agent => agent.runId === runId)?.id;
          const agent = agentId ? store.get('specialist', agentId) : null;
          if (desk.peers.followsHere(agent)) await desk.projectRules.move(agent.id).catch(() => {});
        }
        const runOwner = !store.get('run', runId) && desk.peers.runOwner(runId);
        if (runOwner) return json(response, 200, await desk.peers.forward(runOwner, request.method, `${url.pathname}${url.search}`, request.method === 'POST' ? await body(request) : undefined));
        const copy = desk.peers.chatCopy(runId);
        if (copy) {
          if (request.method === 'GET') return json(response, 200, action === 'messages' ? copy.events || [] : { ...copy.run, remote: copy.node, cloudCopy: true });
          if (request.method === 'POST') return json(response, 200, await desk.peers.chatAction(copy, action, await body(request)));
        }
        if (request.method === 'GET') {
          if (action === 'messages') return json(response, 200, store.events(runId, { visible: true }));
          return json(response, 200, desk.run(runId));
        }
        if (request.method === 'POST') {
          const input = await body(request);
          // A chat with an agent that lives on another computer runs there while that computer is on, even when this one holds a copy of the chat.
          const homeAgent = ['say', 'resume', 'stop', 'app'].includes(action) && store.get('run', runId)?.specialistId ? store.get('specialist', store.get('run', runId).specialistId) : null;
          // A project that runs only on its own computer, or is not on this one, never starts here: the message waits for that computer.
          const follows = action !== 'stop' && desk.peers.followsHere(homeAgent);
          if (follows) await desk.projectRules.move(homeAgent.id).catch(() => {});
          const elsewhere = !follows && homeAgent && desk.peers.isRemote(homeAgent) && (desk.peers.online(homeAgent.node) || homeAgent.pinned || Boolean(homeAgent.projectSlug && !desk.projectRules.folderHere(homeAgent.projectSlug)));
          if (elsewhere) return json(response, 200, await desk.peers.chatAction({ id: runId, node: homeAgent.node, agentId: homeAgent.id }, action, input));
          // Its computer is off and the project is here: the agent moves to this computer and carries on, shown as working here.
          if (homeAgent && desk.peers.isRemote(homeAgent) && action !== 'stop') await desk.projectRules.move(homeAgent.id).catch(() => {});
          if (action === 'stop') return json(response, 200, await desk.stop(runId));
          // Continue in Claude app (on), or bring the chat back to Rex Desk only (on: false).
          if (action === 'app') return json(response, 200, await desk.continueInApp(runId, input.on !== false));
          // Voice mode on (the briefing is made now) or off.
          if (action === 'voice') {
            // The sentences Voice mode says often are made now, while the body opens, so they play at once: the welcome
            // first, then the rest, a few at a time.
            if (input.on !== false) { const lines = readyLines(); let next = 0; const work = async () => { while (next < lines.length) { const line = lines[next++]; await speakerOf().speak(line, { lang: 'en' }).catch(() => {}); } }; void work(); void work(); void work(); }
            return json(response, 200, desk.voiceMode(runId, input.on !== false));
          }
          if (action === 'fresh') return json(response, 200, await desk.freshStart(runId));
          if (action === 'say') return json(response, 200, await desk.say(runId, input.text, input));
          if (action === 'resume') return json(response, 200, await desk.resume(runId, input));
          if (action === 'verify') return json(response, 200, await desk.verify(runId));
          if (action === 'publish') return json(response, 200, await desk.publish(runId, { ...input, approved: true }));
        }
      }
      // The file window: open, view, save, format, and open in another program.
      // Read a reply aloud with a neural voice (Microsoft's Edge voices, as studybook uses): the MP3 comes back as the response.
      // Every spoken line goes through one speaker (Microsoft's natural voices, or Fish Audio when chosen), so Voice mode, the
      // speaker button and the short status lines are all in the same voice. The sound is sent as it arrives.
      if (url.pathname === '/api/speak' && request.method === 'POST') {
        const input = await body(request); let started = false; const speaker = speakerOf();
        const send = (chunk, voice) => { if (!started) { started = true; response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Rex-Voice': voice }); } response.write(chunk); };
        try { await speaker.speak(input.text, { lang: input.lang, voice: input.voice, onChunk: send }); }
        catch (error) { if (!started) throw error; }
        response.end(); return;
      }
      if (url.pathname === '/api/speak/engine' && request.method === 'GET') return json(response, 200, await speakerOf().status());
      if (url.pathname === '/api/speak/engine' && request.method === 'POST') { const speaker = speakerOf(); speaker.save(await body(request)); return json(response, 200, await speaker.status()); }
      if (url.pathname === '/api/speak/fish-key' && request.method === 'POST') { const speaker = speakerOf(); const saved = speaker.saveKey((await body(request)).key); return json(response, 200, { saved, ...await speaker.status() }); }
      if (url.pathname === '/api/speak/voices' && request.method === 'GET') return json(response, 200, NEURAL_VOICES);
      // Opens one of Rex Desk's own pages in the normal browser, for when the app cannot open a window itself.
      if (url.pathname === '/api/open-page' && request.method === 'POST') {
        const target = String((await body(request)).path || '');
        if (!/^\/(files|jev)(?:[#?].*)?$/.test(target)) return json(response, 400, { error: 'Only Rex Desk pages open this way.' });
        const address = `http://127.0.0.1:${request.socket.localPort}${target}`;
        const [command, args] = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '""', address.replace(/&/g, '^&')]] : process.platform === 'darwin' ? ['open', [address]] : ['xdg-open', [address]];
        spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return json(response, 200, { opened: true });
      }
      if (url.pathname === '/api/files/open' && request.method === 'GET') return json(response, 200, desk.files.open(url.searchParams.get('path'), url.searchParams.get('run') || '', url.searchParams.get('room') || ''));
      if (url.pathname === '/api/files/raw' && request.method === 'GET') {
        const file = desk.files.check(url.searchParams.get('path') || ''), kind = kindOf(file);
        if (!existsSync(file) || statSync(file).isDirectory()) return json(response, 404, { error: 'No such file.' });
        // HTML runs in a sandbox with no origin; SVG can carry script, so it gets the strict one; everything else may sit in a frame.
        const ext = path.extname(file).toLowerCase(), textual = !['image', 'video', 'audio', 'pdf'].includes(kind);
        return serveFile(request, response, file, { sandbox: kind === 'html' ? 'scripts' : ext === '.svg' ? true : false, frame: !['html'].includes(kind) && ext !== '.svg', download: url.searchParams.has('download'), type: kind === 'html' ? '' : textual ? 'text/plain; charset=utf-8' : mimeOf(file) || '' });
      }
      if (url.pathname === '/api/files/sheet' && request.method === 'GET') return json(response, 200, await desk.files.sheet(url.searchParams.get('path') || ''));
      if (url.pathname === '/api/files/doc' && request.method === 'GET') { const html = await desk.files.doc(url.searchParams.get('path') || ''); response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:;" }); response.end(html); return; }
      if (url.pathname === '/api/files/save' && request.method === 'POST') { const input = await body(request); try { return json(response, 200, desk.files.save(input.path, input)); } catch (error) { return json(response, error.status || 400, { error: error.message, conflict: error.status === 409 }); } }
      if (url.pathname === '/api/files/format' && request.method === 'POST') { const input = await body(request); return json(response, 200, await desk.files.format(input.path, input.text)); }
      if (url.pathname === '/api/files/reveal' && request.method === 'POST') { const input = await body(request); return json(response, 200, desk.files.reveal(input.path, input.how)); }
      if (url.pathname === '/api/worktrees' && request.method === 'GET') return json(response, 200, await desk.worktrees.list());
      const worktreeChanges = /^\/api\/worktrees\/([\w-]+)\/changes$/.exec(url.pathname);
      if (worktreeChanges && request.method === 'GET') return json(response, 200, await desk.worktrees.changes(worktreeChanges[1]));
      const worktreeTask = /^\/api\/worktrees\/([\w-]+)\/tasks$/.exec(url.pathname);
      if (worktreeTask && request.method === 'POST') { const input = await body(request); return json(response, 200, input.remove ? desk.worktrees.removeTask(worktreeTask[1], String(input.taskId || '')) : desk.worktrees.addTask(worktreeTask[1], String(input.taskId || ''))); }
      if (url.pathname === '/api/monitor' && request.method === 'GET') return json(response, 200, await desk.monitor.snapshot({ fresh: url.searchParams.has('fresh') }));
      if (url.pathname === '/api/monitor/clean' && request.method === 'POST') return json(response, 200, await desk.monitor.clean({ reason: 'you pressed Free memory' }));
      if (url.pathname === '/api/monitor/end' && request.method === 'POST') return json(response, 200, await (async input => desk.monitor.end(input.pid, { outside: input.outside === true }))(await body(request)));
      if (url.pathname === '/api/specialists' && request.method === 'GET') return json(response, 200, desk.specialists.list());
      if (url.pathname === '/api/specialists' && request.method === 'POST') return json(response, 200, desk.specialists.create({ ...(await body(request)), by: 'you' }));
      const lessonMatch = url.pathname.match(/^\/api\/specialists\/([^/]+)\/lessons\/(\d+)$/);
      if (lessonMatch && request.method === 'DELETE') return json(response, 200, desk.specialists.forget(lessonMatch[1], Number(lessonMatch[2])));
      // A project's two rules: runs only on its computer, and keep out of the cloud (see project-rules.js).
      const ruleMatch = url.pathname.match(/^\/api\/project-rules\/([^/]+)$/);
      if (ruleMatch && request.method === 'PUT') return json(response, 200, desk.projectRules.set(decodeURIComponent(ruleMatch[1]), await body(request)));
      if (url.pathname === '/api/project-rules' && request.method === 'GET') return json(response, 200, desk.projectRules.list());
      const specialistMatch = url.pathname.match(/^\/api\/specialists\/([^/]+)(?:\/(rename|duplicate|assign|say|loop|move|follow))?$/);
      if (specialistMatch) {
        const [, specialistId, part] = specialistMatch;
        let remoteAgent = store.get('specialist', specialistId);
        // A message for an agent whose computer is off, whose project is also here and not kept to its computer: it moves here.
        if (request.method === 'POST' && part === 'follow') { const input = await body(request); const agent = store.get('specialist', specialistId); if (!agent || agent.kind === 'main') return json(response, 404, { error: 'No such agent.' }); return json(response, 200, store.put('specialist', specialistId, { ...agent, follows: Boolean(input.on) })); }
        const followsHere = desk.peers.followsHere(remoteAgent);
        if (request.method === 'POST' && ['say', 'assign'].includes(part) && followsHere) { await desk.projectRules.move(specialistId).catch(() => {}); remoteAgent = store.get('specialist', specialistId); }
        if (desk.peers.isRemote(remoteAgent) && request.method === 'POST' && ['say', 'assign'].includes(part) && !desk.peers.online(remoteAgent.node) && !remoteAgent.pinned && (!remoteAgent.projectSlug || desk.projectRules.folderHere(remoteAgent.projectSlug))) {
          await desk.projectRules.move(specialistId).catch(() => {}); remoteAgent = store.get('specialist', specialistId);
        }
        if (request.method === 'POST' && part === 'move') return json(response, 200, await desk.projectRules.move(specialistId));
        if (desk.peers.isRemote(remoteAgent) && request.method === 'POST' && ['say', 'assign'].includes(part)) {
          const input = await body(request), task = input.taskId && store.get('task', input.taskId);
          return json(response, 200, await desk.peers.command(remoteAgent, part, task ? { ...input, taskNumber: task.taskNumber || task.externalId } : input));
        }
        if (desk.peers.isRemote(remoteAgent) && request.method === 'POST' && part === 'duplicate') return json(response, 200, await desk.peers.forward(remoteAgent.node, 'POST', url.pathname, await body(request)));
        if (request.method === 'POST' && part === 'assign') { const input = await body(request); return json(response, 200, await desk.assignTask({ specialistId, ...desk.peers.localTask(input) })); }
        if (request.method === 'PUT' && !part) return json(response, 200, desk.specialists.update(specialistId, await body(request)));
        if (request.method === 'POST' && part === 'loop') return json(response, 200, await desk.runLoop(specialistId));
        if (request.method === 'POST' && part === 'rename') return json(response, 200, desk.specialists.rename(specialistId, (await body(request)).name));
        if (request.method === 'POST' && part === 'duplicate') return json(response, 200, desk.specialists.duplicate(specialistId, (await body(request)).name));
        if (request.method === 'POST' && part === 'say') return json(response, 200, await desk.specialistTurn(specialistId, { prompt: String((await body(request)).text || '').slice(0, 4000) }));
        if (request.method === 'DELETE' && !part) return json(response, 200, desk.specialists.remove(specialistId));
      }
      // A file someone attached in a chat, to show in the chat's Media and Files tabs. Only files under Rex Desk's uploads folder.
      if (url.pathname === '/api/uploads/file' && request.method === 'GET') {
        const uploads = path.resolve(store.media('uploads')); let file = path.resolve(String(url.searchParams.get('path') || ''));
        // A chat restored from the backup into another data folder (a reinstall, a new computer) still names the old folder.
        const moved = /[\\/]uploads[\\/]([^\\/]+)[\\/]([^\\/]+)$/.exec(String(url.searchParams.get('path') || ''));
        if (moved && !file.toLowerCase().startsWith(`${uploads.toLowerCase()}${path.sep}`)) { const here = path.join(uploads, moved[1], moved[2]); if (existsSync(here)) file = here; }
        if (!file.toLowerCase().startsWith(`${uploads.toLowerCase()}${path.sep}`) || !existsSync(file)) {
          // A picture attached in a chat on another computer comes from the shared copy of that chat.
          const picture = desk.peers.chatPicture(String(url.searchParams.get('path') || ''));
          if (picture) { response.writeHead(200, { 'Content-Type': mime[path.extname(picture.name).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Length': picture.data.length }); return response.end(picture.data); }
          return json(response, 404, { error: 'That file is not in the chat uploads.' });
        }
        return serveFile(request, response, file, { sandbox: /\.(html?|svg)$/i.test(file), download: url.searchParams.has('download'), cache: 'private, max-age=86400' });
      }
      if (url.pathname === '/api/uploads' && request.method === 'POST') {
        const name = path.basename(String(url.searchParams.get('name') || 'file')).replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 120) || 'file', folder = path.join(store.media('uploads'), randomUUID()), target = path.join(folder, name);
        mkdirSync(folder, { recursive: true }); let size = 0; const out = createWriteStream(target);
        try { for await (const chunk of request) { size += chunk.length; if (size > 25 * 1024 * 1024) throw new Error('A file can be at most 25 MB.'); if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve)); } await new Promise((resolve, reject) => { out.end(); out.once('finish', resolve); out.once('error', reject); }); }
        catch (error) { out.destroy(); rmSync(folder, { recursive: true, force: true }); throw error; }
        return json(response, 200, { path: target, name, size });
      }
      if (url.pathname === '/api/presence' && request.method === 'POST') {
        const input = await body(request), view = String(input.view ?? desk.presence.view ?? '').slice(0, 200);
        desk.presence = { focused: Boolean(input.focused), view, at: Date.now() };
        // The chat on screen in a window the person is looking at is read.
        if (desk.presence.focused && view) desk.notifier.read({ key: view });
        return json(response, 200, { ok: true });
      }
      if (url.pathname === '/api/notices/read' && request.method === 'POST') { const input = await body(request); return json(response, 200, desk.notifier.read({ key: String(input.key || ''), all: input.all === true })); }
      if (url.pathname === '/api/notices/prefs' && request.method === 'POST') return json(response, 200, desk.notifier.setPrefs(await body(request)));
      if (url.pathname === '/api/notices/push-test' && request.method === 'POST') return json(response, 200, await desk.notifier.testPush());
      if (url.pathname === '/api/notices/push-qr' && request.method === 'GET') { const { push } = desk.notifier.prefs(); const link = `${push.server}/${push.topic}`; return json(response, 200, { link, svg: await QRCode.toString(link, { type: 'svg', margin: 2, color: { dark: '#111418', light: '#ffffff' } }) }); }
      if (url.pathname === '/api/notices/test' && request.method === 'POST') return json(response, 200, desk.notifier.test());
      if (url.pathname === '/api/notices/mute' && request.method === 'POST') { const input = await body(request); return json(response, 200, desk.notifier.mute(String(input.key || ''), input.on !== false)); }
      const taskNameMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/name$/);
      if (taskNameMatch && request.method === 'POST') return json(response, 200, { name: await desk.englishName(taskNameMatch[1]) });
      if (url.pathname === '/api/main' && request.method === 'POST') return json(response, 200, await desk.startMain(await body(request)));
      if (url.pathname === '/api/memory' && request.method === 'GET') return json(response, 200, { directory: desk.memory.directory, projects: desk.memory.list(), scannedAt: desk.memory.state().scannedAt || null });
      if (url.pathname === '/api/memory/page' && request.method === 'GET') return json(response, 200, { page: url.searchParams.get('name') || 'index', text: desk.memory.readDoc(url.searchParams.get('name') || 'index') });
      if (url.pathname === '/api/memory/scan' && request.method === 'POST') { const input = await body(request); return json(response, 200, desk.memory.scan({ roots: Array.isArray(input.roots) && input.roots.length ? input.roots : scanRoots(store, root) })); }
      if (url.pathname === '/api/profile' && request.method === 'GET') return json(response, 200, { ...desk.memory.profile(), name: store.config().name || '', email: session?.email || '', agents: desk.specialists.list().filter(agent => agent.kind !== 'main').map(agent => ({ id: agent.id, name: agent.name, project: agent.projectSlug })) });
      // The knowledge space as a graph: the person, what the agents learned, the agents and their projects, and the second brain's notes.
      if (url.pathname === '/api/knowledge' && request.method === 'GET') {
        const brainPath = /Where:\s*`([^`]+)`/.exec(desk.memory.secondBrain())?.[1] || '';
        const agents = desk.specialists.list().map(agent => ({ id: agent.id, name: agent.name, purpose: agent.purpose || '', project: agent.kind === 'main' ? '' : agent.projectSlug, lessons: (agent.lessons || []).map(lesson => lesson.text) }));
        return json(response, 200, await knowledgeGraph({ profile: desk.memory.profile(), name: store.config().name || '', agents, brainPath }));
      }
      if (url.pathname === '/api/profile/notes' && request.method === 'POST') { const input = await body(request); const result = desk.memory.personNote(String(input.kind || ''), input.text, { lasting: true, replaces: input.replaces || '' }); notify(); return json(response, 200, result); }
      if (url.pathname === '/api/profile/notes' && request.method === 'DELETE') { const input = await body(request); const result = desk.memory.forgetPersonNote(String(input.kind || ''), input.text); notify(); return json(response, 200, result); }
      if (url.pathname === '/api/profile/photo' && request.method === 'GET') { const photo = desk.memory.photo(); if (!photo) return json(response, 404, { error: 'No profile photo yet.' }); return serveFile(request, response, photo.file); }
      if (url.pathname === '/api/profile/photo' && request.method === 'POST') { const result = desk.memory.setPhotoData((await body(request)).data, 'upload'); notify(); return json(response, 200, result); }
      if (url.pathname === '/api/profile/photo' && request.method === 'DELETE') { const result = desk.memory.removePhoto(); notify(); return json(response, 200, result); }
      if (url.pathname === '/api/memory/user' && request.method === 'PUT') return json(response, 200, desk.memory.setUser((await body(request)).text));
      if (url.pathname === '/api/rooms/from-chat' && request.method === 'POST') { const input = await body(request); return json(response, 200, desk.rooms.fromChat({ agentId: input.agentId, name: input.name, members: input.members || [], history: desk.personalChat(input.agentId, Math.min(Number(input.limit) || 20, 60)) })); }
      if (url.pathname === '/api/rooms' && request.method === 'POST') { const input = await body(request); return json(response, 200, desk.rooms.create(input.name, input.members)); }
      const roomOnly = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
      if (roomOnly && request.method === 'PUT') return json(response, 200, desk.rooms.rename(roomOnly[1], (await body(request)).name));
      if (roomOnly && request.method === 'DELETE') return json(response, 200, desk.rooms.remove(roomOnly[1]));
      const roomImage = url.pathname.match(/^\/api\/rooms\/([^/]+)\/image$/);
      if (roomImage && request.method === 'GET') {
        const room = desk.rooms.room(roomImage[1]), file = room.image && path.join(store.media('room-images'), path.basename(room.image));
        if (!file || !existsSync(file)) return json(response, 404, { error: 'This room has no picture.' });
        return serveFile(request, response, file, { cache: 'no-cache' });
      }
      if (roomImage && request.method === 'POST') {
        const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[String(request.headers['content-type'] || '').split(';')[0]];
        if (!ext) throw new Error('Choose a PNG, JPEG, WebP or GIF picture.');
        const room = desk.rooms.room(roomImage[1]), folder = path.join(store.media('room-images')), chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 5 * 1024 * 1024) throw new Error('The picture can be at most 5 MB.'); chunks.push(chunk); }
        mkdirSync(folder, { recursive: true });
        if (room.image && room.image !== room.id + ext) rmSync(path.join(folder, path.basename(room.image)), { force: true });
        writeFileSync(path.join(folder, room.id + ext), Buffer.concat(chunks));
        return json(response, 200, desk.rooms.setImage(room.id, room.id + ext));
      }
      const awayMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/away$/);
      if (awayMatch && request.method === 'PUT') return json(response, 200, desk.rooms.setAway(awayMatch[1], await body(request)));
      const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(messages|members)(?:\/([^/]+))?$/);
      if (roomMatch) {
        const [, roomId, part, extra] = roomMatch;
        if (part === 'messages' && request.method === 'GET') return json(response, 200, desk.rooms.messages(roomId, { after: Number(url.searchParams.get('after')) || 0 }));
        if (part === 'messages' && request.method === 'POST') { const input = await body(request); return json(response, 200, await desk.rooms.post(roomId, { text: input.text, to: input.to, replyTo: input.replyTo || '' })); }
        if (part === 'messages' && extra && request.method === 'DELETE') return json(response, 200, desk.rooms.deleteMessage(roomId, extra));
        if (part === 'members' && request.method === 'POST') return json(response, 200, desk.rooms.addMember(roomId, (await body(request)).agentId));
        if (part === 'members' && request.method === 'DELETE') return json(response, 200, desk.rooms.removeMember(roomId, extra));
      }
      const artifactMatch = url.pathname.match(/^\/artifacts\/([a-f0-9-]+)\/([^/]+)$/);
      if (artifactMatch) {
        const [, runId, encodedFile] = artifactMatch, file = decodeURIComponent(encodedFile);
        const artifact = store.list('artifact').find(item => item.runId === runId && item.file === file);
        if (!artifact) {
          // Evidence from a chat on another computer comes from the shared copy of that chat.
          const picture = desk.peers.evidencePicture(runId, file);
          if (picture) { response.writeHead(200, { 'Content-Type': mime[path.extname(picture.name).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Length': picture.data.length }); return response.end(picture.data); }
          // A page (or any other file) an agent shared on the other computer: unpacked from the copy that came with the chat, or
          // fetched from the account's backup, then served from here the way a page made here is (in its sandbox).
          const carried = path.join(store.media('artifacts'), runId, path.basename(file));
          if (!existsSync(carried)) { try { desk.peers.restoreEvidence(runId, file); } catch { /* not carried with the chat */ } }
          if (!existsSync(carried)) await store.cloud.files?.fetchOne?.(`data/artifacts/${runId}/${path.basename(file)}`).catch(() => false);
          if (existsSync(carried)) return serveFile(request, response, carried, { sandbox: /\.html?$/i.test(file) ? 'scripts' : false, download: url.searchParams.has('download') });
          const notHere = () => { response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }); return response.end('<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;min-height:100vh;font:15px/1.6 system-ui,sans-serif;background:#16181d;color:#e6e8eb;text-align:center;padding:24px"><div style="max-width:440px"><p style="font-size:17px;font-weight:600;margin:0 0 8px">This file is not on this computer yet.</p><p style="margin:0;color:#9aa3b1">It was made on your other computer. It arrives here once both computers are connected through your Rex Desk account. Open it on the computer that made it, or try again later.</p></div></body>'); };
          return notHere();
        }
        const location = path.join(store.media('artifacts'), runId, path.basename(file));
        if (!existsSync(location)) desk.peers.restoreEvidence(runId, file);
        // Not carried with the chat: fetched now from the account's backup, only this one file.
        if (!existsSync(location)) await store.cloud.files?.fetchOne?.(`data/artifacts/${runId}/${path.basename(file)}`).catch(() => false);
        if (!existsSync(location)) { const notHere = () => { response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }); return response.end('<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;min-height:100vh;font:15px/1.6 system-ui,sans-serif;background:#16181d;color:#e6e8eb;text-align:center;padding:24px"><div style="max-width:440px"><p style="font-size:17px;font-weight:600;margin:0 0 8px">This file is not on this computer yet.</p><p style="margin:0;color:#9aa3b1">It was made on your other computer. It arrives here once both computers are connected through your Rex Desk account. Open it on the computer that made it, or try again later.</p></div></body>'); }; return notHere(); }
        return serveFile(request, response, location, { sandbox: artifact.type === 'text/html' ? (artifact.page ? 'scripts' : true) : false, download: url.searchParams.has('download') });
      }
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: 'API route not found.' });
      const publicFiles = { '/': 'chat.html', '/chat.js': 'chat.js', '/chat-agents.js': 'chat-agents.js', '/chat-composer.js': 'chat-composer.js', '/chat-update.js': 'chat-update.js', '/chat-activity.js': 'chat-activity.js', '/chat-markdown.js': 'chat-markdown.js', '/chat-rooms.js': 'chat-rooms.js', '/chat-pick.js': 'chat-pick.js', '/chat-settings.js': 'chat-settings.js', '/chat-devices.js': 'chat-devices.js', '/chat-monitor.js': 'chat-monitor.js', '/chat-worktrees.js': 'chat-worktrees.js', '/chat-viewer.js': 'chat-viewer.js', '/chat-notices.js': 'chat-notices.js', '/chat-files.js': 'chat-files.js', '/chat-card.js': 'chat-card.js', '/chat-speak.js': 'chat-speak.js', '/files': 'files.html', '/files-window.js': 'files-window.js', '/chat-media.js': 'chat-media.js', '/presence.js': 'presence.js', '/chat.css': 'chat.css', '/glass.css': 'glass.css', '/rex-core.js': 'rex-core.js', '/chat-palette.js': 'chat-palette.js', '/chat-split.js': 'chat-split.js', '/themes.css': 'themes.css', '/chat-glass.js': 'chat-glass.js', '/ai-logos.js': 'ai-logos.js', '/chat-tour-ai.js': 'chat-tour-ai.js', '/chat-local-ai.js': 'chat-local-ai.js', '/win-bar.js': 'win-bar.js', '/chat-graph.js': 'chat-graph.js', '/graph-worker.js': 'graph-worker.js', '/signin': 'signin.html', '/chat-signin.js': 'chat-signin.js', '/theme.js': 'theme.js', '/style.css': 'style.css', '/login-scene.js': 'login-scene.js', '/favicon.svg': 'favicon.svg', '/favicon.ico': 'favicon.ico', '/jev': 'jev.html', '/jev.js': 'jev.js', '/jev.css': 'jev.css', '/recorder.js': 'recorder.js', '/pwa.js': 'pwa.js', '/sw.js': 'sw.js', '/offline.html': 'offline.html', '/manifest.webmanifest': 'manifest.webmanifest', '/icon-180.png': 'icon-180.png', '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png' };
      // three.js ships from the installed package; the page loads no remote scripts.
      const vendorFiles = { '/vendor/three/three.module.js': 'three/build/three.module.js', '/vendor/three/three.core.js': 'three/build/three.core.js', '/vendor/driver/driver.js.mjs': 'driver.js/dist/driver.js.mjs', '/vendor/driver/driver.css': 'driver.js/dist/driver.css' };
      if (vendorFiles[url.pathname]) return serveFile(request, response, path.join(root, 'node_modules', vendorFiles[url.pathname]), { cache: 'public, max-age=604800' });
      const editorFile = url.pathname.match(/^\/vendor\/codemirror\/((?:lib|mode\/[a-z0-9-]+|addon\/[a-z]+)\/[a-z0-9-]+\.(?:js|css))$/);
      if (editorFile) return serveFile(request, response, path.join(root, 'node_modules', 'codemirror', ...editorFile[1].split('/')), { cache: 'public, max-age=604800' });
      // The Khmer themes' fonts (Kantumruy Pro and Moul, SIL Open Font License) ship in public/fonts.
      if (/^\/fonts\/[a-z0-9-]+\.woff2$/.test(url.pathname) && existsSync(path.join(root, 'public', url.pathname.slice(1)))) return serveFile(request, response, path.join(root, 'public', url.pathname.slice(1)), { cache: 'public, max-age=604800' });
      // One file per language, { "English text": "Translation" } (see public/i18n.js). Always checked again, so a fix to a word shows at once.
      if (/^\/i18n\/[a-z]{2,3}\.json$/.test(url.pathname) && existsSync(path.join(root, 'public', url.pathname.slice(1)))) return serveFile(request, response, path.join(root, 'public', url.pathname.slice(1)), { cache: 'no-cache' });
      // A page script or style added after this server started is served by its name too, so a server still waiting for
      // agents to finish before it restarts does not leave the page stuck on a missing file.
      // The Settings tours: their steps in public/guides, and the voice of each step in public/guides/voice.
      const file = publicFiles[url.pathname] || (/^\/(?:guides\/)?[a-z0-9-]+\.(?:js|css)$/.test(url.pathname) || /^\/guides\/voice\/[a-z0-9-]+\.m4a$/.test(url.pathname) ? url.pathname.slice(1) : '');
      if (!file || !existsSync(path.join(root, 'public', file))) return json(response, 404, { error: 'Page not found.' });
      return serveFile(request, response, path.join(root, 'public', file));
    } catch (error) { if (!response.headersSent) json(response, 400, { error: error.message }); else response.end(); }
  };
  // The window key file exists before the server answers, so the desktop app can read it as soon as it sees the server up.
  windowKey();
  const server = http.createServer(handler);
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { await closeSession(); unlinkSync(lockPath); throw error; }
  address = `http://127.0.0.1:${server.address().port}`;
  listenPort = server.address().port;
  // The installed app's version of the server that is listening now, so a newer app can tell a leftover server from its own
  // (written here, once this server owns the port, not by the app before it knows whether the start worked).
  if (process.env.REX_DESK_VERSION && !dataDirectory) { try { writeFileSync(path.join(dataRoot, 'server.version'), process.env.REX_DESK_VERSION); } catch {} }
  // The person's other computers and phone reach this Rex Desk over Tailscale when they turned that on (see peers.js).
  remoteOpen = () => {
    const desk = session?.desk, wanted = desk?.peers.settings().remote ? tailscaleAddresses() : [], key = wanted.join(',');
    if (key === remoteAt) return; remoteAt = key;
    for (const item of remoteServers.splice(0)) item.close();
    for (const host of wanted) { const item = http.createServer(handler); item.on('error', error => session?.store.event('', 'remote-listen-error', { message: error.message })); item.listen(listenPort, host); remoteServers.push(item); }
  };
  void opening.then(() => { if (session) startDesk(session.desk, session.store); });
  let lastSync = Date.now(), ticks = 0;
  const timer = setInterval(() => {
    if (!session) { awake.set(false); return; }
    const { store, desk } = session;
    // "Update when it finishes": the last agent is done, so the update goes in now.
    if (updateWhenIdle && updates.state.ready && !busyAgents(store).length && ![...(desk.live?.keys?.() || [])].some(id => !store.get('run', id)?.inApp)) { try { installNow(); } catch (error) { updateWhenIdle = false; store.event('', 'update-error', { message: error.message }, true); notify(); } return; }
    const minutes = store.config().syncMinutes;
    if (minutes && Date.now() - lastSync >= minutes * 60000 && !desk.sources.syncing) {
      lastSync = Date.now(); void desk.sources.sync().catch(error => store.event('', 'sync-error', { message: error.message }));
    }
    void desk.scheduleTick().catch(error => store.event('', 'schedule-error', { message: error.message }, true));
    void desk.rooms.awayTick().catch(error => store.event('', 'away-error', { message: error.message }, true));
    void desk.loopTick().catch(error => store.event('', 'loop-error', { message: error.message }, true));
    if (++ticks % 8 === 0) void desk.findPullRequests();
    if (ticks % 4 === 0) remoteOpen(); // Tailscale may start after Rex Desk
    if (ticks % 4 === 0) void desk.worktrees.scan().catch(() => {});
    // Claude account usage, as /usage shows it, every 5 minutes (and whenever the accounts window opens).
    if (ticks % 20 === 1) void desk.refreshClaudeUsage().then(notify, () => {});
    // The computer stays awake (the screen may still lock) while an agent works or other devices may connect.
    awake.set(desk.live.size > 0 || Boolean(desk.peers.settings().remote));
    if (ticks % 12 === 0) void desk.monitor.tick().catch(error => store.event('', 'monitor-error', { message: error.message }, true));
  }, 15000);
  timer.unref();
  // The installed app looks for a signed update shortly after start and every six hours.
  // A new version shows within minutes of being published: checked 30 s after start, then every 10 minutes (and when the
  // window comes back, see chat.js). The page is told at once when the answer changed, so the update card appears by itself.
  let lastUpdateKey = '';
  const checkForUpdate = () => updates.check().then(status => { const key = `${status.available?.version || ''}${status.ready}`; if (key !== lastUpdateKey) { lastUpdateKey = key; notify(); } }, () => {});
  const updateTimer = updates.state.supported ? setInterval(() => void checkForUpdate(), 10 * 60000) : null;
  const firstCheck = updates.state.supported ? setTimeout(() => void checkForUpdate(), 30000) : null;
  updateTimer?.unref(); firstCheck?.unref();
  const handle = { server, address, accounts, updates, get restartWanted() { return restartWanted; }, get store() { return session?.store; }, get desk() { return session?.desk; }, async close() {
    awake.set(false); computer.stop(); voice.stopAll(); clearInterval(timer); for (const item of remoteServers) item.close(); clearInterval(updateTimer); clearTimeout(firstCheck); await closeSession(); for (const client of clients) client.end();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); unlinkSync(lockPath);
  } };
  return handle;
}

// Starts the server that takes over from this one. On Windows it is created through WMI, so it does not live in the job of
// whoever started this server (a terminal, an agent session, the desktop app): when that closes, Windows ends every process
// in its job, and a plain detached child would die with it.
// The replacement keeps this server's port, so a checkout used as the real app (started on 4317) stays on 4317 after it updates.
async function startReplacement(port) {
  // The log goes in the data folder. The installed app has no .local folder, and cmd.exe does not start a command whose
  // log folder is missing: the replacement never started, and Rex Desk stayed down after "Move" until the window restarted it.
  const log = path.join(process.env.REX_DATA_DIR || path.join(root, '.local'), 'server-restart.log');
  try { mkdirSync(path.dirname(log), { recursive: true }); } catch {}
  if (process.platform === 'win32') {
    // WMI starts it with the user's plain environment, so the folders and the installed app's details this server was given are passed on.
    const carry = ['REX_DATA_DIR', 'REX_DESK_MEMORY', 'REX_DESK_VERSION', 'REX_DESK_EXE', 'REX_CLONE_DIR', 'REX_NO_AUTO_PULL', 'TEMP', 'TMP'].filter(name => process.env[name]).map(name => `set "${name}=${process.env[name]}"&& `).join('');
    const command = `cmd.exe /c "${carry}set REX_RESTART_AFTER=${process.pid}&& set PORT=${port}&& "${process.execPath}" src/server.js >> "${log}" 2>&1"`;
    const script = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${command.replaceAll("'", "''")}'; CurrentDirectory = '${root.replaceAll("'", "''")}' }; exit $r.ReturnValue`;
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30000 });
    return;
  }
  let out = 'ignore'; try { out = openSync(log, 'a'); } catch {}
  spawn(process.execPath, ['src/server.js'], { cwd: root, detached: true, stdio: ['ignore', out, out], env: { ...process.env, REX_RESTART_AFTER: String(process.pid), PORT: String(port) } }).unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // A background job that fails without its own catch (a room deleted mid-reply, a peer gone mid-sync) is logged, not fatal:
  // Node would otherwise end the whole server, and every agent's chat with it.
  process.on('unhandledRejection', error => console.error(`Unhandled: ${error?.stack || error}`));
  const app = await createApp({ catchUp: true });
  console.log(`Rex Desk: ${app.address}\nMCP: ${app.address}/mcp\n${app.store ? `Keys and history stay in ${app.store.directory}` : 'Locked: sign in from the dashboard.'}`);
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  // New code (a pull, or a commit from another session) is picked up without anyone restarting by hand: when HEAD moves
  // and no agent is working, a fresh server starts and this one hands over. The open page sees the new version and reloads.
  // Auto update: every 10 minutes fetch origin and fast-forward the branch, but only when the checkout is clean, the branch
  // tracks a remote and has no local commits of its own. Someone's unfinished edits or unpushed work are never touched.
  // New dependencies are installed before the restart below picks the new code up.
  const run = (command, args) => { try { return execFileSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'], shell: command === 'npm' }).trim(); } catch { return null; } };
  const pullNewCode = () => {
    if (closing || process.env.REX_NO_AUTO_PULL === '1' || (app.desk?.live?.size || 0) > 0) return;
    if (run('git', ['status', '--porcelain', '--untracked-files=no']) !== '') return;
    if (run('git', ['rev-parse', '--abbrev-ref', '@{u}']) === null || run('git', ['fetch', '--quiet']) === null) return;
    const [ahead, behind] = String(run('git', ['rev-list', '--left-right', '--count', 'HEAD...@{u}']) || '').split(/\s+/).map(Number);
    if (ahead !== 0 || !(behind > 0)) return;
    const before = readCode();
    if (run('git', ['merge', '--ff-only', '--quiet', '@{u}']) === null) return;
    const changed = run('git', ['diff', '--name-only', before, 'HEAD']) || '';
    if (/^package(-lock)?\.json$/m.test(changed)) run('npm', ['install', '--no-audit', '--no-fund']);
  };
  if (startedCode) { const pullTimer = setInterval(pullNewCode, 600000); pullTimer.unref(); setTimeout(pullNewCode, 60000).unref(); }
  // A folder move asked for in Settings: start a fresh server, which does the move before it opens anything.
  setInterval(() => {
    if (closing || !app.restartWanted) return;
    closing = true;
    void startReplacement(Number(new URL(app.address).port)).then(() => Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 10000))]).finally(() => process.exit(0)), () => { closing = false; });
  }, 1000).unref();
  if (startedCode) setInterval(() => {
    if (closing || readCode() === startedCode || readCode() === '' || (app.desk?.live?.size || 0) > 0) return;
    closing = true;
    // If the new server could not be started, this one keeps running and tries again on the next tick.
    // Closing waits at most 10s: the new server waits up to 60s for this one to let go, and gives up after that.
    void startReplacement(Number(new URL(app.address).port)).then(() => Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 10000))]).finally(() => process.exit(0)), () => { closing = false; });
  }, 20000).unref();
}
