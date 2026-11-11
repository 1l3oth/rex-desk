import test from 'node:test';
import assert from 'node:assert/strict';
import { projectIn } from '../src/runners.js';

test('a project agent is kept out of other projects by any spelling of their folder', () => {
  const others = [{ name: 'flow-was', path: 'f:/flow-was' }];
  assert.equal(projectIn({ command: 'cd /f/flow-was && git show 88ede631a34' }, others)?.name, 'flow-was');
  assert.equal(projectIn({ file_path: 'F:\\flow-was\\src\\OPENAPI_L001_act.jsp' }, others)?.name, 'flow-was');
  assert.equal(projectIn({ pattern: 'API_CALL', path: 'F:/flow-was' }, others)?.name, 'flow-was');
  assert.equal(projectIn({ command: 'git -C "F:\\flow-was" log' }, others)?.name, 'flow-was');
  assert.equal(projectIn({ command: 'cd F:/flow-was-worktrees/49760 && ls' }, others), null, 'a folder that only starts the same is not that project');
  assert.equal(projectIn({ file_path: 'F:/studybook/index.html' }, others), null);
  assert.equal(projectIn({ command: 'cd /f/flow-was' }, []), null, 'Rex Agent has no list and goes anywhere');
});
