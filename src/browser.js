import path from 'node:path';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { shellCommand, stopTree, fingerprint } from './processes.js';
import { now } from './store.js';
import { flowPreview } from './flow-runtime.js';
import { electronLaunch } from './electron-runtime.js';
import { effectiveRepository } from './project-detect.js';

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export class Evidence {
  constructor(store, getRun, emit, deskUrl = () => '') {
    Object.assign(this, { store, getRun, emit, deskUrl }); this.sessions = new Map();
    // A paused recording keeps its preview server and its page and cookies, so the next action continues where it left off.
    this.previews = new Map(); this.resumes = new Map(); this.idleTimers = new Map(); this.idleMs = 60000;
  }
  directory(runId) { const directory = path.join(this.store.directory, 'artifacts', runId); mkdirSync(directory, { recursive: true }); return directory; }
  attach(runId, file, title, type, metadata = {}) {
    const artifact = { id: randomUUID(), runId, file: path.basename(file), title, type, createdAt: now(), ...metadata };
    this.store.put('artifact', artifact.id, artifact); return artifact;
  }
  async start(runId, { url } = {}) {
    if (this.sessions.has(runId)) return this.sessions.get(runId);
    const run = this.getRun(runId);
    if (run.role === 'verifier') return this.startQa(runId, run, url);
    if (!run.worktree) throw new Error('This run has no worktree.');
    const repository = effectiveRepository(this.store.config().repositories.find(item => item.id === run.repositoryId));
    if (!repository?.devCommand && !repository?.flowRuntime && !repository?.electronRuntime) throw new Error('Set this repository’s dev command, Flow Tomcat preset, or Electron preset in Settings.');
    const directory = this.directory(runId);
    if (repository.electronRuntime) return this.startElectron(runId, run, repository, directory);
    const kept = this.previews.get(runId), resume = this.resumes.get(runId);
    let process, baseUrl;
    if (kept) ({ process, baseUrl } = kept);
    else {
      const command = String(repository.devCommand || '').replaceAll('{port}', String(run.port)).replaceAll('{worktree}', run.worktree);
      const onData = text => this.emit(runId, 'dev-output', { text });
      process = repository.flowRuntime ? flowPreview(repository, run, this.store.directory, onData)
        : shellCommand(command, { cwd: run.worktree, env: { PORT: String(run.port), REX_RUN_ID: runId }, timeout: 0, onData });
      process.done.then(result => this.emit(runId, 'dev-exit', { exitCode: result.exitCode })).catch(error => this.emit(runId, 'dev-error', { message: error.message }));
      baseUrl = `http://127.0.0.1:${run.port}`;
      let ready = false;
      const readySeconds = repository.flowRuntime ? 240 : 60;
      for (let attempt = 0; attempt < readySeconds; attempt++) {
        try { const response = await fetch(baseUrl + repository.browserPath, { signal: AbortSignal.timeout(1000), redirect: 'manual' }); if (response.status >= 200 && response.status < 400) { ready = true; break; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!ready) { stopTree(process.child); throw new Error(`Preview did not return a successful response within ${readySeconds} seconds. Check the runtime settings and journal.`); }
    }
    this.previews.delete(runId);
    const { chromium } = await import('playwright');
    let browser;
    try { browser = await chromium.launch({ headless: true }); }
    catch (error) { stopTree(process.child); throw new Error(`Browser could not start. Run "npx playwright install chromium". ${error.message}`); }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: directory, size: { width: 1440, height: 900 } }, ...(resume?.state ? { storageState: resume.state } : {}) });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    page.on('pageerror', error => this.emit(runId, 'browser-error', { message: error.message }));
    page.on('console', message => { if (message.type() === 'error') this.emit(runId, 'browser-console', { text: message.text() }); });
    const session = { browser, context, page, process, baseUrl, assertions: [], actions: 0 };
    this.sessions.set(runId, session); this.resumes.delete(runId);
    await page.goto(resume?.url && resume.url.startsWith(baseUrl) ? resume.url : baseUrl + repository.browserPath, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return session;
  }
  qaSessionFile() { return path.join(this.store.directory, 'qa-session.json'); }
  // Rex Desk's own dashboard answers approvals, so a recorded browser never loads it.
  isDesk(address) {
    try {
      const own = new URL(this.deskUrl()), target = new URL(address), port = url => url.port || (url.protocol === 'https:' ? '443' : '80');
      return port(target) === port(own) && (['localhost', '[::1]', '0.0.0.0'].includes(target.hostname) || target.hostname.startsWith('127.'));
    } catch { return false; }
  }
  // The QA agent chooses the test site for each issue: wherever the project runs with the developer's fix.
  qaSite(address) {
    let url;
    try { url = new URL(String(address || '')); } catch { throw new Error('Choose the test site: call open with url set to the address where this project runs for this issue, for example its dev or QA server.'); }
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('The test site must be an http(s) address.');
    if (this.isDesk(url.href)) throw new Error('Rex Desk itself cannot be the test site.');
    return url;
  }
  // QA checks browse the site the agent chose, signed in with the session the person saved from their own sign-in.
  async startQa(runId, run, address) {
    const resume = this.resumes.get(runId); this.resumes.delete(runId);
    const site = this.qaSite(address || resume?.url || run.qaUrl);
    const directory = this.directory(runId), { chromium } = await import('playwright');
    let browser;
    try { browser = await chromium.launch({ headless: true }); }
    catch (error) { throw new Error(`Browser could not start. Run "npx playwright install chromium". ${error.message}`); }
    const state = this.qaSessionFile();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: directory, size: { width: 1440, height: 900 } }, ...(resume?.state ? { storageState: resume.state } : existsSync(state) ? { storageState: state } : {}) });
    await context.route(url => this.isDesk(url.href), route => route.abort('blockedbyclient'));
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    page.on('pageerror', error => this.emit(runId, 'browser-error', { message: error.message }));
    page.on('console', message => { if (message.type() === 'error') this.emit(runId, 'browser-console', { text: message.text() }); });
    const session = { browser, context, page, baseUrl: site.origin, qa: true, assertions: [], actions: 0 };
    this.sessions.set(runId, session);
    await this.openQaSite(runId, session, site);
    return session;
  }
  // Playwright routes miss redirects, so after every navigation a page that reached Rex Desk is sent away.
  async leaveDesk(page) {
    if (!this.isDesk(page.url())) return;
    await page.goto('about:blank').catch(() => {});
    throw new Error('Rex Desk itself cannot be the test site.');
  }
  async openQaSite(runId, session, site) {
    session.baseUrl = site.origin;
    this.emit(runId, 'qa-site', { url: site.href });
    await session.page.goto(site.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.leaveDesk(session.page);
  }
  // A visible browser where the person signs in to the test site; its cookies are saved every few seconds and when the window closes.
  // Without an address the window opens blank, and the person goes to each site they want QA checks to use.
  async openQaSignIn(address) {
    const site = address ? this.qaSite(address) : null;
    if (this.qaLogin) { if (site) await this.qaLogin.page.goto(site.href, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); await this.qaLogin.page.bringToFront().catch(() => {}); return this.qaStatus(); }
    const { chromium } = await import('playwright'), file = this.qaSessionFile();
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: null, ...(existsSync(file) ? { storageState: file } : {}) });
    const page = await context.newPage();
    const save = () => context.storageState({ path: file }).catch(() => {});
    const timer = setInterval(save, 3000);
    this.qaLogin = { browser, page };
    browser.on('disconnected', () => { clearInterval(timer); this.qaLogin = null; });
    page.on('close', async () => { clearInterval(timer); await save(); await browser.close().catch(() => {}); });
    if (site) await page.goto(site.href, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    return this.qaStatus();
  }
  qaStatus() { const file = this.qaSessionFile(); return { open: Boolean(this.qaLogin), savedAt: existsSync(file) ? statSync(file).mtime.toISOString() : '' }; }
  async proofPrint(runId) { const run = this.getRun(runId); return run.worktree ? fingerprint(run.worktree) : 'qa'; }
  // Desktop runs record the app's own window; its profile, logs, updater, and protocol handlers stay isolated per run.
  async startElectron(runId, run, repository, directory) {
    const { _electron } = await import('playwright');
    const { home, options } = electronLaunch(repository, run, this.store.directory, directory);
    this.emit(runId, 'electron-start', { home, executable: options.executablePath, note: 'Separate user data, logs, and session; updater, auto-launch, and protocol registration disabled.' });
    const app = await _electron.launch(options);
    const page = await app.firstWindow({ timeout: 90000 });
    const context = app.context();
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    page.on('pageerror', error => this.emit(runId, 'browser-error', { message: error.message }));
    page.on('console', message => { if (message.type() === 'error') this.emit(runId, 'browser-console', { text: message.text() }); });
    await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
    const session = { electron: app, context, page, baseUrl: new URL(page.url()).origin, assertions: [], actions: 0 };
    this.sessions.set(runId, session);
    return session;
  }
  async action(runId, { action, selector, value, url, expected }) {
    if (action === 'close') return this.close(runId);
    const opening = !this.sessions.has(runId), session = await this.start(runId, { url: action === 'open' ? url : undefined });
    const { page } = session;
    this.emit(runId, 'browser-action', { action, selector, url, value: action === 'fill' ? '[input hidden from journal]' : value });
    switch (action) {
      // A QA run may move to another site it chose, for example a second region; the recording continues.
      case 'open': if (session.qa && url && !opening) await this.openQaSite(runId, session, this.qaSite(url)); break;
      case 'navigate': {
        const target = new URL(url || '/', session.electron ? page.url() : session.baseUrl);
        if (target.origin !== (session.electron ? new URL(page.url()).origin : session.baseUrl)) throw new Error(session.qa ? 'Recorded browser navigation must stay on the test site origin. Use open with url to switch to another site.' : 'Recorded browser navigation must stay on this run’s preview origin.');
        await page.goto(target.href, { waitUntil: 'domcontentloaded' }); break;
      }
      case 'click': await page.locator(selector).click({ timeout: 15000 }); break;
      case 'fill': {
        const local = /^https?:\/\/(127\.|localhost|\[::1\])/.test(page.url()), saved = this.store.config().testAccount || {};
        const account = { username: (local && saved.localUsername) || saved.username }, password = (local && saved.localUsername && this.store.testPassword('local')) || this.store.testPassword(), typed = String(value || '');
        if (typed.includes('{{test.password}}')) {
          if (!password) throw new Error('No test account password is saved in Settings → QA verification. Ask the human with desk_ask.');
          if (await page.locator(selector).getAttribute('type') !== 'password') throw new Error('{{test.password}} can only be typed into a password field.');
        }
        if (typed.includes('{{test.username}}') && !account.username) throw new Error('No test account is saved in Settings → QA verification. Ask the human with desk_ask.');
        await page.locator(selector).fill(typed.replaceAll('{{test.username}}', account.username || '').replaceAll('{{test.password}}', password)); break;
      }
      case 'press': await page.locator(selector).press(value); break;
      case 'select': await page.locator(selector).selectOption(value); break;
      case 'check': await page.locator(selector).setChecked(value !== 'false'); break;
      case 'assertText': {
        const actual = await page.locator(selector || 'body').innerText();
        if (!actual.includes(expected)) throw new Error(`Text assertion failed: expected ${JSON.stringify(expected)}.`);
        session.assertions.push({ action, selector, expected, at: now(), fingerprint: await this.proofPrint(runId) }); break;
      }
      case 'assertVisible': {
        if (!await page.locator(selector).isVisible()) throw new Error(`Visibility assertion failed: ${selector}.`);
        session.assertions.push({ action, selector, at: now(), fingerprint: await this.proofPrint(runId) }); break;
      }
      case 'screenshot': {
        const file = path.join(this.directory(runId), `screen-${Date.now()}.png`);
        await page.screenshot({ path: file, fullPage: true });
        this.attach(runId, file, value || 'Browser screenshot', 'image/png'); break;
      }
      default: throw new Error(`Unknown browser action: ${action}`);
    }
    if (session.qa) await this.leaveDesk(page);
    session.actions++;
    if (!session.electron) this.armIdle(runId);
    const controls = await page.locator('button,input,textarea,select,a,[role="button"]').evaluateAll(nodes => nodes.slice(0, 100).map(node =>
      ({ tag: node.tagName.toLowerCase(), id: node.id, name: node.getAttribute('name'), label: node.getAttribute('aria-label') || node.textContent?.trim().slice(0, 100), type: node.getAttribute('type') })));
    // The saved password never travels back to the agent, even if a page echoes it.
    const secrets = [this.store.testPassword(), this.store.testPassword('local')].filter(Boolean);
    const hide = text => secrets.reduce((value, secret) => value.replaceAll(secret, '[test password]').replaceAll(encodeURIComponent(secret), '[test password]'), String(text));
    return { url: hide(page.url()), title: hide(await page.title()), text: hide((await page.locator('body').innerText()).slice(0, 14000)), controls };
  }
  // After a quiet minute, save the clip and close the browser; the next action reopens the same page in a new clip.
  armIdle(runId) {
    clearTimeout(this.idleTimers.get(runId));
    this.idleTimers.set(runId, setTimeout(() => {
      const session = this.sessions.get(runId);
      if (session && !session.electron) void this.close(runId, { pause: true }).then(() => this.emit(runId, 'browser-paused', { note: 'No browser action for a minute: the clip was saved. The next action continues on the same page.' })).catch(() => {});
    }, this.idleMs).unref());
  }
  stopPreview(runId) { const kept = this.previews.get(runId); if (kept) { stopTree(kept.process.child); this.previews.delete(runId); } }
  async close(runId, { pause = false } = {}) {
    clearTimeout(this.idleTimers.get(runId)); this.idleTimers.delete(runId);
    const session = this.sessions.get(runId);
    if (!session) { if (!pause) { this.stopPreview(runId); this.resumes.delete(runId); } return { closed: true }; }
    this.sessions.delete(runId);
    if (pause) { try { this.resumes.set(runId, { state: await session.context.storageState(), url: session.page.url() }); } catch {} }
    const directory = this.directory(runId);
    const traceFile = path.join(directory, `trace-${Date.now()}.zip`);
    const video = session.page.video();
    try {
      await session.context.tracing.stop({ path: traceFile });
      if (session.electron) { await session.electron.close().catch(() => {}); session.electron = { close: async () => {} }; }
      else await session.context.close();
      if (video) this.attach(runId, await video.path(), 'Recorded browser test', 'video/webm', { assertions: session.assertions, actions: session.actions });
      this.attach(runId, traceFile, 'Playwright trace', 'application/zip');
    } finally {
      if (session.electron) await session.electron.close().catch(() => {});
      else { await session.browser.close(); if (session.process) { if (pause) this.previews.set(runId, { process: session.process, baseUrl: session.baseUrl }); else stopTree(session.process.child); } }
    }
    if (!pause) { this.stopPreview(runId); this.resumes.delete(runId); }
    return { closed: true, assertions: session.assertions.length };
  }
  report(runId, { summary, checks, risk, qa }) {
    const run = this.getRun(runId);
    const artifacts = this.store.list('artifact').filter(item => item.runId === runId);
    const events = this.store.events(runId, { limit: 200 });
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(run.title)} — verification</title>
      <style>body{font:16px/1.6 system-ui;max-width:960px;margin:48px auto;padding:0 24px;color:#183039}h1{line-height:1.2}pre{white-space:pre-wrap;background:#f1f5f5;padding:16px;overflow:auto}video,img{max-width:100%}a{color:#145b7c}small{color:#50646c}</style>
      <h1>${escape(run.title)}</h1><p>${escape(summary)}</p><small>${escape(run.branch || '')} · ${escape(now())}</small>
      <h2>Verification</h2><pre>${escape(JSON.stringify(checks, null, 2))}</pre>
      ${qa ? `<h2>QA result: ${escape(qa.verdict)}</h2><p>Test site: ${escape(run.qaUrl || '')}</p><h3>Tracker comment</h3><pre>${escape(qa.comment || '')}</pre><pre>${escape(JSON.stringify(qa.steps || [], null, 2))}</pre>` : ''}${risk ? `<h2>Estimated code risk</h2><p>${escape(risk.score ?? 'Unassessed')}/10 · ${escape(risk.level || '')} · ${risk.requiresHumanReview ? 'Human review required' : 'Low-risk draft PR eligible'}</p><p>${escape(risk.reason || '')}</p><pre>${escape(JSON.stringify(risk, null, 2))}</pre>` : ''}
      <h2>Evidence</h2>${artifacts.map(item => item.type === 'video/webm'
        ? `<h3>${escape(item.title)}</h3><video controls src="${encodeURIComponent(item.file)}"></video>`
        : `<p><a href="${encodeURIComponent(item.file)}">${escape(item.title)}</a></p>`).join('')}
      <h2>Work journal</h2>${events.filter(event => !['command-output', 'dev-output', 'agent-operation'].includes(event.kind)).map(event => `<pre>${escape(JSON.stringify(event, null, 2))}</pre>`).join('')}</html>`;
    const file = path.join(this.directory(runId), `report-${Date.now()}.html`);
    writeFileSync(file, html);
    return this.attach(runId, file, 'Verification report', 'text/html');
  }
  async stopAll() { await this.qaLogin?.browser.close().catch(() => {}); await Promise.allSettled([...this.sessions.keys()].map(runId => this.close(runId))); for (const runId of [...this.previews.keys()]) this.stopPreview(runId); }
}
