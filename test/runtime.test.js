import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyProfileOverrides, seedFlowWorktree, seedProduct, validateFlowRuntime, runtimeProfile } from '../src/flow-runtime.js';

const temporary = label => mkdtempSync(path.join(os.tmpdir(), `rex-desk-${label}-`));
const config = `<?xml version="1.0" encoding="UTF-8"?>
<jex>
  <!-- <globalConfig><default_region>ap-northeast-2</default_region></globalConfig> -->
  <globalConfig>
    <default_region>ap-northeast-1</default_region>
    <product_name>MORNINGMATE</product_name>
    <default_countryCode>JP</default_countryCode>
    <default_langCode>en</default_langCode>
    <secret>do-not-touch</secret>
  </globalConfig>
  <service_URL><real_url>https://example.invalid</real_url></service_URL>
</jex>
`;
const flowSeed = () => {
  const seed = temporary('seed');
  mkdirSync(path.join(seed, 'src/WEB-INF/jex/config'), { recursive: true });
  mkdirSync(path.join(seed, 'src/WEB-INF/jex/license'), { recursive: true });
  writeFileSync(path.join(seed, 'src/WEB-INF/jex/config/jex.content.user.xml'), config);
  writeFileSync(path.join(seed, 'src/WEB-INF/jex/config/jex.content.xml'), '<jex><db>seed</db></jex>');
  writeFileSync(path.join(seed, 'src/WEB-INF/jex/license/jex.license'), 'license');
  return seed;
};
const runtime = seed => validateFlowRuntime(process.platform === 'win32' ? { templateBase: 'C:\\tomcat-template', javaHome: 'C:\\java8', catalinaHome: 'C:\\tomcat', seedPath: seed, maxHeapMb: 512 } : null);

test('product profiles switch only globalConfig codes and keep every other setting', () => {
  const flow = applyProfileOverrides(config, { default_region: 'ap-northeast-2', product_name: 'FLOW', default_countryCode: 'KR', default_langCode: 'ko' });
  assert.match(flow, /<globalConfig>[\s\S]*<default_region>ap-northeast-2<\/default_region>[\s\S]*<product_name>FLOW<\/product_name>/);
  assert.match(flow, /<secret>do-not-touch<\/secret>/);
  assert.match(flow, /<!-- <globalConfig><default_region>ap-northeast-2<\/default_region><\/globalConfig> -->/);
  assert.equal(flow, config.replace('>ap-northeast-1<', '>ap-northeast-2<').replace('>MORNINGMATE<', '>FLOW<').replace('>JP<', '>KR<').replace('>en<', '>ko<'));
  assert.throws(() => applyProfileOverrides('<jex/>', { default_region: 'x' }), /no globalConfig/);
});

test('runtime profiles validate product and region, and two runs get independent worktree configuration', { skip: process.platform !== 'win32' }, () => {
  const seed = flowSeed();
  assert.equal(seedProduct(seed).product, 'morningmate');
  const flow = runtime(seed);
  assert.deepEqual(flow.profiles.map(profile => profile.id), ['morningmate', 'flow']);
  assert.throws(() => validateFlowRuntime({ ...flow, profiles: [{ id: 'flow', product: 'flow', overrides: { default_region: 'ap-northeast-1' } }] }), /Flow uses region ap-northeast-2/);
  assert.throws(() => validateFlowRuntime({ ...flow, profiles: [{ id: 'mm', product: 'morningmate', overrides: { product_name: 'BAD VALUE!' } }] }), /short code/);
  const repository = { name: 'flow-was', flowRuntime: flow };
  assert.throws(() => runtimeProfile(repository, 'missing'), /not configured/);
  const first = temporary('worktree-a'), second = temporary('worktree-b');
  const morningmate = seedFlowWorktree(repository, first, 'morningmate');
  const flowRun = seedFlowWorktree(repository, second, 'flow');
  assert.equal(morningmate.files.length, 3);
  assert.equal(seedProduct(first).product, 'morningmate');
  assert.equal(seedProduct(second).product, 'flow');
  assert.equal(flowRun.profile.region, 'ap-northeast-2');
  assert.equal(readFileSync(path.join(seed, 'src/WEB-INF/jex/config/jex.content.user.xml'), 'utf8'), config, 'The seed checkout is never modified');
  // Resuming re-applies the selected profile without copying over files the worktree already has.
  writeFileSync(path.join(second, 'src/WEB-INF/jex/config/jex.content.xml'), '<jex><db>branch-local</db></jex>');
  assert.equal(seedFlowWorktree(repository, second, 'flow').files.length, 0);
  assert.equal(readFileSync(path.join(second, 'src/WEB-INF/jex/config/jex.content.xml'), 'utf8'), '<jex><db>branch-local</db></jex>');
});

test('the Electron preset is detected from package metadata and rejects paths or switches that escape the worktree', async () => {
  const { detectElectron, validateElectronRuntime, electronLaunch } = await import('../src/electron-runtime.js');
  const root = temporary('electron');
  mkdirSync(path.join(root, 'app'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ main: './app/main.js', devDependencies: { electron: '43.2.0' } }));
  writeFileSync(path.join(root, 'app/package.json'), JSON.stringify({ name: 'flow', main: 'main.js' }));
  const detected = detectElectron(root);
  assert.equal(detected.appDir, 'app');
  assert.equal(detected.nestedInstall, true);
  assert.equal(detectElectron(temporary('plain')), null);
  assert.throws(() => validateElectronRuntime({ appDir: '../other' }), /inside the repository/);
  assert.throws(() => validateElectronRuntime({ electronPath: 'C:\\Windows\\notepad.exe' }), /inside the repository/);
  assert.throws(() => validateElectronRuntime({ electronPath: 'C:Windows/notepad.exe' }), /inside the repository/);
  assert.throws(() => validateElectronRuntime({ args: '--enable-logging; calc' }), /plain switches/);
  assert.throws(() => electronLaunch({ electronRuntime: detected }, { id: 'run', worktree: root, port: 1 }, temporary('data'), temporary('video')), /not installed in this worktree/);
});
