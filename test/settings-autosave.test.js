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
    const saver = async () => (await (await fetch(`${base}/api/state`)).json()).config.saver;
    const open = async () => { await page.evaluate(() => document.querySelector('[data-action="settings-open"], .rail-settings')?.click()); await page.waitForTimeout(600); await page.evaluate(() => document.querySelector('[data-st-section="agents"]').click()); await page.waitForTimeout(600); };
    await open();
    await page.locator('.settings-pop [name="saver"]').evaluate(box => box.click());
    await page.evaluate(() => document.querySelector('[data-st-section="notify"]').click());
    await page.waitForTimeout(300);
    assert.equal(await saver(), false, 'a section switch saves the edit of the section left');
    await page.evaluate(() => document.querySelector('[data-st-section="agents"]').click()); await page.waitForTimeout(500);
    await page.locator('.settings-pop [name="saver"]').evaluate(box => box.click());
    await page.evaluate(() => document.querySelector('.settings-pop [data-st-close]').click());
    await page.waitForTimeout(300);
    assert.equal(await saver(), true, 'closing saves the waiting edit');
  } finally { await browser.close(); await app.close?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ } }
});

// Only Escape closes Settings: typing in a field must leave it open.
test('Settings stays open while typing and closes on Escape', async () => {
  const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-st-'));
  const app = await createApp({ dataDirectory: dir, port: 0, requireAccount: false });
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(`http://127.0.0.1:${app.server.address().port}/`); await page.waitForTimeout(2500);
    await page.addStyleTag({ content: ':has(>.tour-card){display:none!important}' });
    await page.evaluate(() => document.querySelector('[data-action="settings-open"], .rail-settings')?.click()); await page.waitForTimeout(600);
    await page.locator('.settings-pop [name="name"]').click();
    await page.keyboard.type('abc'); await page.waitForTimeout(300);
    assert.equal(await page.locator('.settings-pop').count(), 1, 'typing keeps Settings open');
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    assert.equal(await page.locator('.settings-pop').count(), 0, 'Escape closes Settings');
  } finally { await browser.close(); await app.close?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ } }
});

// Removing a test sign-in or a task app connection must be stored, so it stays gone after Settings is opened again.
test('removing a test sign-in or a connection is saved', async () => {
  const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-st-'));
  const app = await createApp({ dataDirectory: dir, port: 0, requireAccount: false });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch();
  try {
    const config = async () => (await (await fetch(`${base}/api/state`)).json()).config;
    const put = async data => fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-rex-desk': '1' }, body: JSON.stringify(data) });
    const current = await config();
    const reply = await put({ ...current, testAccounts: [{ site: 'localhost', username: 'qa@example.com', password: 'x' }], sources: [{ id: 'conn1', type: 'morningmate', name: 'MM test', baseUrl: 'https://mm.example.test', projectIds: [], userId: '' }] });
    assert.ok(reply.ok, 'test setup: the config accepted a sign-in and a connection: ' + await reply.clone().text());
    const page = await (await browser.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(`${base}/`); await page.waitForTimeout(2500);
    await page.addStyleTag({ content: ':has(>.tour-card){display:none!important}' });
    await page.evaluate(() => document.querySelector('[data-action="settings-open"], .rail-settings')?.click()); await page.waitForTimeout(600);
    const github = page.waitForResponse(response => response.url().includes('/api/github'));
    await page.evaluate(() => document.querySelector('[data-st-section="projects"]').click()); await github; await page.waitForTimeout(300);
    assert.equal((await config()).testAccounts.length, 1);
    await page.evaluate(() => document.querySelector('.settings-pop .st-adv:has([name="ta.0.site"]) > summary').click());
    await page.locator('.settings-pop [data-st-signin-remove]').first().click(); await page.waitForTimeout(800);
    assert.equal((await config()).testAccounts.length, 0, 'the removed sign-in is gone from the saved config');
    await page.evaluate(() => document.querySelector('[data-st-section="connectors"]').click()); await page.waitForTimeout(800);
    assert.equal((await config()).sources.length, 1);
    page.on('dialog', dialog => dialog.accept());
    await page.locator('.settings-pop [data-tr-remove]').first().evaluate(button => button.click()); await page.waitForTimeout(500);
    const confirmButton = page.locator('.dialog-back button.primary, .confirm-pop button.primary').last();
    if (await confirmButton.count()) await confirmButton.click();
    await page.waitForTimeout(800);
    assert.equal((await config()).sources.length, 0, 'the removed connection is gone from the saved config');
  } finally { await browser.close(); await app.close?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ } }
});

// A save waiting on a slow /autostart must not later put an older copy of the config over a newer edit.
test('a slow first save cannot overwrite a newer edit', async () => {
  const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-st-'));
  const app = await createApp({ dataDirectory: dir, port: 0, requireAccount: false });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 } })).newPage();
    let release = () => {}, held = false;
    const gate = new Promise(done => { release = done; });
    await page.goto(`${base}/`); await page.waitForTimeout(2500);
    await page.route('**/api/autostart', async route => { if (route.request().method() === 'POST') { held = true; await gate; } await route.continue(); });
    await page.addStyleTag({ content: ':has(>.tour-card){display:none!important}' });
    const config = async () => (await (await fetch(`${base}/api/state`)).json()).config;
    await page.evaluate(() => document.querySelector('[data-action="settings-open"], .rail-settings')?.click()); await page.waitForTimeout(600);
    await page.locator('.settings-pop [name="name"]').fill('First Name'); // autosaves, then waits on the held /autostart
    for (let i = 0; i < 100 && !held; i++) await page.waitForTimeout(100);
    assert.ok(held, 'test setup: the first save is waiting on /autostart');
    await page.evaluate(() => document.querySelector('[data-st-section="agents"]').click()); await page.waitForTimeout(500);
    const saverBefore = await page.locator('.settings-pop [name="saver"]').isChecked();
    await page.locator('.settings-pop [name="saver"]').evaluate(box => box.click()); // second edit while the first is still in flight
    await page.waitForTimeout(1500);
    release();
    for (let i = 0; i < 100 && (await config()).saver !== !saverBefore; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(1500);
    const saved = await config();
    assert.equal(saved.saver, !saverBefore, 'the newer edit survives');
    assert.equal(saved.name, 'First Name', 'the first edit is kept too');
  } finally { await browser.close(); await app.close?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ } }
});

// Changing a value and changing it back while the first save is held: the last value the person set is the one that must be stored.
test('an edit reverted while the first save waits ends as the reverted value', async () => {
  const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-st-'));
  const app = await createApp({ dataDirectory: dir, port: 0, requireAccount: false });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 } })).newPage();
    let release = () => {}, held = false;
    const gate = new Promise(done => { release = done; });
    await page.goto(`${base}/`); await page.waitForTimeout(2500);
    await page.route('**/api/autostart', async route => { if (route.request().method() === 'POST') { held = true; await gate; } await route.continue(); });
    await page.addStyleTag({ content: ':has(>.tour-card){display:none!important}' });
    const config = async () => (await (await fetch(`${base}/api/state`)).json()).config;
    await page.evaluate(() => document.querySelector('[data-action="settings-open"], .rail-settings')?.click()); await page.waitForTimeout(600);
    const original = (await config()).name;
    const field = page.locator('.settings-pop [name="name"]');
    await field.fill('Changed Name');
    for (let i = 0; i < 100 && !held; i++) await page.waitForTimeout(100);
    assert.ok(held, 'test setup: the first save is waiting on /autostart');
    await field.fill(original); // change it back while the first save is held
    await page.waitForTimeout(1200);
    release();
    await page.waitForTimeout(3000);
    assert.equal((await config()).name, original, 'the reverted value is the stored one');
  } finally { await browser.close(); await app.close?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ } }
});

// Leave General and come back while the first save is held: the form must still show the new name, and a later change (the theme) must not bring the old name back.
test('an edit stays visible and stored after leaving and returning while its save is pending', async () => {
  const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-st-'));
  const app = await createApp({ dataDirectory: dir, port: 0, requireAccount: false });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 } })).newPage();
    let release = () => {}, held = false;
    const gate = new Promise(done => { release = done; });
    await page.goto(`${base}/`); await page.waitForTimeout(2500);
    await page.route('**/api/autostart', async route => { if (route.request().method() === 'POST') { held = true; await gate; } await route.continue(); });
    await page.addStyleTag({ content: ':has(>.tour-card){display:none!important}' });
    const config = async () => (await (await fetch(`${base}/api/state`)).json()).config;
    await page.evaluate(() => document.querySelector('[data-action="settings-open"], .rail-settings')?.click()); await page.waitForTimeout(600);
    await page.locator('.settings-pop [name="name"]').fill('Pending Name');
    for (let i = 0; i < 100 && !held; i++) await page.waitForTimeout(100);
    assert.ok(held, 'test setup: the first save is waiting on /autostart');
    await page.evaluate(() => document.querySelector('[data-st-section="notify"]').click()); await page.waitForTimeout(500);
    await page.evaluate(() => document.querySelector('[data-st-section="general"]').click()); await page.waitForTimeout(800);
    assert.equal(await page.locator('.settings-pop [name="name"]').inputValue(), 'Pending Name', 'the form shows the new name, not the old confirmed one');
    const theme = page.locator('.settings-pop select[name="theme"]');
    const options = await theme.locator('option').evaluateAll(list => list.map(o => o.value));
    await theme.selectOption(options.find(value => value !== options[0]) || options[0]); await page.waitForTimeout(800);
    release();
    for (let i = 0; i < 100 && (await config()).name !== 'Pending Name'; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(2000);
    assert.equal((await config()).name, 'Pending Name', 'the name survives the theme change');
  } finally { await browser.close(); await app.close?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ } }
});

// Remove a task app while its save is held, leave Tasks and come back: it stays removed, and changing only the sync interval must not bring it back.
test('a removed task app stays removed after leaving and returning while the save is pending', async () => {
  const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-st-'));
  const app = await createApp({ dataDirectory: dir, port: 0, requireAccount: false });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch();
  try {
    const config = async () => (await (await fetch(`${base}/api/state`)).json()).config;
    const current = await config();
    const reply = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-rex-desk': '1' }, body: JSON.stringify({ ...current, sources: [
      { id: 'conn1', type: 'morningmate', name: 'MM one', baseUrl: 'https://mm.example.test', projectIds: [], userId: '' },
      { id: 'conn2', type: 'morningmate', name: 'MM two', baseUrl: 'https://mm2.example.test', projectIds: [], userId: '' }] }) });
    assert.ok(reply.ok, 'test setup: two connections saved');
    const page = await (await browser.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 } })).newPage();
    let release = () => {}, held = false;
    const gate = new Promise(done => { release = done; });
    await page.goto(`${base}/`); await page.waitForTimeout(2500);
    await page.route('**/api/config', async route => { if (route.request().method() === 'PUT') { held = true; await gate; } await route.continue(); });
    await page.addStyleTag({ content: ':has(>.tour-card){display:none!important}' });
    page.on('dialog', dialog => dialog.accept());
    await page.evaluate(() => document.querySelector('[data-action="settings-open"], .rail-settings')?.click()); await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector('[data-st-section="connectors"]').click()); await page.waitForTimeout(800);
    assert.equal(await page.locator('.settings-pop [data-tr-remove]').count(), 2);
    await page.locator('.settings-pop [data-tr-remove]').first().evaluate(button => button.click()); await page.waitForTimeout(500);
    const confirmButton = page.locator('.dialog-back button.primary, .confirm-pop button.primary').last();
    if (await confirmButton.count()) await confirmButton.click();
    for (let i = 0; i < 100 && !held; i++) await page.waitForTimeout(100);
    assert.ok(held, 'test setup: the removal save is waiting');
    await page.evaluate(() => document.querySelector('[data-st-section="notify"]').click()); await page.waitForTimeout(500);
    await page.evaluate(() => document.querySelector('[data-st-section="connectors"]').click()); await page.waitForTimeout(800);
    assert.equal(await page.locator('.settings-pop [data-tr-remove]').count(), 1, 'the removed connection does not come back on screen');
    await page.locator('.settings-pop [name="syncMinutes"]').fill('7');
    await page.waitForTimeout(1200);
    release();
    for (let i = 0; i < 100 && (await config()).syncMinutes !== 7; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(1500);
    const saved = await config();
    assert.equal(saved.syncMinutes, 7, 'the interval was saved');
    assert.equal(saved.sources.length, 1, 'the removal survives the interval change');
  } finally { await browser.close(); await app.close?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ } }
});

// While a Settings page waits on the server it shows grey skeleton rows, not a Loading text.
test('the Market page opens from the sidebar, lists what agents can use, and Settings has no Tools section', async () => {
  const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-st-'));
  const app = await createApp({ dataDirectory: dir, port: 0, requireAccount: false, runnerFactory: () => ({ async start() {}, async interrupt() {} }) });
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(`http://127.0.0.1:${app.server.address().port}/`); await page.waitForTimeout(2500);
    await page.addStyleTag({ content: ':has(>.tour-card){display:none!important}' });
    await page.evaluate(() => document.querySelector('[data-open="market"]').click()); await page.waitForTimeout(600);
    await page.waitForTimeout(1200);
    assert.ok(await page.locator('.page.mk .mk-row').count() >= 1, 'rows once loaded (Rex Desk itself at least)');
    assert.ok(await page.locator('.page.mk .mk-seg button').count() === 5, 'All, Skills, Commands, MCP, Connectors');
    await page.evaluate(() => document.querySelector('[data-action="settings-open"], .rail-settings')?.click()); await page.waitForTimeout(600);
    assert.equal(await page.locator('[data-st-section="tools"]').count(), 0, 'no Tools and skills section in Settings');
  } finally { await browser.close(); await app.close?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ } }
});

// Jev and voice: a switch change keeps the "Done without asking" list, and a slow background answer cannot redraw the tab before the save reads it.
test('a Jev and voice switch change keeps the allowed actions and survives a slow background redraw', async () => {
  const dir = mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'rex-st-'));
  const app = await createApp({ dataDirectory: dir, port: 0, requireAccount: false, runnerFactory: () => ({ async start() {}, async interrupt() {} }) });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch();
  try {
    const config = async () => (await (await fetch(`${base}/api/state`)).json()).config;
    const current = await config();
    const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-rex-desk': '1' }, body: JSON.stringify({ ...current, control: { ...current.control, allow: ['close_app'] } }) });
    assert.ok(put.ok, 'test setup: an allowed action saved');
    const page = await (await browser.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(`${base}/`); await page.waitForTimeout(2500);
    await page.addStyleTag({ content: ':has(>.tour-card){display:none!important}' });
    let release = () => {};
    const gate = new Promise(done => { release = done; });
    await page.route('**/api/speak/voices', async route => { await gate; await route.continue(); });
    await page.evaluate(() => document.querySelector('[data-action="settings-open"], .rail-settings')?.click()); await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector('[data-st-section="jev"]').click()); await page.waitForTimeout(800);
    await page.locator('.settings-pop [name="control.agents"]').evaluate(box => box.click());
    release(); await page.waitForTimeout(1500);
    const saved = (await config()).control;
    assert.equal(saved.agents, true, 'the switch change was saved');
    assert.deepEqual(saved.allow, ['close_app'], 'the allowed actions are kept');
    assert.equal(await page.locator('.settings-pop [name="control.agents"]').isChecked(), true, 'the switch still shows on after the redraw');
  } finally { await browser.close(); await app.close?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ } }
});
