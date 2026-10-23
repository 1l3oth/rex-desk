import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const files = ['public/app.js', ...readdirSync('src').filter(file => file.endsWith('.js')).map(file => `src/${file}`)];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status || 1);
}
const result = spawnSync(process.execPath, ['--test', 'test/core.test.js'], { stdio: 'inherit', windowsHide: true });
process.exit(result.status || 0);
