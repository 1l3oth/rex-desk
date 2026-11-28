import test from 'node:test';
import assert from 'node:assert/strict';
import { connectorsHtml, connectorsClick, signInParts } from '../public/chat-connectors.js';
import { useLanguage } from '../public/i18n.js';
import { loadLanguage } from '../scripts/i18n-keys.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const GOOGLE_DRIVE_ITEM = {
  id: 'googledrive',
  name: 'Google Drive',
  group: 'docs',
  icon: 'color/googledrive.svg',
  tier: 'mcp',
  phase: 1,
  note: 'Sign in with your Google account.',
  connect: { kind: 'remote-mcp', auth: 'oauth', url: 'https://drivemcp.googleapis.com/mcp/v1', fields: [] },
};

function renderDriveRow(signIn, extra = {}) {
  return connectorsHtml(
    { ui: { snap: {} }, esc },
    {
      extra: {
        connectors: {
          types: [{ id: 'docs', name: 'Docs and files' }],
          connectors: [],
          connections: [],
          accounts: [],
          links: [{ id: 'link-gd', connectorId: 'googledrive', name: 'Google Drive', server: 'googledrive' }],
          catalog: { groups: [{ id: 'docs', name: 'Docs and files' }], items: [GOOGLE_DRIVE_ITEM] },
          signIns: signIn ? [signIn] : [],
        },
        ...extra,
      },
    },
    { sources: [] },
  );
}

test('Google Drive OAuth row renders needed state with Sign in button', () => {
  useLanguage('en');
  const html = renderDriveRow({ name: 'googledrive', state: 'needed', waiting: false, link: '', error: '' });
  assert.match(html, /Google Drive/);
  assert.match(html, /Not signed in/);
  assert.match(html, /data-mcp-start="googledrive"[^>]*>Sign in<\/button>/);
  assert.doesNotMatch(html, /Switch account|data-mcp-sign-out/);
  assert.doesNotMatch(html, /\sstyle=|\son\w+=/i, 'follows CSP: no inline styles or event handlers');
});

test('Google Drive OAuth row renders connected state with escaped accountEmail, Switch account, and Sign out', () => {
  useLanguage('en');
  const html = renderDriveRow({
    name: 'googledrive',
    state: 'connected',
    waiting: false,
    link: '',
    error: '',
    accountEmail: 'user+<tag>@gmail.com',
  });
  assert.match(html, /<span title="user\+&lt;tag&gt;@gmail\.com">Signed in as user\+&lt;tag&gt;@gmail\.com\. Rex Desk keeps the sign-in fresh\.<\/span>/);
  assert.doesNotMatch(html, /<tag>/, 'accountEmail is HTML-escaped');
  assert.match(html, /<div class="cx-actions"><button type="button" class="btn small quiet" data-mcp-start="googledrive">Switch account<\/button><button type="button" class="btn small quiet" data-mcp-sign-out="googledrive">Sign out<\/button><button type="button" class="btn small quiet danger" data-cn-unlink="link-gd"/);
  assert.doesNotMatch(html, /\sstyle=|\son\w+=/i);
});

test('Google Drive OAuth row renders connected state fallback copy when accountEmail is absent', () => {
  useLanguage('en');
  const html = renderDriveRow({
    name: 'googledrive',
    state: 'connected',
    waiting: false,
    link: '',
    error: '',
  });
  assert.match(html, /Signed in\. Rex Desk keeps the sign-in fresh\./);
  assert.doesNotMatch(html, /Signed in as /);
  assert.match(html, /data-mcp-start="googledrive">Switch account<\/button>/);
  assert.match(html, /data-mcp-sign-out="googledrive">Sign out<\/button>/);
});

test('Google Drive OAuth row renders waiting link and Cancel while switching accounts from connected state', () => {
  useLanguage('en');
  const html = renderDriveRow({
    name: 'googledrive',
    state: 'connected',
    waiting: true,
    link: 'https://accounts.google.com/o/oauth2/v2/auth?prompt=select_account&scope=a&b=1',
    error: '',
    accountEmail: 'old@gmail.com',
  });
  assert.match(html, /Finish signing in in your browser\./);
  assert.match(html, /href="https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?prompt=select_account&amp;scope=a&amp;b=1"/);
  assert.match(html, /Open the sign-in page/);
  assert.match(html, /data-mcp-cancel="googledrive">Cancel<\/button>/);
  assert.doesNotMatch(html, /Switch account|data-mcp-sign-out/);
});

test('Google Drive OAuth row renders expired state with and without accountEmail and keeps Sign in again button', () => {
  useLanguage('en');
  const withEmail = renderDriveRow({
    name: 'googledrive',
    state: 'expired',
    waiting: false,
    link: '',
    error: '',
    accountEmail: 'alice"<x>@gmail.com',
  });
  assert.match(withEmail, /<span class="tb-status bad" title="alice&quot;&lt;x&gt;@gmail\.com"><i aria-hidden="true"><\/i>Sign-in expired \(alice&quot;&lt;x&gt;@gmail\.com\)<\/span>/);
  assert.doesNotMatch(withEmail, /<x>/);
  assert.match(withEmail, /data-mcp-start="googledrive">Sign in again<\/button>/);

  const withoutEmail = renderDriveRow({
    name: 'googledrive',
    state: 'expired',
    waiting: false,
    link: '',
    error: '',
  });
  assert.match(withoutEmail, /<span class="tb-status bad"><i aria-hidden="true"><\/i>Sign-in expired<\/span>/);
  assert.match(withoutEmail, /data-mcp-start="googledrive">Sign in again<\/button>/);
});

test('signInParts hides Switch account on remote clients while keeping connected email and Sign out', () => {
  useLanguage('en');
  const parts = signInParts({ esc }, {
    name: 'googledrive',
    state: 'connected',
    waiting: false,
    link: '',
    error: '',
    accountEmail: 'user@gmail.com',
    elsewhere: true,
  });
  assert.match(parts.sub, /Signed in as user@gmail\.com\./);
  assert.doesNotMatch(parts.button, /data-mcp-start|Switch account/);
  assert.match(parts.button, /data-mcp-sign-out="googledrive"/);
});

test('catalogFormHtml and howLine describe direct sign-in after adding Google Drive', () => {
  useLanguage('en');
  const probeForm = renderDriveRow(null, {
    connectorPick: 'googledrive',
    cnProbe: { ok: true, method: 'oauth', needs: 'sign-in', tools: 6 },
  });
  assert.match(probeForm, /Google Drive answered\. Add it, then press Sign in\./);
  assert.match(probeForm, /data-cn-save[^>]*>Add<\/button>/);

  const fallbackRow = renderDriveRow(null);
  assert.match(fallbackRow, /Agents can use Google Drive after you sign in\./);
});

test('Khmer translations render Google Drive connected, Switch account, expired, and probe copy cleanly', () => {
  const km = loadLanguage('km');
  useLanguage('km', km);
  try {
    const connected = renderDriveRow({
      name: 'googledrive',
      state: 'connected',
      waiting: false,
      link: '',
      error: '',
      accountEmail: 'pkay@gmail.com',
    });
    assert.match(connected, /បានចូលគណនីជា pkay@gmail\.com។ Rex Desk រក្សាការចូលគណនីនេះឱ្យនៅប្រើបាន។/);
    assert.match(connected, /ប្ដូរគណនី/);
    assert.match(connected, /ចាកចេញ/);

    const expired = renderDriveRow({
      name: 'googledrive',
      state: 'expired',
      waiting: false,
      link: '',
      error: '',
      accountEmail: 'pkay@gmail.com',
    });
    assert.match(expired, /ការចូលគណនីផុតកំណត់ \(pkay@gmail\.com\)/);
    assert.match(expired, /ចូលម្ដងទៀត/);
  } finally {
    useLanguage('en');
  }
});

test('connectorsClick handles Switch account start and polling cleanly', async () => {
  useLanguage('en');
  const opened = [];
  const prevWindow = globalThis.window;
  globalThis.window = { open: (...args) => opened.push(args) };
  try {
    const calls = [];
    let drawCount = 0;
    let pollStep = 0;
    const state = {
      extra: {
        connectors: {
          signIns: [{ name: 'googledrive', state: 'connected', waiting: false, link: '', error: '', accountEmail: 'first@gmail.com' }],
        },
      },
    };
    const ctx = {
      api: async (route, opts) => {
        calls.push({ route, opts });
        if (route === '/mcp-sign-in/start') return { url: 'https://accounts.google.com/o/oauth2/v2/auth?prompt=select_account' };
        if (route === '/connectors') {
          pollStep += 1;
          return {
            signIns: [{
              name: 'googledrive',
              state: 'connected',
              waiting: false,
              link: '',
              error: '',
              accountEmail: pollStep === 1 ? 'second@gmail.com' : 'second@gmail.com',
            }],
          };
        }
        return {};
      },
      toast: () => {},
      refresh: async () => {},
    };
    const button = { dataset: { mcpStart: 'googledrive' } };
    const target = { closest: sel => (sel === '[data-mcp-start]' ? button : null) };
    const handled = await connectorsClick(ctx, state, target, { isConnected: true }, () => { drawCount += 1; });
    assert.equal(handled, true);
    assert.equal(calls[0].route, '/mcp-sign-in/start');
    assert.deepEqual(calls[0].opts, { method: 'POST', data: { name: 'googledrive' } });
    assert.equal(opened.length, 1);
    assert.equal(opened[0][0], 'https://accounts.google.com/o/oauth2/v2/auth?prompt=select_account');
    assert.equal(state.extra.connectors.signIns[0].accountEmail, 'second@gmail.com');
    assert.ok(drawCount >= 1);
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

test('connectorsClick uses connector display name in Sign out confirmation while sending raw server id', async () => {
  useLanguage('en');
  const prevDocument = globalThis.document;
  const dialogs = [];
  const listeners = new Map();
  globalThis.document = {
    activeElement: null,
    documentElement: {},
    createElement: () => {
      const el = {
        className: '',
        innerHTML: '',
        _click: null,
        addEventListener(type, fn) { if (type === 'click') el._click = fn; },
        remove() {},
        querySelector(sel) {
          if (sel === '[data-confirm="yes"]') {
            return {
              focus() {
                dialogs.push(el.innerHTML);
                queueMicrotask(() => el._click?.({ target: { closest: q => (q === '[data-confirm]' ? { dataset: { confirm: 'yes' } } : null) } }));
              },
            };
          }
          return null;
        },
      };
      return el;
    },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    body: { append() {} },
  };
  try {
    const calls = [];
    const state = {
      extra: {
        connectors: {
          links: [{ id: 'link-gd', connectorId: 'googledrive', name: 'Google Drive', server: 'googledrive' }],
          catalog: { items: [GOOGLE_DRIVE_ITEM] },
          signIns: [{ name: 'googledrive', state: 'connected', waiting: false, link: '', error: '', accountEmail: 'pkay@gmail.com' }],
        },
      },
    };
    const ctx = {
      api: async (route, opts) => {
        calls.push({ route, opts });
        if (route === '/connectors') return { ...state.extra.connectors, signIns: [{ name: 'googledrive', state: 'needed', waiting: false, link: '', error: '' }] };
        return {};
      },
      toast: () => {},
      refresh: async () => {},
    };
    const button = { dataset: { mcpSignOut: 'googledrive' } };
    const target = { closest: sel => (sel === '[data-mcp-sign-out]' ? button : null) };
    const handled = await connectorsClick(ctx, state, target, { isConnected: true }, () => {});
    assert.equal(handled, true);
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0], /Sign out of Google Drive\? Agents cannot use it until you sign in again\./);
    assert.doesNotMatch(dialogs[0], /Sign out of googledrive\?/);
    assert.deepEqual(calls[0], { route: '/mcp-sign-in/sign-out', opts: { method: 'POST', data: { name: 'googledrive' } } });
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
});

test('connectorsClick shows revocation failure warning and Google permissions link when remote sign-out fails, in English and Khmer', async () => {
  useLanguage('en');
  const prevDocument = globalThis.document;
  globalThis.document = {
    activeElement: null,
    documentElement: {},
    createElement: () => {
      const el = {
        className: '',
        innerHTML: '',
        _click: null,
        addEventListener(type, fn) { if (type === 'click') el._click = fn; },
        remove() {},
        querySelector(sel) {
          if (sel === '[data-confirm="yes"]') {
            return { focus() { queueMicrotask(() => el._click?.({ target: { closest: q => (q === '[data-confirm]' ? { dataset: { confirm: 'yes' } } : null) } })); } };
          }
          return null;
        },
      };
      return el;
    },
    addEventListener() {},
    removeEventListener() {},
    body: { append() {} },
  };
  try {
    const toasts = [];
    const state = {
      extra: {
        connectors: {
          types: [{ id: 'docs', name: 'Docs and files' }],
          connectors: [],
          connections: [],
          accounts: [],
          links: [{ id: 'link-gd', connectorId: 'googledrive', name: 'Google Drive', server: 'googledrive' }],
          catalog: { groups: [{ id: 'docs', name: 'Docs and files' }], items: [GOOGLE_DRIVE_ITEM] },
          signIns: [{ name: 'googledrive', state: 'connected', waiting: false, link: '', error: '', accountEmail: 'pkay@gmail.com' }],
        },
      },
    };
    const ctx = {
      api: async route => {
        if (route === '/mcp-sign-in/sign-out') {
          return {
            localCleared: true,
            revocation: 'failed',
            revoked: false,
            manageUrl: 'https://myaccount.google.com/permissions',
            signIns: [{ name: 'googledrive', state: 'needed', waiting: false, link: '', error: '' }],
          };
        }
        if (route === '/connectors') {
          return { ...state.extra.connectors, signIns: [{ name: 'googledrive', state: 'needed', waiting: false, link: '', error: '' }] };
        }
        return {};
      },
      toast: (text, bad) => toasts.push({ text, bad }),
      refresh: async () => {},
    };
    const button = { dataset: { mcpSignOut: 'googledrive' } };
    const target = { closest: sel => (sel === '[data-mcp-sign-out]' ? button : null) };
    await connectorsClick(ctx, state, target, { isConnected: true }, () => {});
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].bad, true);
    assert.match(toasts[0].text, /remote revoke failed.*https:\/\/myaccount\.google\.com\/permissions/);
    assert.deepEqual(state.extra.signOutNotes.googledrive, { label: 'Google Drive', manageUrl: 'https://myaccount.google.com/permissions' });

    const enHtml = connectorsHtml({ ui: { snap: {} }, esc }, state, { sources: [] });
    assert.match(enHtml, /Signed out here, but Google Drive could not revoke access remotely\./);
    assert.match(enHtml, /<a href="https:\/\/myaccount\.google\.com\/permissions" target="_blank" rel="noopener noreferrer">https:\/\/myaccount\.google\.com\/permissions<\/a>/);
    assert.match(enHtml, /data-mcp-start="googledrive"[^>]*>Sign in<\/button>/);
    assert.doesNotMatch(enHtml, /\sstyle=|\son\w+=/i);

    const km = loadLanguage('km');
    useLanguage('km', km);
    const kmHtml = connectorsHtml({ ui: { snap: {} }, esc }, state, { sources: [] });
    assert.match(kmHtml, /បានចាកចេញនៅទីនេះ ប៉ុន្តែ Google Drive មិនអាចដកសិទ្ធិចូលប្រើពីចម្ងាយបានទេ។/);
    assert.match(kmHtml, /ដកសិទ្ធិចូលប្រើក្នុងការកំណត់គណនីរបស់អ្នក:/);
    assert.match(kmHtml, /https:\/\/myaccount\.google\.com\/permissions/);

    // Subsequent sign-out with revocation: 'revoked' clears the failure note.
    useLanguage('en');
    const okCtx = {
      api: async route => (route === '/mcp-sign-in/sign-out'
        ? { localCleared: true, revocation: 'revoked', revoked: true, manageUrl: 'https://myaccount.google.com/permissions', signIns: [] }
        : { ...state.extra.connectors, signIns: [{ name: 'googledrive', state: 'needed', waiting: false, link: '', error: '' }] }),
      toast: (text, bad) => toasts.push({ text, bad }),
      refresh: async () => {},
    };
    await connectorsClick(okCtx, state, target, { isConnected: true }, () => {});
    assert.equal(state.extra.signOutNotes.googledrive, undefined);
    assert.equal(toasts.length, 1, 'no error toast when remote revocation succeeds');
  } finally {
    useLanguage('en');
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
});
