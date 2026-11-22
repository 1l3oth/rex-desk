import { t } from './i18n.js';
import { askConfirm } from './confirm.js';
// The AIs an agent can run on, in one place: their names, the line under each in a picker, and the warning before a switch.
export const AI_IDS = ['claude', 'codex', 'gemini', 'openrouter'];
export const aiId = value => AI_IDS.includes(value) ? value : 'claude';
export const aiName = value => ({ codex: t('Codex'), gemini: t('Gemini'), openrouter: t('OpenRouter') })[value] || t('Claude Code');
export const aiChoices = () => [
  { id: 'claude', label: t('Claude Code'), hint: t('Your Claude plan') },
  { id: 'codex', label: t('Codex'), hint: t('Your ChatGPT plan') },
  { id: 'gemini', label: t('Gemini'), hint: t('Google account, through Antigravity') },
  { id: 'openrouter', label: t('OpenRouter'), hint: t('Your OpenRouter key, any model it offers') },
];
// Another AI cannot reopen the conversation: it starts fresh and first reads the whole chat so far, which costs time and tokens.
export const confirmAiSwitch = (who, to) => askConfirm(t`Switch ${who} to ${aiName(to)}?

${aiName(to)} cannot continue the current session. It starts a new one and first rereads the whole conversation, which takes time and uses tokens on its account.`, { ok: t('Switch') });
