import { askConfirm } from './confirm.js';
import { seeThroughHere, solidSlider } from './see-through.js';
import { t, languagePicker } from './i18n.js';
import { pickerHtml } from '/chat-pick.js';
import { noticeSettingsHtml } from '/chat-notices.js';
import { voicesFor, chosenVoice, setSpeechEngine } from '/chat-speak.js';
import { loadFolders, foldersHtml, folderClick, startTour } from '/chat-tour.js';
import { skeletonHtml } from '/chat-skeleton.js';
import { glassSlider } from '/chat-glass.js';
import { trackerDraft, readTrackers, trackersHtml, trackerSources, trackerClick, trackerInput } from '/chat-trackers.js';
import { connectorsHtml, connectorsClick, connectorsChange, loadConnectors } from '/chat-connectors.js';
import { runSettingsTour } from '/chat-settings-tour.js';
import { loadLocalAi, localAiHtml, localAiClick } from '/chat-local-ai.js';
import { loadTourAi, aiListHtml, tourAiClick } from '/chat-tour-ai.js';
import { loadStorage, storageHtml, storageClick, storageInput } from '/chat-storage.js';
// Settings, as a popup over the chat: the sections on the left, one section's settings on the right. Each section saves on its own,
// so a change never waits for the rest. It replaces the old "Issues & settings" page.
// The plan, bought and managed right here with the account this computer is signed in to: Stripe's payment page opens in the
// browser, already knowing who pays, and the plan shows here by itself once it is paid.
function planCard(database, state) {
  const billing = state.extra.billing; if (!billing) return '';
  const busy = state.extra.billingBusy ? 'disabled' : '';
  const tick = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const list = items => `<ul class="pl-feat">${items.map(item => `<li>${tick}<span>${item}</span></li>`).join('')}</ul>`;
  if (!billing.signedIn) return `<div class="pl-card"><div class="pl-head"><b>${t`Your plan`}</b></div><p class="pl-sub">${t`Sign in with your Rex Desk account to see your plan, buy cloud backup or add space.`}</p><button type="button" class="btn primary" data-st-plan-signin ${busy}>${t`Sign in with Rex Desk`}</button></div>`;
  const space = billing.space || database.space; if (!space) return '';
  // Step 1: choose. Free and Cloud backup side by side, with a monthly or yearly switch, as on every big app's plan page.
  if (!space.paid) {
    const yearly = state.extra.billingCycle === 'year';
    const waiting = state.extra.billingWaiting ? `<div class="pl-wait" role="status"><span class="pl-spin" aria-hidden="true"></span><span><b>${t`Waiting for your payment`}</b><small>${t`Finish paying on the Stripe page in your browser. Cloud backup turns on here by itself.`}</small></span><button type="button" class="btn small" data-st-buy="${yearly ? 'year' : 'month'}" ${busy}>${t`Open the payment page again`}</button></div>` : '';
    return `${waiting}<div class="pl-cycle" role="radiogroup" aria-label="${t`Billing period`}"><button type="button" role="radio" aria-checked="${!yearly}" class="${yearly ? '' : 'on'}" data-st-cycle="month">${t`Monthly`}</button><button type="button" role="radio" aria-checked="${yearly}" class="${yearly ? 'on' : ''}" data-st-cycle="year">${t`Yearly`}<span class="pl-save">${t`Save 33%`}</span></button></div>
      <div class="pl-grid">
        <div class="pl-card"><div class="pl-head"><b>${t`Free`}</b><span class="pl-badge">${t`Current plan`}</span></div><p class="pl-price"><b>$0</b></p>${list([t('Every agent, chat and tool on this computer'), t('Works fully offline'), t('No cloud copy')])}</div>
        <div class="pl-card pl-pick"><div class="pl-head"><b>${t`Cloud backup`}</b><span class="pl-badge pl-badge-accent">${t`Recommended`}</span></div><p class="pl-price"><b>${yearly ? '$24' : '$2.99'}</b><small>${yearly ? t('a year') : t('a month')}</small></p>${list([t('Your agents, chats, tasks and settings in a private cloud database only your account can open'), t('1 GB for pictures and files, locked on your computer before they upload'), t('The same desk on every computer you sign in on, kept in step within seconds'), t('A new computer or a reinstall gets everything back when you sign in'), t('Need more room? Add 5 GB for $1 a month'), t('Cancel any time, nothing on your computer is lost')])}<button type="button" class="btn primary pl-cta" data-st-buy="${yearly ? 'year' : 'month'}" ${busy}>${t`Upgrade to Cloud backup`}</button></div>
      </div>
      <div class="pl-card pl-faq"><div class="pl-head"><b>${t`Questions`}</b></div>
        <details><summary>${t`What happens if I cancel?`}</summary><p class="pl-sub">${t`Cloud backup keeps working until the end of the period you paid for. After that nothing new goes up, and everything stays on your computer.`}</p></details>
        <details><summary>${t`What if my cloud space runs out?`}</summary><p class="pl-sub">${t`Chats and changes keep syncing. New files wait on your computer until there is room. Add 5 GB any time for $1 a month.`}</p></details>
        <details><summary>${t`Who handles my card?`}</summary><p class="pl-sub">${t`Stripe. Rex Desk never sees or keeps your card number.`}</p></details>
      </div>`;
  }
  // Step 3: the plan you have. Name, status, next payment, space, and what you can do with it.
  const files = space.files || {}, share = files.limit ? Math.min(1, files.used / files.limit) : 0, gb = bytes => (bytes / 1024 ** 3).toFixed(bytes >= 1024 ** 3 ? 1 : 2);
  const yearly = space.interval === 'year', date = space.renews ? new Date(space.renews).toLocaleDateString(document.documentElement.lang || 'en', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const amount = space.interval ? (yearly ? 24 + 10 * (space.packs || 0) : 2.99 + (space.packs || 0)).toFixed(2).replace(/\.00$/, '') : '';
  const status = space.status === 'past_due' ? [t('Payment problem'), 'bad'] : space.endsAtPeriodEnd ? [t('Cancelled'), 'warn'] : [t('Active'), 'good'];
  const next = space.status === 'past_due' ? t`Your last payment did not go through. Update your card in Manage billing to keep cloud backup.`
    : space.endsAtPeriodEnd ? (date ? t`Cloud backup ends on ${date}. Everything stays on your computer.` : '')
    : date && amount ? t`Next payment ${`$${amount}`} on ${date}` : '';
  const done = state.extra.billingJustPaid ? `<div class="pl-done" role="status">${tick}<span><b>${t`You are on Cloud backup`}</b><small>${t`Thank you. Your desk is backing up to the cloud now.`}</small></span></div>` : '';
  return `${done}<div class="pl-card pl-current${share >= 0.95 ? ' full' : share >= 0.8 ? ' high' : ''}">
    <div class="pl-head"><b>${t`Cloud backup`}</b><span class="pl-badge pl-${status[1]}">${status[0]}</span></div>
    <p class="pl-price"><b>${space.interval ? (yearly ? '$24' : '$2.99') : '$0'}</b><small>${space.interval ? (yearly ? t('a year') : t('a month')) : t('given by Rex Desk')}</small></p>
    ${next ? `<p class="pl-sub">${next}</p>` : ''}
    <div class="pl-usage"><div class="pl-usage-row"><span>${t`Pictures and files`}</span><span>${t`${gb(files.used || 0)} of ${gb(files.limit || 0)} GB`}</span></div><progress class="pl-meter" max="100" value="${Math.max(1, Math.round(share * 100))}" aria-label="${t`Cloud space used`}"></progress>${space.database?.limit ? (() => { const dbShare = Math.min(1, space.database.used / space.database.limit), mb = bytes => Math.round(bytes / 1024 ** 2); return `<div class="pl-usage-row pl-usage-db"><span>${t`Chats and settings`}</span><span>${t`${mb(space.database.used)} of ${mb(space.database.limit)} MB`}</span></div><progress class="pl-meter${dbShare >= 0.8 ? ' pl-meter-high' : ''}" max="100" value="${Math.max(1, Math.round(dbShare * 100))}" aria-label="${t`Database space used`}"></progress>`; })() : ''}${space.packs ? `<small class="pl-sub">${t`Includes ${space.packs * 5} GB of extra space`}</small>` : ''}${share >= 0.95 ? `<small class="pl-sub">${t`Almost full. Chats and changes keep syncing; new files wait on this computer until there is room.`}</small>` : ''}</div>
    <div class="pl-actions"><button type="button" class="btn${share >= 0.8 ? ' primary' : ''}" data-st-pack ${busy}>${t`Add 5 GB`}</button><button type="button" class="btn" data-st-manage ${busy}>${yearly ? t('Switch to monthly') : t('Switch to yearly')}</button><button type="button" class="btn" data-st-manage ${busy}>${t`Manage billing`}</button></div>
  </div>
  <div class="pl-card"><div class="pl-head"><b>${t`Payment method`}</b><button type="button" class="btn small" data-st-manage ${busy}>${t`Change`}</button></div>
    <p class="pl-sub">${billing.card ? `<b class="pl-cardname">${String(billing.card.brand || '').replace(/^./, ch => ch.toUpperCase()).replace(/[<>&"]/g, '')} •••• ${String(billing.card.last4 || '').replace(/\D/g, '')}</b> · ${t`expires ${String(billing.card.expMonth).padStart(2, '0')}/${billing.card.expYear}`}` : t`Kept by Stripe. Change it in Manage billing.`}</p></div>
  <div class="pl-card"><div class="pl-head"><b>${t`Billing history`}</b></div>
    ${(billing.invoices || []).length ? `<ul class="pl-bills">${billing.invoices.map(item => `<li><span>${new Date(item.date).toLocaleDateString(document.documentElement.lang || 'en', { day: 'numeric', month: 'short', year: 'numeric' })}</span><span>${'$' + Number(item.amount).toFixed(2)}</span><span class="pl-badge pl-${item.status === 'paid' ? 'good' : item.status === 'open' ? 'warn' : 'bad'}">${item.status === 'paid' ? t('Paid') : item.status === 'open' ? t('Due') : t('Not paid')}</span>${item.url ? `<a href="${item.url.replace(/"/g, '')}" target="_blank" rel="noopener">${t`Receipt`}</a>` : '<span></span>'}</li>`).join('')}</ul>` : `<p class="pl-sub">${t`No payments yet.`}</p>`}</div>`;
}
// Voice engine answers across every Settings window. A save always wins: a load counts only when no save started or was still out while it ran,
// and only the newest save (or newest load) counts. show puts a kept answer on the Settings window that is open now.
// saves: voice saves started; open: saves still out; loads: engine loads started; best: the newest save that worked; shown: the save on screen.
const ttsRun = { saves: 0, open: 0, loads: 0, best: null, shown: 0, show: null };
const SECTIONS = [
  ['general', t('General'), t('Name, language, look')],
  ['notify', t('Notifications'), t('Pop-ups, sound, quiet hours')],
  ['jev', t('Jev and voice'), t('Voice, computer control, speech')],
  ['ai', t('AI'), t('Accounts, models, local AI')],
  ['agents', t('Agents'), t('How many, mode, branches')],
  ['projects', t('Projects'), t('Repositories and test sign-ins')],
  ['connectors', t('Connectors'), t('Task apps, chat, code and docs')],
  ['backup', t('Account and backup'), t('Plan, cloud copy, devices')],
  ['storage', t('Storage'), t('Space used and folders')],
  ['about', t('About'), t('Version and updates')],
];
// Each section is one or more panels. The old section names still open the right page.
const PARTS = { general: ['general'], notify: ['notify'], jev: ['jev'], ai: ['accounts', 'localai'], agents: ['agents'], projects: ['projects', 'signins'], connectors: ['sources', 'schedule'], backup: ['backup'], storage: ['storage', 'folders'], about: ['about'] };
const ALIAS = { accounts: 'ai', localai: 'ai', signins: 'projects', tasks: 'connectors', sources: 'connectors', schedule: 'connectors', plan: 'backup', devices: 'backup', folders: 'storage' };
const SAVE_PARTS = ['general', 'agents', 'accounts', 'projects', 'sources', 'jev', 'schedule', 'signins'];
const GROUPS = [
  [t('You'), ['general', 'notify', 'jev']],
  [t('Agents'), ['ai', 'agents']],
  [t('Work'), ['projects', 'connectors']],
  [t('This computer'), ['backup', 'storage', 'about']],
];
// The Settings gear: the phone's Settings tab and the General section use this one drawing.
export const SETTINGS_GEAR = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>';
// An icon for each section, shown in the phone's list of sections.
const ST_ICON = {
  tools: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8V20h3.2l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.4 2.4-2.6-.6-.6-2.6z"/>',
  about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  storage: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  general: SETTINGS_GEAR,
  folders: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5 12 16l2.5-2.5"/>',
  notify: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  agents: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17.5" cy="9" r="2.5"/><path d="M16 14.5a5 5 0 0 1 5.5 5"/>',
  ai: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  connectors: '<path d="M9 7V4M15 7V4M7 7h10v4a5 5 0 0 1-10 0zM12 16v4"/>',
  tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/>',
  accounts: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="11" r="2.2"/><path d="M5.5 16a3.6 3.6 0 0 1 7 0M14 10h4M14 13.5h3"/>',
  localai: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  projects: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  sources: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/>',
  jev: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  schedule: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  signins: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  devices: '<rect x="2" y="4" width="14" height="10" rx="1.5"/><path d="M6 18h6M9 14v4"/><rect x="17" y="8" width="5" height="12" rx="1"/>',
  plan: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19M6.5 15h4"/>',
  backup: '<path d="M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 7.9"/><path d="M12 12v8M9 15l3-3 3 3"/>',
  connect: '<path d="M9 15l6-6M10 6l1-1a4.2 4.2 0 0 1 6 6l-1 1M14 18l-1 1a4.2 4.2 0 0 1-6-6l1-1"/>',
};
// Cloud backup, as a new person first meets it: a picture of what it does (one desk in the cloud, on a laptop and a
// desktop), and why it is worth turning on.
const CLOUD_ART = `<svg class="st-cloud-art" viewBox="0 0 220 96" width="220" height="96" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path class="sca-line" d="M62 66c10-10 22-14 32-14M158 66c-10-10-22-14-32-14" stroke-dasharray="3 5"/>
  <path class="sca-cloud" d="M88 50a16 16 0 0 1 2-31.8A22 22 0 0 1 131 22a14 14 0 0 1 1 28z"/>
  <path class="sca-mark" d="M110 30v12M104.5 35.5 110 30l5.5 5.5"/>
  <rect class="sca-dev" x="14" y="58" width="44" height="28" rx="4"/><path class="sca-dev" d="M8 90h56"/>
  <rect class="sca-dev" x="162" y="56" width="44" height="30" rx="4"/><path class="sca-dev" d="M178 90h12M184 86v4"/>
  <path class="sca-dot" d="M27 70h18M27 76h11M175 68h18M175 74h11"/>
</svg>`;
const CLOUD_WHY = [
  ['<rect x="2.5" y="4" width="13" height="9.5" rx="1.5"/><path d="M6 17h6M9 13.5V17"/><rect x="15.5" y="9" width="6" height="11" rx="1.2"/>', t('Pick up on any computer'), t('Sign in at work or at home and the same agents, chats and settings are there.')],
  ['<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3 4.5v4h4"/><path d="M12 8v4.5l3 1.8"/>', t('Nothing lost'), t('After a reinstall, a broken drive or a new computer, everything comes back when you sign in.')],
  ['<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2.5"/>', t('Private to you'), t('A database of your own that only your account can open. Nothing to set up: no address and no key.')],
];
// What goes to the cloud backup, once it is on. Agents, rooms, projects and settings always go: they make the desk follow
// the person. The rest can stay on this computer only; each switch saves at once.
const BACKUP_PARTS = [
  ['chats', t('Chat history'), t('Every message with your agents. Off: your other computers start these chats empty.')],
  ['rooms', t('Group chat messages'), t('Off: group chat messages stay on this computer, and your other computers do not see them.')],
  ['tasks', t('Tasks'), t('Rex Desk tasks and the Flow and Morningmate issues you synced.')],
  ['files', t('Pictures and files'), t('Screenshots, recordings and files in your chats. Usually the biggest part of a backup.')],
];
const backupPartsHtml = parts => `<h3>${t`What goes to the cloud`}</h3><p class="muted">${t`Changes save at once. Turning one off deletes it from the cloud; turning it on sends it back.`}</p>
  <label class="st-check"><input type="checkbox" checked disabled><span><b>${t`Agents, rooms, projects and settings`}</b><small>${t`Always backed up: they are what makes your desk follow you to another computer.`}</small></span></label>
  ${BACKUP_PARTS.map(([part, title, help]) => `<label class="st-check"><input type="checkbox" data-st-part="${part}" ${parts[part] !== false ? 'checked' : ''}><span><b>${title}</b><small>${help}</small></span></label>`).join('')}
  <p class="muted">${t`To keep one whole project out of the cloud, use Settings, Projects.`}</p>`;
const stIcon = id => `<span class="st-ic st-ic-${id}" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ST_ICON[id] || ''}</svg></span>`;
const ASKS = { quit_app: t('Close an app'), hibernate: t('Hibernate'), shutdown: t('Shut down'), restart: t('Restart'), sign_out: t('Sign out'), stop_program: t('Stop a program'), empty_trash: t('Empty the Recycle Bin') };
const LANGS = [['en', t('English')], ['km', t('Khmer')], ['ko', t('Korean')]];
const DAYS = [t('Sun'), t('Mon'), t('Tue'), t('Wed'), t('Thu'), t('Fri'), t('Sat')];

// Settings > About, drawn like a product's About page: the mark and version first, then what this Rex Desk holds and
// how much room it takes on this computer. No inline styles (the page rules forbid them): bar widths come from classes.
const ABOUT_MARK = '<svg viewBox="0 0 64 64" width="72" height="72" aria-hidden="true"><rect x="2" y="2" width="60" height="60" rx="14" fill="#4b5563"/><g fill="#fff"><rect x="16" y="16" width="14" height="14" rx="3"/><rect x="34" y="16" width="14" height="14" rx="3"/><rect x="16" y="34" width="14" height="14" rx="3"/><rect x="34" y="34" width="14" height="14" rx="3" opacity=".47"/></g></svg>';
const sizeText = value => { if (value == null) return 'unknown'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; let size = value, at = 0; while (size >= 1024 && at < units.length - 1) { size /= 1024; at++; } return `${size >= 100 || at === 0 ? Math.round(size) : size.toFixed(1)} ${units[at]}`; };
const countText = value => Number(value || 0).toLocaleString();
// A bar part's width as one of 50 classes (ab-w0 to ab-w50, 2% each), set in chat.css.
const widthClass = share => `ab-w${Math.max(1, Math.min(50, Math.round(share * 50)))}`;
export function aboutHtml(about, update, checking) {
  const e = value => String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
  const version = update.current || about?.version || '';
  const status = !update.supported ? t('Runs from source code and updates with Git.') : update.ready ? t`Version ${e(update.available?.version)} is downloaded and ready.` : update.available ? t`Version ${e(update.available.version)} is on its way.` : update.checkedAt ? t('Up to date.') : t('Not checked yet.');
  const head = `<div class="ab-hero">${ABOUT_MARK}<div><h2>${t`Rex Desk`}</h2><p class="ab-ver">${version ? t`Version ${e(version)}${update.stage ? ` · ${e(update.stage)}` : ''}` : t('Development copy')}</p><p class="ab-status${update.ready || update.available ? ' new' : ''}">${status}</p>
    <div class="ab-actions">${update.supported ? `<button type="button" class="btn small" data-st-update-check ${checking ? 'disabled' : ''}>${checking ? t('Checking…') : t('Check for updates')}</button>` : ''}${update.ready ? `<button type="button" class="btn small primary" data-action="update-install">${t`Install and restart`}</button>` : ''}</div></div></div>`;
  if (!about) return `${head}<h3>${t`What it holds`}</h3><div class="ab-tiles ab-loading">${'<div class="ab-tile"><b>&nbsp;</b><span>&nbsp;</span></div>'.repeat(5)}</div>`;
  if (about.error) return `${head}<p class="error-text">${e(t(about.error))}</p>`;
  const c = about.counts || {};
  const tiles = [[t('Agents'), c.agents], [t('Chats'), c.chats], [t('Group chats'), c.rooms], [t('Tasks'), c.tasks], [t('Files from agents'), c.files]]
    .map(([label, value]) => `<div class="ab-tile"><b>${countText(value)}</b><span>${label}</span></div>`).join('');
  return `${head}<h3>${t`What it holds`}</h3><div class="ab-tiles">${tiles}</div>
    <div class="ab-foot"><button type="button" class="btn small" data-st-about-refresh>${t`Count again`}</button></div>`;
}

export function openSettings(ctx, section = 'general', extra = {}) {
  const { ui, esc, api, toast, refresh } = ctx;
  document.querySelector('.dialog-back.settings')?.remove();
  const back = document.createElement('div'); back.className = 'dialog-back settings'; document.body.append(back);
  const phone = window.matchMedia('(max-width:760px)').matches;
  if (section === 'tools') { ctx.open('market'); return; }
  section = ALIAS[section] || section; if (!PARTS[section]) section = 'general';
  const state = { section, extra: { ...extra }, list: phone && section === 'general', trackers: trackerDraft(ui) };
  const has = part => (PARTS[state.section] || []).includes(part);
  const local = {};
  const config = () => ({ ...(ui.snap.config || {}), ...local });
  const field = (label, control, help = '') => `<label class="st-field"><span>${label}</span>${control}${help ? `<small>${help}</small>` : ''}</label>`;
  // Spoken replies: which voice says Rex Desk's English lines. Microsoft's natural voices (free), or Fish Audio (online).
  const speechBlock = () => {
    const tts = state.extra.tts || { engine: 'standard' };
    const fish = tts.engine === 'fish', money = t`The free model costs nothing (Fish Audio's fair use). The best model costs about ${'$' + (tts.paidCostPerMinute || 0.02).toFixed(2)} for each minute of speech.`;
    const select = (name, options, current) => `<select data-st-tts="${name}">${options.map(([value, label]) => `<option value="${esc(value)}" ${String(current) === String(value) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
    const keyRow = tts.hasKey
      ? `<p class="muted">${tts.keyFrom === 'rex-desk' ? t`Your Fish Audio key is kept locked on this computer.` : t`Your Fish Audio key comes from the FISH_AUDIO_API_KEY setting this computer started Rex Desk with.`} ${tts.keyFrom === 'rex-desk' ? `<button type="button" class="btn small" data-st-fish-remove>${t`Remove key`}</button>` : ''}</p>`
      : `<div class="st-field"><span>${t`Add your Fish Audio key`}</span><div class="st-row"><input type="password" data-st-fish-key autocomplete="off" spellcheck="false" placeholder="${t`Paste your key`}"><button type="button" class="btn small primary" data-st-fish-save>${t`Add key`}</button></div><small>${t`Make a key at`} <a href="https://fish.audio/app/api-keys" target="_blank" rel="noopener">fish.audio/app/api-keys</a>. ${t`It is kept locked on this computer and sent only to Fish Audio. Without a key, your usual voice stays.`}</small></div>`;
    const usage = t`Today: ${tts.usedMinutesToday} min. This month: ${tts.usedMinutesMonth} min.`;
    const details = fish ? `${keyRow}
      ${field(t('Voice'), select('voice', tts.voices, tts.voice))}
      ${field(t`Speed ${tts.speed.toFixed(2)}x`, `<input type="range" data-st-tts="speed" min="0.7" max="1.5" step="0.05" value="${tts.speed}">`)}
      ${field(t('Model'), select('model', [['s2.1-pro-free', t('Free model')], ['s2.1-pro', t('Best model (paid)')]], tts.model), t("Both are Fish Audio's newest generation."))}
      ${field(t('Daily limit (minutes of speech)'), `<input type="number" data-st-tts="dailyMinutes" min="1" max="600" step="1" value="${tts.dailyMinutes}">`, t('After this your usual voice says the rest of the day, so the cost stays small.'))}
      <p class="muted"><b>${t`Cost`}</b>: ${money} ${usage}</p>
      ${tts.problem || tts.holding ? `<p class="error-text" role="alert">${esc(tts.holding || tts.problem)} ${t`Your usual voice is used meanwhile.`}</p>` : ''}
      <div class="st-actions"><button type="button" class="btn small" data-st-tts-test ${tts.hasKey && !state.extra.ttsTesting ? '' : 'disabled'}>${state.extra.ttsTesting ? t('Playing…') : t('Try this voice')}</button></div>` : '';
    return `<h3>${t`Spoken replies`}</h3>
      ${field(t('Voice engine'), select('engine', [['standard', t('Natural voices (Microsoft, free)')], ['fish', t('Fish Audio (online)')]], tts.engine), t('Fish Audio says English only. Korean and Khmer keep the natural voices. If there is no key, or Fish Audio cannot answer, your usual voice says it, so Voice mode never goes silent.'))}
      ${details}
      ${['en', 'ko', 'km'].map(lang => field(t`Reading voice, ${{ en: t('English'), ko: t('Korean'), km: t('Khmer') }[lang]}`, `<select data-st-voice="${lang}"><option value="">${t`Natural voice (recommended)`}</option><optgroup label="${t`Natural voices`}">${(state.extra.neural?.[lang] || []).map(([id, label]) => `<option value="${esc(id)}" ${chosenVoice(lang) === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}</optgroup>${(state.extra.voices?.[lang] || []).length ? `<optgroup label="${t`This computer's voices`}">${state.extra.voices[lang].map(voice => `<option value="${esc(voice.name)}" ${chosenVoice(lang) === voice.name ? 'selected' : ''}>${esc(voice.name)}</option>`).join('')}</optgroup>` : ''}</select>`, lang === 'en' ? t("For the speaker button on agent messages. Natural voices are Microsoft's Edge voices (the same studybook uses): the text is sent to Microsoft to be read. This computer's voices stay on this computer.") : '')).join('')}`;
  };
  const jevStatus = () => {
    if (config().control?.enabled === false) return t('Off. Jev does nothing until you turn it on.');
    const claude = ui.accounts?.claude?.profiles?.some(item => item.loggedIn);
    if (config().jev?.hasKey || claude) return state.extra.anywhere?.platform === 'windows' && state.extra.anywhere.running ? t('Ready. Press Ctrl+Alt+J in any app, then say or type what to do.') : t('Ready. Open Jev from the left bar, then say or type what to do.');
    if (!ui.accounts) return t('Checking what Jev needs…');
    return t('To start, Jev needs Claude signed in (Settings, AI) or an OpenRouter key under Advanced.');
  };
  const check = (name, on, label, help = '') => `<label class="st-check"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}><span><b>${label}</b>${help ? `<small>${help}</small>` : ''}</span></label>`;
  const input = (name, value, attrs = '') => `<input name="${name}" value="${esc(value ?? '')}" ${attrs}>`;
  // Flow, Morningmate and Orbit only matter once one is connected; until then their settings stay out of the way.
  const hasTracker = () => (config().sources || []).some(source => source.type === 'flow' || source.type === 'morningmate');
  const hasOrbit = () => (config().sources || []).some(source => source.type === 'orbit');
  // A short "best use" note at the top of a section, with a button that walks through that section on the real controls.
  const tip = (id, text) => `<div class="st-tip"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z"/></svg><span><b>${t`Best use`}</b> ${text}</span><button type="button" class="btn small quiet" data-st-show="${id}">${t`Show me`}</button></div>`;
  // GitHub accounts come from the GitHub CLI. Signing in runs GitHub's device flow: approve the shown code on github.com.
  const githubHtml = () => {
    const github = state.extra.github;
    const head = `<h3>${t`GitHub`}</h3><p class="muted">${t`Pushes, pull requests and clones use the active account. Rex Desk uses the GitHub CLI sign-in and never keeps a GitHub token.`}</p>`;
    if (!github) return `${head}${skeletonHtml(2)}`;
    if (!github.installed) return `${head}<p class="error-text">${t`The GitHub CLI (gh) is not installed on this computer.`}</p>`;
    const login = github.login, waiting = ['waiting', 'starting'].includes(login?.state);
    const list = github.accounts.map(account => `<li><b>${esc(account.login)}</b>${account.active ? `<span class="muted">${t`Active`}</span>` : account.valid ? `<button type="button" class="btn small quiet" data-st-gh-use="${esc(account.login)}">${t`Use`}</button>` : `<span class="error-text">${t`Sign in again`}</span>`}</li>`).join('');
    const signIn = waiting
      ? `<div class="st-gh-code"><span>${t`Enter this code on GitHub`}</span><code>${esc(login.code || '…')}</code><button type="button" class="btn small" data-st-gh-copy="${esc(login.code || '')}">${t`Copy`}</button><a class="btn small" href="${esc(login.url)}" target="_blank" rel="noopener">${t`Open GitHub`}</a><button type="button" class="btn small quiet" data-st-gh-cancel>${t`Cancel`}</button><small class="muted">${t`This updates by itself once you approve it.`}</small></div>`
      : `<div class="st-actions"><button type="button" class="btn small" data-st-gh-login>${github.accounts.length ? t('Sign in another GitHub account') : t('Sign in to GitHub')}</button></div>`;
    return `${head}<ul class="st-list">${list || `<li class="muted">${t`No GitHub account signed in.`}</li>`}</ul>${signIn}${login?.state === 'failed' ? `<p class="error-text">${esc(login.error)}</p>` : ''}`;
  };
  let githubTimer = 0;
  const loadGithub = async () => {
    const before = state.extra.github?.login?.state;
    try { state.extra.github = await api('/github'); } catch (error) { state.extra.github = { installed: true, accounts: [], login: { state: 'failed', error: error.message } }; }
    if (!document.body.contains(back)) return;
    // Keep what is typed in Test sign-ins: this redraw comes whenever GitHub answers, often mid-typing.
    if (has('projects')) { readSignins(); draw(); }
    const now = state.extra.github.login?.state;
    clearTimeout(githubTimer); if (['waiting', 'starting'].includes(now)) githubTimer = setTimeout(loadGithub, 2000);
    else if (now === 'done' && before && before !== 'done') toast((state.extra.github.login.account ? t`Signed in to GitHub as ${state.extra.github.login.account}.` : t('Signed in to GitHub.')));
  };
  const githubClick = async target => {
    if (target.closest('[data-st-gh-login]')) { target.closest('[data-st-gh-login]').disabled = true; const login = await api('/github/login', { method: 'POST' }); state.extra.github = { ...(state.extra.github || { installed: true, accounts: [] }), login }; await loadGithub(); return true; }
    if (target.closest('[data-st-gh-cancel]')) { await api('/github/login', { method: 'DELETE' }); await loadGithub(); return true; }
    const use = target.closest('[data-st-gh-use]'); if (use) { await api('/github/switch', { method: 'POST', data: { user: use.dataset.stGhUse } }); await loadGithub(); toast(t`${use.dataset.stGhUse} is now the active GitHub account.`); return true; }
    const copy = target.closest('[data-st-gh-copy]'); if (copy) { await navigator.clipboard.writeText(copy.dataset.stGhCopy); toast(t('Copied.')); return true; }
    return false;
  };
  // Test sign-ins are edited as a working copy: a new empty row has no user name yet, which the server would drop if saved at once.
  const signins = () => (state.signins ||= (config().testAccounts || []).map(account => ({ ...account, password: account.password || '' })));
  const readSignins = () => signins().forEach((account, index) => { for (const key of ['site', 'username', 'password']) { const input = back.querySelector(`[name="ta.${index}.${key}"]`); if (input) account[key] = input.value; } });
  const panels = {
    about: () => aboutHtml(state.extra.about, ui.snap.update || {}, state.extra.checking),
    general: () => `<h2>${t`General`}</h2>
      ${field(t('Language'), languagePicker(t('Language')), t('Rex Desk shows in the language you pick.'))}
      ${tip('general', t('Set your name so agents call you by it, and turn on "Start Rex Desk when I sign in" so schedules and your phone keep working.'))}
      ${ui.snap.account?.email ? `<div class="st-account"><span class="si-avatar">${esc(ui.snap.account.email[0].toUpperCase())}</span><span><b>${esc(ui.snap.account.email)}</b><small>${t`${ui.snap.account.role === 'superadmin' ? t('Superadmin') : t('Member')} · this computer`}</small></span><button type="button" class="btn small" data-st-signout>${t`Sign out`}</button></div>` : ''}
      ${field(t('Your name'), input('name', config().name, 'maxlength="60"'), t('Agents call you by this name.'))}
      ${field(t('Look'), `<div class="st-skins" role="radiogroup" aria-label="${t`Look`}">${[['midnight', t('Midnight'), '#5b8def', '#7c5cf0', '#0e1220'], ['cyberpunk', t('Cyberpunk'), '#ff2bd6', '#00e5ff', '#06030d'], ['gojo', t('Gojo'), '#59b4ff', '#e6f2ff', '#040817'], ['crayon', t('Crayon'), '#e4572e', '#ffd166', '#fbf5e6'], ['sakura', t('Sakura'), '#ff7ab8', '#c4a8ff', '#fff2f7'], ['forest', t('Forest'), '#3ddc84', '#a3d977', '#06100b'], ['sunset', t('Sunset'), '#ff7a45', '#ff5a8a', '#120708'], ['angkor', t('Angkor'), '#a3402a', '#e7967a', '#f3e2d8'], ['lacquer', t('Royal lacquer'), '#d8a94b', '#8e2a1c', '#0f0a09'], ['tonle', t('Tonle Sap'), '#f392b5', '#76c2a3', '#08151a'], ['waterfest', t('Water Festival'), '#e9b949', '#4aa3c4', '#0a1626']].map(([key, label, a, b, base]) => `<button type="button" role="radio" class="st-skin${(window.rexSkin?.value || 'midnight') === key ? ' on' : ''}" aria-checked="${(window.rexSkin?.value || 'midnight') === key}" data-st-skin="${key}" data-a="${a}" data-b="${b}" data-base="${base}"><span class="st-skin-swatch"><i></i><i></i></span><span>${label}</span></button>`).join('')}</div>`)}
      ${field(t('Glass'), glassSlider(), t('How see-through Rex Desk is.'))}
      ${field(t('Text size'), `<div class="st-size" role="radiogroup" aria-label="${t`Text size`}">${[['compact', t('Compact'), t('More fits on screen')], ['normal', t('Normal'), t('As before')], ['large', t('Large'), t('Easier to read')]].map(([key, label, hint]) => `<button type="button" role="radio" class="${(window.rexSize?.value || 'compact') === key ? 'on' : ''}" aria-checked="${(window.rexSize?.value || 'compact') === key}" data-st-size="${key}"><b>${label}</b><small>${hint}</small></button>`).join('')}</div>`)}
      ${seeThroughHere() ? field(t('See-through window'), `<div class="st-solid">${solidSlider()}<button type="button" class="btn small" data-solid-reset>${t`Make solid`}</button></div>`, t('Drag left to see what is behind Rex Desk, right for solid. It never goes below 20%. Ctrl+Shift+0 or the tray icon makes it solid again.')) : ''}
      ${field(t('Light or dark'), `<select name="theme">${[['system', t('Follow Windows')], ['dark', t('Dark')], ['light', t('Light')]].map(([value, label]) => `<option value="${value}" ${(window.rexTheme?.preference || 'system') === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`)}
      ${check('autostart', state.extra.autostart?.enabled, t('Start Rex Desk when I sign in to Windows'), t('So schedules, away mode and your phone keep working without opening the app.'))}`,
    folders: () => `<h2>${t`Folders`}</h2><p class="muted">${t`Where Rex Desk keeps things on this computer. Move copies everything to the folder you pick and keeps the old folder as a backup. Moving the data restarts Rex Desk.`}</p>
      ${tip('folders', t('Leave Rex Desk data where it is. Move "Files from agents" to a big drive if screenshots and recordings fill your C: drive.'))}${foldersHtml(ctx, state)}`,
    notify: () => `<h2>${t`Notifications`}</h2><p class="muted">${t`Changes save as you make them.`}</p>${tip('notify', t('Keep pop-ups for questions only, and set quiet hours for the night. Agents that need you then wait in Needs you.'))}${noticeSettingsHtml(ctx)}`,
    agents: () => `<h2>${t`Agents`}</h2>
      ${tip('agents', t('Start with Auto mode and 2 agents at once. Turn on "Save my Claude usage" if you hit your Claude limit. Leave the branch name as it is unless your team has a naming rule.'))}
      ${field(t('New agents and chats start in'), `<select name="defaultMode">${[['bypassPermissions', t('Dangerous: run everything without asking')], ['auto', t('Auto: safe steps run, risky ones ask')], ['acceptEdits', t('Accept edits: edit files freely, ask before commands')], ['manual', t('Ask first: ask before each step')], ['plan', t('Plan: plan only, change nothing')]].map(([value, label]) => `<option value="${value}" ${(config().defaultMode || 'bypassPermissions') === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`, t('Used when you have not picked a mode for a chat. An AI without that mode asks first instead. You can still change the mode under the message box.'))}
      ${check('autonomy', config().autonomy !== false, t('Let agents act on their own'), t('They start work and open draft pull requests without asking you each time. Nothing is ever merged. Off: they ask first.'))}
      ${check('showChanges', config().showChanges !== false, t('Show code changes after each change'), t('After an agent changes code, it makes a page of the change with plain notes and asks you to OK it. With a code reviewer on the team, it asks after the reviewer approves.'))}
      ${check('saver', config().saver !== false, t('Save my Claude usage'), t('Room chat and Away mode check-ins run on Sonnet, which uses much less of your Claude plan. Code changes, personal chats and Rex Agent keep the model you chose. An agent with its own model always uses it.'))}
      ${field(t('Start a fresh chat at'), `<select name="handoffTokens">${[[150000, '150k'], [200000, '200k'], [300000, '300k'], [0, t('Off')]].map(([value, label]) => `<option value="${value}"${Number(config().handoffTokens ?? 200000) === value ? ' selected' : ''}>${label}</option>`).join('')}</select>`, t('When a chat holds this many tokens, the agent writes a short handoff and carries on in a fresh chat. Every step re-sends the whole chat, so smaller uses much less of your plan.'))}`,
    accounts: () => `<h2>${t`AI accounts`}</h2>${field(t('Default model'), pickerHtml(ctx, { id: 'st-model', name: 'model', label: t('Default model'), value: config().models?.claude || '', items: [{ value: '', label: t('Claude Code default') }, ...(ui.snap.choices?.models || []).map(model => ({ value: model.id, label: model.label }))] }), t('An agent can have its own model on its card.'))}<p class="muted">${t`The AI your agents think with. Press Set up or Sign in on one: Rex Desk installs what is missing, then opens the sign-in in your browser. Use this picks the one new agents use.`}</p>${aiListHtml(ctx, state)}
      <h3>${t`More accounts`}</h3><p class="muted">${t`Add a second account of the same AI, switch between them, and see how much of each plan is used.`}</p>${tip('accounts', t('One account is enough to start. Add a second only if you often hit the usage limit.'))}<button type="button" class="btn" data-st-open="accounts">${t`Manage accounts`}</button>`,
    localai: () => `<h2>${t`Local AI`}</h2>${localAiHtml(ctx, state)}`,
    storage: () => storageHtml(ctx, state),
    projects: () => {
      // Each project that has agents: where its agents may work, and whether their chats may go to the cloud.
      const projectRulesHtml = () => {
        const rules = ui.snap.projectRules || []; if (!rules.length) return '';
        const rule = item => `<div class="st-rule"><div class="st-rule-head"><b>${esc(item.slug)}</b><span class="muted">${(item.agents === 1 ? t`${item.agents} agent · ${esc(item.computers.join(', '))}` : t`${item.agents} agents · ${esc(item.computers.join(', '))}`) + (item.here ? '' : t` · not on this computer`)}</span></div>
          <label class="st-check"><input type="checkbox" data-st-rule="pinned" data-slug="${esc(item.slug)}" ${item.pinned ? 'checked' : ''}><span><b>${t`Runs only on its computer`}</b><small>${t`Its agents never move and never start on another computer. You can still chat with them from anywhere.`}</small></span></label>
          <label class="st-check"><input type="checkbox" data-st-rule="noCloud" data-slug="${esc(item.slug)}" ${item.noCloud ? 'checked' : ''}><span><b>${t`Keep out of the cloud`}</b><small>${t`Its chats and files go only straight between your computers. Turning this on deletes its cloud copy; turning it off sends it back.`}</small></span></label></div>`;
        return `<h3>${t`Where each project's agents work`}</h3><p class="muted">${t`For a project that is only on one computer, like work code. Changes save at once.`}</p>${rules.map(rule).join('')}`;
      };
      const repositories = config().repositories || [];
      const row = (repo, index) => `<details class="st-repo" ${state.openRepo === index ? 'open' : ''}><summary><b>${esc(repo.name)}</b><code>${esc(repo.path)}</code><span class="muted">${repo.plain ? t`Not a Git folder` : `${esc(repo.baseBranch)} → ${esc(repo.targetBranch)}`}</span></summary>
        ${repo.plain ? `<p class="muted small">${t`Not a Git folder: agents work straight in it. There are no branches or pull requests.`}</p>` : `<div class="st-row">${field(t('New work starts from'), input(`repo.${index}.baseBranch`, repo.baseBranch, 'spellcheck="false"'))}${field(t('Pull requests go to'), input(`repo.${index}.targetBranch`, repo.targetBranch, 'spellcheck="false"'))}</div>`}
        <details class="st-adv"><summary>${t`Advanced`}</summary>
        ${field(t('Set up'), input(`repo.${index}.setupCommand`, repo.setupCommand, `spellcheck="false" placeholder="${t('Found from the project files')}"`))}
        ${field('Run (needs {port})', input(`repo.${index}.devCommand`, repo.devCommand, `spellcheck="false" placeholder="${t('Found from the project files')}"`))}
        ${field(t('Test'), input(`repo.${index}.testCommand`, repo.testCommand, `spellcheck="false" placeholder="${t('Found from the project files')}"`))}
        ${field(t('Work folder'), input(`repo.${index}.workFolder`, repo.workFolder || '', `spellcheck="false" placeholder="${esc(`${repo.path}-work`)}"`), t('Where agents keep the worktrees of this project (one folder per task), temp files and test data. Empty uses the folder next to the project, on its drive.'))}
        ${repo.plain ? '' : field(t('How changes go out'), `<select name="repo.${index}.push"><option value="pr" ${repo.push !== 'direct' ? 'selected' : ''}>${t`Draft pull request`}</option><option value="direct" ${repo.push === 'direct' ? 'selected' : ''}>${t`Push straight to the branch`}</option></select>`, t('Push straight: agents push their commits onto the target branch, with no pull request. Saying "no PR" in a chat does the same for one change.'))}
        </details>
        <button type="button" class="btn small quiet danger" data-st-repo-remove="${index}">${t`Remove this project`}</button></details>`;
      return `<h2>${t`Projects`}</h2><p class="muted">${t`The code your agents work on. In a Git project each run gets its own copy, so your own copy is never touched; in a folder without Git, agents work straight in the folder, one at a time. Rex Agent can also add a project when you name it in chat.`}</p>
        ${repositories.length ? repositories.map(row).join('') : `<p class="muted">${t`No projects yet.`}</p>`}
        ${projectRulesHtml()}
        <details class="st-adv"><summary>${t`Advanced`}</summary>${field(t('Branch names start with'), input('branchPrefix', config().branchPrefix, 'spellcheck="false"'), t`New branches look like ${esc(String(config().branchPrefix || 'rex-desk').replace(/\/+$/, ''))}/fix-login-button. Change it only if your team has a rule for branch names.`)}</details>
        <div class="st-add"><input data-st-repo-path placeholder="${t`A folder, like D:\\dev\\my-app, or owner/name on GitHub to clone`}" spellcheck="false" aria-label="${t`Folder of a project, or a GitHub project to copy here`}"><button type="button" class="btn small" data-st-repo-pick>${t`Browse…`}</button><button type="button" class="btn small primary" data-st-repo-add>${t`Add`}</button></div>
        ${githubHtml()}`;
    },
    // Connectors (chat-connectors.js): empty until the person adds one; Flow and Morningmate keep their own cards under Task trackers.
    sources: () => connectorsHtml(ctx, state, config(), {
      trackers: (state.trackers || []).length ? trackersHtml(ctx, state, config()) : '',
      syncField: (config().sources || []).length ? field(t('Check for new tasks every'), `<span class="st-unit">${input('syncMinutes', config().syncMinutes, 'type="number" min="0" max="1440"')}<em>${t`minutes`}</em></span>`, t('0 checks only when you press Sync.')) : '' }),
    // One switch on top says whether Jev is on and what it still needs; keys, ranking, the spoken-reply engine and the reading voices wait under Advanced.
    jev: () => `<h2>${t`Jev and voice`}</h2>
      ${check('control.enabled', config().control?.enabled !== false, t('Jev and voice'), jevStatus())}
      ${tip('jev', t('Talk to Jev to run this computer by voice: open apps, change volume, read the screen. Keep "Ask me before shutting down" on.'))}
      <h3>${t`Controlling this computer`}</h3>
      ${check('control.confirm', config().control?.confirm !== false, t('Ask me before shutting down, restarting, signing out, closing apps or emptying the Recycle Bin'))}
      ${check('control.agents', config().control?.agents, t('Let agents control this computer too'))}
      ${(config().control?.allow || []).length ? `<div class="st-field"><span>${t`Done without asking`}</span><div class="st-chips">${config().control.allow.map(action => `<span class="st-chip">${esc(ASKS[action] || action.replaceAll('_', ' '))}<button type="button" class="ag-x" data-st-allow-off="${esc(action)}" aria-label="${t`Ask again before this`}">×</button></span>`).join('')}</div><small>${t`Press × to have Jev ask you again first. "Yes, always" on a Jev question adds one here.`}</small></div>` : ''}
      ${field(t('Voice language'), `<select name="control.language">${LANGS.map(([value, label]) => `<option value="${value}" ${(config().control?.language || 'en') === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`)}
      <details class="st-adv st-adv-top"><summary>${t`Advanced`}</summary><div class="st-adv-body">
      <h3>${t`OpenRouter`}</h3>
      ${field(t('OpenRouter key'), `<input type="password" name="jev.apiKey" autocomplete="off" spellcheck="false" placeholder="${config().jev?.hasKey ? t('Saved. Paste a new key to replace it.') : 'sk-or-…'}">`, t('Optional. For issue ranking and the Gemini voice engine. Kept locked on this computer and sent only to OpenRouter.'))}
      ${config().jev?.hasKey ? check('jev.clearKey', false, t('Remove the saved key')) : ''}
      ${hasTracker() ? `<h3>${t`Ranking your issues`}</h3>
      <div class="st-row">${field(t('Jev model'), input('jev.model', config().jev?.model, 'placeholder="Newest Jev release" spellcheck="false"'))}${field(t('Versions you ship now'), input('jev.versions', config().jev?.versions, `placeholder="${t('App 2.0.1, website current release')}"`))}</div>
      ${check('jev.auto', config().jev?.auto !== false, t('Rank new and changed issues after each sync'))}
      ${config().jev?.hasKey ? `<div class="st-actions"><button type="button" class="btn small" data-st-rank ${state.extra.ranking ? 'disabled' : ''}>${state.extra.ranking ? t('Ranking…') : t('Rank my issues now')}</button><small class="muted">${t`Shift-click to check every issue again.`}</small></div>` : ''}` : ''}
      ${speechBlock()}
      <div class="st-actions"><button type="button" class="btn" data-st-open="voice">${t`Voice engine and compare`}</button></div></div></details>`,
    schedule: () => { if (state.extra.connectorPick) return ''; const schedule = config().schedule || {}; const days = schedule.days || [1, 2, 3, 4, 5]; if (!hasTracker() && !hasOrbit()) return ''; return `<h2>${t`Schedule`}</h2><p class="muted">${t`At the set time Rex Desk looks for new tasks, Rex Agent sorts them, and agents start work up to your daily limit. Questions wait in Needs you.`}</p>
      ${tip('schedule', t('Set it for when you start your day, with a small limit like 3 runs. You come back to finished work and a short list of questions.'))}
      ${check('schedule.enabled', schedule.enabled, t('Start work on its own on a schedule'))}
      <div class="st-row">${field(t('Time'), input('schedule.time', schedule.time || '09:00', 'type="time"'))}${field(t('Most runs a day'), input('schedule.maxRuns', schedule.maxRuns || 6, 'type="number" min="1" max="20"'), t('Runs use your Claude plan.'))}</div>
      <fieldset class="st-days"><legend>${t`Days`}</legend>${DAYS.map((day, index) => `<label><input type="checkbox" name="schedule.days" value="${index}" ${days.includes(index) ? 'checked' : ''}><span>${day}</span></label>`).join('')}</fieldset>
      ${hasTracker() ? check('schedule.fix', schedule.fix !== false, t('Start runs for the top-ranked issues'), t('Jev ranks the Flow or Morningmate issues; the top ones start first. Needs a project for them.')) : ''}
      <div class="st-actions"><button type="button" class="btn small" data-st-schedule-run ${state.extra.scheduling ? 'disabled' : ''}>${state.extra.scheduling ? t('Starting…') : t('Run it now')}</button></div>`; },
    signins: () => `<details class="st-adv"><summary>${t`Test sign-ins`}</summary><p class="muted">${t`An agent can sign in to a preview it starts with these, without ever seeing the password. Never used on a live production site.`}</p>
      ${tip('signins', t('Add a test account for your app, so agents can sign in to their preview and check their own fix on screen.'))}
      ${signins().map((account, index) => `<div class="st-signin"><input name="ta.${index}.site" value="${esc(account.site || '')}" placeholder="${t`Site, like localhost or staging.example.com`}" aria-label="${t`Site`}"><input name="ta.${index}.username" value="${esc(account.username || '')}" placeholder="${t`User name or email`}" aria-label="${t`User name`}"><input type="password" name="ta.${index}.password" value="${esc(account.password || '')}" placeholder="${account.hasPassword ? t('Saved') : t('Password')}" aria-label="${t`Password`}" autocomplete="new-password"><button type="button" class="ag-x" data-st-signin-remove="${index}" aria-label="${t`Remove this sign-in`}">×</button></div>`).join('')}
      <button type="button" class="btn small" data-st-signin-add>${t`+ Add a sign-in`}</button></details>`,
    backup: () => { const database = ui.snap.database || {}, update = ui.snap.update || {}, account = database.account, hosted = Boolean(account && account.url === database.url); return `<h2>${t`Cloud backup`}</h2>
      ${tip('backup', t('Sign in with your Rex Desk account to back up, and your agents and chats follow you to your other computers.'))}
      ${state.extra.billing?.signedIn ? planCard(database, state) : ''}<p>${esc((hosted ? { connected: t('Backed up with your Rex Desk account.'), syncing: t('Uploading your backup…'), connecting: t('Connecting to your backup…'), offline: t('Your backup is offline; changes wait and upload later.'), error: t('Your backup needs attention.') } : { connected: t('Copied to your Turso database.'), syncing: t('Uploading to Turso…'), connecting: t('Connecting to Turso…'), offline: t('Turso is offline; changes wait and upload later.'), error: t('Turso needs attention.') })[database.state] || t('Kept on this computer only.'))}${database.pending ? t` ${Number(database.pending)} changes waiting.` : ''}</p>
      ${account ? `<div class="st-account st-cloud-account"><span class="si-avatar">${esc((account.name || account.email || '?')[0].toUpperCase())}</span><span><b>${esc(account.name || account.email)}</b><small>${esc(hosted ? t`Rex Desk account${account.name ? ` · ${account.email}` : ''}. This computer renews its backup key by itself.` : t`Rex Desk account${account.name ? ` · ${account.email}` : ''}. Signed in, but the backup uses another database.`)}</small></span><button type="button" class="btn small" data-st-account-out>${t`Sign out`}</button></div>` : ''}
      ${database.configured ? '' : `<div class="st-cloud">${CLOUD_ART}<div class="st-cloud-head"><b>${t`Back up with your Rex Desk account`}</b><small>${t`Your whole desk, kept safe in the cloud and ready on every computer you sign in on.`}</small></div><ul class="st-cloud-why">${CLOUD_WHY.map(([icon, title, text]) => `<li><span class="st-cloud-why-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></span><span><b>${title}</b><small>${text}</small></span></li>`).join('')}</ul>${state.extra.billing?.signedIn ? (state.extra.billing.space?.paid ? `<button type="button" class="btn primary" data-st-account ${state.extra.account ? 'disabled' : ''}>${esc(state.extra.account || t('Turn on cloud backup'))}</button>` : `<button type="button" class="btn primary" data-st-section="plan">${t`See plans`}</button><p class="st-cloud-fine">${t`Cloud backup comes with the Cloud backup plan, from $2.99 a month.`}</p>`) : `<button type="button" class="btn primary" data-st-account ${state.extra.account ? 'disabled' : ''}>${esc(state.extra.account || t('Sign in with Rex Desk'))}</button><p class="st-cloud-fine">${t`New here? Signing in also makes your account.`}</p>`}</div>`}${database.accountNote ? `<p class="error-text" role="alert">${esc(database.accountNote)}</p>` : ''}${database.configured ? `<div class="st-actions"><button type="button" class="btn" data-st-db-sync>${t`Upload now and check`}</button><button type="button" class="btn" data-st-db-off>${t`Stop using this database`}</button></div>${backupPartsHtml(database.parts || {})}` : ''}

      ${database.configured && !hosted ? `<p class="muted">${t`Pictures and files stay on this computer: only a Rex Desk account backup keeps them in the cloud.`}</p>` : ''}${database.error ? `<p class="error-text" role="alert">${esc(database.error)}</p>` : ''}`; },
  };
    // One section: its panels one after the other. A panel's own title becomes a plain heading under the section's title.
  const sectionHtml = () => {
    const parts = PARTS[state.section], label = (SECTIONS.find(([id]) => id === state.section) || [])[1] || '';
    if (parts.length === 1) return panels[parts[0]]();
    return `<h2>${label}</h2>` + parts.map(part => panels[part]().replace(/<h2>([^]*?)<\/h2>/, (_, heading) => heading === label ? '' : `<h3 class="st-part" data-st-part-${part}>${heading}</h3>`)).join('');
  };
  const draw = () => {
    if (has('backup') && !state.extra.billing && !state.extra.billingLoading) { state.extra.billingLoading = true; void api('/billing').then(data => { state.extra.billing = data; state.extra.billingLoading = false; draw(); }).catch(() => { state.extra.billing = { signedIn: false }; state.extra.billingLoading = false; draw(); }); }
    if (has('sources') && !state.extra.connectors) void loadConnectors(ctx, state, draw);
    // A redraw of the same section keeps the place the person scrolled to (ticking a box used to jump back to the top).
    // The list of sections on the left always keeps its place: picking one lower down used to jump the list back to the top.
    const keep = back.dataset.section === state.section ? back.querySelector('.st-panel')?.scrollTop || 0 : 0, keepNav = back.querySelector('.st-nav')?.scrollTop || 0;
    queueMicrotask(() => { back.dataset.section = state.section; const panel = back.querySelector('.st-panel'); if (panel && keep) panel.scrollTop = keep; const nav = back.querySelector('.st-nav'); if (nav && keepNav) nav.scrollTop = keepNav; });
    // A redraw of the same section keeps the details blocks the person opened.
    const openDetails = back.dataset.section === state.section ? [...back.querySelectorAll('.st-panel details')].map(item => item.open) : [];
    const title = (SECTIONS.find(([id]) => id === state.section) || [])[1] || t('Settings');
    back.innerHTML = `<form class="settings-pop${state.list ? ' st-listing' : ' st-open'}" aria-label="${t`Settings`}"><nav class="st-nav"><div class="st-navhead"><h1>${t`Settings`}</h1><button type="button" class="st-done" data-st-close>${t`Done`}</button></div><button type="button" class="st-guide-btn" data-st-show-all><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/></svg>${t`Take the tour`}</button>${GROUPS.map(([group, ids]) => `<div class="st-group" role="group" aria-label="${group}"><span class="st-glabel" aria-hidden="true">${group}</span>${ids.map(id => SECTIONS.find(([key]) => key === id)).filter(Boolean).map(([id, label, hint]) => `<button type="button" class="${state.section === id && !state.list ? 'on' : ''}" data-st-section="${id}">${stIcon(id)}<span class="st-nl"><b>${label}</b><small>${hint}</small></span><svg class="st-chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`).join('')}</div>`).join('')}<div class="st-group"><button type="button" data-st-go="devices" data-st-section-link>${stIcon('devices')}<span class="st-nl"><b>${t`Devices`}</b></span></button></div></nav>
      <div class="st-body"><div class="st-mhead"><button type="button" class="st-back" data-st-back aria-label="${t`Back to Settings`}"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg><span>${t`Settings`}</span></button><b>${esc(title)}</b></div><div class="st-panel" data-st-panel>${sectionHtml()}</div>
      </div>
      <button type="button" class="st-x" data-st-close aria-label="${t`Close settings`}">×</button></form>`;
    groupPanel(back.querySelector('[data-st-panel]'));
    back.querySelectorAll('.st-panel details').forEach((item, index) => { if (openDetails[index]) item.open = true; });
  };
  // System Settings style: after each draw, the rows under a heading are wrapped in one rounded group, so rows read as a list with thin dividers.
  const groupPanel = panel => {
    if (!panel) return;
    let box = null;
    for (const node of [...panel.children]) {
      if (node.matches('.st-tip')) continue;
      if (node.matches('.st-adv-top')) { box = null; node.querySelectorAll(':scope > .st-adv-body').forEach(groupPanel); continue; }
      if (node.matches('h2,h3,p,.error-text,small') || node.classList.contains('muted')) { box = null; continue; }
      if (node.classList.contains('st-box')) { box = null; continue; }
      if (!box) { box = document.createElement('div'); box.className = 'st-box'; panel.insertBefore(box, node); }
      box.append(node);
    }
  };
  const values = () => Object.fromEntries([...back.querySelectorAll('[name]')].filter(el => el.type !== 'checkbox' || el.name === 'schedule.days').map(el => [el.name, el.value]));
  const checked = name => Boolean(back.querySelector(`[name="${name}"]`)?.checked);
  let flushSave = () => {};
  // One source of truth: `local` holds every edit that the server has not confirmed yet, and config() is the confirmed config with it laid on top.
  // Every page renders from config(), every edit is written into `local` at once, and saves run one at a time, sending the keys still in `local` at send time.
  // A key leaves `local` only when the server confirmed that same value, so a failed save leaves its keys dirty for the next one.
  let saveChain = Promise.resolve();
  const save = (quiet = false) => {
    const job = collectSave();
    const run = saveChain.then(() => sendSave(job, quiet));
    saveChain = run.catch(() => {});
    return run;
  };
  function collectSave() {
    const base = JSON.parse(JSON.stringify(config())), v = values(), next = { ...base };
    let autostart = null;
    if (has('general')) { next.name = v.name; window.rexTheme?.set(v.theme); autostart = checked('autostart'); }
    if (has('agents')) Object.assign(next, { defaultMode: v.defaultMode, reportToOrbit: back.querySelector('[name="reportToOrbit"]') ? checked('reportToOrbit') : Boolean(base.reportToOrbit), saver: checked('saver'), showChanges: checked('showChanges'), handoffTokens: Number(v.handoffTokens ?? base.handoffTokens ?? 200000), autonomy: checked('autonomy') });
    if (has('accounts') && back.querySelector('#st-model')) next.models = { ...base.models, claude: back.querySelector('#st-model').value };
    if (has('projects') && back.querySelector('[name="branchPrefix"]')) next.branchPrefix = v.branchPrefix;
    if (has('projects')) next.repositories = base.repositories.map((repo, index) => ({ ...repo, ...Object.fromEntries(['baseBranch', 'targetBranch', 'setupCommand', 'devCommand', 'testCommand', 'workFolder', 'push'].map(key => [key, v[`repo.${index}.${key}`] ?? repo[key]])) }));
    if (has('jev')) next.jev = { ...base.jev, apiKey: v['jev.apiKey'] || '', clearKey: checked('jev.clearKey'), ...(back.querySelector('[name="jev.model"]') ? { model: v['jev.model'], versions: v['jev.versions'], auto: checked('jev.auto') } : {}) };
    if (has('jev')) { next.control = { ...base.control, enabled: checked('control.enabled'), confirm: checked('control.confirm'), agents: checked('control.agents'), language: v['control.language'] }; }
    const schedule0 = base.schedule || {};
    if (has('schedule') && back.querySelector('[name="schedule.enabled"]')) next.schedule = { enabled: checked('schedule.enabled'), time: v['schedule.time'], maxRuns: Number(v['schedule.maxRuns']), fix: back.querySelector('[name="schedule.fix"]') ? checked('schedule.fix') : schedule0.fix !== false, days: [...back.querySelectorAll('[name="schedule.days"]:checked')].map(box => Number(box.value)) };
    if (has('sources')) { readTrackers(back, state); next.sources = trackerSources(ui, state, config()); if (v.syncMinutes != null) next.syncMinutes = Number(v.syncMinutes); }
    if (has('signins')) { readSignins(); next.testAccounts = state.signins.filter(account => account.username.trim()); }
    const patch = Object.fromEntries(Object.entries(next).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(base[key])));
    Object.assign(local, JSON.parse(JSON.stringify(patch)));
    return { autostart, sources: has('sources') };
  }
  async function sendSave({ autostart, sources }, quiet) {
    if (autostart !== null) await api('/autostart', { method: 'POST', data: { enabled: autostart } }).catch(() => {});
    const sent = JSON.parse(JSON.stringify(local));
    if (Object.keys(sent).length) {
      ui.snap.config = await api('/config', { method: 'PUT', data: { ...(ui.snap.config || {}), ...sent } });
      for (const [key, value] of Object.entries(sent)) if (JSON.stringify(local[key]) === JSON.stringify(value)) delete local[key];
    }
    await refresh(); if (quiet) return; if (sources) state.trackers = trackerDraft(ui, config()); state.signins = null; toast(t('Saved.')); draw();
  }
  // Settings > About: asks the server for the version, counts and sizes, then draws them.
  async function loadAbout(fresh = false) {
    try { state.extra.about = await api(`/about${fresh ? '?fresh=1' : ''}`); } catch (error) { state.extra.about = { error: error.message }; }
    if (has('about') && document.body.contains(back)) draw();
  }
  // Open one section and resolve once what it shows is loaded (the tours wait for it before circling its controls).
  async function goSection(requested) {
    const id = ALIAS[requested] || requested; if (!PARTS[id]) return;
    flushSave();
    state.section = id; state.list = false;
    if (has('sources')) state.trackers = trackerDraft(ui, config());
    if (has('projects')) void loadGithub();
    if (has('general')) state.extra.autostart = await api('/autostart').catch(() => null);
    draw();
    if (has('about')) await loadAbout();
    if (has('folders')) { await loadFolders(ctx, state); if (has('folders')) draw(); }
    if (has('localai')) { await loadLocalAi(ctx, state); if (has('localai')) draw(); }
    if (has('storage')) { await loadStorage(ctx, state, { onUpdate: () => has('storage') && draw() }); if (has('storage')) draw(); }
    if (has('accounts')) { await loadTourAi(ctx, state); if (has('accounts')) draw(); }
    const mark = ['signins', 'schedule', 'localai', 'devices', 'folders'].includes(requested) ? back.querySelector(`[data-st-part-${requested}]`) : null;
    if (mark) { mark.scrollIntoView({ block: 'start' }); return; }
    back.querySelector('[data-st-panel]')?.scrollTo({ top: 0 });
  }
  back.addEventListener('click', async event => {
    const target = event.target;
    try {
      if (target === back || target.closest('[data-st-close]')) { flushSave(); back.remove(); return; }
      if (target.closest('[data-st-back]')) { flushSave(); state.list = true; draw(); return; }
      const section = target.closest('[data-st-section]'); if (section) { await goSection(section.dataset.stSection); return; }
      if (target.closest('[data-st-about-refresh]')) { state.extra.about = null; draw(); await loadAbout(true); return; }
      const copyPath = target.closest('[data-st-copy-path]'); if (copyPath) { await navigator.clipboard.writeText(copyPath.dataset.stCopyPath); toast(t('Copied.')); return; }
      if (await connectorsClick(ctx, state, target, back, draw)) return;
      if (await trackerClick(ctx, state, target, back, draw)) { if (target.closest('[data-tr-remove], [data-tr-unperson]') && has('sources')) await save(true); return; }
      if (await folderClick(ctx, state, target, draw)) return;
      if (has('localai') && await localAiClick(ctx, state, target, draw)) return;
      if (has('storage') && await storageClick(ctx, state, target, draw)) return;
      if (has('accounts') && target.closest('[data-tai-local]')) { back.querySelector('[data-st-part-localai]')?.scrollIntoView({ block: 'start' }); return; }
      if (has('accounts') && await tourAiClick(ctx, state, target, () => { if (has('accounts') && document.body.contains(back)) draw(); }, () => has('accounts') && document.body.contains(back))) return;
      // A feature tour circles the real controls of a section; "Take the tour" goes through every section.
      const show = target.closest('[data-st-show]'); if (show) { await runSettingsTour(goSection, { section: show.dataset.stShow }); return; }
      if (target.closest('[data-st-show-all]')) { await runSettingsTour(goSection, { all: true }); return; }
      if (target.closest('[data-st-tour]')) { flushSave(); back.remove(); startTour(ctx); return; }
      if (await githubClick(target)) return;
      if (target.closest('[data-st-rank]')) {
        state.extra.ranking = true; draw();
        try { const result = await api('/jev/prioritize', { method: 'POST', data: { force: event.shiftKey } }); await refresh(); toast(result.failed ? t`Jev rated ${result.done - result.failed} of ${result.total}; ${result.failed} failed: ${result.error}` : result.total ? (result.total === 1 ? t`Jev rated ${result.total} issue.` : t`Jev rated ${result.total} issues.`) : t('Every issue is already rated. Shift-click to check them all again.'), Boolean(result.failed)); }
        finally { state.extra.ranking = false; draw(); } return;
      }
      if (target.closest('[data-st-schedule-run]')) {
        state.extra.scheduling = true; draw();
        try { const result = await api('/schedule/run', { method: 'POST' }); toast(result.state === 'started' ? (result.issues === 1 ? t`Started Rex Agent on ${result.issues} new issue.` : t`Started Rex Agent on ${result.issues} new issues.`) : result.reason, result.state !== 'started'); await refresh(); }
        finally { state.extra.scheduling = false; draw(); } return;
      }
      if (target.closest('[data-st-update-check]')) {
        state.extra.checking = true; draw();
        try { const update = await api('/update/check', { method: 'POST' }); ui.snap.update = update; toast(update.error || (update.available ? t`Rex Desk ${update.available.version} is ${update.ready ? 'ready to install' : 'downloading'}.` : t('Rex Desk is up to date.')), Boolean(update.error)); }
        finally { state.extra.checking = false; draw(); } return;
      }
      const open = target.closest('[data-st-open]'); if (open) { flushSave(); back.remove(); document.body.insertAdjacentHTML('beforeend', `<button hidden data-action="${open.dataset.stOpen === 'accounts' ? 'accounts' : open.dataset.stOpen === 'sources' ? 'task-connect' : 'st-voice'}" id="st-opener"></button>`); document.getElementById('st-opener').click(); document.getElementById('st-opener')?.remove(); return; }
      const go = target.closest('[data-st-go]'); if (go) { flushSave(); back.remove(); ctx.open(go.dataset.stGo); return; }
      if (target.closest('[data-st-signout]')) { if (!await askConfirm(t('Sign out of Rex Desk on this computer? Running agents of this account stop.'))) return; await api('/auth/logout', { method: 'POST', data: {} }); location.href = '/signin'; return; }
      const allowOff = target.closest('[data-st-allow-off]'); if (allowOff) { await api('/computer/allow', { method: 'POST', data: { actions: [allowOff.dataset.stAllowOff], on: false } }); await refresh(); draw(); return; }
      if (target.closest('[data-st-account]')) {
        // One click: the Rex Desk sign-in opens in the browser; the account service then makes the person's database and this computer connects to it.
        state.extra.account = t('Opening the Rex Desk sign-in…'); draw();
        try {
          // Already signed in to Rex Desk when this workspace opened: no second trip to the browser.
          const { url } = await api('/database/account-start', { method: 'POST' }); if (url) window.open(url, '_blank', 'noopener');
          state.extra.account = url ? t('Waiting for you to sign in in the browser…') : t('Turning cloud backup on…'); draw();
          // Asked short and repeated: see waitForBrowserSignIn in chat-signin.js (a Mac's webview cuts one long request at about a minute).
          let status; for (let misses = 0; !status || status.waiting; ) { try { status = await api('/database/account-finish', { method: 'POST' }); misses = 0; } catch (error) { if (error.name !== 'TypeError' || ++misses > 6) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); } }
          toast(status.state === 'connected' ? (status.created ? t('Cloud backup is on. Your private database was made and your history was uploaded.') : t('Cloud backup is on. This computer is connected to your backup.')) : t`Signed in. The backup is ${status.state}; changes wait and upload later.`, status.state !== 'connected');
          await refresh();
        } finally { state.extra.account = ''; draw(); }
        return;
      }
      if (target.closest('[data-st-account-out]')) {
        if (!await askConfirm(t('Sign this computer out of your Rex Desk account? The backup keeps working for up to 30 days, then stops until you sign in again.'))) return;
        await api('/database/account-signout', { method: 'POST' }); toast(t('Signed out of your Rex Desk account on this computer.')); await refresh(); draw(); return;
      }
      if (target.closest('[data-st-plan-signin]')) {
        try { const { url } = await api('/net/sign-in', { method: 'POST' }); if (url) window.open(url, '_blank', 'noopener'); toast(t('Finish signing in in the browser. Your plan shows here by itself.')); const until = Date.now() + 5 * 60000; const look = async () => { const data = await api('/billing').catch(() => null); if (data?.signedIn) { state.extra.billing = data; draw(); return; } if (Date.now() < until) setTimeout(look, 3000); }; setTimeout(look, 3000); }
        catch (error) { toast(error.message, true); }
        return;
      }
      const cycle = target.closest('[data-st-cycle]')?.dataset.stCycle;
      if (cycle) { state.extra.billingCycle = cycle; draw(); return; }
      const buy = target.closest('[data-st-buy]')?.dataset.stBuy;
      if (buy || target.closest('[data-st-manage]')) {
        state.extra.billingBusy = true; draw();
        try {
          const result = await api(buy ? '/billing/checkout' : '/billing/portal', { method: 'POST', data: buy ? { offer: buy } : {} });
          window.open(result.url, '_blank', 'noopener');
          if (buy && !result.already) { state.extra.billingWaiting = true; const until = Date.now() + 20 * 60000; const look = async () => { const data = await api('/billing').catch(() => null); if (data) state.extra.billing = data; if (data?.space?.paid) { state.extra.billingWaiting = false; state.extra.billingJustPaid = true; toast(t('Cloud backup is on. Thank you.')); draw(); return; } if (Date.now() < until && state.extra.billingWaiting) setTimeout(look, 5000); draw(); }; setTimeout(look, 5000); }
        } catch (error) { toast(error.message, true); }
        finally { state.extra.billingBusy = false; draw(); }
        return;
      }
      if (target.closest('[data-st-pack]')) {
        if (!await askConfirm(t('Add 5 GB of cloud space for $1 a month ($10 a year on a yearly plan)? It is charged to the card your plan uses.'))) return;
        state.extra.billingBusy = true; draw();
        try { await api('/billing/pack', { method: 'POST' }); state.extra.billing = await api('/billing').catch(() => state.extra.billing); toast(t('5 GB more cloud space added.')); }
        catch (error) { toast(error.message, true); }
        finally { state.extra.billingBusy = false; draw(); }
        return;
      }
      if (target.closest('[data-st-db-off]')) {
        if (!await askConfirm(t('Stop copying to this cloud database? Everything stays on this computer and nothing is deleted in the cloud. You can then turn on the Rex Desk account backup.'))) return;
        try { await api('/database/disconnect', { method: 'POST' }); state.extra.billing = null; toast(t('This computer no longer copies to that database.')); } catch (error) { toast(error.message, true); }
        await refresh(); draw(); return;
      }
      if (target.closest('[data-st-db-sync]')) {
        const button = target.closest('[data-st-db-sync]'); button.disabled = true; button.textContent = t('Uploading…');
        try { const result = await api('/database/sync', { method: 'POST' }); if (result.stillGoing) toast(t('Still uploading. It keeps going by itself; check again later.')); else toast(result.matched ? t`Everything on this computer is in the cloud: ${result.localRecords} records and ${result.localEvents} messages.` : t`${result.missingRecords} records and ${result.missingEvents} messages from this computer did not reach the cloud. Check the connection and try again.`, !result.matched); }
        catch (error) { toast(error.message, true); }
        finally { await refresh(); draw(); }
        return;
      }
      if (target.closest('[data-st-signin-add]')) { readSignins(); state.signins.push({ id: crypto.randomUUID(), site: '', username: '', password: '' }); draw(); back.querySelector(`[name="ta.${state.signins.length - 1}.site"]`)?.focus(); return; }
      const dropSignin = target.closest('[data-st-signin-remove]'); if (dropSignin) { readSignins(); state.signins.splice(Number(dropSignin.dataset.stSigninRemove), 1); draw(); await save(true); return; }
      const dropRepo = target.closest('[data-st-repo-remove]'); if (dropRepo) { const repo = config().repositories[Number(dropRepo.dataset.stRepoRemove)]; if (!await askConfirm(t`Remove ${repo.name} from Rex Desk? The folder on disk stays.`)) return; ui.snap.config = await api('/config', { method: 'PUT', data: { ...config(), repositories: config().repositories.filter(item => (repo.id ? item.id !== repo.id : item.name !== repo.name || item.path !== repo.path)) } }); await refresh(); draw(); return; }
      if (target.closest('[data-st-repo-pick]')) { const picked = await api('/repositories/pick', { method: 'POST', data: {} }).catch(() => null); if (picked?.path) back.querySelector('[data-st-repo-path]').value = picked.path; return; }
      if (target.closest('[data-st-repo-add]')) {
        let folder = back.querySelector('[data-st-repo-path]').value.trim(); if (!folder) return toast(t('Type or browse to a project folder first.'), true);
        // owner/name or a github.com address is cloned next to Rex Desk with the active GitHub account, then added like a folder.
        if ((!/[\\:]/.test(folder) && /^[\w.-]+\/[\w.-]+$/.test(folder)) || /^https:\/\/github\.com\//.test(folder)) {
          const button = target.closest('[data-st-repo-add]'); button.disabled = true; button.textContent = t('Cloning…');
          try { folder = (await api('/repositories/clone', { method: 'POST', data: { repository: folder } })).path; } finally { button.disabled = false; button.textContent = t('Add'); }
        }
        const found = await api('/repositories/inspect', { method: 'POST', data: { path: folder } });
        ui.snap.config = await api('/config', { method: 'PUT', data: { ...config(), repositories: [...config().repositories, { name: found.name, path: found.path, ...(found.git === false ? { plain: true } : { baseBranch: found.preferredBranch || 'develop', targetBranch: found.preferredBranch || 'develop' }) }] } });
        await refresh(); toast(t`Added ${found.name}.`); draw(); return;
      }
    } catch (error) { toast(error.message, true); }
  });
  // Every field saves by itself: a change saves at once, typing saves a moment after the last key. There is no Save button.
  let autoTimer = 0, pendingSave = false, jevLater = false;
  const afterSave = () => { if (jevLater) { jevLater = false; if (has('jev') && document.body.contains(back)) draw(); } };
  // Save a waiting edit now, before the page it belongs to is redrawn or closed (it reads the fields synchronously).
  flushSave = () => { if (!pendingSave) return; clearTimeout(autoTimer); pendingSave = false; save(true).catch(error => toast(error.message, true)); jevLater = false; };
  const ownSave = el => el.matches?.('[data-st-part],[data-st-rule],[data-st-tts],[data-st-voice],[data-st-fish-key]') || el.closest?.('[data-st-fish]');
  const autoSave = event => {
    const el = event.target;
    if (!el.matches?.('input,select,textarea') || !el.closest('[data-st-panel]') || ownSave(el) || !PARTS[state.section].some(part => SAVE_PARTS.includes(part))) return;
    clearTimeout(autoTimer); pendingSave = true;
    autoTimer = setTimeout(() => { pendingSave = false; if (document.body.contains(back)) save(true).then(keyRedraw).catch(error => toast(error.message, true)); afterSave(); }, event.type === 'input' ? 700 : 150);
  };
  // A saved or removed OpenRouter key brings or hides the Rank button and the Remove box, but a quiet save does not redraw.
  // So after any autosave lands, draw again when the page no longer matches the saved key, whichever field's save carried it.
  // An edit still waiting (a newer key or any other field) is left alone: its own save lands later and checks again.
  const keyRedraw = () => {
    if (pendingSave || !has('jev') || !document.body.contains(back)) return;
    if (Boolean(back.querySelector('[name="jev.clearKey"]')) !== Boolean(config().jev?.hasKey)) draw();
  };
  back.addEventListener('input', event => { if (event.target.matches?.('input:not([type=checkbox],[type=radio],[type=range]),textarea')) autoSave(event); });
  back.addEventListener('change', autoSave);
  back.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.body.classList.contains('driver-active')) { flushSave(); back.remove(); } });
  back.addEventListener('input', event => {
    // Tools and skills: the search box narrows the skill list as you type, with no redraw.
    if (has('storage') && storageInput(ctx, state, event, draw)) return;
    trackerInput(back, state, event, draw);
  });
  back.addEventListener('change', event => { if (event.target.closest?.('[data-cn-report], [data-cn-field]')) { void connectorsChange(ctx, state, event.target, draw); return; } trackerInput(back, state, event, draw); });
  back.addEventListener('toggle', event => { const card = event.target.dataset?.trCard; if (card && event.target.open) state.openTracker = card; }, true);
  // A backup part saves at once; turning one off asks first, because it deletes that part from the cloud.
  back.addEventListener('change', async event => {
    const part = event.target.dataset?.stPart; if (!part) return;
    const on = event.target.checked, name = event.target.closest('label').querySelector('b').textContent;
    if (!on && !await askConfirm(t`Stop backing up ${name.toLowerCase()}? It is deleted from the cloud and stays on this computer.`)) { event.target.checked = true; return; }
    try { const reply = await api('/database/parts', { method: 'PUT', data: { [part]: on } }); ui.snap.database = reply.status; toast(on ? t`${name} is backed up again. Uploading it now.` : t`${name} stays on this computer only. Its cloud copy is being deleted.`); draw(); }
    catch (error) { event.target.checked = !on; toast(error.message, true); }
  });
  // A project's two rules save at once.
  back.addEventListener('change', async event => {
    const rule = event.target.dataset?.stRule; if (!rule) return;
    const slug = event.target.dataset.slug, on = event.target.checked;
    if (rule === 'noCloud' && on && !await askConfirm(t`Keep ${slug} out of the cloud? Its chats and files are deleted from the cloud database. They stay on your computers.`)) { event.target.checked = false; return; }
    try { await api(`/project-rules/${encodeURIComponent(slug)}`, { method: 'PUT', data: { [rule]: on } }); await refresh({ full: true }); toast(rule === 'pinned' ? (on ? t`${slug} now runs only on its computer.` : t`${slug}'s agents can be moved again.`) : (on ? t`${slug} is kept out of the cloud. Its cloud copy is being deleted.` : t`${slug} uses the cloud again. Its chats are being sent back.`)); draw(); }
    catch (error) { event.target.checked = !on; toast(error.message, true); }
  });
  // The voices on this computer, for the reading voice choices.
  // Two caches with one writer each: the engine settings come only from a voice save or the newest engine answer, the voice lists only from the list answer.
  const SPEAK_CACHE = 'rex-desk-speak-cache', VOICE_LIST_CACHE = 'rex-desk-voice-list-cache';
  try {
    const cached = JSON.parse(localStorage.getItem(SPEAK_CACHE) || 'null');
    let lists = JSON.parse(localStorage.getItem(VOICE_LIST_CACHE) || 'null');
    // Earlier builds kept the voice lists inside the engine cache: move them to their own cache once, before an engine answer rewrites that one.
    if (!lists && cached?.neural) { lists = cached.neural; localStorage.setItem(VOICE_LIST_CACHE, JSON.stringify(lists)); }
    if (cached?.tts) state.extra.tts ||= cached.tts; state.extra.neural ||= lists;
  } catch { /* private window */ }
  const keepSpeak = status => { try { localStorage.setItem(SPEAK_CACHE, JSON.stringify({ tts: status })); } catch { /* private window */ } };
  const keepVoiceLists = neural => { try { localStorage.setItem(VOICE_LIST_CACHE, JSON.stringify(neural)); } catch { /* private window */ } };
  const showTts = status => { keepSpeak(status); setSpeechEngine(status); ttsRun.show?.(status); };
  const takeTts = async (request, save = false) => {
    if (save) {
      // Once no save is out any more, the newest save that worked is shown and cached; a failed save never touches either,
      // so it cannot hide an earlier save that worked.
      const mine = ++ttsRun.saves; ttsRun.open++;
      let status, failed = null;
      try { status = await request(); if (mine > (ttsRun.best?.n || 0)) ttsRun.best = { n: mine, status }; } catch (error) { failed = error; } finally { ttsRun.open--; }
      if (!ttsRun.open && ttsRun.best && ttsRun.best.n > ttsRun.shown) { ttsRun.shown = ttsRun.best.n; showTts(ttsRun.best.status); }
      if (failed) throw failed;
      return status;
    }
    // A load counts only when no save was out when it started, none started since, and it is the newest load:
    // a load started during a save may have been answered before that save landed.
    const mine = ++ttsRun.loads, savesAtStart = ttsRun.saves, openAtStart = ttsRun.open;
    const status = await request();
    if (mine !== ttsRun.loads || openAtStart || savesAtStart !== ttsRun.saves || ttsRun.open) return null;
    showTts(status); return status;
  };
  ttsRun.show = status => { state.extra.tts = status; jevDraw(); };
  // A background answer redraws the Jev tab only when no edit is waiting to save; otherwise the redraw waits until that save has read the fields.
  const jevDraw = () => { if (!has('jev') || !document.body.contains(back)) return; if (pendingSave) { jevLater = true; return; } draw(); };
  if (has('jev') && !ui.accounts) void api('/agents').then(list => { ui.accounts ||= list; jevDraw(); }).catch(() => {});
  void api('/computer').then(info => { state.extra.anywhere = info.anywhere; jevDraw(); }).catch(() => {});
  void takeTts(() => api('/speak/engine')).then(status => { if (status) jevDraw(); }).catch(() => {});
  void api('/speak/voices').then(neural => { state.extra.neural = neural; keepVoiceLists(neural); jevDraw(); }).catch(() => {});
  if ('speechSynthesis' in window) void Promise.all(['en', 'ko', 'km'].map(lang => voicesFor(lang).then(list => [lang, list.map(voice => ({ name: voice.name }))]))).then(pairs => { state.extra.voices = Object.fromEntries(pairs); jevDraw(); });
  // Spoken replies: each control saves at once.
  back.addEventListener('change', async event => {
    const name = event.target.dataset?.stTts; if (!name) return;
    try { await takeTts(() => api('/speak/engine', { method: 'POST', data: { [name]: event.target.value } }), true); toast(t('Saved.')); }
    catch (error) { toast(error.message, true); }
    jevDraw();
  });
  back.addEventListener('click', async event => {
    const save = event.target.closest('[data-st-fish-save]'), remove = event.target.closest('[data-st-fish-remove]'), test = event.target.closest('[data-st-tts-test]');
    if (!save && !remove && !test) return;
    event.preventDefault();
    try {
      if (save) { const key = back.querySelector('[data-st-fish-key]')?.value || ''; await takeTts(() => api('/speak/fish-key', { method: 'POST', data: { key } }), true); toast(t('Fish Audio key saved.')); }
      if (remove) { await takeTts(() => api('/speak/fish-key', { method: 'POST', data: { key: '' } }), true); toast(t('Fish Audio key removed.')); }
      if (test) {
        state.extra.ttsTesting = true; jevDraw();
        const response = await fetch('/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rex-desk': '1' }, body: JSON.stringify({ text: 'Hi, this is how I will sound when we talk in Voice mode.', lang: 'en' }) });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || t('The voice service did not answer.'));
        const audio = new Audio(URL.createObjectURL(await response.blob())); await audio.play().catch(() => {});
        await new Promise(resolve => { audio.onended = resolve; audio.onerror = resolve; setTimeout(resolve, 15000); });
        await takeTts(() => api('/speak/engine'));
      }
    } catch (error) { toast(error.message, true); }
    state.extra.ttsTesting = false; jevDraw();
  });
  back.addEventListener('change', event => { const lang = event.target.dataset?.stVoice; if (!lang) return; try { if (event.target.value) localStorage.setItem(`rex-desk-voice-${lang}`, event.target.value); else localStorage.removeItem(`rex-desk-voice-${lang}`); } catch { /* private window */ } toast(t('Reading voice saved.')); });
  if (has('projects')) void loadGithub();
  if (has('about')) void loadAbout();
  if (has('folders')) void loadFolders(ctx, state).then(() => has('folders') && draw());
  if (has('localai')) void loadLocalAi(ctx, state).then(() => has('localai') && draw());
  if (has('storage')) void loadStorage(ctx, state, { onUpdate: () => has('storage') && draw() }).then(() => has('storage') && draw());
  if (has('accounts')) void loadTourAi(ctx, state).then(() => has('accounts') && draw());
  if (has('general')) void api('/autostart').then(result => { state.extra.autostart = result; if (has('general') && document.body.contains(back)) draw(); }).catch(() => {});
  // The Notifications tab saves on change; redraw it when its settings come back changed, keeping the scroll.
  let noticeHtml = '';
  window.__rexNoticeSettingsRedraw = () => {
    if (!document.body.contains(back)) { window.__rexNoticeSettingsRedraw = null; return; }
    if (!has('notify')) return;
    const html = panels.notify(); if (html === noticeHtml) return; noticeHtml = html;
    const panel = back.querySelector('[data-st-panel]'), top = panel?.scrollTop || 0; if (panel) { panel.innerHTML = html; panel.scrollTop = top; }
  };
  draw(); back.querySelector('.st-nav button.on')?.focus();
}
