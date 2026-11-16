import path from 'node:path';
import { git } from './processes.js';

// After a straight push to the branch Rex Desk itself runs from, bring that checkout up to date (fast-forward only), so nobody has to pull by hand.
// It never touches a checkout that is on another branch or has local changes; it says why it skipped. Returns one plain line, or '' when the push was not to Rex Desk.
export async function pullLiveCheckout({ root, repositoryPath, target }) {
  if (!root || !repositoryPath || path.resolve(root).toLowerCase() !== path.resolve(repositoryPath).toLowerCase()) return '';
  try {
    const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (branch !== target) return `Rex Desk's own folder is on ${branch}, not ${target}, so it was not updated.`;
    if ((await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim()) return 'Rex Desk\'s own folder has changes that are not committed, so it was not updated. Pull it by hand.';
    const before = (await git(root, ['rev-parse', 'HEAD'])).trim();
    await git(root, ['pull', '--ff-only', 'origin', target]);
    const changed = (await git(root, ['diff', '--name-only', before, 'HEAD'])).split('\n').filter(Boolean);
    if (!changed.length) return 'Rex Desk\'s own folder was already up to date.';
    return changed.some(file => file.startsWith('src/') || file === 'package.json') ? 'Rex Desk\'s own folder is updated. The server code changed, so Rex Desk needs a restart.' : 'Rex Desk\'s own folder is updated. Refresh the page to see it.';
  } catch (error) { return `Rex Desk's own folder could not be updated (${String(error.message).split('\n')[0]}). Pull it by hand.`; }
}
