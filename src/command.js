import { execFile } from 'node:child_process';
import { askJev, defaultJevModel } from './jev.js';
import { resolveCommand } from './processes.js';
import { checkParams } from './computer.js';

// Turns what the person said or typed (Khmer, Korean, or English) into computer actions and runs them.
// Jev picks the action: one fast choice among the actions this computer has. When that action needs values (an app
// name, a volume level, text to type), or the request takes several steps, a small model fills them in as JSON.
export const plannerModel = '~anthropic/claude-haiku-latest';
const settle = { open_app: 1800, open_settings: 1800, open_url: 1500, web_search: 1500, open_folder: 1200, focus_window: 700, click_item: 700, press_keys: 400 };

// Not a computer action: Jev hands it to a browser agent that works in its own chat.
export const webAction = { id: 'web_task', title: 'Do it on a website', does: 'Do a task on websites for the person: search and compare (flights, hotels, prices, products), fill in a form, book or buy (it asks before paying), sign up, check an account. Not for opening one page: use open_url or web_search for that.', params: { task: { type: 'string', required: true, describe: 'the whole request in English, with every detail the person gave (places, dates, number of people, budget)' } } };
export function describeActions(list) {
  return list.map(action => {
    const params = Object.entries(action.params || {}).map(([name, spec]) => `${name}${spec.required ? '' : '?'}: ${spec.type === 'enum' ? spec.values.join('|') : spec.type}${spec.describe ? ` (${spec.describe})` : ''}`);
    return `- ${action.id}: ${action.does}${params.length ? `. Values: ${params.join('; ')}` : ''}`;
  }).join('\n');
}
const plannerInstructions = actionList => `You turn a request spoken or typed to a computer into actions. The request may be in Khmer, Korean, or English.
Reply with only JSON: {"steps":[{"action":"<id>","params":{...}}],"say":"<one short English sentence saying what you will do>"}.
Use only these actions:
${actionList}
Rules: use at most 8 steps. To press something on screen by its words use click_item with params.name. Text to type keeps the language the person wants typed.
Numbers are plain numbers (volume 30, hours 5). If the request is not about this computer or is unclear, reply {"steps":[],"say":"<what is unclear>"}.`;

// The commands people say most, recognized instantly in English, Korean, and Khmer without asking any model.
// Only clear, safe requests match here; anything else, or anything with more than one step, goes to Jev.
const words = {
  volume: /volume|sound|louder|quieter|볼륨|소리|សំឡេង/i, down: /\b(down|lower|decrease|reduce|quieter)\b|줄여|낮춰|작게|បន្ថយ/i, up: /\b(up|raise|increase|louder)\b|키워|높여|크게|올려|បង្កើន|ដំឡើង/i,
  unmute: /unmute|음소거\s*(해제|풀어|꺼)|បើកសំឡេង/i, mute: /\bmute\b|음소거|បិទសំឡេង/i,
  on: /\b(on|enable)\b|켜|បើក/i, off: /\b(off|disable)\b|꺼|끄|បិទ/i,
  wifi: /wi-?fi|와이파이|វ៉ាយហ្វាយ/i, bluetooth: /bluetooth|블루투스|ប៊្លូធូស/i, camera: /camera|webcam|카메라|កាមេរ៉ា/i,
  dark: /dark\s*mode|다크\s*모드|ងងឹត/i, light: /light\s*mode|라이트\s*모드|ភ្លឺ/i, brightness: /brightness|밝기|ពន្លឺ/i,
  lock: /\block\b|잠금|잠가|ចាក់សោ/i, screenshot: /screen\s*shot|스크린\s*샷|화면\s*캡처|ថតអេក្រង់/i, battery: /battery|배터리|ថ្ម/i,
  settings: /settings|설정|ការកំណត់/i, sleep: /^\s*(go to )?sleep\s*$|^\s*절전\s*(모드)?\s*$|^\s*ដេក\s*$/i,
};
const settingsWords = { bluetooth: words.bluetooth, wifi: words.wifi, sound: /sound|audio|소리|사운드|សំឡេង/i, display: /display|screen|디스플레이|화면|អេក្រង់/i, battery: words.battery,
  camera: words.camera, microphone: /microphone|mic|마이크|មីក្រូ/i, updates: /update|업데이트|អាប់ដេត/i, wallpaper: /wallpaper|background|배경/i, network: /network|internet|네트워크|인터넷|អ៊ីនធឺណិត/i,
  notifications: /notification|알림|ការជូនដំណឹង/i, privacy: /privacy|개인\s*정보|ឯកជន/i, language: /language|언어|ភាសា/i, date_time: /date|time|날짜|시간|កាលបរិច្ឆេទ/i };
export function quickMatch(text) {
  const said = String(text || '').trim(), number = /(\d{1,3})\s*(%|percent|퍼센트|ភាគរយ)?/.exec(said)?.[1];
  const one = (action, params = {}) => ({ steps: [{ action, params }] });
  if (/\b(and|then)\b|그리고|하고\s|រួច|ហើយ/i.test(said) || said.length > 80) return null;
  if (words.settings.test(said)) { const page = Object.entries(settingsWords).find(([, pattern]) => pattern.test(said))?.[0]; return one('open_settings', page ? { page } : {}); }
  if (words.brightness.test(said) && number !== undefined) return one('brightness_set', { level: Number(number) });
  if (words.volume.test(said) || words.mute.test(said) || words.unmute.test(said)) {
    if (words.unmute.test(said)) return one('unmute');
    if (words.mute.test(said)) return one('mute');
    if (number !== undefined) return one('volume_set', { level: Number(number) });
    if (words.down.test(said)) return one('volume_down');
    if (words.up.test(said)) return one('volume_up');
    return null;
  }
  for (const device of ['wifi', 'bluetooth', 'camera']) if (words[device].test(said) && (words.on.test(said) || words.off.test(said))) return one(device, { on: !words.off.test(said) });
  if (words.dark.test(said)) return one('dark_mode', { on: !words.off.test(said) });
  if (words.light.test(said)) return one('dark_mode', { on: false });
  if (words.screenshot.test(said)) return one('screenshot');
  if (words.battery.test(said) && !/saver|mode|절약|សន្សំ/i.test(said)) return one('battery_status');
  if (words.lock.test(said)) return one('lock');
  if (words.sleep.test(said)) return one('sleep');
  return null;
}

export function parsePlan(text, known) {
  const json = String(text || '').match(/\{[\s\S]*\}/)?.[0];
  let value; try { value = JSON.parse(json); } catch { throw new Error('The planner did not answer in JSON.'); }
  const steps = (Array.isArray(value?.steps) ? value.steps : []).slice(0, 8).filter(step => known.has(step?.action)).map(step => ({ action: step.action, params: step.params && typeof step.params === 'object' ? step.params : {} }));
  return { steps, say: String(value?.say || '').slice(0, 300) };
}

export class Commander {
  constructor(computer, { apiKey = () => '', model = () => defaultJevModel, fetcher = fetch, settings = () => ({}), env = () => process.env, cwd, planner, webTask } = {}) {
    Object.assign(this, { computer, apiKey, model, fetcher, settings, env, cwd, webTask });
    if (planner) this.plan = planner;
  }
  // Jev's single choice: which action, "several" for a multi-step request, or "none".
  async choose(text, available, apiKey) {
    const criteria = Object.fromEntries(available.map(action => [action.id, action.does]));
    criteria.several = 'The request needs two or more of these actions in a row, for example open an app and then click or type in it';
    criteria.none = 'None of these: the request is not about controlling this computer, or it is unclear';
    const result = await askJev({ apiKey, model: this.model() || defaultJevModel, fetcher: this.fetcher,
      state: { request: text, computer: this.computer.key === 'mac' ? 'macOS' : 'Windows', note: 'A person said or typed this to their own computer. It may be Khmer, Korean, or English.' },
      questions: { action: { type: 'choice', instructions: 'Which computer action does this request ask for?', criteria } } });
    return result.answers?.action?.choice || 'none';
  }
  async plan(text, actionList) {
    const apiKey = this.apiKey();
    if (apiKey) {
      const response = await this.fetcher('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Rex Desk' },
        body: JSON.stringify({ model: plannerModel, max_tokens: 600, temperature: 0, messages: [{ role: 'system', content: plannerInstructions(actionList) }, { role: 'user', content: text }] }) });
      if (!response.ok) throw new Error(`Planning failed (${response.status}).`);
      return (await response.json())?.choices?.[0]?.message?.content;
    }
    // Without an OpenRouter key the signed-in Claude Code plans on the person's subscription: slower, but no extra cost.
    const executable = resolveCommand('claude'), env = { ...this.env() }; delete env.CLAUDECODE; delete env.ANTHROPIC_API_KEY;
    return new Promise((resolve, reject) => execFile(executable.command, [...executable.args, '-p', '--model', 'haiku', '--max-turns', '1', `${plannerInstructions(actionList)}\n\nRequest: ${text}`],
      { env, cwd: this.cwd, timeout: 90000, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout) => error ? reject(new Error('Claude Code could not plan the request.')) : resolve(stdout)));
  }
  async understand(text) {
    const request = String(text || '').trim().slice(0, 1000);
    if (!request) throw new Error('Say or type what the computer should do.');
    const available = [...this.computer.available(), ...(this.webTask ? [webAction] : [])], known = new Set(available.map(action => action.id)), apiKey = this.apiKey();
    const quick = quickMatch(request);
    if (quick && quick.steps.every(step => known.has(step.action))) return { ...quick, say: quick.steps.map(step => this.computer.action(step.action).title).join(', '), via: 'instant' };
    let choice = 'several', via = 'planner';
    if (apiKey) { choice = await this.choose(request, available, apiKey).catch(() => 'several'); via = 'jev'; }
    if (choice === 'none') return { steps: [], say: 'That is not something this computer can do, or it was unclear. Try again in other words.', via };
    const chosen = available.find(action => action.id === choice);
    // An action with nothing to fill in runs straight from Jev's choice.
    if (chosen && !Object.keys(chosen.params || {}).length) return { steps: [{ action: chosen.id, params: {} }], say: chosen.title, via };
    const plan = parsePlan(await this.plan(request, describeActions(chosen ? [chosen] : available)), known);
    return { ...plan, via: chosen ? `${via}+planner` : 'planner' };
  }
  needsConfirm(steps) {
    if (this.settings().confirm === false) return [];
    return steps.filter(step => this.actionOf(step.action).confirm).map(step => this.actionOf(step.action).title);
  }
  // Understand, then run unless something needs the person's yes first.
  async perform(text) {
    const plan = await this.understand(text);
    if (!plan.steps.length) return { ...plan, done: false, results: [] };
    plan.steps.forEach(step => { step.params = checkParams(this.actionOf(step.action), step.params); });
    const confirm = this.needsConfirm(plan.steps);
    if (confirm.length) return { ...plan, done: false, needsConfirm: confirm, results: [] };
    return { ...plan, ...await this.runSteps(plan.steps) };
  }
  actionOf(id) { return id === webAction.id ? webAction : this.computer.action(id); }
  async runSteps(steps) {
    const results = [];
    for (const step of steps.slice(0, 8)) {
      const action = this.actionOf(step.action);
      if (step.action === webAction.id) {
        try { const run = await this.webTask(step.params.task); results.push({ action: step.action, title: action.title, ok: true, result: { text: 'A browser agent is on it. Follow it in Rex Desk; it asks you before paying or sending anything.', runId: run.id, url: `/#/run/${run.id}` } }); }
        catch (error) { results.push({ action: step.action, title: action.title, ok: false, error: error.message }); }
        break;
      }
      try { results.push({ action: step.action, title: action.title, ok: true, result: (await this.computer.run(step.action, step.params)).result ?? null }); }
      catch (error) { results.push({ action: step.action, title: action.title, ok: false, error: error.message }); break; }
      if (settle[step.action] && step !== steps.at(-1)) await new Promise(resolve => setTimeout(resolve, settle[step.action]));
    }
    return { done: results.every(result => result.ok), results };
  }
}
