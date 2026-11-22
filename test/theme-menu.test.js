import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';

// The slash / @ / # menu opens above the composer box. A theme must never clip the composer box itself, or the menu is cut off.
// This is the Cyberpunk regression (themes.css clip-path on .composer .box2). Every skin is checked.
const SKINS = ['midnight', 'cyberpunk', 'sakura', 'gojo', 'crayon', 'forest', 'sunset'];

test('the slash menu is visible and not clipped in every theme', async () => {
  const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-menu-'));
  const app = await createApp({ dataDirectory: dir, port: 0, requireAccount: false });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(`${base}/`); await page.waitForTimeout(2500);
    await page.addStyleTag({ content: ':has(>.tour-card){display:none!important}' });
    await page.waitForSelector('#draft', { timeout: 10000 });
    for (const skin of SKINS) {
      await page.evaluate(s => { window.rexSkin ? window.rexSkin.set(s) : (document.documentElement.dataset.skin = s); }, skin);
      await page.waitForTimeout(150);
      // Open the slash menu the way typing does.
      await page.evaluate(() => { const box = document.getElementById('draft'); box.focus(); box.value = '/'; box.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.waitForSelector('#menu .menu', { state: 'visible', timeout: 4000 });
      const check = await page.evaluate(() => {
        const box2 = document.querySelector('.composer .box2');
        const menu = document.querySelector('#menu .menu');
        const r = menu.getBoundingClientRect();
        // A point just inside the menu's top edge: if an ancestor clips the box, this pixel is cut and hits something else.
        const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + 4);
        const hit = document.elementFromPoint(x, y);
        return { clip: getComputedStyle(box2).clipPath, width: r.width, height: r.height, onTop: !!(hit && menu.contains(hit)) };
      });
      assert.equal(check.clip, 'none', `${skin}: the composer box must not clip (it would cut the menu)`);
      assert.ok(check.width > 0 && check.height > 0, `${skin}: the menu has a real size`);
      assert.ok(check.onTop, `${skin}: the top of the menu is visible, not clipped away`);
      await page.evaluate(() => { const box = document.getElementById('draft'); box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); box.blur(); });
      await page.keyboard.press('Escape'); await page.waitForTimeout(100);
    }
  } finally { await browser.close(); await app.close?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ } }
});
