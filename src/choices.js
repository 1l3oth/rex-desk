// What the person can pick in the chat input for an agent: the model, how hard it thinks, and how it handles permissions.
// These apply when the agent starts or resumes; a running terminal session keeps the choices it started with.
export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Manual is Claude Code's usual behaviour: it asks in the terminal. bypassPermissions and dontAsk are not offered.
export const MODES = [
  { id: 'manual', label: 'Manual' },
  { id: 'auto', label: 'Auto' },
  { id: 'plan', label: 'Plan' },
  { id: 'acceptEdits', label: 'Accept edits' },
];

// Only values from the lists above are accepted; anything else is refused instead of being passed to the CLI.
export function runOptions(input = {}) {
  const out = {};
  if (input.model) { if (!MODELS.some(item => item.id === input.model)) throw new Error('Choose one of the listed models.'); out.model = input.model; }
  if (input.effort) { if (!EFFORTS.includes(input.effort)) throw new Error('Choose low, medium, high, xhigh or max effort.'); out.effort = input.effort; }
  if (input.permissionMode) { if (!MODES.some(item => item.id === input.permissionMode)) throw new Error('Choose Manual, Auto, Plan or Accept edits.'); out.permissionMode = input.permissionMode; }
  return out;
}
