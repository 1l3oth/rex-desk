// Connectors: the task trackers Rex Desk syncs natively (Orbit, Flow, Morningmate) are the entries in CONNECTORS,
// with the same shape, so the Settings page, sync, status pushes and run prompts loop over what is connected and never
// name an app themselves. Every other app (MCP servers, tokens, webhooks) is in public/connectors/catalog.json and
// connector-catalog.js, checked by a real connect before it is saved. A person who connects nothing sees none of them.
//
// One connection is saved as { id, connectorId, name, enabled, secretRef, options }. The task trackers still keep their rows
// in config.sources (that is what sync, the task list and every agent's task-source picks read), so a connection is a view
// of a source row: connectionOf() reads one, sourceOf() writes one back. The key stays encrypted in the secret store under
// the connection id (secretRef), as before.
import { ORBIT_URL, orbitCall, orbitTasks, orbitStatus, orbitComment } from './orbit.js';

export const CONNECTOR_TYPES = [
  { id: 'tasks', name: 'Task trackers' },
  { id: 'chat', name: 'Chat' },
  { id: 'code', name: 'Code hosts' },
  { id: 'docs', name: 'Docs and files' },
];

// icon: a file in public/connectors/ (Simple Icons, CC0), or a letter for a plain tile.
// auth: key (one pasted key or token), device (a code approved in the app), mcp (the app's own MCP sign-in), host (the host app's MCP).
// ready: it can be connected from the Add connector picker in this version.
const entry = (id, name, type, icon, auth, gives, extra = {}) => ({ id, name, type, icon, auth, gives, fields: [], ready: false, ...extra });
export const CONNECTORS = [
  entry('orbit', 'Orbit', 'tasks', 'letter:O', 'key', ['tasks', 'statuses', 'comments', 'report', 'mcpTools'], { ready: true, fields: ['apiKey', 'baseUrl', 'statusFilter', 'sendReport'], keyHint: 'Orbit: open the goal, then Settings, API, Generate Project Key.', account: 'device' }),
  entry('flow', 'Flow', 'tasks', 'letter:F', 'key', ['tasks', 'statuses', 'runPresets'], { ready: true, fields: ['apiKey', 'baseUrl', 'projectIds', 'userId', 'statusFilter', 'statusMap'] }),
  entry('morningmate', 'Morningmate', 'tasks', 'letter:M', 'key', ['tasks', 'statuses', 'runPresets'], { ready: true, fields: ['apiKey', 'baseUrl', 'projectIds', 'userId', 'statusFilter', 'statusMap'] }),
];
export const connector = id => CONNECTORS.find(item => item.id === id) || null;
// What the window needs to draw the picker: no code, no secrets.
export const catalog = () => ({ types: CONNECTOR_TYPES, connectors: CONNECTORS.map(({ id, name, type, icon, auth, gives, ready, keyHint, keyUrl, account }) => ({ id, name, type, icon, auth, gives, ready, keyHint: keyHint || '', keyUrl: keyUrl || '', account: account || '' })) });

// ---------- the saved shape ----------
const OPTION_KEYS = ['baseUrl', 'projectIds', 'userId', 'repositoryId', 'statusFilter', 'statuses', 'statusMap', 'sendReport'];
// A source row from an older version has no sendReport: the old global "send the final report to Orbit" switch decides.
export function connectionOf(source, config = {}) {
  const options = Object.fromEntries(OPTION_KEYS.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  if (source.type === 'orbit' && options.sendReport === undefined) options.sendReport = Boolean(config.reportToOrbit);
  return { id: source.id, connectorId: source.type, name: source.name, enabled: source.enabled !== false, secretRef: source.hasKey || source.apiKey ? `secret:${source.id}` : '', options };
}
export function sourceOf(connection) {
  const { id, connectorId, name, enabled, options = {} } = connection;
  return { ...Object.fromEntries(OPTION_KEYS.filter(key => options[key] !== undefined).map(key => [key, options[key]])), id, type: connectorId, name, ...(enabled === false ? { enabled: false } : {}) };
}
export const connections = (config = {}) => (config.sources || []).map(source => connectionOf(source, config));

// ---------- what each connector does ----------
// The same five calls for every connector that brings tasks in; the trackers that are not built yet have none.
// ctx: { store, sources (the SourceManager), fetcher }.
const MODULES = {
  orbit: {
    test: (ctx, source, key) => orbitCall(source, key, 'tasks.list', { limit: 1 }, ctx.fetcher).then(result => ({ ok: true, sample: (result.tasks || []).length })),
    fetchTasks: (ctx, source) => { const key = ctx.store.credential(source.id); if (!key) throw new Error(`Add the Orbit project key for ${source.name}.`); return orbitTasks(source, key, ctx.fetcher); },
    pushStatus: (ctx, source, task, phase) => orbitStatus(source, ctx.store.credential(source.id), task, phase, ctx.fetcher),
    pushComment: (ctx, source, task, body) => orbitComment(source, ctx.store.credential(source.id), task, body, ctx.fetcher),
    promptHint: connection => connection.options.sendReport ? 'After the investigation, send a concise report through the installed Orbit MCP if it is available. Include the source task reference and what you found. Never claim a local file URL is publicly accessible.' : '',
  },
};
export const connectorModule = id => MODULES[id] || null;
export const defaultBase = type => type === 'orbit' ? ORBIT_URL : '';
// The lines connected apps add to a run prompt, one per connection that has something to say.
export const promptHints = (config, extra = {}) => [...new Set(connections(config).filter(item => item.enabled).map(item => connectorModule(item.connectorId)?.promptHint?.(item, extra) || '').filter(Boolean))];
