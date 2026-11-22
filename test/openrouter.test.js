import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOpenRouterKey, openrouterEnvironment, openrouterModels, OPENROUTER_API } from '../src/openrouter.js';
import { AgentProfiles } from '../src/agents.js';
import { aiProvider, providerTitle } from '../src/codex.js';

const reply = (status, data) => async () => ({ ok: status < 400, status, json: async () => data });

test('OpenRouter runs Claude Code against its Anthropic-compatible API with the key as auth token', () => {
  const env = openrouterEnvironment({ ANTHROPIC_API_KEY: 'sk-ant-real', PATH: 'x' }, 'sk-or-v1-abc', 'D:/data/openrouter-claude');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-or-v1-abc');
  assert.equal(env.ANTHROPIC_API_KEY, '', 'a real Anthropic key must not take over');
  assert.equal(env.REX_AGENT_API_KEY, '1', 'the runner keeps the auth token instead of stripping it');
  assert.equal(env.CLAUDE_CONFIG_DIR, 'D:/data/openrouter-claude');
  assert.match(env.ANTHROPIC_DEFAULT_SONNET_MODEL, /^~anthropic\//);
  assert.equal(aiProvider('openrouter'), 'openrouter');
  assert.equal(providerTitle('openrouter'), 'OpenRouter');
});

test('a key is checked with GET /api/v1/key and a refused key says so plainly', async () => {
  let asked = '';
  const good = await checkOpenRouterKey('sk-or-v1-good', { fetcher: async (url, options) => { asked = `${url} ${options.headers.Authorization}`; return reply(200, { data: { label: 'sk-or-v1-go...', is_free_tier: false } })(); } });
  assert.equal(asked, `${OPENROUTER_API}/v1/key Bearer sk-or-v1-good`);
  assert.deepEqual(good, { ok: true, label: 'sk-or-v1-go...', freeTier: false, limitRemaining: null });
  const bad = await checkOpenRouterKey('sk-or-v1-bad', { fetcher: reply(401, { error: { code: 401, message: 'Invalid API key' } }) });
  assert.equal(bad.ok, false); assert.match(bad.error, /did not accept/);
  assert.equal((await checkOpenRouterKey('')).ok, false);
});

test('the model list keeps tool-capable models, Claude first', async () => {
  const models = await openrouterModels({ fetcher: reply(200, { data: [
    { id: 'openai/gpt-x', name: 'OpenAI: GPT X', created: 30, supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000002' } },
    { id: 'meta/no-tools', name: 'No tools', created: 40, supported_parameters: ['temperature'] },
    { id: 'anthropic/claude-sonnet-5.5', name: 'Anthropic: Claude Sonnet 5.5', created: 10, supported_parameters: ['tools'], pricing: { prompt: '0.000003', completion: '0.000015' } },
    { id: 'google/gemma-x:free', name: 'Gemma X (free)', created: 5, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } },
    { id: 'old/paid', name: 'Old paid', created: 1, supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000001' } },
  ] }) });
  assert.deepEqual(models.map(item => item.id), ['anthropic/claude-sonnet-5.5', 'google/gemma-x:free', 'openai/gpt-x', 'old/paid']);
  assert.equal(models[0].hint, '$3 in, $15 out per million tokens');
  assert.equal(models[1].hint, 'Free');
  const capped = await openrouterModels({ limit: 2, fetcher: reply(200, { data: [
    { id: 'a/paid1', created: 9, supported_parameters: ['tools'], pricing: { prompt: '1', completion: '1' } },
    { id: 'a/paid2', created: 8, supported_parameters: ['tools'], pricing: { prompt: '1', completion: '1' } },
    { id: 'b/free1:free', created: 1, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } },
    { id: 'b/free2:free', created: 2, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } },
  ] }) });
  assert.deepEqual(capped.map(item => item.id), ['b/free2:free', 'b/free1:free'], 'every free model stays, even past the limit');
});

test('OpenRouter shows as ready only when its saved key works, and the environment carries the key', async () => {
  const secrets = { openrouter: 'enc:sk-or-v1-saved' };
  const store = { directory: 'D:/data', config: () => ({ agentProfiles: {} }), get: (kind, id) => kind === 'secret' ? secrets[id] : null, decrypt: value => value.replace(/^enc:/, '') };
  const agents = new AgentProfiles(store, { checkKey: async key => key === 'sk-or-v1-saved' ? { ok: true, label: 'saved', freeTier: true } : { ok: false, error: 'no' } });
  const status = await agents.status('openrouter');
  assert.equal(status.loggedIn, true); assert.equal(status.plan, 'Free tier'); assert.equal(status.hasKey, true);
  assert.equal(agents.environment('openrouter', {}).ANTHROPIC_AUTH_TOKEN, 'sk-or-v1-saved');
  assert.equal(agents.environment('claude', {}).ANTHROPIC_AUTH_TOKEN, undefined, 'other AIs never get the key');
  assert.throws(() => agents.login('openrouter', ''), /add your OpenRouter key/);
  delete secrets.openrouter; agents.invalidate('openrouter');
  const none = await agents.status('openrouter');
  assert.equal(none.loggedIn, false); assert.equal(none.hasKey, Boolean(process.env.OPENROUTER_API_KEY));
});
