import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, defaults, now } from '../src/store.js';
import { parseIntent, matchesIntent, TrackerQuery } from '../src/query.js';
import { weeklyReport, thisWeek } from '../src/report.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const context = { sources: ['morningmate'], projects: [{ sourceId: 's', id: '257572', name: '[QA] Morningmate', followed: true }], fields: { Region: ['KR', 'JP'] }, statuses: ['Request', 'In Development'], people: [{ id: 'kim@flow.team', name: 'Kim' }] };
const blank = { sources: [], projects: [], assignee: 'anyone', status: 'any', statusNames: [], fields: {}, keyword: '', numberFrom: 0, numberTo: 0, createdFrom: '', createdTo: '', updatedFrom: '', updatedTo: '', dropped: [] };

test('the model only fills a filter, and anything the trackers do not offer is dropped and named', () => {
  const intent = parseIntent('Sure: {"projects":["[qa] morningmate","Secret project"],"assignee":"me","status":"request","fields":{"region":["jp","Mars"],"Color":["red"]},"numberFrom":"48000","createdFrom":"2026-13-40","keyword":" tray "}', context);
  assert.deepEqual(intent.projects, ['[QA] Morningmate']);
  assert.deepEqual(intent.fields, { Region: ['JP'] });
  assert.equal(intent.assignee, 'me'); assert.equal(intent.status, 'request'); assert.equal(intent.numberFrom, 48000); assert.equal(intent.createdFrom, ''); assert.equal(intent.keyword, 'tray');
  assert.deepEqual(intent.dropped.sort(), ['Region option "Mars"', 'field "Color"', 'project "Secret project"']);
  assert.equal(parseIntent('{"assignee":"nobody@x"}', context).assignee, 'anyone');
  assert.throws(() => parseIntent('no json here', context), /could not be understood/);
});

test('rows are checked against every part of the intent', () => {
  const task = { assignees: ['rex@flow.team'], statusName: 'Request', statusCategory: '0', fields: [{ name: 'Region', value: 'JP' }], title: 'Tray icon disappears', taskNumber: '48100', createdAt: '2026-11-03 10:00', updatedAt: '2026-11-05 09:00' };
  const me = new Set(['rex@flow.team']);
  assert.ok(matchesIntent(task, { ...blank, assignee: 'me', status: 'request', fields: { Region: ['JP'] }, keyword: 'tray', numberFrom: 48000, numberTo: 48200, createdFrom: '2026-11-01' }, { me }));
  assert.equal(matchesIntent(task, { ...blank, assignee: 'not-me' }, { me }), false);
  assert.equal(matchesIntent(task, { ...blank, status: 'done' }, { me }), false);
  assert.equal(matchesIntent(task, { ...blank, fields: { Region: ['KR'] } }, { me }), false);
  assert.equal(matchesIntent(task, { ...blank, createdTo: '2026-11-02' }, { me }), false);
  assert.equal(matchesIntent(task, { ...blank, statusNames: ['In Development'], status: 'request' }, { me }), false, 'a named status wins over the group');
});

test('a typed request is read live from the tracker with the assignee and option filters it honours', async () => {
  const store = new Store(temporary('query'));
  store.saveConfig({ ...defaults, sources: [{ id: 's', name: 'Morningmate', type: 'morningmate', baseUrl: 'https://api.morningmate.com', projectIds: ['257572'], userId: 'rex@flow.team', apiKey: 'key' }] });
  store.put('task', 's:257572:2', { id: 's:257572:2', active: true });
  const columns = [{ columnSrno: '1', columnType: 'USER', defaultColumnType: 'WORKER_ID', columnName: '' }, { columnSrno: '6', columnType: 'TEXT', defaultColumnType: 'TASK_NM', columnName: '' },
    { columnSrno: '989', columnType: 'OPTION', defaultColumnType: '', columnName: 'Region', options: [{ optionId: '5603', optionName: 'KR' }, { optionId: '5604', optionName: 'JP' }] }];
  const row = (taskId, title, status, category, region, worker) => ({ taskId, postId: `p${taskId}`, projectTitle: '[QA] Morningmate', columns: [
    { columnId: '12', columnType: 'STATUS', defaultColumnType: 'STATUS', columnData: [{ optionName: status, optionCategory: category }] },
    { columnId: '6', columnType: 'TEXT', defaultColumnType: 'TASK_NM', columnData: [{ customColumnData: title }] },
    { columnId: '989', columnType: 'OPTION', columnData: [{ optionName: region }] },
    { columnId: '1', columnType: 'USER', defaultColumnType: 'WORKER_ID', columnData: [{ customColumnData: worker }] }] });
  const requests = [];
  const sources = { request: async (source, endpoint) => {
    requests.push(endpoint);
    if (endpoint.endsWith('/columns')) return { columns };
    return { hasNext: false, tasks: [row('1', 'Old JP bug', 'Completed', '2', 'JP', 'rex@flow.team'), row('2', 'Tray icon JP', 'Request', '0', 'JP', 'rex@flow.team'), row('3', 'Someone else', 'Request', '0', 'JP', 'kim@flow.team')] };
  } };
  let prompt;
  const query = new TrackerQuery(store, sources, { model: async (instructions, input) => { prompt = input; return '{"assignee":"me","status":"open","fields":{"Region":["JP"]}}'; } });
  const result = await query.ask('my open JP tasks');
  assert.match(prompt, /my open JP tasks/); assert.match(prompt, /Region/); assert.doesNotMatch(prompt, /"key"/);
  const filter = JSON.parse(decodeURIComponent(requests.find(endpoint => endpoint.includes('/tasks/filter')).split('filterRecords=')[1]));
  assert.deepEqual(filter, [{ COLUMN_SRNO: '989', OPERATOR_TYPE: 'IN', FILTER_DATA: '5604' }, { COLUMN_SRNO: '1', OPERATOR_TYPE: 'IN', FILTER_DATA: 'rex@flow.team' }]);
  assert.deepEqual(result.rows.map(item => [item.title, item.onDesk]), [['Tray icon JP', true]]);
  store.close();
});

test('the weekly report lists each issue once with every run, commit and pull request in the range', async () => {
  const store = new Store(temporary('report'));
  store.saveConfig({ ...defaults, repositories: [{ id: 'web', name: 'flow-was', path: 'C:/flow-was', baseBranch: 'develop', targetBranch: 'develop' }] });
  store.put('task', 't1', { id: 't1', title: 'Tray icon', taskNumber: '41189', statusName: 'In Development', url: 'https://flow.team/l/abc', source: 'morningmate', projectName: '[QA] Morningmate' });
  store.put('run', 'r1', { id: 'r1', role: 'worker', taskId: 't1', repositoryId: 'web', branch: 'temp/rex/fix/tray', baseCommit: 'abc', state: 'published', prUrl: 'https://github.com/o/r/pull/7', prNumber: 7, createdAt: '2026-11-03T01:00:00Z', updatedAt: '2026-11-03T05:00:00Z' });
  store.put('run', 'r2', { id: 'r2', role: 'worker', taskId: 't1', repositoryId: 'web', branch: 'temp/rex/fix/gone', state: 'failed', prUrl: 'https://github.com/o/r/pull/8', createdAt: '2026-11-04T01:00:00Z' });
  store.put('run', 'old', { id: 'old', role: 'worker', taskId: 't1', repositoryId: 'web', branch: 'x', createdAt: '2026-10-01T01:00:00Z', updatedAt: '2026-10-01T02:00:00Z' });
  const ranges = [];
  const log = async (directory, range) => { ranges.push(range); if (range.includes('gone')) throw new Error('fatal: bad revision'); return 'a1b2c3d4e5f6\t2026-11-03T02:00:00Z\tfix(tray): keep the icon after update'; };
  const report = await weeklyReport(store, { from: '2026-11-02', to: '2026-11-06', log, pullCommits: async (directory, url) => [{ hash: 'ffff', at: '', subject: `from ${url}` }] });
  assert.equal(report.cards.length, 1);
  const [card] = report.cards;
  assert.deepEqual([card.number, card.status, card.url], ['41189', 'In Development', 'https://flow.team/l/abc']);
  assert.deepEqual(card.runs.map(run => [run.prUrl, run.commits.map(commit => commit.subject)]), [['https://github.com/o/r/pull/7', ['fix(tray): keep the icon after update']], ['https://github.com/o/r/pull/8', ['from https://github.com/o/r/pull/8']]]);
  assert.deepEqual(ranges.slice(0, 1), ['abc..temp/rex/fix/tray']);
  assert.ok(ranges.includes('develop..origin/temp/rex/fix/gone'), 'the pushed copy is tried before the pull request');
  assert.deepEqual(thisWeek(new Date(2026, 10, 6)), { from: '2026-11-02', to: '2026-11-06' });
  store.close();
});

test('an answer that is not JSON is asked again once before the request is refused', async () => {
  const answers = ['Here is the filter you asked for.', '{"assignee":"me"}'];
  const query = new TrackerQuery({}, {}, { model: async () => answers.shift() });
  assert.equal((await query.interpret('my tasks', context)).assignee, 'me');
  const events = [];
  const stubborn = new TrackerQuery({ event: (...args) => events.push(args) }, {}, { model: async () => 'no idea' });
  await assert.rejects(stubborn.interpret('my tasks', context), /could not be understood/);
  assert.equal(events[0][1], 'query-unreadable');
});
