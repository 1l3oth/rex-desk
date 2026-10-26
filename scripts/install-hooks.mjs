// npm install points Git at the repository's own hooks (.githooks), so a push to master is refused before it leaves the computer.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('.git')) {
  try { execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' }); }
  catch { console.log('Could not set core.hooksPath; run: git config core.hooksPath .githooks'); }
}
