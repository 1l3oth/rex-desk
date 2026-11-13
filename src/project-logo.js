// A project's own logo, for the avatar of an agent made for it: the files a project usually keeps its logo or icon in,
// best first. Only small pictures (an avatar travels with the agent to the person's other computers): a logo over 60 KB
// is skipped, and the agent gets one of the robot avatars instead.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const LIMIT = 60 * 1024;
const TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const FOLDERS = ['', 'public', 'assets', 'src/assets', 'static', 'images', 'img', 'public/images', 'public/img', 'src/images', 'resources', '.github', 'docs'];
const NAMES = ['logo.svg', 'logo.png', 'logo.webp', 'logo-mark.svg', 'mark.svg', 'icon.svg', 'favicon.svg', 'apple-touch-icon.png', 'icon.png', 'logo.jpg', 'favicon.png', 'icon-192.png', 'icon-512.png', 'android-chrome-192x192.png'];
// App icons kept where desktop and mobile builds look for them.
const APP_ICONS = ['app/icon.svg', 'app/icon.png', 'src/app/icon.svg', 'src/app/icon.png', 'app/apple-icon.png', 'src/app/apple-icon.png', // Next.js
  'src-tauri/icons/128x128.png', 'src-tauri/icons/icon.png', 'desktop/src-tauri/icons/128x128.png', 'build/icon.png', 'electron/icon.png', 'resources/icon.png', 'app/src/main/res/mipmap-xxhdpi/ic_launcher.png', 'app/src/main/res/mipmap-xhdpi/ic_launcher.png', 'ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-60x60@3x.png'];

const usable = file => {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return false;
    const size = statSync(file).size;
    return size > 0 && size <= LIMIT && Boolean(TYPES[path.extname(file).toLowerCase()]);
  } catch { return false; }
};
// An SVG that carries a script or loads something from elsewhere is left alone.
const safeSvg = text => !/<script|on[a-z]+\s*=|javascript:|<foreignObject|xlink:href\s*=\s*["']?https?:|href\s*=\s*["']?https?:/i.test(text);

// The candidates in order, for the person to see (and for tests).
export function logoCandidates(root) {
  const found = [];
  for (const folder of FOLDERS) for (const name of NAMES) found.push(path.join(root, folder, name));
  for (const icon of APP_ICONS) found.push(path.join(root, icon));
  // A name with the project in it, like "rexdesk-logo.svg", in the usual folders.
  for (const folder of ['', 'public', 'assets', 'src/assets', 'static', 'images']) {
    try { for (const name of readdirSync(path.join(root, folder))) if (/logo/i.test(name) && TYPES[path.extname(name).toLowerCase()]) found.push(path.join(root, folder, name)); } catch { /* no such folder */ }
  }
  return [...new Set(found)];
}

// The logo as a data URL ({ file, dataUrl }), or null when the project has none Rex Desk can use.
export function findProjectLogo(root) {
  if (!root || !existsSync(root)) return null;
  for (const file of logoCandidates(root)) {
    if (!usable(file)) continue;
    const type = TYPES[path.extname(file).toLowerCase()], bytes = readFileSync(file);
    if (type === 'image/svg+xml' && !safeSvg(bytes.toString('utf8'))) continue;
    return { file, dataUrl: `data:${type};base64,${bytes.toString('base64')}` };
  }
  return null;
}
