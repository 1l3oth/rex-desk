// Rex Agent's own face: a glowing core with small lights circling it, one for each agent (up to five). The lights turn
// faster while Rex Agent works. Drawn as one small SVG; only rotation moves, so it costs the graphics card next to nothing.
let defsAdded = false;
function addDefs() {
  if (defsAdded || typeof document === 'undefined') return;
  defsAdded = true;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('rex-core-defs');
  svg.innerHTML = '<defs><radialGradient id="rex-core-orb" cx="40%" cy="35%"><stop offset="0" class="rc-s0"/><stop offset=".38" class="rc-s1"/><stop offset="1" class="rc-s2"/></radialGradient></defs>';
  (document.body || document.documentElement).append(svg);
}

// Where each light sits: [radius, size]. How fast each one turns lives in glass.css (rc-o0 to rc-o4): the page's safety rules allow no inline styles.
const MOONS = [[40, 5.2], [46, 4], [34, 3.6], [46, 3.4], [40, 3]];

export function rexCore(size = 'sm', agents = 3) {
  addDefs();
  const count = Math.max(1, Math.min(5, Number(agents) || 1));
  const moons = MOONS.slice(0, count).map(([radius, dot], index) =>
    `<g class="rc-orbit rc-o${index}"><circle class="rc-moon" cx="50" cy="${50 - radius}" r="${dot}"/></g>`).join('');
  return `<span class="av rex-core ${size}" role="img" aria-label="Rex Agent"><svg viewBox="0 0 100 100" aria-hidden="true">
    <circle class="rc-glow" cx="50" cy="50" r="30"/><circle class="rc-ring" cx="50" cy="50" r="40"/><circle class="rc-orb" cx="50" cy="50" r="25"/>${moons}</svg></span>`;
}
