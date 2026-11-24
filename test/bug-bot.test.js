import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BugBot, bugBotLink, isAllowedGroup, mentionsBot, parseRef, extractMedia, safetyVerdict, redact,
  sortReport, rateCheck, RATE, findDuplicate, linkTarget, openReportsFor, MAX_MEDIA_BYTES,
} from '../src/bug-bot.js';

// A tiny in-memory store + coordinator, like test/telegram.test.js. encrypt/decrypt are identity so the connector secret
// round-trips as JSON. A routing fetcher answers Telegram and Jev calls and records every Telegram method it saw.
function makeDesk({ jevAnswers = null, groups = [] } = {}) {
  const records = new Map(), key = (kind, id) => `${kind}:${id}`;
  const store = {
    directory: null,
    list: kind => [...records.entries()].filter(([k]) => k.startsWith(`${kind}:`)).map(([, value]) => value),
    get: (kind, id) => records.get(key(kind, id)) ?? null,
    put: (kind, id, value) => { records.set(key(kind, id), value); },
    delete: (kind, id) => { records.delete(key(kind, id)); },
    encrypt: text => text, decrypt: text => text,
    config: () => ({ control: { language: 'en' }, jev: {}, version: '0.0.115' }),
    emit: () => {}, event: () => {},
  };
  // Save the bug-bot connector with a token, a username, and the allowed groups.
  records.set('connector:bugs', { id: 'bugs', connectorId: 'telegram-bugs', name: 'Bug bot', at: '2026-01-01' });
  records.set('secret:connector:bugs', JSON.stringify({ botToken: 'TKN', botUsername: 'rexbugbot', botId: 999, groups, reportAt: '09:00' }));

  const calls = [];
  const fetcher = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : {};
    const method = String(url).split('/').pop();
    calls.push({ method, body });
    if (method === 'getChatMember') return reply({ ok: true, result: { status: 'member' } });
    if (method === 'sendMessage') return reply({ ok: true, result: { message_id: 7000 + calls.length } });
    return reply({ ok: true, result: {} });
  };
  const reply = data => ({ ok: true, json: async () => data });

  const jevFetcher = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ model: 'jev', answers: jevAnswers || { kind: { choice: 'bug' }, severity: { score: 3 } } }) });
  const createdTasks = [];
  const desk = {
    store,
    jev: { apiKey: () => (jevAnswers === 'nokey' ? '' : 'KEY'), fetcher: jevFetcher },
    localTasks: { create: async input => { const made = { id: `local:${createdTasks.length + 1}`, ...input }; createdTasks.push(made); return made; } },
    telegram: { sendFromAgent: async () => {} },
    specialists: {},
    version: '0.0.115',
  };
  return { desk, store, calls, createdTasks };
}
const groupMsg = (over = {}) => ({ update_id: Math.floor(Math.random() * 1e6), message: { message_id: 10, chat: { id: -100, type: 'supergroup', title: 'Acme' }, from: { id: 42, first_name: 'Dara' }, ...over } });

// ---------- pure helpers ----------

test('allowed-groups: only listed groups pass', () => {
  const groups = [{ id: '-100' }, { id: '-200' }];
  assert.equal(isAllowedGroup(groups, -100), true);
  assert.equal(isAllowedGroup(groups, '-200'), true);
  assert.equal(isAllowedGroup(groups, -999), false);
  assert.equal(isAllowedGroup([], -100), false);
});

test('mentionsBot: entity mention, text_mention and plain @handle', () => {
  assert.equal(mentionsBot({ text: 'hey @rexbugbot it broke', entities: [{ type: 'mention', offset: 4, length: 10 }] }, 'rexbugbot', 999), true);
  assert.equal(mentionsBot({ caption: 'look @rexbugbot', caption_entities: [{ type: 'mention', offset: 5, length: 10 }] }, 'rexbugbot', 999), true);
  assert.equal(mentionsBot({ text: 'x', entities: [{ type: 'text_mention', offset: 0, length: 1, user: { id: 999 } }] }, 'rexbugbot', 999), true);
  assert.equal(mentionsBot({ text: 'just chatting' }, 'rexbugbot', 999), false);
  assert.equal(mentionsBot({ text: '@someoneelse hi' }, 'rexbugbot', 999), false);
});

test('parseRef: finds a report number', () => {
  assert.equal(parseRef('#7 still broken'), 7);
  assert.equal(parseRef('still about 12'), 12);
  assert.equal(parseRef('no number here'), null);
});

test('extractMedia: classifies attachments and keeps size', () => {
  assert.deepEqual(extractMedia({ photo: [{ file_id: 'a', file_size: 10 }, { file_id: 'b', file_size: 99 }] }), { kind: 'photo', fileId: 'b', size: 99 });
  assert.equal(extractMedia({ video: { file_id: 'v', file_size: 5 } }).kind, 'video');
  assert.equal(extractMedia({ document: { file_id: 'd', file_size: 5 } }).kind, 'document');
  assert.equal(extractMedia({ text: 'hi' }).kind, 'none');
});

test('safetyVerdict: keeps pictures and short videos, drops files, big media, member links', () => {
  assert.equal(safetyVerdict({ photo: [{ file_id: 'a', file_size: 100 }] }).drop, false);
  assert.equal(safetyVerdict({ document: { file_id: 'd', file_size: 10 } }).drop, true);
  assert.equal(safetyVerdict({ photo: [{ file_id: 'a', file_size: MAX_MEDIA_BYTES + 1 }] }).drop, true);
  assert.equal(safetyVerdict({ text: 'see https://spam.example' }).drop, true);
  assert.equal(safetyVerdict({ text: 'see https://spam.example' }, { isAdmin: true }).drop, false);
  assert.equal(safetyVerdict({ text: 'the save button does nothing' }).drop, false);
});

test('redact: hides emails, phone numbers and key-like text', () => {
  const out = redact('mail me at dara@example.com or +855 12 345 678, key ABCDEF0123456789ABCDEF0123456789');
  assert.ok(out.includes('[hidden email]'));
  assert.ok(out.includes('[hidden number]'));
  assert.ok(out.includes('[hidden key]'));
  assert.ok(!out.includes('dara@example.com'));
});

test('sortReport: reads Jev answers into kind + severity', () => {
  assert.deepEqual(sortReport({ kind: { choice: 'feature' }, severity: { score: 1 } }), { kind: 'feature', severity: 1, severityLabel: 'Minor' });
  assert.equal(sortReport({ kind: { choice: 'chat' } }).kind, 'chat');
  assert.equal(sortReport({}).kind, 'chat');
});

// ---------- rate limit ----------

test('rateCheck: allows a burst, then blocks, then mutes a repeat spammer', () => {
  let bucket = null;
  const now = 1_000_000;
  for (let i = 0; i < RATE.max; i++) { const r = rateCheck(bucket, now); assert.equal(r.allowed, true); bucket = r.bucket; }
  // One past the limit earns a strike and is blocked but not muted.
  let r = rateCheck(bucket, now); assert.equal(r.allowed, false); assert.equal(r.muted, false); bucket = r.bucket;
  // Fill the window and go over again twice more to reach the mute threshold.
  for (let s = 1; s < RATE.strikesToMute; s++) {
    bucket = { ...bucket, times: Array.from({ length: RATE.max }, () => now) };
    r = rateCheck(bucket, now); bucket = r.bucket;
  }
  assert.equal(r.muted, true);
  assert.equal(r.justMuted, true);
  // While muted, every message is blocked.
  assert.equal(rateCheck(bucket, now + 1000).allowed, false);
  // The window resets after it passes.
  assert.equal(rateCheck(null, now).allowed, true);
});

// ---------- reply linking ----------

test('linkTarget: reply-to-ack, #N, one open, several open', () => {
  const reports = [
    { num: 5, groupId: '-100', reporterId: '42', status: 'queued', createdAt: '2026-01-02', text: 'a' },
    { num: 6, groupId: '-100', reporterId: '42', status: 'approved', createdAt: '2026-01-03', text: 'b' },
    { num: 7, groupId: '-100', reporterId: '99', status: 'queued', createdAt: '2026-01-04', text: 'c' },
  ];
  // Reply to the "Got it, #5" ack wins.
  assert.equal(linkTarget(reports, { groupId: '-100', reporterId: '42', text: 'more', ackReportNum: 5 }).report.num, 5);
  // "#6" names a report the sender owns.
  assert.equal(linkTarget(reports, { groupId: '-100', reporterId: '42', text: 'also #6' }).report.num, 6);
  // A "#7" the sender does not own does not attach; they have two open of their own, so ask which.
  assert.ok(linkTarget(reports, { groupId: '-100', reporterId: '42', text: 'about #7' }).choices.length === 2);
  // Only one open report: attach straight to it.
  assert.equal(linkTarget([reports[0]], { groupId: '-100', reporterId: '42', text: 'more' }).report.num, 5);
  // No open report of theirs: nothing.
  assert.deepEqual(linkTarget(reports, { groupId: '-100', reporterId: '13', text: 'hello' }), {});
});

test('openReportsFor: only the sender own open reports, newest first', () => {
  const reports = [
    { num: 1, groupId: '-1', reporterId: '42', status: 'done', createdAt: '2026-01-01' },
    { num: 2, groupId: '-1', reporterId: '42', status: 'queued', createdAt: '2026-01-02' },
    { num: 3, groupId: '-1', reporterId: '42', status: 'approved', createdAt: '2026-01-03' },
  ];
  assert.deepEqual(openReportsFor(reports, '-1', '42').map(r => r.num), [3, 2]);
});

test('findDuplicate: merges the same text from the same person', () => {
  const reports = [{ num: 1, groupId: '-1', reporterId: '42', status: 'queued', text: 'the save button does nothing' }];
  assert.equal(findDuplicate(reports, { groupId: '-1', reporterId: '42', text: 'The save button   does nothing' }).num, 1);
  assert.equal(findDuplicate(reports, { groupId: '-1', reporterId: '42', text: 'a totally different bug' }), null);
  assert.equal(findDuplicate(reports, { groupId: '-1', reporterId: '99', text: 'the save button does nothing' }), null);
});

// ---------- live flows through BugBot ----------

test('allowed-groups: leaves a group it was not allowed into, files nothing', async () => {
  const { desk, calls, store } = makeDesk({ groups: [] });
  const bot = new BugBot(desk, { fetcher: await mkFetcher(calls) });
  await bot.handleUpdate(groupMsg({ chat: { id: -500, type: 'supergroup', title: 'Random' } }), bugBotLink(store));
  assert.ok(calls.find(c => c.method === 'leaveChat'));
  assert.equal(store.list('bugreport').length, 0);
});

test('sorting: a bug is queued hidden with an ack, a feature gets a polite reply, chat is ignored', async () => {
  // bug
  let ctx = makeDesk({ groups: [{ id: '-100' }], jevAnswers: { kind: { choice: 'bug' }, severity: { score: 4 } } });
  let bot = new BugBot(ctx.desk, { fetcher: await mkFetcher(ctx.calls) });
  await bot.handleUpdate(groupMsg({ text: '@rexbugbot the export crashes', entities: [{ type: 'mention', offset: 0, length: 10 }] }), bugBotLink(ctx.store));
  let reports = ctx.store.list('bugreport');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'queued');
  assert.equal(reports[0].hidden, true);
  assert.ok(ctx.calls.find(c => c.method === 'sendMessage' && /Got it, #\d/.test(c.body.text)));

  // feature
  ctx = makeDesk({ groups: [{ id: '-100' }], jevAnswers: { kind: { choice: 'feature' }, severity: { score: 1 } } });
  bot = new BugBot(ctx.desk, { fetcher: await mkFetcher(ctx.calls) });
  await bot.handleUpdate(groupMsg({ text: '@rexbugbot please add dark mode', entities: [{ type: 'mention', offset: 0, length: 10 }] }), bugBotLink(ctx.store));
  reports = ctx.store.list('bugreport');
  assert.equal(reports[0].status, 'feature');
  assert.ok(ctx.calls.find(c => c.method === 'sendMessage' && /request #\d/i.test(c.body.text)));

  // chat
  ctx = makeDesk({ groups: [{ id: '-100' }], jevAnswers: { kind: { choice: 'chat' }, severity: { score: 0 } } });
  bot = new BugBot(ctx.desk, { fetcher: await mkFetcher(ctx.calls) });
  await bot.handleUpdate(groupMsg({ text: '@rexbugbot thanks team!', entities: [{ type: 'mention', offset: 0, length: 10 }] }), bugBotLink(ctx.store));
  assert.equal(ctx.store.list('bugreport').length, 0);
});

test('reply linking: a reply to the "Got it, #N" ack adds to that report', async () => {
  const { desk, store, calls } = makeDesk({ groups: [{ id: '-100' }] });
  const bot = new BugBot(desk, { fetcher: await mkFetcher(calls) });
  // Seed report #5 and remember its ack message id 8001.
  store.put('bugreport', 'bug-5', { id: 'bug-5', num: 5, groupId: '-100', reporterId: '42', status: 'queued', text: 'first note', media: [], createdAt: '2026-01-02' });
  store.put('bugmsg', '8001', { id: '8001', groupId: '-100', num: 5, linkId: 'bugs' });
  await bot.handleUpdate(groupMsg({ text: 'and it also freezes', reply_to_message: { message_id: 8001 } }), bugBotLink(store));
  const report = store.get('bugreport', 'bug-5');
  assert.equal(report.adds.length, 1);
  assert.match(report.adds[0].text, /freezes/);
  assert.ok(calls.find(c => c.method === 'sendMessage' && /Added to #5/.test(c.body.text)));
});

test('reply linking: a bare follow-up attaches to the sender one open report (no Jev call)', async () => {
  const { desk, store, calls } = makeDesk({ groups: [{ id: '-100' }] });
  const bot = new BugBot(desk, { fetcher: await mkFetcher(calls) });
  store.put('bugreport', 'bug-9', { id: 'bug-9', num: 9, groupId: '-100', reporterId: '42', status: 'queued', text: 'the thing', media: [], createdAt: '2026-01-02' });
  await bot.handleUpdate(groupMsg({ text: 'here is a screenshot detail' }), bugBotLink(store));
  assert.equal(store.get('bugreport', 'bug-9').adds.length, 1);
});

test('approve: a queued bug becomes a task for the App Agent and leaves the hidden queue', async () => {
  const { desk, store, createdTasks } = makeDesk({ groups: [{ id: '-100' }] });
  store.put('specialist', 'app', { id: 'app', name: 'RexDesk_App_Agent' });
  const bot = new BugBot(desk, {});
  store.put('bugreport', 'bug-3', { id: 'bug-3', num: 3, groupId: '-100', reporterId: '42', status: 'queued', hidden: true, text: 'crash on save', severity: 4, media: [], createdAt: '2026-01-02' });
  bot.approve('bug-3');
  await new Promise(r => setTimeout(r, 0));
  const report = store.get('bugreport', 'bug-3');
  assert.equal(report.approved, true);
  assert.equal(report.hidden, false);
  assert.equal(createdTasks.length, 1);
  assert.equal(createdTasks[0].assignee, 'RexDesk_App_Agent');
});

// A fetcher that records Telegram calls, shared by the live-flow tests.
async function mkFetcher(calls) {
  return async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : {};
    const method = String(url).split('/').pop();
    calls.push({ method, body });
    if (method === 'getChatMember') return { ok: true, json: async () => ({ ok: true, result: { status: 'member' } }) };
    if (method === 'sendMessage') return { ok: true, json: async () => ({ ok: true, result: { message_id: 8000 + calls.length } }) };
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
}

test('picker: a button only attaches the held text for its own reporter, group and offered reports', async () => {
  const { desk, store, calls } = makeDesk({ groups: [{ id: '-100' }, { id: '-200' }] });
  const bot = new BugBot(desk, { fetcher: await mkFetcher(calls) });
  for (const [num, reporterId, groupId] of [[1, '42', '-100'], [2, '42', '-100'], [3, '77', '-100'], [4, '42', '-200']]) {
    store.put('bugreport', `bug-${num}`, { id: `bug-${num}`, num, groupId, reporterId, status: 'queued', text: `report ${num}`, media: [], createdAt: `2026-01-0${num}` });
  }
  await bot.handleUpdate(groupMsg({ text: 'held secret detail' }), bugBotLink(store));
  const [held] = store.list('bugpick');
  assert.deepEqual(held.nums.sort(), [1, 2]);
  const button = num => `pick:${held.id}:${num}`;
  const press = (data, from = 42, chatId = -100) => bot.handleUpdate({ callback_query: { id: 'q', data, from: { id: from }, message: { message_id: 9, chat: { id: chatId } } } }, bugBotLink(store));
  await press(button(1), 77); // someone else presses the button
  await press(button(3)); // a report the picker never offered
  await press(button(4), 42, -200); // the same reporter's report in another group
  await press('pick:1'); // an old-style button with no picker id
  for (const num of [1, 2, 3, 4]) assert.equal(store.get('bugreport', `bug-${num}`).adds, undefined, `#${num} untouched`);
  await press(button(2));
  assert.match(store.get('bugreport', 'bug-2').adds[0].text, /held secret detail/);
  assert.equal(store.list('bugpick').length, 0);
});
