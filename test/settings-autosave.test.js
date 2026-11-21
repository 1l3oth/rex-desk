import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';

// An edit typed in Settings must be saved even when the person closes Settings or switches section before the short autosave wait ends.
test('Settings saves a waiting edit at once when it is closed or the section changes', async () => {
  const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-st-'));
  const app = await createApp({ dataDirectory: dir, port: 0, requireAccount: false });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(`${base}/`); await page.waitForTimeout(2500);
    await page.addStyleTag({ content: ':has(>.tour-card){display:none!important}' });
    const branchPrefix = async () => (await (await fetch(`${base}/api/state`)).json()).config.branchPrefix;
    const open = async () => { await page.evaluate(() => document.querySelector('[data-action="settings-open"], .rail-settings')?.click()); await page.waitForTimeout(600); await page.evaluate(() => document.querySelector('[data-st-section="agents"]').click()); await page.waitForTimeout(600); };
    await open();
    await page.locator('.settings-pop [name="branchPrefix"]').fill('qq1');
    await page.evaluate(() => document.querySelector('[data-st-section="notify"]').click());
    await page.waitForTimeout(300);
    assert.equal(await branchPrefix(), 'qq1', 'a section switch saves the edit of the section left');
    await page.evaluate(() => document.querySelector('[data-st-section="agents"]').click()); await page.waitForTimeout(500);
    await page.locator('.settings-pop [name="branchPrefix"]').fill('qq2');
    await page.evaluate(() => document.querySelector('.settings-pop [data-st-close]').click());
    await page.waitForTimeout(300);
    assert.equal(await branchPrefix(), 'qq2', 'closing saves the waiting edit');
  } finally { await browser.close(); await app.close?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ } }
});
