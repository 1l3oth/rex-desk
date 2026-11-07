import test from 'node:test';
import assert from 'node:assert/strict';
import { actions, Computer, bestMatch, parseKeys, checkParams, settingsPages } from '../src/computer.js';
import { Commander, parsePlan, quickMatch } from '../src/command.js';
import { cleanTranscript, Voice } from '../src/voice.js';

// A Windows computer whose PowerShell worker is replaced by a recorder.
function fakeWindows(answer = () => ({})) {
  const calls = [];
  const computer = new Computer({ platform: 'win32', runner: { call: async (script, args) => { calls.push({ script, args }); return answer(script, args, calls.length); }, stop() {} } });
  return { computer, calls };
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('every action works on Windows, names what it does, and has a unique id', () => {
  assert.equal(new Set(actions.map(action => action.id)).size, actions.length);
  for (const action of actions) {
    assert.ok(action.win, `${action.id} has a Windows implementation`);
    assert.ok(action.does.length > 15, `${action.id} explains itself to Jev`);
  }
  const mac = new Computer({ platform: 'darwin' }).catalog();
  assert.ok(mac.filter(action => action.available).length >= 50, 'most actions work on macOS too');
  assert.equal(mac.find(action => action.id === 'hibernate').available, false);
  for (const [win] of Object.values(settingsPages)) assert.match(win, /^ms-settings:/);
});

test('spoken names, keys, and values are checked before anything runs', () => {
  const apps = [{ name: 'Google Chrome' }, { name: 'Calculator' }, { name: 'Microsoft Edge' }];
  assert.equal(bestMatch('chrome', apps, app => app.name).name, 'Google Chrome');
  assert.equal(bestMatch('calc', apps, app => app.name).name, 'Calculator');
  assert.equal(bestMatch('photoshop', apps, app => app.name), null);
  assert.deepEqual(parseKeys('Ctrl + Shift + T'), ['ctrl', 'shift', 't']);
  assert.throws(() => parseKeys(''), /one to five keys/);
  const volume = actions.find(action => action.id === 'volume_set');
  assert.deepEqual(checkParams(volume, { level: '150' }), { level: 100 });
  assert.throws(() => checkParams(volume, {}), /needs level/);
  assert.throws(() => checkParams(actions.find(action => action.id === 'power_mode'), { mode: 'turbo' }), /must be one of/);
  assert.deepEqual(checkParams(actions.find(action => action.id === 'dark_mode'), { on: 'yes' }), { on: true });
});

test('Windows actions go to the worker with their values, and sleep answers before it happens', async () => {
  const { computer, calls } = fakeWindows((script, args) => script.includes('RexDesk.Audio') ? { level: args.level ?? 50, muted: false } : { done: true });
  const result = await computer.run('volume_down', { step: 20 });
  assert.equal(result.result.level, 30);
  assert.equal(calls.at(-1).args.level, 30);
  await assert.rejects(computer.run('stop_program', { name: 'csrss' }), /keeps Windows or Rex Desk running/);
  await assert.rejects(computer.run('open_url', { url: 'file:///C:/Windows' }), /Only web addresses/);
  const before = calls.length, sleep = await computer.run('sleep');
  assert.equal(sleep.scheduled, true);
  assert.equal(calls.length, before, 'the computer has not gone to sleep yet');
});

test('Jev picks the action and the planner fills its values', async () => {
  const { computer, calls } = fakeWindows((script, args) => ({ level: args.level ?? 50, muted: false }));
  const requests = [];
  const fetcher = async (url, options) => {
    const payload = JSON.parse(options.body); requests.push({ url, payload });
    if (url.endsWith('/systemone')) return json({ answers: { action: { choice: payload.state.request.includes('loud') ? 'volume_set' : payload.state.request.includes('hush') ? 'mute' : 'none' } } });
    return json({ choices: [{ message: { content: '{"steps":[{"action":"volume_set","params":{"level":70}}],"say":"Setting the volume to 70%."}' } }] });
  };
  const commander = new Commander(computer, { apiKey: () => 'key', fetcher });
  const loud = await commander.perform('make it loud, 70 percent');
  assert.equal(loud.via, 'jev+planner');
  assert.equal(loud.done, true);
  assert.equal(calls.at(-1).args.level, 70);
  assert.ok(Object.keys(requests[0].payload.questions.action.criteria).includes('several'));
  assert.ok(requests[1].payload.messages[0].content.includes('volume_set'), 'the planner sees only the chosen action');
  // An action with nothing to fill in runs straight from Jev's choice, without the planner.
  requests.length = 0;
  const mute = await commander.perform('hush the speakers please');
  assert.equal(mute.via, 'jev'); assert.equal(requests.length, 1);
  const none = await commander.perform('what is the capital of France');
  assert.equal(none.steps.length, 0);
});

test('shutdown-like actions wait for a yes unless confirmations are off', async () => {
  const { computer } = fakeWindows();
  const plan = async () => '{"steps":[{"action":"shutdown","params":{}}],"say":"Shutting down."}';
  const asking = new Commander(computer, { planner: plan, settings: () => ({ confirm: true }) });
  const result = await asking.perform('shut the computer down');
  assert.deepEqual(result.needsConfirm, ['Shut down']);
  assert.equal(result.results.length, 0);
  const trusting = new Commander(computer, { planner: plan, settings: () => ({ confirm: false }) });
  assert.equal((await trusting.perform('shut the computer down')).results[0].ok, true);
});

test('everyday commands in English, Korean, and Khmer run at once, without a model', async () => {
  const action = text => quickMatch(text)?.steps.map(step => `${step.action}${Object.keys(step.params).length ? JSON.stringify(step.params) : ''}`).join(' ') ?? null;
  assert.equal(action('Turn the volume down'), 'volume_down');
  assert.equal(action('볼륨 좀 줄여줘'), 'volume_down');
  assert.equal(action('បន្ថយសំឡេង'), 'volume_down');
  assert.equal(action('set the volume to 30%'), 'volume_set{"level":30}');
  assert.equal(action('음소거 해제'), 'unmute');
  assert.equal(action('mute'), 'mute');
  assert.equal(action('turn off bluetooth'), 'bluetooth{"on":false}');
  assert.equal(action('와이파이 켜줘'), 'wifi{"on":true}');
  assert.equal(action('បិទកាមេរ៉ា'), 'camera{"on":false}');
  assert.equal(action('Open Bluetooth settings'), 'open_settings{"page":"bluetooth"}');
  assert.equal(action('다크 모드 켜줘'), 'dark_mode{"on":true}');
  assert.equal(action('lock the computer'), 'lock');
  // Several steps, or anything unclear, go to Jev and the planner instead.
  assert.equal(action('open Chrome and search for the weather'), null);
  assert.equal(action('sleep and wake up in 5 hours'), null);
  assert.equal(action('shut the computer down'), null);
  const { computer } = fakeWindows(() => ({ level: 40, muted: false }));
  const result = await new Commander(computer, { planner: async () => { throw new Error('no model should be asked'); } }).perform('볼륨 줄여');
  assert.equal(result.via, 'instant'); assert.equal(result.done, true);
});

test('a plan keeps only known actions and at most eight steps', () => {
  const known = new Set(['open_app', 'type_text']);
  const plan = parsePlan('Sure! {"steps":[{"action":"open_app","params":{"name":"Notepad"}},{"action":"format_disk"},{"action":"type_text","params":{"text":"សួស្តី"}}],"say":"Opening Notepad."}', known);
  assert.deepEqual(plan.steps.map(step => step.action), ['open_app', 'type_text']);
  assert.equal(plan.steps[1].params.text, 'សួស្តី');
  assert.throws(() => parsePlan('no json here', known), /JSON/);
});

test('the voice engine answer loses its language prefix, and an uninstalled engine says how to install it', async () => {
  assert.equal(cleanTranscript('language Korean<asr_text>볼륨을 줄여 주세요.'), '볼륨을 줄여 주세요.');
  assert.equal(cleanTranscript('Turn it down'), 'Turn it down');
  const voice = new Voice('Z:/nowhere/voice', { platform: 'win32' });
  assert.equal(voice.status().installed, false);
  await assert.rejects(voice.transcribe(Buffer.from('RIFF'), 'km'), /not installed/);
  await assert.rejects(voice.transcribe(Buffer.from('RIFF'), 'fr'), /Khmer \(km\), English \(en\), and Korean \(ko\)/);
});
