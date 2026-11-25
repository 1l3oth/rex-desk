import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';

// L111: the AI picked under the message box belongs to that chat. Picking Gemini in chat A once showed Gemini in every
// other chat until a reload, and chat B's next message went out on Gemini. Sends are caught in the browser, so no AI runs.
const runnerFactory = () => ({ async start() {}, async interrupt() {}, close() {} });

for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  test(`each chat keeps its own AI under the message box (${label})`, async () => {
    const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-ai-pick-'));
    const memory = process.env.REX_DESK_MEMORY; process.env.REX_DESK_MEMORY = path.join(dir, 'memory');
    const app = await createApp({ dataDirectory: path.join(dir, 'data'), port: 0, requireAccount: false, runnerFactory });
    const at = new Date().toISOString();
    app.store.put('run', 'chat-a', { id: 'chat-a', role: 'worker', title: 'Chat A', provider: 'claude', state: 'finished', createdAt: at });
    app.store.put('run', 'chat-b', { id: 'chat-b', role: 'worker', title: 'Chat B', provider: 'codex', state: 'finished', createdAt: at });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const browser = await chromium.launch();
    try {
      const page = await (await browser.newContext({ viewport, bypassCSP: true })).newPage();
      const sent = [];
      await page.route('**/api/runs/*/resume', route => { sent.push({ run: route.request().url().split('/runs/')[1].split('/')[0], ...route.request().postDataJSON() }); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
      const provider = () => page.locator('#opt-provider').inputValue();
      const open = async id => { await page.goto(`${base}/#/run/${id}`); await page.addStyleTag({ content: ':has(>.tour-card){display:none!important}' }); await page.waitForSelector('#opt-provider', { state: 'attached', timeout: 15000 }); };

      await open('chat-a');
      assert.equal(await provider(), 'claude');
      // Picked in chat A with the app's own picker.
      await page.locator('.composer [data-pick="opt-provider"] .pick2-btn').click();
      await page.locator('.pop .pop-item', { hasText: 'Gemini' }).click();
      assert.equal(await provider(), 'gemini');

      // Chat B, opened in the same page (no reload): its own AI, and its message goes out on it.
      await page.evaluate(() => { location.hash = '#/run/chat-b'; });
      await page.waitForFunction(() => document.getElementById('opt-provider')?.value === 'codex', null, { timeout: 15000 }).catch(() => {});
      assert.equal(await provider(), 'codex', 'chat B shows its own AI, not the one picked in chat A');
      await page.locator('#draft').fill('Hello B');
      await page.locator('[data-action="send"]').click();
      for (let i = 0; i < 50 && !sent.length; i++) await page.waitForTimeout(100);
      assert.equal(sent[0]?.run, 'chat-b'); assert.equal(sent[0]?.provider, 'codex', 'chat B\'s message goes out on its own AI');

      // Back in chat A, its pick is still there and its message goes out on Gemini.
      await page.evaluate(() => { location.hash = '#/run/chat-a'; });
      await page.waitForFunction(() => document.getElementById('opt-provider')?.value === 'gemini', null, { timeout: 15000 }).catch(() => {});
      assert.equal(await provider(), 'gemini', 'chat A keeps what was picked in it');
      await page.locator('#draft').fill('Hello A');
      await page.locator('[data-action="send"]').click();
      for (let i = 0; i < 50 && sent.length < 2; i++) await page.waitForTimeout(100);
      assert.equal(sent[1]?.run, 'chat-a'); assert.equal(sent[1]?.provider, 'gemini');
      await page.screenshot({ path: path.join(process.env.REX_SHOT_DIR || dir, `ai-pick-${label}.png`) });
    } finally {
      await browser.close(); await app.close?.();
      if (memory === undefined) delete process.env.REX_DESK_MEMORY; else process.env.REX_DESK_MEMORY = memory;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ }
    }
  });
}
