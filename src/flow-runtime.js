import path from 'node:path';
import { existsSync, readdirSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, constants } from 'node:fs';
import { shellCommand } from './processes.js';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../scripts/start-flow-tomcat.ps1', import.meta.url));
// Flow decides the product from globalConfig: ap-northeast-2 runs Flow, any other region runs Morningmate (FlowBase.isGlobalService).
export const profileKeys = ['default_region', 'product_name', 'default_countryCode', 'default_langCode'];
export const productPresets = {
  morningmate: { name: 'Morningmate', overrides: { default_region: 'ap-northeast-1', product_name: 'MORNINGMATE', default_countryCode: 'JP', default_langCode: 'en' } },
  flow: { name: 'Flow', overrides: { default_region: 'ap-northeast-2', product_name: 'FLOW', default_countryCode: 'KR', default_langCode: 'ko' } },
};
const userConfig = 'src/WEB-INF/jex/config/jex.content.user.xml';

export function defaultProfiles() {
  return Object.entries(productPresets).map(([id, preset]) => ({ id, name: preset.name, product: id, overrides: { ...preset.overrides }, seedPath: '' }));
}
function validateProfile(profile, index) {
  const id = String(profile.id || '').trim();
  if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new Error(`Runtime profile ${index + 1} needs a short lowercase ID.`);
  if (!['flow', 'morningmate'].includes(profile.product)) throw new Error(`Runtime profile ${id} must be Flow or Morningmate.`);
  const overrides = {};
  for (const key of profileKeys) {
    const value = String(profile.overrides?.[key] ?? productPresets[profile.product].overrides[key]).trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(value)) throw new Error(`Runtime profile ${id}: ${key} must be a short code such as ${productPresets[profile.product].overrides[key]}.`);
    overrides[key] = value;
  }
  if ((profile.product === 'flow') !== (overrides.default_region === 'ap-northeast-2')) throw new Error(`Runtime profile ${id}: Flow uses region ap-northeast-2; Morningmate uses any other region.`);
  const seedPath = String(profile.seedPath || '').trim();
  if (seedPath && !path.isAbsolute(seedPath)) throw new Error(`Runtime profile ${id}: seed folder must be absolute.`);
  return { id, name: String(profile.name || productPresets[profile.product].name).slice(0, 60), product: profile.product, overrides, seedPath: seedPath ? path.resolve(seedPath) : '' };
}
export function validateFlowRuntime(value) {
  if (!value) return undefined;
  if (process.platform !== 'win32') throw new Error('The Flow Tomcat preset currently requires Windows. Use a custom dev command elsewhere.');
  const result = {};
  for (const key of ['templateBase', 'javaHome', 'catalinaHome', 'seedPath']) {
    if (!path.isAbsolute(value[key] || '')) throw new Error(`Flow Tomcat ${key} must be an absolute folder.`);
    result[key] = path.resolve(value[key]);
  }
  result.maxHeapMb = Number(value.maxHeapMb || 512);
  if (!Number.isInteger(result.maxHeapMb) || result.maxHeapMb < 256 || result.maxHeapMb > 4096) throw new Error('Tomcat heap must be 256–4096 MB per worker.');
  result.profiles = (Array.isArray(value.profiles) && value.profiles.length ? value.profiles : defaultProfiles()).map(validateProfile);
  if (new Set(result.profiles.map(profile => profile.id)).size !== result.profiles.length) throw new Error('Runtime profile IDs must be unique.');
  result.defaultProfile = result.profiles.some(profile => profile.id === value.defaultProfile) ? value.defaultProfile : result.profiles[0].id;
  return result;
}
// Reads only the product-switch codes, never credentials, so Settings can show which product a seed starts.
export function seedProduct(seedPath) {
  const file = path.join(seedPath || '', userConfig);
  if (!seedPath || !existsSync(file)) return null;
  const block = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '').match(/<globalConfig>([\s\S]*?)<\/globalConfig>/)?.[1] || '';
  const values = Object.fromEntries(profileKeys.map(key => [key, block.match(new RegExp(`<${key}>\\s*([^<]*?)\\s*</${key}>`))?.[1] || '']));
  return { product: values.default_region && values.default_region !== 'ap-northeast-2' ? 'morningmate' : 'flow', ...values };
}
export function applyProfileOverrides(text, overrides) {
  // Commented-out examples often repeat globalConfig; only the live section is switched.
  const comments = [...text.matchAll(/<!--[\s\S]*?-->/g)].map(item => [item.index, item.index + item[0].length]);
  const match = [...text.matchAll(/<globalConfig>([\s\S]*?)<\/globalConfig>/g)].find(item => !comments.some(([start, end]) => item.index >= start && item.index < end));
  if (!match) throw new Error('JEX user configuration has no globalConfig section to switch products.');
  let block = match[1];
  for (const [key, value] of Object.entries(overrides)) {
    const pattern = new RegExp(`(<${key}>)[^<]*(</${key}>)`);
    block = pattern.test(block) ? block.replace(pattern, `$1${value}$2`) : `${block}  <${key}>${value}</${key}>\n`;
  }
  return text.slice(0, match.index) + `<globalConfig>${block}</globalConfig>` + text.slice(match.index + match[0].length);
}
export function runtimeProfile(repository, profileId) {
  const flow = repository.flowRuntime;
  if (!flow) return null;
  const profiles = flow.profiles?.length ? flow.profiles : defaultProfiles();
  const selected = profiles.find(profile => profile.id === (profileId || flow.defaultProfile)) || profiles[0];
  if (profileId && selected.id !== profileId) throw new Error(`Runtime profile ${profileId} is not configured for ${repository.name}.`);
  return selected;
}
export function seedFlowWorktree(repository, worktree, profileId) {
  const flow = repository.flowRuntime;
  if (!flow) return { files: [], profile: null };
  const profile = runtimeProfile(repository, profileId), seed = profile.seedPath || flow.seedPath;
  const copied = [];
  // Copy only local JEX settings. Never share mutable files, build output, or node_modules between branches.
  for (const relative of ['src/WEB-INF/jex/config', 'src/WEB-INF/jex/license']) {
    const from = path.join(seed, relative), to = path.join(worktree, relative);
    const visit = (source, destination) => {
      if (!existsSync(source)) return;
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('JEX configuration seed must contain real files, not links.');
        const sourceFile = path.join(source, entry.name), targetFile = path.join(destination, entry.name);
        if (entry.isDirectory()) visit(sourceFile, targetFile);
        else if (entry.isFile() && !existsSync(targetFile)) {
          mkdirSync(path.dirname(targetFile), { recursive: true });
          copyFileSync(sourceFile, targetFile, constants.COPYFILE_EXCL);
          copied.push(path.relative(worktree, targetFile));
        }
      }
    };
    visit(from, to);
  }
  // The product switch is written only into this worktree's copy; the seed checkout keeps its own configuration.
  const target = path.resolve(worktree, userConfig);
  if (!target.startsWith(path.resolve(worktree) + path.sep)) throw new Error('Runtime configuration must stay inside the worktree.');
  if (!existsSync(target)) throw new Error(`The seed folder ${seed} has no ${userConfig}. Choose a Flow checkout with local JEX configuration.`);
  writeFileSync(target, applyProfileOverrides(readFileSync(target, 'utf8'), profile.overrides));
  return { files: copied, profile: { id: profile.id, name: profile.name, product: profile.product, region: profile.overrides.default_region } };
}
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
export function flowPreview(repository, run, dataDirectory, onData) {
  const flow = repository.flowRuntime;
  const runtime = path.join(dataDirectory, 'runtimes', run.id);
  const command = `& ${quote(launcher)} -Worktree ${quote(run.worktree)} -Runtime ${quote(runtime)} -Port ${run.port} -TemplateBase ${quote(flow.templateBase)} -JavaHome ${quote(flow.javaHome)} -CatalinaHome ${quote(flow.catalinaHome)} -MaxHeapMb ${flow.maxHeapMb}`;
  return shellCommand(command, { cwd: run.worktree, timeout: 0, env: { PORT: String(run.port), REX_RUN_ID: run.id }, onData });
}
