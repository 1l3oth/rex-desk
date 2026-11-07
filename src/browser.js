import path from 'node:path';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { shellCommand, stopTree, fingerprint } from './processes.js';
import { now } from './store.js';
import { flowPreview } from './flow-runtime.js';
import { electronLaunch } from './electron-runtime.js';
import { effectiveRepository } from './project-detect.js';
import { siteEnvironment, releasedToProduction, testSites, accountForSite } from './sites.js';

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
  async proofPrint(runId) { const run = this.getRun(runId); return run.worktree ? fingerprint(run.worktree) : ''; }
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
      // open starts the run own preview and lands on it; there is nothing left to do here.
      case 'open': break;
      case 'navigate': {
        const target = new URL(url || '/', session.electron ? page.url() : session.baseUrl);
        if (target.origin !== (session.electron ? new URL(page.url()).origin : session.baseUrl)) throw new Error('Recorded browser navigation must stay on this run’s preview origin.');
        await page.goto(target.href, { waitUntil: 'domcontentloaded' }); break;
      }
      case 'click': await page.locator(selector).click({ timeout: 15000 }); break;
      case 'fill': {
        const accounts = this.store.testAccounts(), account = accountForSite(accounts, page.url()), typed = String(value || '');
        // A saved sign-in belongs to one test server. Typing it into the live service signs real customers' site in with
        // it, and it fails there anyway, so Rex Desk refuses instead of sending those credentials to production.
        const site = siteEnvironment(page.url());
        const placeholder = /\{\{test\.(username|password)\}\}/.test(typed);
        if (site.environment === 'production' && placeholder)
          throw new Error(`Rex Desk does not type a saved test sign-in into ${site.host}, the live ${site.product} service: those accounts belong to the test servers. Open the server where this fix runs (${testSites(site.product).join(', ')}), or ask the human with desk_ask to sign in to ${site.host} themselves from Settings → QA verification.`);
        if (placeholder && !account)
          throw new Error(`No sign-in is saved for ${site.host || 'this site'} in Settings → QA verification${accounts.length ? `; sign-ins are saved for ${accounts.map(item => item.site || 'any site').join(', ')}` : ''}. Ask the human with desk_ask.`);
        if (typed.includes('{{test.password}}')) {
          if (!account.password) throw new Error(`The sign-in saved for ${account.site || 'any site'} has no password in Settings → QA verification. Ask the human with desk_ask.`);
          if (await page.locator(selector).getAttribute('type') !== 'password') throw new Error('{{test.password}} can only be typed into a password field.');
        }
        await page.locator(selector).fill(typed.replaceAll('{{test.username}}', account?.username || '').replaceAll('{{test.password}}', account?.password || '')); break;
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
    session.actions++;
    if (!session.electron) this.armIdle(runId);
    const controls = await page.locator('button,input,textarea,select,a,[role="button"]').evaluateAll(nodes => nodes.slice(0, 100).map(node =>
      ({ tag: node.tagName.toLowerCase(), id: node.id, name: node.getAttribute('name'), label: node.getAttribute('aria-label') || node.textContent?.trim().slice(0, 100), type: node.getAttribute('type') })));
    // The saved password never travels back to the agent, even if a page echoes it.
    const secrets = this.store.testAccounts().map(account => account.password).filter(Boolean);
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
  report(runId, { summary, checks, risk }) {
    const run = this.getRun(runId);
    const artifacts = this.store.list('artifact').filter(item => item.runId === runId);
    const events = this.store.events(runId, { limit: 200 });
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(run.title)} — verification</title>
      <style>body{font:16px/1.6 system-ui;max-width:960px;margin:48px auto;padding:0 24px;color:#183039}h1{line-height:1.2}pre{white-space:pre-wrap;background:#f1f5f5;padding:16px;overflow:auto}video,img{max-width:100%}a{color:#145b7c}small{color:#50646c}</style>
      <h1>${escape(run.title)}</h1><p>${escape(summary)}</p><small>${escape(run.branch || '')} · ${escape(now())}</small>
      <h2>Verification</h2><pre>${escape(JSON.stringify(checks, null, 2))}</pre>
      <h2>Evidence</h2>${artifacts.map(item => item.type === 'video/webm'
        ? `<h3>${escape(item.title)}</h3><video controls src="${encodeURIComponent(item.file)}"></video>`
        : `<p><a href="${encodeURIComponent(item.file)}">${escape(item.title)}</a></p>`).join('')}
      <h2>Work journal</h2>${events.filter(event => !['command-output', 'dev-output', 'agent-operation'].includes(event.kind)).map(event => `<pre>${escape(JSON.stringify(event, null, 2))}</pre>`).join('')}</html>`;
    const file = path.join(this.directory(runId), `report-${Date.now()}.html`);
    writeFileSync(file, html);
    return this.attach(runId, file, 'Verification report', 'text/html');
  }
  async stopAll() { await Promise.allSettled([...this.sessions.keys()].map(runId => this.close(runId))); for (const runId of [...this.previews.keys()]) this.stopPreview(runId); }
}
