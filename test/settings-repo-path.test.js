import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';

// Settings, Projects: the folder box keeps what was typed when the page redraws by itself (GitHub accounts answering, or a
// GitHub sign-in being waited on every 2 s), and is empty again after a successful Add.
test('the project folder box keeps what was typed through redraws and empties after Add', async () => {
  const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-st-repo-'));
  const folder = path.join(dir, 'my-app'); mkdirSync(folder);
  const app = await createApp({ dataDirectory: path.join(dir, 'data'), port: 0, requireAccount: false, runnerFactory: () => ({ async start() {}, async interrupt() {}, close() {} }) });
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 } })).newPage();
    // GitHub answers only when the test says so; after that it reports a sign-in being waited on, so Settings asks every 2 s.
    let release; const held = new Promise(resolve => { release = resolve; });
    let githubCalls = 0;
    await page.route('**/api/github', async route => {
      githubCalls++;
      if (githubCalls === 1) await held;
      await route.fulfill({ json: { installed: true, accounts: [], login: { state: 'waiting', code: 'ABCD-1234', url: 'https://github.com/login/device' } } });
    });
    await page.goto(`http://127.0.0.1:${app.server.address().port}/`); await page.locator('.pf-trigger').waitFor({ timeout: 60000 });
    await page.addStyleTag({ content: ':has(>.tour-card){display:none!important}' });
    await page.evaluate(() => { document.querySelector('[data-action="profile-toggle"]')?.click(); document.querySelector('[data-action="settings-open"]')?.click(); });
    await page.locator('.settings-pop').waitFor({ timeout: 30000 });
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => document.querySelector('.settings-pop [data-st-section="projects"]')?.click());
      try { await page.locator('.settings-pop [data-st-section="projects"].on').waitFor({ timeout: 10000 }); break; } catch { /* clicked during a redraw */ }
    }
    const box = page.locator('.settings-pop [data-st-repo-path]');
    await box.click(); await page.keyboard.type(folder);
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
    const redraws = () => page.evaluate(() => window.__redraws || 0);
    await page.evaluate(() => { const pop = document.querySelector('.settings-pop').parentElement; new MutationObserver(() => { window.__redraws = (window.__redraws || 0) + 1; }).observe(pop, { childList: true }); });
    release();
    await page.waitForFunction(() => window.__redraws > 0, null, { timeout: 15000 });
    assert.equal(await box.inputValue(), folder, 'GitHub answering after typing keeps the folder');
    assert.equal(await box.evaluate(input => document.activeElement === input), true, 'the box keeps focus');
    assert.deepEqual(await box.evaluate(input => [input.selectionStart, input.selectionEnd]), [folder.length - 2, folder.length - 2], 'the cursor stays where it was');
    // A sign-in being waited on redraws every 2 s: typing more in between is kept too.
    await page.keyboard.press('End'); await page.keyboard.type('X');
    const before = await redraws();
    await page.waitForFunction(count => window.__redraws > count, before, { timeout: 10000 });
    assert.equal(await box.inputValue(), `${folder}X`, 'the 2 s sign-in wait keeps the folder');
    await page.keyboard.press('Backspace');
    // Add uses the kept text, and the box is empty after it, through the next redraws as well.
    await page.locator('.settings-pop [data-st-repo-add]').click();
    await page.locator('.settings-pop .st-repo summary', { hasText: 'my-app' }).waitFor({ timeout: 30000 });
    assert.equal(app.store.config().repositories.length, 1);
    assert.equal(await box.inputValue(), '', 'empty after a successful Add');
    const after = await redraws();
    await page.waitForFunction(count => window.__redraws > count, after, { timeout: 10000 });
    assert.equal(await box.inputValue(), '', 'the old path does not come back');
  } finally { await browser.close(); await app.close?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ } }
});
