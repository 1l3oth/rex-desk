import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/monitor.js';

test('the monitor sorts processes: working agents with their tools, previews, leftovers, your own terminals', () => {
  const self = 100, list = [
    { pid: self, ppid: 1, name: 'node.exe', mb: 150, cmd: 'node src/server.js' },
    { pid: 200, ppid: self, name: 'claude.exe', mb: 300, cmd: 'claude.exe --print' },
    { pid: 201, ppid: 200, name: 'node.exe', mb: 40, cmd: 'node @playwright/mcp/cli.js' },
    { pid: 300, ppid: self, name: 'cmd.exe', mb: 5, cmd: 'cmd /c npm run dev' },
    { pid: 301, ppid: 300, name: 'java.exe', mb: 600, cmd: 'java -DJEX_HOME=F:/wt/src' },
    { pid: 400, ppid: 50, name: 'claude.exe', mb: 470, cmd: 'claude.exe --resume' },
    { pid: 500, ppid: 9999, name: 'node.exe', mb: 30, cmd: 'node C:/npm-cache/_npx/x/node_modules/@playwright/mcp/cli.js --browser chrome' },
    { pid: 501, ppid: 500, name: 'node.exe', mb: 20, cmd: 'node child' },
    { pid: 600, ppid: 70, name: 'node.exe', mb: 11, cmd: 'C:\nodejs\node.exe src/server.js' },
    { pid: 50, ppid: 1, name: 'WindowsTerminal.exe', mb: 80, cmd: 'wt' },
    { pid: 70, ppid: 1, name: 'explorer.exe', mb: 90, cmd: 'explorer' },
  ];
  const groups = classify(list, { selfPid: self });
  assert.deepEqual(groups.agents.map(item => item.pid), [200]);
  assert.equal(groups.agents[0].mb, 340, 'an agent counts with its tools'); assert.equal(groups.agents[0].helpers, 1);
  assert.deepEqual(groups.previews.map(item => item.pid).sort(), [300, 301]);
  assert.deepEqual(groups.terminals.map(item => item.pid), [400], 'your own Claude Code is never a leftover');
  assert.equal(groups.terminals[0].app, 'Windows Terminal', 'it says which app opened it');
  assert.deepEqual(groups.leftovers.map(item => item.pid).sort(), [500, 501], 'a helper whose app closed, and its child');
  assert.deepEqual(groups.servers.map(item => item.pid), [600]);
});
