// Loaded with `electron -r` before the app's main script. Each Rex Desk run gets its own profile folders,
// and the app cannot update itself, register login startup, or claim URL protocols on this computer.
const { app } = require('electron');
const Module = require('node:module');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const home = process.env.REX_ELECTRON_HOME;
if (!home) throw new Error('REX_ELECTRON_HOME is required for an isolated Electron run.');
for (const [name, folder] of [['userData', 'user-data'], ['sessionData', 'session-data'], ['logs', 'logs'], ['crashDumps', 'crash-dumps'], ['temp', 'temp']]) {
  try { app.setPath(name, path.join(home, folder)); } catch {}
}
app.setAsDefaultProtocolClient = () => false;
app.removeAsDefaultProtocolClient = () => false;
app.setLoginItemSettings = () => {};

class InertUpdater extends EventEmitter {
  constructor() { super(); this.logger = null; this.channel = null; this.autoDownload = false; this.autoInstallOnAppQuit = false; }
  checkForUpdates() { process.nextTick(() => this.emit('update-not-available', null)); return Promise.resolve(null); }
  checkForUpdatesAndNotify() { return this.checkForUpdates(); }
  downloadUpdate() { return Promise.resolve([]); }
  quitAndInstall() {}
  setFeedURL() {}
  isUpdaterActive() { return false; }
}
class InertAutoLaunch {
  enable() { return Promise.resolve(); }
  disable() { return Promise.resolve(); }
  isEnabled() { return Promise.resolve(false); }
}
const updater = new InertUpdater();
const load = Module._load;
Module._load = function rexIsolatedLoad(request, parent, isMain) {
  if (request === 'electron-updater') return { autoUpdater: updater, AppUpdater: InertUpdater, NsisUpdater: InertUpdater, MacUpdater: InertUpdater };
  if (request === 'auto-launch') return InertAutoLaunch;
  const loaded = load.apply(this, arguments);
  if (request === 'electron' && loaded && loaded.autoUpdater) {
    // Electron's built-in Squirrel updater is also replaced; the property is read-only, so wrap the module.
    return new Proxy(loaded, { get: (target, key) => key === 'autoUpdater' ? updater : Reflect.get(target, key) });
  }
  return loaded;
};
process.env.REX_ELECTRON_ISOLATED = '1';
