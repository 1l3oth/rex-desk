// Feature tours inside Settings, with Driver.js (MIT, served from node_modules): each step dims the page, circles one
// real control and explains it in a small card, while Rex's own voice reads the Khmer line. "Show me" on a section runs
// that section's tour; "Take the tour" runs every section in turn.
import { driver } from '/vendor/driver/driver.js.mjs';
import { TOURS, ORDER, INTRO, OUTRO } from '/guides/settings-tour-steps.js';

const MUTE = 'rex-desk-tour-mute';
let audio = null;
const muted = () => { try { return localStorage.getItem(MUTE) === '1'; } catch { return false; } };
const stop = () => { if (audio) { audio.pause(); audio = null; } };
const play = id => { stop(); if (muted() || !id) return; audio = new Audio(`/guides/voice/${id}.m4a`); audio.play().catch(() => {}); };
const esc = text => String(text).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
// The card or row around a control, so the circle takes in its label and help text too.
const around = selector => () => {
  const panel = document.querySelector('.settings-pop'); if (!panel || !selector) return undefined;
  const found = selector.split(',').map(one => panel.querySelector(one.trim())).find(Boolean);
  const box = found ? found.closest('.st-check, .st-field, .st-repo, .st-folder, .st-tip, .st-tracker') || found : undefined;
  // Settings scrolls inside its own panel, so bring the control to the middle there, leaving room for the card under it.
  box?.scrollIntoView({ block: 'center' });
  return box;
};

// goSection(id) opens a Settings section and resolves once its contents are on screen.
export async function runSettingsTour(goSection, { section, all = false } = {}) {
  const sections = all ? ORDER : [section];
  let index = 0, next = false;
  const start = async () => {
    const id = sections[index]; await goSection(id);
    const nav = document.querySelector(`.settings-pop [data-st-section="${id}"]`);
    const steps = TOURS[id].map((step, number) => ({ ...step, element: number === 0 ? (nav && nav.offsetParent ? nav : around('h2')) : around(step.target) }));
    if (all && index === 0) steps.unshift({ ...INTRO, element: undefined });
    if (all && index === sections.length - 1) steps.push({ ...OUTRO, element: around(OUTRO.target) });
    const last = index === sections.length - 1;
    next = false;
    const tour = driver({
      steps: steps.map((step, number) => ({ element: step.element, popover: { description: `<p class="rt-km" lang="km">${esc(step.km)}</p><p class="rt-en">${esc(step.en)}</p>`, side: step.element === nav ? 'right' : 'bottom', align: step.element === nav ? 'center' : 'start' }, voice: step.id })),
      popoverClass: 'rex-tour', overlayColor: '#05070c', overlayOpacity: 0.6, stagePadding: 6, stageRadius: 12, smoothScroll: true, allowClose: true,
      showProgress: true, progressText: all ? `Part ${index + 1} of ${sections.length} · {{current}}/{{total}}` : '{{current}} of {{total}}',
      nextBtnText: 'Next', prevBtnText: 'Back', doneBtnText: all && !last ? 'Next feature' : 'Done',
      onHighlighted: (element, step) => play(step.voice),
      onPopoverRender: popover => {
        const sound = document.createElement('button'); sound.type = 'button'; sound.className = 'rt-sound';
        const label = () => { sound.textContent = muted() ? 'Voice off' : 'Voice on'; sound.setAttribute('aria-pressed', String(!muted())); };
        label(); sound.addEventListener('click', () => { try { localStorage.setItem(MUTE, muted() ? '0' : '1'); } catch { /* private window */ } label(); if (muted()) stop(); else play(tour.getActiveStep()?.voice); });
        popover.footerButtons.prepend(sound);
      },
      onNextClick: () => { if (tour.isLastStep()) { next = true; tour.destroy(); } else tour.moveNext(); },
      onDestroyed: () => { stop(); if (next && all && !last) { index += 1; void start(); } },
    });
    tour.drive();
  };
  await start();
}
