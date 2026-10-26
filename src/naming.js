// A readable English branch name from the QA issue, written when a run starts so even Korean or Japanese titles get one.
// Uses the person's OpenRouter key (the one Jev uses) and a small model; any failure falls back to the tracker number.
export const namingModel = '~anthropic/claude-haiku-latest';
const types = ['fix', 'feature', 'refactor', 'chore', 'docs'];
const generic = new Set(['issue', 'bug', 'fix', 'problem', 'task', 'error', 'qa', 'request', 'update', 'change']);

export function parseBranchName(text) {
  const json = String(text || '').match(/\{[\s\S]*\}/)?.[0];
  let value; try { value = JSON.parse(json); } catch { return null; }
  const words = String(value?.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 7 || words.every(word => generic.has(word) || /^\d+$/.test(word))) return null;
  return { type: types.includes(value.type) ? value.type : 'fix', title: words.join(' ') };
}

export async function branchName(task, { apiKey, fetcher = fetch, model = namingModel }) {
  if (!apiKey) return null;
  const issue = { title: task.title, status: task.statusName || task.status, project: task.projectName, description: String(task.description || '').slice(0, 1500),
    fields: Object.fromEntries((task.fields || []).slice(0, 8).map(field => [field.name, field.value])) };
  const response = await fetcher('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Rex Desk' },
    body: JSON.stringify({ model, max_tokens: 80, temperature: 0.4, messages: [
      { role: 'system', content: 'You name Git branches for QA issues. Read the issue (it may be Korean or Japanese) and reply with only JSON: {"type":"fix|feature|refactor|chore|docs","name":"3 to 6 lowercase English words"}. The name says which feature breaks and how, specific enough to recognize the issue among others, for example "project-view-names-ignore-language" or "preview-download-shows-blank-page". No ticket numbers, product names, or filler words such as issue, bug, or fix.' },
      { role: 'user', content: JSON.stringify(issue) }] }) });
  if (!response.ok) throw new Error(`Branch naming failed (${response.status}).`);
  const data = await response.json();
  return parseBranchName(data?.choices?.[0]?.message?.content);
}
