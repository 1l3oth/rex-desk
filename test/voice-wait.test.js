import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { Voice, voiceThreads } from '../src/voice.js';

test('when the free on-computer voice is not set up, the mic offers to set it up here (no silent wait, no "go to Settings" dead end)', () => {
  const composer = readFileSync(new URL('../public/chat-composer.js', import.meta.url), 'utf8');
  // The mic asks to set up the free on-computer voice and starts the download itself, rather than only pointing at Settings.
  assert.match(composer, /async function offerInstallVoice\(ctx\)/);
  assert.match(composer, /ctx\.api\('\/voice\/install', \{ method: 'POST' \}\)/, 'the mic starts the install itself');
  assert.match(composer, /if \(\/not installed\|\\binstall\\b\/i\.test\(error\.message\) && await offerInstallVoice\(ctx\)\) return;/, 'a not-installed error offers the free setup before anything else');
  // The download does not block dictation: it watches in the background and tells the person when it is ready.
  assert.match(composer, /function watchInstallVoice\(ctx\)/);
  assert.match(composer, /Voice on this computer is ready/);
  assert.doesNotMatch(composer, /Voice is not installed yet\. Install it in Settings/, 'the old Settings-only dead end is gone');
});

test('the Voice dialog says plainly that browser dictation sends voice to the browser maker, and the chosen engine is used in the app', () => {
  const composer = readFileSync(new URL('../public/chat-composer.js', import.meta.url), 'utf8');
  // Browser speech recognition is tried before the chosen engine (the free live path on phones), so the dialog must be
  // explicit that, in a browser, the audio goes to the browser's own speech service, not to the picked engine.
  assert.match(composer, /browserSpeech !== 'no' \? `<p class="muted small">/, 'the note shows only when browser speech is actually in use');
  assert.match(composer, /sends your voice to the browser maker/, 'the dialog names where browser audio goes');
  assert.match(composer, /The engine you pick above is used in the Rex Desk app/, 'the dialog says the chosen engine wins in the app');
});

test('a voice model that is still loading answers "still starting" quickly and keeps loading, with no engine log', async () => {
  const voice = new Voice(mkdtempSync(path.join(process.env.REX_TEST_TMP || os.tmpdir(), 'voice-wait-')));
  let loaded; const loading = new Promise(resolve => { loaded = resolve; });
  voice.server = key => { voice.servers.set(key, { since: Date.now() - 5000, up: false }); return loading; };
  const started = Date.now();
  await assert.rejects(voice.transcribe(Buffer.from('wav'), 'en', { waitMs: 50 }), error => error.starting === true && /still starting/.test(error.message) && !/\x1b|llama/.test(error.message));
  assert.ok(Date.now() - started < 2000);
  const starting = voice.status().starting;
  assert.equal(starting.length, 1); assert.ok(starting[0].seconds >= 5);
  loaded({ url: 'http://127.0.0.1:1' });
});

test('the server waits about 20 seconds for the local model, then says it is still starting and never uploads instead', () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(source, /LOCAL_VOICE_WAIT_MS = 20000/);
  assert.match(source, /still starting\. Try again in a moment/);
  assert.doesNotMatch(source, /is still starting, so/);
});

test('the on-computer voice engine is pinned to half the logical CPUs, so it never oversubscribes a hyper-threaded machine', () => {
  // Half the logical count matches the physical cores on common hyper-threaded hardware and leaves headroom for the
  // rest of the app; it never exceeds the real cores, which is what slows every transcription on a loaded laptop.
  assert.equal(voiceThreads(12), 6, 'the 6-core/12-thread i7-8750H gets its 6 physical cores');
  assert.equal(voiceThreads(8), 4);
  assert.equal(voiceThreads(16), 8);
  assert.equal(voiceThreads(4), 2);
  assert.equal(voiceThreads(2), 2, 'a 2-thread machine keeps both');
  assert.equal(voiceThreads(1), 1, 'a single-core machine gets one thread, not zero');
  // The engine actually receives the thread count (and the same for batch), rather than letting llama grab every logical CPU.
  const source = readFileSync(new URL('../src/voice.js', import.meta.url), 'utf8');
  assert.match(source, /'--threads', threads, '--threads-batch', threads/, 'both --threads and --threads-batch are passed');
});

test('the final pass only re-hears the uncommitted tail, not the whole recording, so a long dictation finishes in a few seconds', () => {
  const composer = readFileSync(new URL('../public/chat-composer.js', import.meta.url), 'utf8');
  const voiceLive = readFileSync(new URL('../public/voice-live.js', import.meta.url), 'utf8');
  // The live loop records where the committed words end on the recording, so the final pass can start from there.
  assert.match(composer, /recording\.liveKept = kept; recording\.liveFrom = from;/, 'each committed cut advances the live cursor on the recording');
  // The path is chosen by the shared finalPass, so the app and the QA harness pick the same one.
  assert.match(composer, /import \{ LIVE_EVERY_MS, livePieces, finalPass, finalChunks, voicedSeconds, looksTruncated, pickFinal, joinWindows, withinBudget, WINDOWED_FINAL_BUDGET_MS, needsWarm \} from '\/voice-live\.js';/, 'the composer uses the shared cut, final-pass and truncation logic');
  assert.match(composer, /const pass = finalPass\(recording\);/, 'finishMic asks finalPass which path to take');
  // finalPass hears only the tail after the last cut, and reports the tail-only path when there is audio after it.
  assert.match(voiceLive, /const tail = from > 0 \? recording\.chunks\.slice\(from\) : \[\];/, 'the final pass hears only the tail after the last cut');
  assert.match(voiceLive, /if \(tail\.length\) return \{ path: 'tail'/, 'any non-empty tail is the tail-only pass');
  assert.doesNotMatch(composer, /tailSeconds/, 'the old 300 ms skip is gone');
  assert.match(composer, /finalText = \[pass\.kept, tailText\]\.filter\(Boolean\)\.join\(' '\);/, 'the committed words and the fresh tail make the final text');
  assert.match(composer, /liveShow\(ctx, live, finalText, \{ final: true \}\);/, 'the final text is shown once, after the truncation guard');
  // A recording that never committed anything is heard whole, in short windows, within the shared deadline.
  assert.match(composer, /finalText = await hearInWindows\(ctx, recording, deadline\);/, 'nothing-committed recordings hear the whole recording in windows');
  // Model-not-ready still bubbles so the install/online offer runs.
  assert.ok(composer.includes("if (error.starting || /not installed|\\binstall\\b/i.test(error.message || '')) throw error;"), 'not-ready errors still bubble to the install/online offer');
  // A tail that fails for any other reason never finalizes partial text: the whole recording is heard instead.
  const tailBlock = composer.slice(composer.indexOf("if (pass.path === 'tail') {"), composer.indexOf('const voiced = voicedSeconds(recording);'));
  assert.match(tailBlock, /finalText = await hearInWindows\(ctx, recording, deadline\);/, 'a failed tail falls back to the whole recording (in windows), not the committed words alone');
});

test('the whole-recording final is heard in short windows, and a still-truncated final errors without saving partial text', () => {
  const composer = readFileSync(new URL('../public/chat-composer.js', import.meta.url), 'utf8');
  const voiceLive = readFileSync(new URL('../public/voice-live.js', import.meta.url), 'utf8');
  // The windowing and the too-short check live in the shared module, so the app and the QA harness behave the same.
  assert.match(voiceLive, /export function finalChunks\(recording/, 'the shared windowing for the final pass');
  assert.match(voiceLive, /export function looksTruncated\(text, voicedSeconds\)/, 'a shared check for a suspiciously short answer, judged against voiced speech time');
  assert.match(voiceLive, /export function voicedSeconds\(recording\)/, 'voiced speech time ignores leading, trailing and in-between silence');
  assert.match(voiceLive, /MIN_WORDS_PER_S = 0\.5, MIN_CHARS_PER_S = 1\.5, MIN_CHECK_S = 8/, 'word and character floors far below real speech, only long voiced spans checked');
  // hearInWindows sends one short request per window, each short enough to complete under load; a short clip stays one request.
  assert.match(composer, /async function hearInWindows\(ctx, recording, deadline\) \{/, 'the whole recording is heard in short windows, within the shared deadline');
  assert.match(composer, /const windows = finalChunks\(recording\);/, 'the windows come from the shared finalChunks');
  assert.match(composer, /if \(windows\.length <= 1\) return hearWavWithin\(ctx, recording\.wav\(\), deadline\);/, 'a short recording is still one request, and it goes through the shared deadline too');
  assert.match(composer, /wavFrom\(recording\.chunks\.slice\(from, to\), recording\.rate\), deadline\)/, 'each window is sent as its own short request, within the deadline');
  // Fail closed: the windows are joined by the shared joinWindows, which skips only a no-speech window and fails the whole
  // final if a spoken window comes back empty, so a subset of the phrases is never returned as if it were complete.
  assert.match(voiceLive, /export async function joinWindows\(windows, voicedOf, hearOne\)/, 'the shared fail-closed window join');
  assert.match(voiceLive, /if \(voicedOf\(from, to\) <= 0\) continue;/, 'only a window with no speech at all is skipped, so a short word is never dropped');
  assert.match(voiceLive, /if \(!text\) throw Object\.assign\(new Error\([^)]*\), \{ busy: true \}\);/, 'a spoken window that comes back empty fails the whole final');
  assert.match(voiceLive, /WINDOWED_FINAL_BUDGET_MS = 180000/, 'the whole windowed final gets one overall budget longer than the 120s single-request timeout');
  assert.match(voiceLive, /export function withinBudget\(promise, msLeft, expired\)/, 'a shared race that cuts an in-flight request at the time left');
  assert.match(composer, /return await joinWindows\(windows, voicedOf, hearOne\);/, 'the composer joins the windows fail-closed');
  assert.match(composer, /const tooBusy = \(\) => Object\.assign\(new Error\(t\('This computer is too busy[^']*'\)\), \{ truncated: true \}\);/, 'the failure says the computer is too busy and clears the box');
  // One deadline for the whole final pass, computed once and threaded through the tail, the windows, the single clip and the retry.
  assert.match(composer, /async function hearWavWithin\(ctx, wav, deadline\) \{/, 'one helper hears a wav within the shared deadline');
  assert.match(composer, /await withinBudget\(hearWords\(ctx, wav\), left, tooBusy\)/, 'the in-flight request is raced against the time left in the budget, so a stalled one is cut off');
  assert.match(composer, /const deadline = Date\.now\(\) \+ WINDOWED_FINAL_BUDGET_MS;/, 'the deadline is computed once when the final pass starts');
  assert.match(composer, /retry = await hearInWindows\(ctx, recording, deadline\);/, 'the retry shares the same deadline, so it only gets the time left');
  // The whole-recording final uses the windows directly, not one long request.
  const wholeBlock = composer.slice(composer.indexOf('} else {', composer.indexOf("if (pass.path === 'tail')")), composer.indexOf('const voiced = voicedSeconds(recording);'));
  assert.match(wholeBlock, /finalText = await hearInWindows\(ctx, recording, deadline\);/, 'the whole pass is heard in windows, never one long request');
  // A suspiciously short final is re-heard once and the fuller kept; it is discarded only if it is STILL far too short
  // for a long voiced span, so a complete or short transcript is never cleared, only a genuinely cut-off one.
  assert.match(composer, /const voiced = voicedSeconds\(recording\);/, 'the check is against voiced speech time, not the whole recording');
  assert.match(composer, /if \(looksTruncated\(finalText, voiced\)\) \{/, 'a short-looking answer enters the re-hear path');
  assert.match(composer, /retry = await hearInWindows\(ctx, recording, deadline\);/, 'the suspect answer is re-heard once, the engine warm by now, sharing the same deadline');
  assert.match(composer, /finalText = pickFinal\(finalText, retry, voiced\);/, 'pickFinal keeps the candidate that passes the guard, not merely the longer string');
  assert.match(composer, /if \(looksTruncated\(finalText, voiced\)\) throw Object\.assign\(new Error\(t\('The voice model returned only part of what was said[^']*'\)\), \{ truncated: true \}\);/, 'only a still-too-short answer surfaces an error instead of finalizing it');
  assert.match(composer, /liveShow\(ctx, live, ''\);/, 'any failed final pass clears the box so partial dictation is never left to send');
});

test('microphone errors keep their real name', async () => {
  const source = readFileSync(new URL('../public/recorder.js', import.meta.url), 'utf8');
  for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError']) assert.match(source, new RegExp(`name === '${name}'`));
  const composer = readFileSync(new URL('../public/chat-composer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(composer, /catch \{[^}]*could not use the microphone/);
});

test('the voice guide has the same steps in English, Khmer and Korean, and recordings stay on this computer unless an online engine was chosen', () => {
  const composer = readFileSync(new URL('../public/chat-composer.js', import.meta.url), 'utf8');
  const guide = /VOICE_GUIDE = \{([\s\S]*?)\n\};/.exec(composer)[1];
  for (const language of ["en", "km", "ko"]) assert.ok(guide.includes(`  ${language}: [`), language);
  assert.doesNotMatch(composer, /<select data-v-language/);
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(server, /\?\.engine \|\| 'local';/);
  assert.match(server, /wanted === 'local' && !ready\.local\) return json\(response, 400/);
});

// liveShow from the page, run against a fake message box.
function liveHarness() {
  const composer = readFileSync(new URL('../public/chat-composer.js', import.meta.url), 'utf8');
  const block = start => { const at = composer.indexOf(start); return composer.slice(at, composer.indexOf(start.startsWith('const') ? '\n' : '\n}', at) + (start.startsWith('const') ? 0 : 2)); };
  const code = ['let liveNow = null, liveTyping = null, listening = null, micStarts = 0; const micButton = () => null, hold = {}, t = text => text;', ...['function liveStart', 'function liveWatch', 'function liveEdit', 'function liveShow', 'function liveWaiting', 'export function endDictation'].map(block)].join('\n').replace('export function', 'function');
  const box = { value: '', getAttribute: () => '', setAttribute() {}, classList: { toggle() {} }, focus() {}, dispatchEvent() {} }; let key = 'a';
  const ctx = { draftKey: () => key, ui: { drafts: new Map() } };
  const run = new Function('document', 'Event', `${code}; return { liveStart, liveShow, liveEdit, endDictation, listen: turn => { listening = turn; }, listening: () => listening };`)({ getElementById: () => box, body: { classList: { remove() {} } } }, class {});
  return { box, ctx, ...run, switchTo: next => { key = next; } };
}
test('live words keep text typed before, after or inside them, and stay with the chat they started in', () => {
  const { box, ctx, liveStart, liveShow, switchTo } = liveHarness();
  box.value = 'Hi'; const live = liveStart(ctx);
  liveShow(ctx, live, 'fix the'); assert.equal(box.value, 'Hi fix the');
  box.value = 'Hi fix the, please';
  liveShow(ctx, live, 'fix the login'); assert.equal(box.value, 'Hi fix the login, please', 'typed after the words stays after them, no repeat');
  box.value = 'Hi fix it, please';
  liveShow(ctx, live, 'fix the login button'); assert.equal(box.value, 'Hi fix it button, please', 'edited words stay as typed, newer words go after the edit');
  const other = liveStart(ctx); switchTo('b'); box.value = 'other chat';
  liveShow(ctx, other, 'hello', { final: true });
  assert.equal(box.value, 'other chat', 'the open chat is not touched'); assert.equal(ctx.ui.drafts.get('a'), 'Hi fix it button, please hello', 'the words land in the chat they started in');
  // Text typed after the words that repeats them is the person's own, never replaced.
  const again = liveHarness(); again.box.value = 'Hi'; const said = again.liveStart(again.ctx);
  again.liveShow(again.ctx, said, 'yes'); again.box.value = 'Hi yes yes';
  again.liveShow(again.ctx, said, 'yes please'); assert.equal(again.box.value, 'Hi yes please yes');
  again.box.value = `Oh ${again.box.value}`;
  again.liveShow(again.ctx, said, 'yes please now'); assert.equal(again.box.value, 'Oh Hi yes please now yes', 'typed before the words moves them along');
});

test('live words follow the exact place the person typed, even when the typed words match the spoken ones', () => {
  const { box, ctx, liveStart, liveShow, liveEdit } = liveHarness();
  const type = (from, to, text) => { const before = box.value; box.value = before.slice(0, from) + text + before.slice(to); liveEdit(live, before, from, to, box.value, from + text.length); };
  box.value = 'Hi'; const live = liveStart(ctx);
  liveShow(ctx, live, 'yes'); assert.equal(box.value, 'Hi yes');
  type(3, 3, 'yes '); assert.equal(box.value, 'Hi yes yes');
  liveShow(ctx, live, 'yes please'); assert.equal(box.value, 'Hi yes yes please', 'typed right before the words: the typed copy stays, the dictated one changes');
  type(box.value.length, box.value.length, ' ok'); liveShow(ctx, live, 'yes please now'); assert.equal(box.value, 'Hi yes yes please now ok', 'typed right after them stays after');
  // Typed between the dictation's own leading space and its first word: still before the words, so a correction replaces them.
  const fixed = liveHarness(); fixed.box.value = 'Hi'; const heard = fixed.liveStart(fixed.ctx);
  fixed.liveShow(fixed.ctx, heard, 'yes'); const was = fixed.box.value; fixed.box.value = 'Hi yes yes'; fixed.liveEdit(heard, was, 3, 3, fixed.box.value, 7);
  fixed.liveShow(fixed.ctx, heard, 'yesterday'); assert.equal(fixed.box.value, 'Hi yes yesterday', 'the corrected word replaces the dictated one, not split around the typed copy');
  // A backspace inside the words: what is left stays as typed, newer words go after it.
  const before = box.value; box.value = before.slice(0, 20) + before.slice(21); liveEdit(live, before, 21, 21, box.value, 20);
  liveShow(ctx, live, 'yes please now go'); assert.equal(box.value, 'Hi yes yes please no go ok');
});

test('a Voice mode turn sends only into the chat it started in, and a cancelled one sends nothing', () => {
  const composer = readFileSync(new URL('../public/chat-composer.js', import.meta.url), 'utf8');
  assert.match(composer, /if \(!said \|\| !alive\(\)\) \{ onState\('idle'\); return; \}/, 'browser Voice mode drops words after a chat switch');
  assert.ok(composer.indexOf('const turnOf = voiceTurns') < composer.indexOf('await browserTurn(ctx, onState, alive)'), 'the chat is taken before the mic opens');
  assert.match(composer, /if \(!alive\(\)\) \{ stream\.getTracks\(\)\.forEach\(track => track\.stop\(\)\); return 'cancelled'; \}/);
  assert.match(composer, /cancelVoiceTurn\(\) \{ voiceTurns\+\+/);
  assert.match(composer, /if \(started\?\.blocked\) \{ if \(!alive\(\)\) return true;/, 'a mic failure after a switch is a cancel, so Voice mode is not turned off in the new chat');
  assert.match(composer, /catch \(error\) \{ if \(!alive\(\)\) return true; ctx\.toast\(micProblem\(error\)/);
  assert.match(composer, /hearWords\(ctx, recording\.wav\(\), \{ alive \}\); if \(alive\(\)\) await sendSpoken/);
  assert.match(composer, /if \(!alive\(\)\) throw Object\.assign\(new Error\('cancelled'\)/);
});

test('Send ends a dictation, so its later words never bring the sent message back into the cleared box', () => {
  const { box, ctx, liveStart, liveShow, endDictation, listen, listening } = liveHarness();
  box.value = 'Hi'; const live = liveStart(ctx); let stopped = 0;
  listen({ live, stop: () => { stopped++; } });
  liveShow(ctx, live, 'fix the login'); assert.equal(box.value, 'Hi fix the login');
  endDictation(); box.value = ''; ctx.ui.drafts.delete('a');
  liveShow(ctx, live, 'fix the login button'); liveShow(ctx, live, 'fix the login button', { final: true });
  assert.equal(box.value, '', 'the box stays empty after Send'); assert.equal(ctx.ui.drafts.has('a'), false, 'no draft is made again');
  assert.equal(stopped, 1, 'the mic stops'); assert.equal(listening(), null);
  const chat = readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8'), at = chat.indexOf('endDictation();');
  assert.ok(at > chat.indexOf('async function send()') && at < chat.indexOf("box.value = ''; box.style.height = ''"), 'send() ends the dictation before clearing the box');
  // A Voice mode turn is not a dictation: Send leaves it listening. A mic still opening when Send came never starts.
  const composer = readFileSync(new URL('../public/chat-composer.js', import.meta.url), 'utf8');
  assert.match(composer, /const turn = \{ voiceTurn: true, stop:/, 'browser Voice mode is marked like the desktop one');
  assert.match(composer, /export function endDictation\(\) \{\n  micStarts\+\+;/);
  assert.equal(composer.match(/if \(start !== micStarts\)/g)?.length, 4, 'every mic start (browser dictation, mic button, held Space twice) checks for a Send while it opened');
  assert.match(composer, /if \(start !== micStarts\) \{ hold\.active = hold\.releasedEarly = false; return; \}/, 'a held Space let go while the mic opened does not stop the next one');
  assert.match(composer, /if \(start !== micStarts\) \{ hold\.active = hold\.pending = hold\.releasedEarly = false;/);
});

test('desktop live words are heard in short pieces cut at a quiet moment, so they keep coming however long the person talks', async () => {
  const composer = readFileSync(new URL('../public/chat-composer.js', import.meta.url), 'utf8');
  const { livePieces } = await import('../public/voice-live.js');
  const per = 4096 / 48000, chunks = seconds => Array.from({ length: Math.round(seconds / per) }, () => 0);
  const need = Math.max(2, Math.ceil(0.5 / per)); // a sustained pause is about half a second of chunks below the floor
  const hush = (rec, at, count = need) => { for (let i = 0; i < count; i++) rec.levels[at + i] = 0.001; return rec; };
  const short = { rate: 48000, chunks: chunks(4), levels: chunks(4).map(() => 0.1) };
  assert.deepEqual(livePieces(short), { cut: 0, end: short.chunks.length }, 'under 5 seconds: the whole part is heard');
  // A sustained pause (half a second of silence) starting around 4 seconds commits at the start of that silence.
  const atPause = Math.round(4 / per);
  const long = hush({ rate: 48000, chunks: chunks(7), levels: chunks(7).map(() => 0.1) }, atPause);
  assert.equal(livePieces(long).cut, atPause, 'cut at the start of a sustained pause after 2.5 seconds');
  assert.equal(livePieces(long, atPause).cut, 0, 'the next part starts at the cut and is short again');
  // Continuous speech with no pause: nothing is committed, so no cut can land mid-word and the final pass can still repair it.
  const talky = { rate: 48000, chunks: chunks(7), levels: chunks(7).map(() => 0.1) };
  assert.equal(livePieces(talky).cut, 0, 'no pause in the window means no mid-word commit');
  // Quiet speech that dips below the floor for a single chunk is a soft syllable, not a pause: no commit (the reviewer's case).
  const oneDip = { rate: 48000, chunks: chunks(7), levels: chunks(7).map(() => 0.1) }; oneDip.levels[atPause] = 0.001;
  assert.equal(livePieces(oneDip).cut, 0, 'one low chunk in quiet speech is not a sustained pause and does not commit');
  // A near-silent run that is still above the speech floor is not a real pause either.
  const dip = hush({ rate: 48000, chunks: chunks(7), levels: chunks(7).map(() => 0.1) }, atPause); for (let i = 0; i < need; i++) dip.levels[atPause + i] = 0.02;
  assert.equal(livePieces(dip).cut, 0, 'the run must be below the speech floor to count as a pause');
  // After a slow request a long backlog waits: only a sustained pause within the first 5 seconds commits.
  const backlog = hush({ rate: 48000, chunks: chunks(20), levels: chunks(20).map(() => 0.1) }, Math.round(18 / per));
  assert.equal(livePieces(backlog).cut, 0, 'a pause past the first 5 seconds is not used'); hush(backlog, Math.round(3 / per));
  assert.ok(livePieces(backlog).cut * per <= 5 && livePieces(backlog).cut > 0, 'a sustained pause inside the first 5 seconds cuts there');
  assert.match(composer, /if \(recording\.stopped \|\| words === null\) return;/, 'a failed request (engine warming up) keeps its piece for the next try');
  assert.match(composer, /wavFrom\(recording\.chunks\.slice\(start, stop\)/, 'each request sends only its own piece');
  assert.doesNotMatch(composer, /LIVE_SLOW_MS/, 'live words never give up for the rest of the turn');
});
