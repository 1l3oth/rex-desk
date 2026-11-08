import { spawn, execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, renameSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import net from 'node:net';

// Voice commands are transcribed on this computer, for free and offline: llama.cpp's llama-server runs Qwen3-ASR.
// Khmer uses a Khmer fine-tune (seanghay/Qwen3-ASR-0.6B-Khmer, about 2% character error); English and Korean use the base model.
// Audio never leaves the computer. Each model's server starts on the first command and stops after five quiet minutes.
export const engineRelease = 'b12189';
export const voiceLanguages = { km: 'Khmer', en: 'English', ko: 'Korean' };
const engineAsset = (platform = process.platform, arch = process.arch) =>
  platform === 'win32' ? `llama-${engineRelease}-bin-win-cpu-x64.zip` : platform === 'darwin' ? `llama-${engineRelease}-bin-macos-${arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz` : '';
export const voiceModels = {
  km: { repo: 'mradermacher/Qwen3-ASR-0.6B-Khmer-GGUF', model: 'Qwen3-ASR-0.6B-Khmer.Q8_0.gguf', mmproj: 'Qwen3-ASR-0.6B-Khmer.mmproj-Q8_0.gguf' },
  base: { repo: 'ggml-org/Qwen3-ASR-0.6B-GGUF', model: 'Qwen3-ASR-0.6B-Q8_0.gguf', mmproj: 'mmproj-Qwen3-ASR-0.6B-Q8_0.gguf' },
};
const modelFor = language => language === 'km' ? 'km' : 'base';
// Qwen3-ASR writes "language Korean<asr_text>" before the words; only the words are wanted.
export const cleanTranscript = text => String(text || '').replace(/^[\s\S]*?<asr_text>/, '').replace(/<\/?asr_text>/g, '').trim();

// A free port each time: a fixed port can still be held by an engine that was killed, and then nothing answers.
const freePort = () => new Promise((resolve, reject) => { const probe = net.createServer(); probe.unref(); probe.on('error', reject); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
const systemTar = () => process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
function findFile(directory, name) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) { const found = findFile(full, name); if (found) return found; }
  }
  return '';
}

export class Voice {
  constructor(directory, { fetcher = fetch, platform = process.platform } = {}) {
    Object.assign(this, { directory, fetcher, platform });
    this.servers = new Map(); this.installing = null; this.progress = null; this.error = '';
  }
  get engineDirectory() { return path.join(this.directory, 'engine'); }
  get modelDirectory() { return path.join(this.directory, 'models'); }
  serverPath() { return existsSync(this.engineDirectory) ? findFile(this.engineDirectory, this.platform === 'win32' ? 'llama-server.exe' : 'llama-server') : ''; }
  modelsReady(key) { const files = voiceModels[key]; return [files.model, files.mmproj].every(name => existsSync(path.join(this.modelDirectory, name))); }
  status() {
    const supported = Boolean(engineAsset(this.platform));
    const languages = Object.fromEntries(Object.keys(voiceLanguages).map(language => [language, Boolean(this.serverPath()) && this.modelsReady(modelFor(language))]));
    return { supported, installed: Object.values(languages).every(Boolean), languages, installing: Boolean(this.installing), progress: this.progress, error: this.error,
      running: [...this.servers.keys()], directory: this.directory, downloadMB: 1900 };
  }
  // About 1.9 GB: the 24 MB engine, the Khmer model, and the English and Korean model, each with its audio encoder.
  install() {
    if (this.installing) return this.installing;
    this.error = '';
    this.installing = this.download().catch(error => { this.error = error.message; throw error; }).finally(() => { this.installing = null; this.progress = null; });
    return this.installing;
  }
  async download() {
    const asset = engineAsset(this.platform);
    if (!asset) throw new Error('Voice commands run on Windows and macOS.');
    mkdirSync(this.modelDirectory, { recursive: true });
    const wanted = [];
    if (!this.serverPath()) wanted.push({ url: `https://github.com/ggml-org/llama.cpp/releases/download/${engineRelease}/${asset}`, file: path.join(this.directory, asset), unpack: true });
    for (const files of Object.values(voiceModels)) for (const name of [files.model, files.mmproj])
      if (!existsSync(path.join(this.modelDirectory, name))) wanted.push({ url: `https://huggingface.co/${files.repo}/resolve/main/${name}`, file: path.join(this.modelDirectory, name) });
    for (const [index, item] of wanted.entries()) {
      this.progress = { file: path.basename(item.file), index: index + 1, total: wanted.length, receivedMB: 0, sizeMB: 0 };
      const response = await this.fetcher(item.url, { redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${path.basename(item.file)}.`);
      this.progress.sizeMB = Math.round(Number(response.headers.get('content-length') || 0) / 1e6);
      const partial = `${item.file}.part`, progress = this.progress;
      const counter = new TransformStream({ transform(chunk, controller) { progress.receivedMB = +(progress.receivedMB + chunk.byteLength / 1e6).toFixed(1); controller.enqueue(chunk); } });
      await pipeline(Readable.fromWeb(response.body.pipeThrough(counter)), createWriteStream(partial));
      renameSync(partial, item.file);
      if (item.unpack) {
        mkdirSync(this.engineDirectory, { recursive: true });
        await new Promise((resolve, reject) => execFile(systemTar(), ['-xf', item.file, '-C', this.engineDirectory], { windowsHide: true }, error => error ? reject(new Error(`Could not unpack the voice engine: ${error.message}`)) : resolve()));
        rmSync(item.file, { force: true });
      }
    }
    return this.status();
  }
  server(key) {
    const running = this.servers.get(key);
    if (running) { this.rest(key); return running.ready; }
    const executable = this.serverPath();
    if (!executable || !this.modelsReady(key)) return Promise.reject(new Error('Voice is not installed yet. Open Settings → Computer control and install voice commands.'));
    // One model in memory at a time: each holds about 1 GB.
    for (const other of [...this.servers.keys()]) if (other !== key) this.stop(other);
    // The entry is registered before anything waits, so a second request for the same model shares this start.
    const entry = { child: null, url: '', log: '' };
    const tail = lines => entry.log.trim().split('\n').slice(-lines).join(' ').slice(-300);
    entry.ready = (async () => {
      const files = voiceModels[key], port = await freePort();
      entry.url = `http://127.0.0.1:${port}`;
      // --load-mode none reads the model in one go (older builds called it --no-mmap); memory-mapping it crawled page by page on a Windows laptop short of free memory.
      const child = entry.child = spawn(executable, ['-m', path.join(this.modelDirectory, files.model), '--mmproj', path.join(this.modelDirectory, files.mmproj),
        '--host', '127.0.0.1', '--port', String(port), '-c', '4096', '--load-mode', 'none', '--no-webui'], { cwd: path.dirname(executable), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', chunk => { entry.log = (entry.log + chunk).slice(-3000); });
      child.on('exit', () => { if (this.servers.get(key) === entry) this.servers.delete(key); });
      if (entry.stopped) child.kill();
      // The first load after a restart reads about 1 GB; on a hard disk that can take a couple of minutes.
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        if (entry.stopped) throw new Error('The voice engine was stopped.');
        if (child.exitCode !== null) throw new Error(`The voice engine stopped: ${tail(2)}`);
        try { if ((await this.fetcher(`${entry.url}/health`, { signal: AbortSignal.timeout(1000) })).ok) return entry; } catch {}
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      throw new Error(`The voice engine did not load its model within 4 minutes. ${tail(1)}`.trim());
    })();
    this.servers.set(key, entry); this.rest(key);
    entry.ready.catch(() => this.stop(key));
    return entry.ready;
  }
  // Each model holds about 1 GB of memory, so it is let go when nobody has spoken for five minutes.
  rest(key) {
    const entry = this.servers.get(key); if (!entry) return;
    clearTimeout(entry.idle); entry.idle = setTimeout(() => this.stop(key), 5 * 60000); entry.idle.unref?.();
  }
  stop(key) { const entry = this.servers.get(key); if (!entry) return; clearTimeout(entry.idle); this.servers.delete(key); entry.stopped = true; entry.child?.kill(); }
  stopAll() { for (const key of [...this.servers.keys()]) this.stop(key); }
  // Warm the right model as soon as the person presses the microphone, so the words come back quickly.
  prepare(language = 'en') { return this.server(modelFor(language)).then(() => true); }
  async transcribe(audio, language = 'en') {
    if (!voiceLanguages[language]) throw new Error('Voice understands Khmer (km), English (en), and Korean (ko).');
    if (!audio?.length) throw new Error('No sound was recorded.');
    // If the Khmer model cannot start on this computer, the base model still tries, and the answer says so.
    let key = modelFor(language), fallback = '';
    let server = await this.server(key).catch(error => { if (key === 'base') throw error; fallback = error.message; return null; });
    if (!server) { key = 'base'; server = await this.server(key); }
    const { url } = server;
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/wav' }), 'command.wav');
    form.append('model', 'qwen3-asr');
    form.append('language', language);
    const response = await this.fetcher(`${url}/v1/audio/transcriptions`, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    const text = await response.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    if (!response.ok) throw new Error(`Transcription failed (${response.status}): ${String(data?.error?.message || text).slice(0, 200)}`);
    this.rest(key);
    return { text: cleanTranscript(data?.text), language, ...(fallback ? { fallback: `The Khmer model did not start, so the general model was used: ${fallback}` } : {}) };
  }
  size() {
    let bytes = 0;
    const walk = directory => { for (const entry of readdirSync(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) walk(full); else bytes += statSync(full).size; } };
    try { walk(this.directory); } catch {}
    return Math.round(bytes / 1e6);
  }
}
