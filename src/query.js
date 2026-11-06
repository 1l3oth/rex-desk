// A sentence typed by the human ("my tasks", "JP tasks from 48000 to 48100", "new tasks not assigned to me") becomes a
// fixed, checked intent; Rex Desk then asks the trackers live with it. The model only fills the intent: it never sees
// an API key and never calls the tracker, and every value it returns is checked against what the tracker offers.
import { execFile } from 'node:child_process';
import { resolveCommand } from './processes.js';
import { namingModel } from './naming.js';
import { normalizeTask, columnNames, accountList, taskAssignees } from './providers.js';

const statusGroups = { open: ['0', '1'], request: ['0'], working: ['1'], done: ['2'], any: null };
const day = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(value)) ? String(value) : '';
const number = value => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const fold = value => String(value ?? '').trim().toLowerCase();

const instructions = `You turn a request for tracker tasks into a JSON filter. Reply with only JSON in this shape:
{"sources":[],"projects":[],"assignee":"anyone","status":"any","statusNames":[],"fields":{},"keyword":"","numberFrom":0,"numberTo":0,"createdFrom":"","createdTo":"","updatedFrom":"","updatedTo":""}
- sources: any of the listed source types; empty means all.
- projects: exact project names from the list; empty means the projects the person follows.
- assignee: "me" (assigned to the person), "not-me" (not assigned to them), "anyone", or one exact person id from the list.
- status: "open" (not finished), "request" (new, not started), "working" (in progress), "done", or "any". statusNames: exact status names from the list, only when the request names one.
- fields: field name to a list of exact option names from the list, such as {"Region":["JP"]}.
- keyword: words that must appear in the title, or "".
- numberFrom/numberTo: task number range, 0 when not asked. createdFrom/createdTo/updatedFrom/updatedTo: YYYY-MM-DD dates, "" when not asked. Resolve "this week", "yesterday" and the like from today.
"New" tasks are status "request" unless the request is about creation dates. Use only values from the lists; leave a part empty when unsure.`;

// The intent the model returned, kept only where it names something the trackers really have.
export function parseIntent(text, context) {
  const json = String(text || '').match(/\{[\s\S]*\}/)?.[0];
  let value; try { value = JSON.parse(json); } catch { throw new Error('The request could not be understood. Try naming the project, person, or status.'); }
  const dropped = [];
  const pick = (list, allowed, kind) => (Array.isArray(list) ? list : []).map(item => {
    const match = allowed.find(option => fold(option) === fold(item));
    if (!match) dropped.push(`${kind} "${item}"`);
    return match;
  }).filter(Boolean);
  const people = context.people.map(person => person.id);
  const assignee = ['me', 'not-me', 'anyone'].includes(value.assignee) ? value.assignee : people.find(id => fold(id) === fold(value.assignee)) || (value.assignee && dropped.push(`person "${value.assignee}"`), 'anyone');
  const fields = {};
  for (const [name, options] of Object.entries(value.fields && typeof value.fields === 'object' ? value.fields : {})) {
    const field = Object.keys(context.fields).find(key => fold(key) === fold(name));
    if (!field) { dropped.push(`field "${name}"`); continue; }
    const chosen = pick(options, context.fields[field], `${field} option`);
    if (chosen.length) fields[field] = chosen;
  }
  return { sources: pick(value.sources, context.sources, 'source'), projects: pick(value.projects, context.projects.map(project => project.name), 'project'),
    assignee, status: Object.hasOwn(statusGroups, value.status) ? value.status : 'any', statusNames: pick(value.statusNames, context.statuses, 'status'), fields,
    keyword: String(value.keyword || '').trim().slice(0, 100), numberFrom: number(value.numberFrom), numberTo: number(value.numberTo),
    createdFrom: day(value.createdFrom), createdTo: day(value.createdTo), updatedFrom: day(value.updatedFrom), updatedTo: day(value.updatedTo), dropped };
}

// One short model turn: the OpenRouter key Jev uses with a small model, or else the signed-in Claude Code's haiku.
export async function askSmallModel(prompt, input, { apiKey, fetcher = fetch, env = process.env, cwd, run = execFile } = {}) {
  if (apiKey) {
    const response = await fetcher('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Rex Desk' },
      body: JSON.stringify({ model: namingModel, max_tokens: 400, temperature: 0, messages: [{ role: 'system', content: prompt }, { role: 'user', content: input }] }) });
    if (!response.ok) throw new Error(`The query model failed (${response.status}).`);
    return (await response.json())?.choices?.[0]?.message?.content || '';
  }
  const executable = resolveCommand('claude'), clean = { ...env }; delete clean.CLAUDECODE;
  return new Promise((resolve, reject) => run(executable.command, [...executable.args, '-p', '--model', 'haiku', '--max-turns', '1', `${prompt}\n\n${input}`],
    { env: clean, cwd, timeout: 90000, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout) => error ? reject(new Error('Claude Code could not read the request. Add an OpenRouter key in Settings → Jev, or sign in Claude Code.')) : resolve(stdout)));
}

export function matchesIntent(task, intent, { me, today = new Date() } = {}) {
  const mine = task.assignees.some(account => me.has(fold(account)));
  if (intent.assignee === 'me' && !mine) return false;
  if (intent.assignee === 'not-me' && mine) return false;
  if (!['me', 'not-me', 'anyone'].includes(intent.assignee) && !task.assignees.some(account => fold(account) === fold(intent.assignee))) return false;
  if (intent.statusNames.length) { if (!intent.statusNames.some(name => fold(name) === fold(task.statusName))) return false; }
  else if (statusGroups[intent.status] && !statusGroups[intent.status].includes(String(task.statusCategory))) return false;
  for (const [field, options] of Object.entries(intent.fields)) {
    const value = fold(task.fields.find(item => fold(item.name) === fold(field))?.value);
    if (!options.some(option => value.split(/,\s*/).includes(fold(option)))) return false;
  }
  if (intent.keyword && !intent.keyword.toLowerCase().split(/\s+/).every(word => fold(task.title).includes(word))) return false;
  const taskNumber = Number(task.taskNumber);
  if (intent.numberFrom && !(taskNumber >= intent.numberFrom)) return false;
  if (intent.numberTo && !(taskNumber <= intent.numberTo)) return false;
  const date = value => String(value || '').slice(0, 10);
  if (intent.createdFrom && !(date(task.createdAt) >= intent.createdFrom)) return false;
  if (intent.createdTo && !(date(task.createdAt) <= intent.createdTo)) return false;
  if (intent.updatedFrom && !(date(task.updatedAt) >= intent.updatedFrom)) return false;
  if (intent.updatedTo && !(date(task.updatedAt) <= intent.updatedTo)) return false;
  return true;
}

const pageLimit = 30, resultLimit = 300;
export class TrackerQuery {
  constructor(store, sources, { model = askSmallModel, apiKey = () => '', env = () => process.env, cwd } = {}) { Object.assign(this, { store, sources, model, apiKey, env, cwd }); this.columns = new Map(); }
  // Project column definitions change rarely, so they are kept for an hour.
  async definitions(source, projectId) {
    const key = `${source.id}:${projectId}`, hit = this.columns.get(key);
    if (hit && Date.now() - hit.at < 3600000) return hit.columns;
    const data = await this.sources.request(source, `/user/projects/${encodeURIComponent(projectId)}/columns`);
    const columns = Array.isArray(data.columns) ? data.columns : [];
    this.columns.set(key, { at: Date.now(), columns }); return columns;
  }
  async context() {
    const config = this.store.config(), projects = new Map(), fields = {}, statuses = new Set(), people = new Map();
    for (const source of config.sources) {
      const directory = this.store.get('directory', source.id);
      for (const project of directory?.projects || []) projects.set(`${source.id}:${project.id}`, { sourceId: source.id, id: project.id, name: project.name, followed: source.projectIds.includes(project.id) });
      for (const id of source.projectIds) if (!projects.has(`${source.id}:${id}`)) projects.set(`${source.id}:${id}`, { sourceId: source.id, id, name: id, followed: true });
      for (const person of directory?.employees || []) people.set(person.id, person);
      for (const projectId of source.projectIds) {
        for (const option of this.store.get('statuses', `${source.id}:${projectId}`)?.data?.options || []) statuses.add(option.optionName);
        const columns = await this.definitions(source, projectId).catch(() => []);
        for (const column of columns.filter(item => item.columnType === 'OPTION' && item.options?.length)) fields[column.columnName] = [...new Set([...(fields[column.columnName] || []), ...column.options.map(option => option.optionName)])];
      }
    }
    return { sources: [...new Set(config.sources.map(source => source.type))], projects: [...projects.values()], fields, statuses: [...statuses], people: [...people.values()] };
  }
  async interpret(text, context, today = new Date()) {
    const lists = { today: today.toISOString().slice(0, 10), sourceTypes: context.sources,
      projects: context.projects.sort((left, right) => Number(right.followed) - Number(left.followed)).slice(0, 80).map(project => `${project.name}${project.followed ? ' (followed)' : ''}`),
      statuses: context.statuses, fields: context.fields, people: context.people.slice(0, 200).map(person => `${person.id}: ${person.name}`) };
    const answer = await this.model(instructions, `Lists: ${JSON.stringify(lists)}\n\nRequest: ${String(text).slice(0, 500)}`, { apiKey: this.apiKey(), env: this.env(), cwd: this.cwd });
    return parseIntent(answer, context);
  }
  async ask(text, { today = new Date() } = {}) {
    if (!String(text || '').trim()) throw new Error('Type what you want to see, for example "my open tasks" or "JP tasks this week".');
    const context = await this.context(), intent = await this.interpret(text, context, today);
    return { text, intent, ...await this.run(intent, context, today) };
  }
  async run(intent, context, today = new Date()) {
    const config = this.store.config(), rows = [], errors = [];
    const sources = config.sources.filter(source => !intent.sources.length || intent.sources.includes(source.type));
    const people = new Map(context.people.map(person => [fold(person.id), person.name]));
    await Promise.all(sources.map(async source => {
      const me = new Set(accountList(source.userId || this.store.get('directory', source.id)?.accountId).map(fold));
      const projects = intent.projects.length ? context.projects.filter(project => project.sourceId === source.id && intent.projects.includes(project.name)) : context.projects.filter(project => project.sourceId === source.id && project.followed);
      for (const project of projects.slice(0, 6)) {
        try {
          const columns = await this.definitions(source, project.id), names = columnNames(columns);
          // Only filters the tracker is known to honour go to the API: the assignee and option columns. The rest is checked here.
          const worker = columns.find(column => /WORKER|ASSIGNEE/i.test(column.defaultColumnType || ''));
          const filters = Object.entries(intent.fields).map(([field, options]) => {
            const column = columns.find(item => item.columnType === 'OPTION' && fold(item.columnName) === fold(field));
            const ids = column?.options?.filter(option => options.includes(option.optionName)).map(option => option.optionId) || [];
            return ids.length ? { COLUMN_SRNO: String(column.columnSrno), OPERATOR_TYPE: 'IN', FILTER_DATA: ids.join(',') } : null;
          }).filter(Boolean);
          const accounts = intent.assignee === 'me' && worker && me.size ? [...me] : [null];
          for (const account of accounts) {
            const records = account ? [...filters, { COLUMN_SRNO: String(worker.columnSrno), OPERATOR_TYPE: 'IN', FILTER_DATA: account }] : filters;
            let cursor = 0;
            for (let page = 0; page < pageLimit; page++) {
              const data = await this.sources.request(source, `/user/posts/projects/${encodeURIComponent(project.id)}/tasks/filter?pageSize=100&cursor=${encodeURIComponent(cursor)}&filterRecords=${encodeURIComponent(JSON.stringify(records))}`);
              for (const row of data.tasks || []) {
                const task = { ...normalizeTask(source, project.id, row, { ...row, title: '', content: '' }, { names }), assignees: taskAssignees(row) };
                if (matchesIntent(task, intent, { me, today })) rows.push(task);
              }
              if (!data.hasNext || data.lastCursor === undefined || Number(data.lastCursor) < 0) break;
              cursor = data.lastCursor;
            }
          }
        } catch (error) { errors.push(`${source.name} · ${project.name}: ${error.message}`); }
      }
    }));
    const unique = [...new Map(rows.map(task => [task.id, task])).values()].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    return { total: unique.length, errors, rows: unique.slice(0, resultLimit).map(task => ({ id: task.id, source: task.source, project: task.projectName, number: task.taskNumber,
      title: task.title, status: task.statusName || task.status, statusCategory: task.statusCategory, assignees: task.assignees.map(account => people.get(fold(account)) || account),
      reporter: people.get(fold(task.reporter)) || task.reporter, createdAt: task.createdAt, updatedAt: task.updatedAt, dueDate: task.dueDate, url: task.url, fields: task.fields,
      onDesk: Boolean(this.store.get('task', task.id)?.active) })) };
  }
}
