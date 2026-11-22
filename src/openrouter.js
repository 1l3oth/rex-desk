import path from 'node:path';

// OpenRouter as an AI for agents. Following OpenRouter's own Claude Code guide
// (openrouter.ai/docs/guides/guides/claude-code-integration), Claude Code talks to OpenRouter's Anthropic-compatible API:
// ANTHROPIC_BASE_URL is https://openrouter.ai/api, the OpenRouter key goes in ANTHROPIC_AUTH_TOKEN, and ANTHROPIC_API_KEY must
// be empty. The key is the one Rex Desk already keeps encrypted for Jev (secret "openrouter"); it is never logged or shown.
export const OPENROUTER_API = 'https://openrouter.ai/api';
// Claude Code's own background helpers ask for its Haiku and Sonnet roles; on OpenRouter they map to these rolling aliases.
const ROLE_MODELS = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: '~anthropic/claude-opus-latest',
  ANTHROPIC_DEFAULT_SONNET_MODEL: '~anthropic/claude-sonnet-latest',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: '~anthropic/claude-haiku-latest',
};
// Its own Claude Code profile folder, so a Claude subscription signed in on this computer never takes over these turns.
export const openrouterHome = dataDirectory => path.join(dataDirectory, 'openrouter-claude');

export function openrouterEnvironment(env, key, home) {
  const result = { ...env, REX_AI_PROVIDER: 'openrouter', REX_AGENT_API_KEY: '1', ANTHROPIC_BASE_URL: OPENROUTER_API, ANTHROPIC_AUTH_TOKEN: key || '', ANTHROPIC_API_KEY: '' };
  if (home) result.CLAUDE_CONFIG_DIR = home;
  for (const [name, value] of Object.entries(ROLE_MODELS)) if (!result[name]) result[name] = value;
  // No model picked: Sonnet, not Claude Code's own default (Opus), which costs far more per token.
  if (!result.ANTHROPIC_MODEL) result.ANTHROPIC_MODEL = ROLE_MODELS.ANTHROPIC_DEFAULT_SONNET_MODEL;
  delete result.REX_OPENROUTER_HOME;
  return result;
}

// Checks a key with OpenRouter's GET /api/v1/key. Only plain facts come back, never the key.
export async function checkOpenRouterKey(key, { fetcher = fetch, timeoutMs = 15000 } = {}) {
  const value = String(key || '').trim();
  if (!value) return { ok: false, error: 'No OpenRouter key yet.' };
  try {
    const response = await fetcher(`${OPENROUTER_API}/v1/key`, { headers: { Authorization: `Bearer ${value}` }, signal: AbortSignal.timeout(timeoutMs) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: response.status === 401 ? 'OpenRouter did not accept this key. Check it and try again.' : `OpenRouter answered ${response.status}. Try again in a moment.` };
    const info = data?.data || {};
    return { ok: true, label: String(info.label || ''), freeTier: Boolean(info.is_free_tier), limitRemaining: info.limit_remaining ?? null };
  } catch (error) { return { ok: false, error: `Could not reach OpenRouter: ${error.message}` }; }
}

// Models that can use tools (agents need them), from OpenRouter's GET /api/v1/models. Claude models come first (OpenRouter says
// Claude Code works best with them), then every free model, then the newest paid ones up to the limit.
const isFree = item => Number(item.pricing?.prompt) === 0 && Number(item.pricing?.completion) === 0;
export async function openrouterModels({ fetcher = fetch, timeoutMs = 20000, limit = 80 } = {}) {
  const response = await fetcher(`${OPENROUTER_API}/v1/models?supported_parameters=tools`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`OpenRouter did not list its models (${response.status}).`);
  const data = await response.json();
  const items = (Array.isArray(data?.data) ? data.data : []).filter(item => item?.id && (item.supported_parameters || []).includes('tools'));
  const rank = item => item.id.startsWith('anthropic/') ? 0 : isFree(item) ? 1 : 2;
  items.sort((a, b) => rank(a) - rank(b) || (Number(b.created) || 0) - (Number(a.created) || 0));
  const price = item => { const prompt = Number(item.pricing?.prompt), completion = Number(item.pricing?.completion); return Number.isFinite(prompt) && Number.isFinite(completion) ? (isFree(item) ? 'Free' : `$${+(prompt * 1e6).toFixed(2)} in, $${+(completion * 1e6).toFixed(2)} out per million tokens`) : ''; };
  const kept = items.filter((item, index) => rank(item) < 2 || index < limit);
  return kept.map(item => ({ id: String(item.id), label: String(item.name || item.id), hint: price(item) }));
}
