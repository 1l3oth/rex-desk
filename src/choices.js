import { aiProvider } from './codex.js';
// What the person can pick in the chat input for an agent: the model, how hard it thinks, and how it handles permissions.
// These apply when the agent starts or resumes; a running terminal session keeps the choices it started with.
export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Dangerous runs tools without asking and is what Rex Desk agents start with. Manual asks for each one in the chat. dontAsk is not offered.
export const MODES = [
  { id: 'bypassPermissions', label: 'Dangerous' },
  { id: 'manual', label: 'Manual' },
  { id: 'auto', label: 'Auto' },
  { id: 'plan', label: 'Plan' },
  { id: 'acceptEdits', label: 'Accept edits' },
];

// The models offered: the list the signed-in Claude Code reported (kept in the store), or the built-in one until it has.
export const modelList = (store, provider = 'claude') => { const saved = store?.get?.('models', provider === 'claude' ? 'list' : provider)?.items; return Array.isArray(saved) && saved.length ? saved : provider === 'claude' ? MODELS : []; };
// The pickers also show the models this account refused (a higher plan only), greyed out, so the person sees why one is missing.
export const pickerModels = (store, provider = 'claude') => { const refused = store?.get?.('models', provider === 'claude' ? 'list' : provider)?.refusedItems || []; return [...modelList(store, provider), ...refused.map(item => ({ ...item, hint: 'Not on your plan: it needs a higher one', disabled: true }))]; };
export const modesFor = provider => provider === 'codex' ? [{ id: 'bypassPermissions', label: 'Dangerous' }, { id: 'manual', label: 'Workspace' }, { id: 'plan', label: 'Read only' }] : MODES;

// Only values from the lists above are accepted; anything else is refused instead of being passed to the CLI.
export function runOptions(input = {}, store) {
  const provider = aiProvider(input.provider || store?.config?.().provider || 'claude');
  const out = input.provider ? { provider } : {};
  if (input.model) { if (!modelList(store, provider).some(item => item.id === input.model)) throw new Error('Choose one of the listed models.'); out.model = input.model; }
  if (input.effort) { if (!EFFORTS.includes(input.effort)) throw new Error('Choose low, medium, high, xhigh or max effort.'); out.effort = input.effort; }
  if (input.permissionMode) { if (!modesFor(provider).some(item => item.id === input.permissionMode)) throw new Error('Choose Dangerous, Manual, Auto, Plan or Accept edits.'); out.permissionMode = input.permissionMode; }
  return out;
}
