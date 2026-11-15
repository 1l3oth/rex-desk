// The file window in a window of its own: the files it was given arrive in the address (#{"paths":[…],"active":…}).
import { standaloneFiles } from '/chat-files.js';
import { showToast } from '/toast.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
async function api(path, { method = 'GET', data } = {}) {
  const response = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-rex-desk': '1' }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && body.signIn) { const auth = await fetch('/api/auth', { headers: { 'x-rex-desk': '1' } }).then(reply => reply.json()).catch(() => null); if (auth?.current) return api(path, { method, data }); }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}
const toast = (text, bad = false) => showToast(text, bad);
const ctx = { api, toast, esc, ui: { view: { type: 'files', id: '' }, snap: {} }, currentRunId: () => '' };
let wanted = {};
try { wanted = JSON.parse(decodeURIComponent(location.hash.slice(1)) || '{}'); } catch { wanted = {}; }
void standaloneFiles(ctx, wanted);
