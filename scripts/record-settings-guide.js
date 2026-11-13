// Records the Settings video guide: a fresh workspace, every Settings section opened in turn by a visible mouse pointer,
// with a Khmer subtitle and a Khmer voice for each line, plus soft click and swoosh sounds.
// Writes public/guides/settings-guide.webm and the chapter list public/guides/settings-guide.js (where each section
// starts, so Settings can open the video at that part).
//
// Run: KIRITTS_API_KEY=... KIRITTS_VOICE=<voice or clone id> FFMPEG=<path to ffmpeg> node scripts/record-settings-guide.js
// The voice comes from KiriTTS (api.kiritts.com). Voiced lines are cached in .local/guide-voice, so a re-record
// only pays for lines that changed.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';
import { git } from '../src/processes.js';

const KEY = process.env.KIRITTS_API_KEY, VOICE = process.env.KIRITTS_VOICE || 'daraboth', SPEED = Number(process.env.KIRITTS_SPEED || 0.9);
const FFMPEG = process.env.FFMPEG || 'ffmpeg', FFPROBE = process.env.FFPROBE || FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
if (!KEY) throw new Error('Set KIRITTS_API_KEY (and KIRITTS_VOICE) to voice the guide.');

// What each section is for and how to use it best, in the order a new person meets them.
// km is the subtitle; say (when given) is what the voice reads, for words it says better spelled another way.
// One idea per sentence, short, ending in ។ so the voice pauses. Common tech words stay in Latin letters.
const INTRO = [
  { km: 'នេះគឺ Rex Desk។ ខ្ញុំនឹងបង្ហាញ Settings ម្តងមួយផ្នែក។' },
];
const OPEN = { km: 'ចុច Settings នៅខាងក្រោម។ ផ្នែកនីមួយៗ save ដោយខ្លួនឯង។' };
const STEPS = [
  ['general', [{ km: 'General៖ ឈ្មោះរបស់អ្នក និងពណ៌ផ្ទៃ។' }, { km: 'បើកមួយនេះ ដើម្បីឲ្យ Rex Desk បើកជាមួយ Windows។', target: '[name="autostart"]' }]],
  ['agents', [{ km: 'Agents៖ របៀបដែលជំនួយការ AI របស់អ្នកធ្វើការ។' }, { km: 'ពីរ agent ក្នុងពេលតែមួយ ល្អសម្រាប់ចាប់ផ្តើម។', target: '[name="concurrency"]' }, { km: 'Auto ធ្វើជំហានដែលមានសុវត្ថិភាព។ ជំហានប្រថុយ វាសួរអ្នកមុន។', target: '[name="defaultMode"]' }, { km: 'Save my Claude usage ជួយសន្សំ limit របស់អ្នក។', target: '[name="saver"]' }]],
  ['accounts', [{ km: 'Claude accounts៖ បន្ថែមគណនីទីពីរ តែពេលអ្នកអស់ limit ញឹកញាប់។' }]],
  ['schedule', [{ km: 'Schedule៖ agent ចាប់ផ្តើមការងារដោយខ្លួនឯង តាមម៉ោងកំណត់។' }, { km: 'កំណត់ម៉ោងពេលព្រឹក ហើយដាក់ចំនួនតិចៗ។', target: '[name="schedule.maxRuns"]' }]],
  ['signins', [{ km: 'Test sign-ins៖ គណនីសាកល្បង ឲ្យ agent ពិនិត្យការកែរបស់វា។', say: 'Test sign in៖ គណនីសាកល្បង ឲ្យ agent ពិនិត្យការកែរបស់វា។' }, { km: 'វា sign in ដោយមិនឃើញ password ឡើយ។' }]],
  ['projects', [{ km: 'Projects៖ folder កូដ ដែល agent ធ្វើការលើ។' }, { km: 'កំណត់ branch ចាប់ផ្តើម និងកន្លែងផ្ញើ pull request។', target: '.st-repo' }]],
  ['sources', [{ km: 'Task sources៖ កន្លែងដែល task មកពី។' }, { km: 'Rex Desk មាន task ស្រាប់។ ភ្ជាប់ Flow ឬ Morningmate តែបើក្រុមអ្នកប្រើ។' }]],
  ['jev', [{ km: 'Jev៖ បញ្ជាកុំព្យូទ័រនេះ ដោយការនិយាយ។' }, { km: 'ទុកមួយនេះឲ្យបើក កុំឲ្យបិទកុំព្យូទ័រដោយច្រឡំ។', target: '[name="control.confirm"]' }]],
  ['notify', [{ km: 'Notifications៖ ទុក pop-up សម្រាប់តែសំណួរ។ កំណត់ម៉ោងស្ងាត់ពេលយប់។', say: 'Notifications៖ ទុក pop up សម្រាប់តែសំណួរ។ កំណត់ម៉ោងស្ងាត់ពេលយប់។' }]],
  ['folders', [{ km: 'Folders៖ កន្លែងទុកទិន្នន័យ និងឯកសាររបស់ agent។' }, { km: 'ប្តូរ Files from agents ទៅ drive ធំ បើ C ពេញ។', target: '.st-folder:last-child' }]],
  ['backup', [{ km: 'Backup៖ sign in ជាមួយគណនី Rex Desk។ chat របស់អ្នកទៅតាមគ្រប់កុំព្យូទ័រ។' }]],
  ['devices', [{ km: 'Devices៖ scan QR code ម្តង ដើម្បីឆ្លើយ agent ពីទូរស័ព្ទ។' }]],
  ['connect', [{ km: 'Connect another AI៖ ឲ្យ Claude Code ដែលបើកស្រាប់ ឃើញ task របស់អ្នក។' }]],
];
const OUTRO = { km: 'ផ្នែកនីមួយៗមាន Best use នៅខាងលើ។ មើលវីដេអូនេះម្តងទៀត ពីខាងលើ Settings។', target: '.st-tip' };

// 1. Voice every line once (cached by voice, speed and text), and measure how long each one is.
const cache = path.resolve('.local/guide-voice'); mkdirSync(cache, { recursive: true });
const seconds = file => Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
async function voice(line) {
  const text = line.say || line.km, file = path.join(cache, `${createHash('sha1').update(`${VOICE}|${SPEED}|${text}`).digest('hex').slice(0, 16)}.wav`);
  if (!existsSync(file)) {
    // The connection sometimes drops mid-answer; try again a few times before giving up.
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch('https://api.kiritts.com/v1/audio/speech', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'kiritts', voice: VOICE, input: text, speed: SPEED, response_format: 'wav' }) });
        if (!response.ok) throw new Error(`KiriTTS ${response.status}: ${(await response.text()).slice(0, 200)}`);
        writeFileSync(file, Buffer.from(await response.arrayBuffer())); break;
      } catch (error) { if (attempt >= 4 || /KiriTTS 4\d\d/.test(error.message)) throw error; console.log(`Voice retry ${attempt}: ${error.message}`); await new Promise(resolve => setTimeout(resolve, 3000 * attempt)); }
    }
  }
  line.file = file; line.length = seconds(file);
}
const all = [...INTRO, OPEN, ...STEPS.flatMap(([, lines]) => lines), OUTRO];
for (const line of all) await voice(line);
console.log(`Voiced ${all.length} lines, ${all.reduce((sum, line) => sum + line.length, 0).toFixed(1)} s of speech.`);

// 2. Record the screen. Every line, click and section change is logged with its time, for the sound in step 3.
const workspace = mkdtempSync(path.join(os.tmpdir(), 'rex-desk-guide-'));
const repository = path.join(workspace, 'my-app'); mkdirSync(repository);
writeFileSync(path.join(repository, 'package.json'), JSON.stringify({ name: 'my-app', private: true, scripts: { dev: 'vite --port {port}', test: 'vitest run' } }, null, 2));
await git(repository, ['init', '-b', 'main']);
await git(repository, ['config', 'user.name', 'Guide']); await git(repository, ['config', 'user.email', 'guide@example.invalid']);
await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'Start']);
const out = path.resolve('public/guides'); mkdirSync(out, { recursive: true });
const agentCommand = async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ loggedIn: true, authMethod: 'guide', email: 'you@example.invalid' }) });
const events = [], chapters = {};
let app, browser, raw;
try {
  app = await createApp({ dataDirectory: path.join(workspace, 'data'), port: 0, agentCommand });
  app.store.saveConfig({ ...app.store.config(), name: 'Alex', tourDismissed: true, repositories: [{ name: 'my-app', path: repository, baseBranch: 'main', targetBranch: 'main' }] });
  browser = await chromium.launch({ headless: true });
  const size = { width: 1280, height: 800 };
  const context = await browser.newContext({ viewport: size, colorScheme: 'dark', bypassCSP: true, recordVideo: { dir: path.join(workspace, 'video'), size } });
  const page = await context.newPage();
  // The guide shows a new person's Rex Desk: no GitHub accounts of whoever records it, and no update card.
  await page.route('**/api/github', route => route.fulfill({ json: { installed: true, accounts: [], login: null } }));
  const started = Date.now(), now = () => (Date.now() - started) / 1000;
  page.setDefaultTimeout(60000);
  await page.goto(app.address, { waitUntil: 'domcontentloaded' });
  await page.locator('.rail-settings').waitFor();
  // The pointer, the subtitle bar and a ring around the control being talked about, drawn over the page.
  await page.addStyleTag({ content: `
    #update-card{display:none!important}
    #guide-cap{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;max-width:980px;padding:12px 26px 14px;border-radius:14px;background:rgba(10,12,18,.94);color:#fff;font:600 25px/1.75 'Noto Sans Khmer','Khmer UI',sans-serif;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.18);pointer-events:none;transition:opacity .2s}
    #guide-ring{position:fixed;z-index:99998;border:3px solid #f5b83d;border-radius:12px;box-shadow:0 0 0 6px rgba(245,184,61,.25);pointer-events:none;transition:all .3s;display:none}
    #guide-mouse{position:fixed;z-index:100000;left:640px;top:420px;width:28px;height:28px;pointer-events:none;transition:left .7s cubic-bezier(.4,0,.2,1),top .7s cubic-bezier(.4,0,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.6))}
    #guide-mouse .tap{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;background:rgba(245,184,61,.55);transform:scale(0);opacity:0}
    #guide-mouse.tapped .tap{animation:guide-tap .45s ease-out}
    @keyframes guide-tap{0%{transform:scale(.3);opacity:1}100%{transform:scale(2.2);opacity:0}}` });
  await page.evaluate(() => {
    const mouse = Object.assign(document.createElement('div'), { id: 'guide-mouse', innerHTML: '<span class="tap"></span><svg viewBox="0 0 24 24" width="28" height="28"><path d="M4 2.5v17.2l4.6-4.3 2.9 6.6 3.1-1.4-2.9-6.5H18z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>' });
    document.body.append(Object.assign(document.createElement('div'), { id: 'guide-ring' }), Object.assign(document.createElement('div'), { id: 'guide-cap' }), mouse);
  });
  const pause = ms => page.waitForTimeout(ms);
  // Move the pointer to an element (its centre, or a point inside it) and wait for it to get there.
  const pointAt = async (locator, { x = 0.5, y = 0.5 } = {}) => {
    const box = await locator.boundingBox(); if (!box) return;
    await page.evaluate(([left, top]) => Object.assign(document.getElementById('guide-mouse').style, { left: `${left}px`, top: `${top}px` }), [box.x + box.width * x, box.y + box.height * y]);
    await pause(750);
  };
  const click = async locator => {
    await pointAt(locator, { x: 0.3 });
    await page.evaluate(() => { const mouse = document.getElementById('guide-mouse'); mouse.classList.remove('tapped'); void mouse.offsetWidth; mouse.classList.add('tapped'); });
    events.push({ at: now(), sound: 'click' });
    await locator.click(); await pause(250);
  };
  // Show a line: subtitle, ring and pointer on its control, then its voice for as long as it lasts.
  const say = async line => {
    const target = line.target ? page.locator('.settings-pop').locator(line.target).first() : null;
    if (target) await target.evaluate(element => (element.closest('.st-check, .st-field, .st-repo, .st-folder, .st-tip') || element).scrollIntoView({ block: 'center' }));
    await page.evaluate(([text, selector]) => {
      document.getElementById('guide-cap').textContent = text;
      const ring = document.getElementById('guide-ring'), found = selector && document.querySelector('.settings-pop')?.querySelector(selector);
      const box = found && (found.closest('.st-check, .st-field, .st-repo, .st-folder, .st-tip') || found);
      if (!box) { ring.style.display = 'none'; return; }
      const rect = box.getBoundingClientRect();
      Object.assign(ring.style, { display: 'block', left: `${rect.left - 6}px`, top: `${rect.top - 6}px`, width: `${rect.width + 12}px`, height: `${rect.height + 12}px` });
    }, [line.km, line.target || '']);
    events.push({ at: now() + 0.15, voice: line.file });
    if (target) await pointAt(target, { x: 0.15, y: 0.5 }).catch(() => {});
    await pause(Math.max(1500, line.length * 1000 + 550 - (target ? 750 : 0)));
  };

  await pause(800); events.push({ at: now(), sound: 'chime' });
  for (const line of INTRO) await say(line);
  await click(page.locator('.rail-settings'));
  const settings = page.getByRole('form', { name: 'Settings' }); await settings.waitFor();
  await say(OPEN);
  for (const [section, lines] of STEPS) {
    const button = settings.locator(`[data-st-section="${section}"]`);
    await button.scrollIntoViewIfNeeded();
    await pointAt(button, { x: 0.3 });
    chapters[section] = Math.max(0, Number((now() - 0.6).toFixed(1)));
    events.push({ at: now(), sound: 'swoosh' });
    await click(button); await pause(300);
    for (const line of lines) await say(line);
  }
  await click(settings.locator('[data-st-section="general"]'));
  await say(OUTRO);
  events.push({ at: now(), sound: 'ding' }); await pause(1600);
  const video = page.video();
  await context.close();
  raw = path.join(cache, 'screen.webm'); execFileSync(FFMPEG, ['-y', '-v', 'error', '-i', await video.path(), '-c', 'copy', raw]);
} finally {
  await browser?.close(); await app?.close?.();
  try { rmSync(workspace, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a file still held open; the temp folder is cleaned later */ }
}

// 3. Sound: soft effects made here as tiny WAV files (no sound files to ship), then voice and effects mixed onto the
// screen recording and squeezed into a small VP9 + Opus file.
const RATE = 48000;
const wav = (file, seconds, sample) => {
  const count = Math.round(seconds * RATE), data = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index++) data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sample(index / RATE) * 32767))), index * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8); head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24); head.writeUInt32LE(RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([head, data]));
};
let seed = 7; const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
let low = 0;
const SOUNDS = {
  click: [0.04, t => Math.sin(2 * Math.PI * 1900 * t) * Math.exp(-t * 140) * 0.35],
  swoosh: [0.34, t => { low += 0.18 * (noise() - low); return low * Math.sin(Math.PI * t / 0.34) ** 2 * 0.5; }],
  chime: [0.8, t => (Math.sin(2 * Math.PI * 880 * t) + 0.5 * Math.sin(2 * Math.PI * 1320 * t)) * Math.exp(-t * 5) * 0.16],
  ding: [1.0, t => (Math.sin(2 * Math.PI * 1320 * t) + 0.4 * Math.sin(2 * Math.PI * 1980 * t)) * Math.exp(-t * 4) * 0.16],
};
for (const [name, [length, sample]] of Object.entries(SOUNDS)) wav(path.join(cache, `sfx-${name}.wav`), length, sample);
const inputs = ['-i', raw], parts = [];
events.forEach((event, index) => {
  inputs.push('-i', event.voice || path.join(cache, `sfx-${event.sound}.wav`));
  const delay = Math.max(0, Math.round(event.at * 1000));
  parts.push(`[${index + 1}:a]aformat=sample_rates=48000:channel_layouts=mono,adelay=${delay}:all=1${event.voice ? ',volume=1.0' : ''}[a${index}]`);
});
const graph = `${parts.join(';')};${events.map((_, index) => `[a${index}]`).join('')}amix=inputs=${events.length}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11[mix]`;
writeFileSync(path.join(cache, 'mix.txt'), graph);
execFileSync(FFMPEG, ['-y', '-v', 'error', ...inputs, '-filter_complex_script', path.join(cache, 'mix.txt'), '-map', '0:v', '-map', '[mix]',
  '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '42', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-c:a', 'libopus', '-b:a', '64k', '-ac', '1', '-shortest', path.join(out, 'settings-guide.webm')], { stdio: 'inherit' });
writeFileSync(path.join(out, 'settings-guide.js'), `// Where each Settings section starts in settings-guide.webm, in seconds. Written by scripts/record-settings-guide.js.\nexport default ${JSON.stringify(chapters)};\n`);
console.log('Wrote public/guides/settings-guide.webm', `${(readFileSync(path.join(out, 'settings-guide.webm')).length / 1e6).toFixed(1)} MB`, chapters);
