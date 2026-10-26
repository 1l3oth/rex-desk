import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, createReadStream, statSync } from 'node:fs';
import { Store } from './store.js';
import { Desk } from './coordinator.js';
import { handleMcp } from './mcp.js';
import { git, resolveCommand } from './processes.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectRepository, pickRepositoryFolder, cloneRepository, discoverRepositories } from './repositories.js';
import { githubAccounts, startGithubLogin, cancelGithubLogin, switchGithubAccount } from './github.js';
import { autostartStatus, setAutostart } from './autostart.js';
import { issueBranch } from './branches.js';
import { profileEnvironment } from './agents.js';
import { setupPrompt } from './setup-prompt.js';
import { cachedTaskImage, cachedTaskMedia } from './images.js';
import { orcaStatus, showWorktreesInOrca, openInOrca, readOrcaTerminal } from './orca.js';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml' };
const json = (response, code, data) => { response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); };
async function body(request) {
  let input = '';
  for await (const chunk of request) { input += chunk; if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new Error('Request exceeds 2 MB.'); }
  try { return input ? JSON.parse(input) : {}; } catch { throw new Error('Request body must be JSON.'); }
}
function serveFile(request, response, file, { sandbox = false, download = false, cache = 'no-store' } = {}) {
  const stat = statSync(file), type = mime[path.extname(file)] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': cache, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
  if (sandbox) headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self';";
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

export async function createApp({ dataDirectory = process.env.REX_DATA_DIR || path.join(root, '.local'), port = Number(process.env.PORT || 4317), runnerFactory, fetcher, agentCommand, imageFetcher = fetch, jevFetcher, namingFetcher } = {}) {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dataDirectory, 'runtime.lock');
  if (existsSync(lockPath)) {
    const owner = Number(readFileSync(lockPath, 'utf8'));
    let alive = false;
    if (Number.isInteger(owner) && owner > 0) { try { process.kill(owner, 0); alive = true; } catch {} }
    if (alive) throw new Error('Rex Desk is already running with this data folder. Open its existing dashboard.');
    unlinkSync(lockPath);
  }
  writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
  const store = new Store(dataDirectory), desk = new Desk(store, { root, runnerFactory, fetcher, agentCommand, jevFetcher, namingFetcher, imageFetcher });
  const clients = new Set();
  const notify = () => { for (const client of clients) client.write('event: change\ndata: {}\n\n'); };
  store.on('change', notify);
  void store.cloud.open();
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const host = request.headers.host;
      const hostname = host ? new URL(`http://${host}`).hostname : '';
      const localHost = ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
      const publicMcp = process.env.REX_PUBLIC_MCP_HOST && hostname === process.env.REX_PUBLIC_MCP_HOST && request.url?.split('?')[0] === '/mcp';
      if (!localHost && !publicMcp) return json(response, 403, { error: 'Use the local dashboard address.' });
      const url = new URL(request.url, `http://${host}`);
      if (url.pathname === '/mcp') {
        const token = request.headers.authorization?.replace(/^Bearer /i, '');
        const scope = desk.scope(token);
        if (!scope) return json(response, 401, { error: 'Supply the Rex Desk bearer token.' });
        if (!['POST', 'GET', 'DELETE'].includes(request.method)) return json(response, 405, { error: 'Use Streamable HTTP.' });
        await handleMcp(desk, scope, request, response, request.method === 'POST' ? await body(request) : undefined); return;
      }
      const origin = request.headers.origin;
      if (origin && origin !== `http://${host}`) return json(response, 403, { error: 'Cross-origin dashboard requests are blocked.' });
      if (request.method !== 'GET' && request.headers['x-rex-desk'] !== '1') return json(response, 403, { error: 'Missing dashboard request header.' });
      if (url.pathname === '/api/events' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        response.write('event: connected\ndata: {}\n\n'); clients.add(response);
        const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 25000);
        request.on('close', () => { clients.delete(response); clearInterval(heartbeat); }); return;
      }
      if (url.pathname === '/api/state') return json(response, 200, desk.snapshot());
      if (url.pathname === '/api/database/connect' && request.method === 'POST') return json(response, 200, await store.cloud.connect(await body(request)));
      if (url.pathname === '/api/database/sync' && request.method === 'POST') { await store.cloud.retry(); return json(response, 200, { ...await store.cloud.verify(), status: store.cloud.status() }); }
      if (url.pathname === '/api/repositories/inspect' && request.method === 'POST') return json(response, 200, await inspectRepository((await body(request)).path));
      if (url.pathname === '/api/repositories/pick' && request.method === 'POST') return json(response, 200, await pickRepositoryFolder());
      // Checkouts beside the ones already configured, and beside Rex Desk itself, so other projects are one click away.
      if (url.pathname === '/api/repositories/discover' && request.method === 'GET') {
        const configured = store.config().repositories.map(item => item.path).filter(Boolean);
        return json(response, 200, { repositories: discoverRepositories([...configured.map(item => path.dirname(item)), path.dirname(root)], configured) });
      }
      if (url.pathname === '/api/qa/sign-in' && request.method === 'POST') return json(response, 200, await desk.evidence.openQaSignIn((await body(request)).url));
      if (url.pathname === '/api/schedule/run' && request.method === 'POST') return json(response, 200, await desk.runSchedule());
      if (url.pathname === '/api/autostart' && request.method === 'GET') return json(response, 200, autostartStatus());
      if (url.pathname === '/api/autostart' && request.method === 'POST') return json(response, 200, await setAutostart(Boolean((await body(request)).enabled), root));
      if (url.pathname === '/api/github' && request.method === 'GET') return json(response, 200, await githubAccounts());
      if (url.pathname === '/api/github/login' && request.method === 'POST') return json(response, 200, await startGithubLogin());
      if (url.pathname === '/api/github/login' && request.method === 'DELETE') return json(response, 200, cancelGithubLogin());
      if (url.pathname === '/api/github/switch' && request.method === 'POST') return json(response, 200, await switchGithubAccount((await body(request)).user));
      if (url.pathname === '/api/repositories/clone' && request.method === 'POST') return json(response, 200, await cloneRepository((await body(request)).repository, path.dirname(root)));
      if (url.pathname === '/api/repositories/branch-preview' && request.method === 'POST') {
        const input = await body(request);
        return json(response, 200, { branch: issueBranch(input.pattern, { prefix: input.prefix || 'temp/rex' }) });
      }
      if (url.pathname === '/api/config' && request.method === 'PUT') { const saved = store.saveConfig(await body(request)); desk.agents.invalidate(); return json(response, 200, saved); }
      if (url.pathname === '/api/agents' && request.method === 'GET') return json(response, 200, await desk.agents.overview({ refresh: url.searchParams.has('refresh') }));
      if (url.pathname === '/api/agents/profile' && request.method === 'POST') {
        const input = await body(request);
        if (!['claude', 'codex'].includes(input.provider)) throw new Error('Choose Claude Code or Codex.');
        const config = store.publicConfig();
        store.saveConfig({ ...config, agentProfiles: { ...config.agentProfiles, [input.provider]: input.profile ?? null } });
        desk.agents.invalidate(input.provider);
        return json(response, 200, await desk.agents.overview());
      }
      if (url.pathname === '/api/agents/mcp' && request.method === 'POST') {
        const { provider } = await body(request);
        if (!['claude', 'codex'].includes(provider)) throw new Error('Choose Claude Code or Codex.');
        if (desk.agents.mcpInstalled(provider)) return json(response, 200, { installed: true, already: true });
        const command = resolveCommand(provider), proxy = path.join(root, 'src', 'stdio.js');
        const args = provider === 'claude' ? [...command.args, 'mcp', 'add', '--scope', 'user', 'rex_desk', '--', process.execPath, proxy]
          : [...command.args, 'mcp', 'add', 'rex_desk', '--', process.execPath, proxy];
        // Profile environment decides which signed-in CLI configuration receives the local stdio entry.
        await exec(command.command, args, { env: profileEnvironment(provider, desk.agents.selected(provider)), windowsHide: true, timeout: 30000 });
        return json(response, 200, { installed: desk.agents.mcpInstalled(provider) });
      }
      if (url.pathname === '/api/orca' && ['GET', 'POST'].includes(request.method)) {
        const repository = store.config().repositories.find(item => item.id === url.searchParams.get('repositoryId'));
        if (url.searchParams.get('repositoryId') && !repository) return json(response, 404, { error: 'Repository not found.' });
        if (request.method === 'POST') { if (!repository) throw new Error('Choose a repository.'); await showWorktreesInOrca(repository.path); }
        return json(response, 200, await orcaStatus(repository?.path));
      }
      if (url.pathname === '/api/setup-prompt' && request.method === 'POST') {
        const input = await body(request);
        return json(response, 200, { prompt: setupPrompt({ target: input.target, root, dataDirectory: store.directory, mcpUrl: desk.mcpUrl, profiles: { claude: desk.agents.selected('claude'), codex: desk.agents.selected('codex') } }) });
      }
      if (url.pathname === '/api/sources/connect' && request.method === 'POST') {
        const source = store.saveConnection(await body(request));
        return json(response, 200, { source, directory: await desk.sources.directory(source.id) });
      }
      if (url.pathname === '/api/sources/setup-agent' && request.method === 'POST') {
        const input = await body(request), source = store.saveConnection(input.source);
        return json(response, 200, { source, run: await desk.startConnectionAgent({ sourceId: source.id, provider: input.provider }) });
      }
      if (url.pathname === '/api/sync' && request.method === 'POST') return json(response, 200, await desk.sources.sync());
      if (url.pathname === '/api/jev/prioritize' && request.method === 'POST') return json(response, 200, await (async () => { const input = await body(request); return desk.jev.prioritize({ force: Boolean(input.force), taskId: String(input.taskId || '') }); })());
      if (url.pathname === '/api/runs' && request.method === 'POST') return json(response, 200, await desk.startTask(await body(request)));
      if (url.pathname === '/api/demo' && request.method === 'POST') return json(response, 200, desk.demo());
      if (url.pathname === '/api/demo' && request.method === 'DELETE') { for (const task of store.list('task')) if (task.demo) store.delete('task', task.id); return json(response, 200, { removed: true }); }
      if (url.pathname === '/api/mcp-config' && request.method === 'POST') {
        return json(response, 200, { url: desk.mcpUrl, token: store.token,
          codex: `[mcp_servers.rex_desk]\nurl = "${desk.mcpUrl}"\nbearer_token_env_var = "REX_DESK_TOKEN"\ntool_timeout_sec = 86400`,
          claude: { mcpServers: { rex_desk: { type: 'http', url: desk.mcpUrl, headers: { Authorization: 'Bearer ${REX_DESK_TOKEN}' } } } } });
      }
      if (url.pathname === '/api/diagnostics') {
        const results = await Promise.all(['claude', 'codex', 'git', 'gh'].map(async name => {
          const command = resolveCommand(name);
          try { const { stdout } = await exec(command.command, [...command.args, '--version'], { windowsHide: true, timeout: 10000 }); return { name, available: true, version: stdout.split('\n')[0] }; }
          catch (error) { return { name, available: false, error: error.message }; }
        })); return json(response, 200, { node: process.version, tools: results });
      }
      const branchMatch = url.pathname.match(/^\/api\/repositories\/([^/]+)\/branches$/);
      if (branchMatch) {
        const repository = store.config().repositories.find(item => item.id === decodeURIComponent(branchMatch[1]));
        if (!repository) return json(response, 404, { error: 'Repository not found.' });
        const branches = (await git(repository.path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'])).split('\n').filter(Boolean);
        return json(response, 200, { branches });
      }
      const interactionMatch = url.pathname.match(/^\/api\/interactions\/([^/]+)\/answer$/);
      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch && request.method === 'GET') return json(response, 200, await desk.sources.taskDetail(decodeURIComponent(taskMatch[1]), { refresh: url.searchParams.has('refresh') }));
      if (url.pathname === '/api/task-file' && request.method === 'GET') {
        const media = await cachedTaskMedia(store, url.searchParams.get('task') || '', url.searchParams.get('url') || '', { fetcher: imageFetcher });
        return serveFile(request, response, media, { cache: 'private, max-age=604800' });
      }
      if (url.pathname === '/api/task-image' && request.method === 'GET') {
        const image = await cachedTaskImage(store, url.searchParams.get('task') || '', url.searchParams.get('url') || '', { fetcher: imageFetcher });
        return serveFile(request, response, image, { cache: 'private, max-age=604800' });
      }
      if (interactionMatch && request.method === 'POST') return json(response, 200, desk.answer(interactionMatch[1], await body(request)));
      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/(messages|journal|stop|resume|verify|publish|orca|tracker|terminal|say))?$/);
      if (runMatch) {
        const [, runId, action] = runMatch;
        if (request.method === 'GET') {
          if (action === 'messages' || action === 'journal') return json(response, 200, store.events(runId, { visible: action === 'messages' }));
          if (action === 'terminal') return json(response, 200, await readOrcaTerminal(desk.run(runId)));
          return json(response, 200, desk.run(runId));
        }
        if (request.method === 'POST') {
          const input = await body(request);
          if (action === 'stop') return json(response, 200, await desk.stop(runId));
          if (action === 'say') return json(response, 200, await desk.say(runId, input.text));
          if (action === 'resume') return json(response, 200, await desk.resume(runId, input));
          if (action === 'verify') return json(response, 200, await desk.verify(runId));
          if (action === 'tracker') return json(response, 200, await desk.trackerFromQa(runId, input.phase));
          if (action === 'publish') return json(response, 200, await desk.publish(runId, { ...input, approved: true }));
          if (action === 'orca') { const run = desk.run(runId); if (!run.worktree) throw new Error('This run has no worktree to open.'); return json(response, 200, await openInOrca(run)); }
        }
      }
      const artifactMatch = url.pathname.match(/^\/artifacts\/([a-f0-9-]+)\/([^/]+)$/);
      if (artifactMatch) {
        const [, runId, encodedFile] = artifactMatch, file = decodeURIComponent(encodedFile);
        const artifact = store.list('artifact').find(item => item.runId === runId && item.file === file);
        if (!artifact) return json(response, 404, { error: 'Artifact not found.' });
        const location = path.join(store.directory, 'artifacts', runId, path.basename(file));
        return serveFile(request, response, location, { sandbox: artifact.type === 'text/html', download: url.searchParams.has('download') });
      }
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: 'API route not found.' });
      const publicFiles = { '/': 'index.html', '/app.js': 'app.js', '/theme.js': 'theme.js', '/style.css': 'style.css', '/icons.svg': 'icons.svg' };
      const file = publicFiles[url.pathname];
      if (!file || !existsSync(path.join(root, 'public', file))) return json(response, 404, { error: 'Page not found.' });
      return serveFile(request, response, path.join(root, 'public', file));
    } catch (error) { if (!response.headersSent) json(response, 400, { error: error.message }); else response.end(); }
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { store.close(); unlinkSync(lockPath); throw error; }
  const address = `http://127.0.0.1:${server.address().port}`;
  desk.mcpUrl = `${address}/mcp`;
  desk.reattachOrca();
  let lastSync = Date.now(), ticks = 0;
  void desk.findPullRequests();
  const timer = setInterval(() => {
    const minutes = store.config().syncMinutes;
    if (minutes && Date.now() - lastSync >= minutes * 60000 && !desk.sources.syncing) {
      lastSync = Date.now(); void desk.sources.sync().catch(error => store.event('', 'sync-error', { message: error.message }));
    }
    void desk.scheduleTick().catch(error => store.event('', 'schedule-error', { message: error.message }, true));
    if (++ticks % 8 === 0) void desk.findPullRequests();
  }, 15000);
  timer.unref();
  return { server, store, desk, address, async close() {
    clearInterval(timer); await desk.shutdown(); for (const client of clients) client.end();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await store.cloud.close(); store.close(); unlinkSync(lockPath);
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = await createApp();
  console.log(`Rex Desk: ${app.address}\nMCP: ${app.address}/mcp\nKeys and history stay in ${app.store.directory}`);
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
