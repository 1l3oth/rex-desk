// The Knowledge graph: you, what the agents learned about you, your agents and projects, and your second brain, as one
// living map. Drawn on a canvas (one picture a frame, not thousands of page elements); the physics runs in graph-worker.js.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
// Each kind of knowledge has its own light. [hue, size, mass]
const KINDS = { you: [212, 24, 7], agent: [268, 15, 3.6], project: [158, 9.5, 2.6], brain: [38, 13, 5], branch: [200, 8.5, 2.2], fact: [200, 4, 1], lesson: [268, 4, 1], note: [226, 2.3, 0.8] };
const NAMED = new Set(['you', 'agent', 'project', 'brain', 'branch']);
const BRANCH_HUE = { explain: 190, personality: 320, likes: 150, dislikes: 2, works: 48, about: 222 };
const LABELS = { you: 'You', agent: 'Agent', project: 'Project', brain: 'Second brain', branch: 'About you', fact: 'What agents know', lesson: 'Lesson', note: 'Note' };
let live = null;
// Three ways to look. Tree: still and calm, it grows out from you branch by branch and then stays where it is.
// Drift: the same lights floating, pulled by their links. Everything: drifting, with every note of the vault.
const FOCUS_NOTES = 70;
const style = () => { try { const saved = localStorage.getItem('rex-knowledge-style'); return ['tree', 'focus', 'all'].includes(saved) ? saved : 'tree'; } catch { return 'tree'; } };
const TREE_NOTES = 260;

function mount(host) {
  if (live?.host === host) return;
  live?.stop();
  host.innerHTML = `<canvas class="kg-canvas" aria-label="Knowledge graph"></canvas>
    <div class="kg-top"><div class="kg-search"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="search" placeholder="Find in your knowledge" aria-label="Find in your knowledge"></div><div class="kg-style" role="tablist" aria-label="How much to show"><button type="button" role="tab" data-kg-style="tree">Tree</button><button type="button" role="tab" data-kg-style="focus">Drift</button><button type="button" role="tab" data-kg-style="all">Everything</button></div><span class="kg-count" role="status"></span><span class="kg-grow"></span><button type="button" class="kg-edit" data-action="kg-view" data-view="list" title="Add or remove what the agents know about you">Edit as a list</button></div>
    <div class="kg-legend"></div><aside class="kg-card" hidden></aside><div class="kg-hint">Drag the space to move · scroll to zoom · click a light to read it</div>`;
  const canvas = host.querySelector('canvas'), context = canvas.getContext('2d'), card = host.querySelector('.kg-card'), count = host.querySelector('.kg-count');
  const state = { host, nodes: [], links: [], positions: new Float32Array(0), shown: new Float32Array(0), near: [], view: { x: 0, y: 0, k: 0.9 }, target: { x: 0, y: 0, k: 0.9 }, hover: -1, picked: -1, drag: null, match: null, born: performance.now(), alive: true };
  const mode = style(), tree = mode === 'tree';
  // The tree needs no physics: where everything goes is worked out once.
  const worker = tree ? { postMessage() {}, terminate() {} } : new Worker('/graph-worker.js');
  worker.onmessage = ({ data }) => { state.positions = data; if (state.shown.length !== data.length) state.shown = Float32Array.from(data); };
  const hueOf = node => node.kind === 'branch' || node.kind === 'fact' ? BRANCH_HUE[node.group] ?? 200 : KINDS[node.kind]?.[0] ?? 210;
  const sizeOf = node => (KINDS[node.kind]?.[1] ?? 4) + (node.kind === 'note' ? Math.min(5, Math.sqrt(node.degree || 0) * 0.55) : Math.min(5, Math.sqrt(node.degree || 0) * 0.5));
  // Faces: the person's photo on their own light, and each agent's initials on theirs.
  const face = new Image(); face.src = '/api/profile/photo'; face.onerror = () => { face.failed = true; };
  const initials = label => label.replace(/[_-]+/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0].toUpperCase()).join('');

  for (const button of host.querySelectorAll('[data-kg-style]')) { const on = button.dataset.kgStyle === mode; button.classList.toggle('on', on); button.setAttribute('aria-selected', String(on)); }
  fetch('/api/knowledge', { headers: { 'x-rex-desk': '1' } }).then(reply => reply.json()).then(graph => {
    if (!state.alive) return;
    const everything = graph.nodes.length;
    if (mode !== 'all') {
      // Keep the vault's most linked notes, and the links among what is kept.
      const degree = new Map(); for (const [from, to] of graph.links) { degree.set(from, (degree.get(from) || 0) + 1); degree.set(to, (degree.get(to) || 0) + 1); }
      const keep = new Set(graph.nodes.filter(node => node.kind === 'note').sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0)).slice(0, tree ? TREE_NOTES : FOCUS_NOTES).map(node => node.id));
      graph.nodes = graph.nodes.filter(node => node.kind !== 'note' || keep.has(node.id));
      const ids = new Set(graph.nodes.map(node => node.id)); graph.links = graph.links.filter(([from, to]) => ids.has(from) && ids.has(to));
      const linked = new Set(graph.links.flat()); for (const id of keep) if (!linked.has(id)) graph.links.push(['brain', id]);
    }
    const index = new Map(graph.nodes.map((node, position) => [node.id, position]));
    state.nodes = graph.nodes.map(node => ({ ...node, degree: 0 }));
    const pairs = [];
    for (const [from, to] of graph.links) { const a = index.get(from), b = index.get(to); if (a === undefined || b === undefined || a === b) continue; pairs.push(a, b); state.nodes[a].degree++; state.nodes[b].degree++; }
    state.links = Uint32Array.from(pairs);
    state.near = state.nodes.map(() => []);
    for (let k = 0; k < pairs.length; k += 2) { state.near[pairs[k]].push(pairs[k + 1]); state.near[pairs[k + 1]].push(pairs[k]); }
    for (const node of state.nodes) { node.hue = hueOf(node); node.size = sizeOf(node); }
    // Names shown from afar: people, projects and branches, and the dozen most linked notes of the vault.
    const hubs = new Set(state.nodes.map((node, position) => [node, position]).filter(([node]) => node.kind === 'note').sort((a, b) => b[0].degree - a[0].degree).slice(0, 12).map(([, position]) => position));
    state.nodes.forEach((node, position) => { node.named = NAMED.has(node.kind) || hubs.has(position); });
    state.order = state.nodes.map((_, position) => position).sort((a, b) => state.nodes[b].size - state.nodes[a].size);
    const mass = Float32Array.from(state.nodes, node => KINDS[node.kind]?.[2] ?? 1);
    if (tree) plant(); else worker.postMessage({ type: 'start', count: state.nodes.length, links: state.links, mass });
    const kinds = [...new Set(state.nodes.map(node => node.kind))].filter(kind => kind !== 'fact' && kind !== 'lesson');
    host.querySelector('.kg-legend').innerHTML = kinds.map(kind => `<span><i data-h="${KINDS[kind][0]}"></i>${LABELS[kind]}</span>`).join(''); tint(host.querySelector('.kg-legend'));
    count.textContent = mode !== 'all' ? `${state.nodes.length.toLocaleString()} of ${everything.toLocaleString()} lights` : `${state.nodes.length.toLocaleString()} lights, ${(pairs.length / 2).toLocaleString()} links`;
  }).catch(error => { count.textContent = `The graph could not load: ${error.message}`; });

  // Sizes follow the box; the canvas is drawn at the screen's real pixel count so it stays sharp.
  let width = 0, height = 0, ratio = 1;
  const resize = () => { ratio = Math.min(2, devicePixelRatio || 1); width = host.clientWidth; height = host.clientHeight; canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); };
  const watcher = new ResizeObserver(resize); watcher.observe(host); resize();
  const toWorld = (px, py) => [(px - width / 2) / state.view.k - state.view.x, (py - height / 2) / state.view.k - state.view.y];
  // The tree. Starting from you, every light hangs from the first light that reaches it; each branch gets a slice of
  // the circle as wide as the number of leaves it carries, and each generation sits on its own ring.
  function plant() {
    const total = state.nodes.length, parent = new Int32Array(total).fill(-1), depth = new Int32Array(total).fill(-1), kids = state.nodes.map(() => []), order = [];
    const root = Math.max(0, state.nodes.findIndex(node => node.kind === 'you')); depth[root] = 0; order.push(root);
    for (let at = 0; at < order.length; at++) { const from = order[at]; for (const to of [...state.near[from]].sort((a, b) => state.nodes[b].size - state.nodes[a].size)) if (depth[to] < 0) { depth[to] = depth[from] + 1; parent[to] = from; kids[from].push(to); order.push(to); } }
    // Groups of notes that link only to each other hang from the second brain by their most linked note, and grow on from there.
    const trunk = state.nodes.findIndex(node => node.kind === 'brain'), stem = trunk >= 0 ? trunk : root;
    for (const i of state.nodes.map((_, position) => position).sort((a, b) => state.nodes[b].degree - state.nodes[a].degree)) {
      if (depth[i] >= 0) continue;
      depth[i] = depth[stem] + 1; parent[i] = stem; kids[stem].push(i); order.push(i);
      for (let at = order.length - 1; at < order.length; at++) { const from = order[at]; for (const to of state.near[from]) if (depth[to] < 0) { depth[to] = depth[from] + 1; parent[to] = from; kids[from].push(to); order.push(to); } }
    }
    order.sort((a, b) => depth[a] - depth[b]);
    // A branch's share of the circle grows with what it carries, but slowly, so one huge branch does not squeeze the rest.
    const leaves = new Float32Array(total); for (let at = order.length - 1; at >= 0; at--) { const i = order[at]; leaves[i] = (kids[i].length ? Math.pow(kids[i].reduce((sum, kid) => sum + leaves[kid], 0), 0.82) : 1) + (state.nodes[i].size >= 8 ? 2.5 : 0); }
    const perRing = []; for (const i of order) perRing[depth[i]] = (perRing[depth[i]] || 0) + 1;
    const from = new Float32Array(total), to = new Float32Array(total); to[root] = 6.2832;
    for (const i of order) { const whole = kids[i].reduce((sum, kid) => sum + leaves[kid], 0); let start = from[i]; for (const kid of kids[i]) { const share = (to[i] - from[i]) * leaves[kid] / whole; from[kid] = start; to[kid] = start + share; start += share; } }
    // Each ring is far enough out for its most crowded branch to fit its lights side by side.
    const ring = [0];
    for (let d = 1; d < perRing.length; d++) { let need = ring[d - 1] + 110; for (const i of order) if (depth[i] === d - 1 && kids[i].length > 1) need = Math.max(need, Math.min(ring[d - 1] + 230, kids[i].reduce((sum, kid) => sum + state.nodes[kid].size * 2 + 9, 0) / Math.max(0.05, to[i] - from[i]))); ring[d] = need; }
    const final = new Float32Array(total * 2);
    for (const i of order) { const middle = (from[i] + to[i]) / 2 - 1.5708; final[i * 2] = Math.cos(middle) * ring[depth[i]]; final[i * 2 + 1] = Math.sin(middle) * ring[depth[i]]; }
    const edges = []; for (const i of order) if (parent[i] >= 0) edges.push(parent[i], i);
    state.links = Uint32Array.from(edges);
    Object.assign(state, { tree: { parent, depth, order, final, last: perRing.length - 1 }, appear: new Float32Array(total), positions: new Float32Array(total * 2), shown: new Float32Array(total * 2), born: performance.now() });
  }
  // Growing: a light waits on its parent until its turn, then travels out along its branch. After that nothing moves.
  function growTree(now) {
    const { parent, depth, order, final, last } = state.tree, seconds = (now - state.born) / 1000, wait = Math.min(0.26, 2.4 / Math.max(1, last));
    if (state.tree.done) return;
    for (const i of order) {
      const p = parent[i]; if (p < 0) { state.appear[i] = Math.min(1, seconds / 0.4); continue; }
      const t = Math.min(1, Math.max(0, (seconds - 0.25 - (depth[i] - 1) * wait) / 0.7)), eased = 1 - Math.pow(1 - t, 3);
      state.appear[i] = eased;
      state.positions[i * 2] = state.positions[p * 2] + (final[i * 2] - final[p * 2]) * eased; state.positions[i * 2 + 1] = state.positions[p * 2 + 1] + (final[i * 2 + 1] - final[p * 2 + 1]) * eased;
    }
    state.shown.set(state.positions);
    if (seconds > 0.25 + last * wait + 0.8) state.tree.done = true;
  }
  // Colours are set from script: the page's safety rules do not allow style written into the markup.
  function tint(scope) { for (const element of scope.querySelectorAll('[data-h]')) element.style.setProperty('--h', element.dataset.h); }
  // The camera frames the whole graph while it opens, until the person moves it themselves.
  function fit() {
    if (state.touched || !state.nodes.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const where = state.tree ? state.tree.final : state.positions;
    for (let i = 0; i < state.nodes.length; i++) { const x = where[i * 2], y = where[i * 2 + 1]; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    if (!Number.isFinite(minX)) return;
    state.target = { k: Math.min(1.6, Math.max(0.1, Math.min(width / (maxX - minX + 160), height / (maxY - minY + 160)))), x: -(minX + maxX) / 2, y: -(minY + maxY) / 2 };
  }
  const fitting = setInterval(fit, 300); setTimeout(() => clearInterval(fitting), 9000);
  function nodeAt(px, py) {
    const [wx, wy] = toWorld(px, py); let best = -1, bestDistance = Infinity;
    for (let i = 0; i < state.nodes.length; i++) {
      const dx = state.shown[i * 2] - wx, dy = state.shown[i * 2 + 1] - wy, reach = state.nodes[i].size * Math.pow(state.view.k, -0.5) + 6 / state.view.k, distance = dx * dx + dy * dy;
      if (distance < reach * reach && distance < bestDistance) { best = i; bestDistance = distance; }
    }
    return best;
  }

  function draw(now) {
    if (!state.alive || !host.isConnected) { stop(); return; }
    requestAnimationFrame(draw);
    // Nothing to draw until the physics has sent its first positions.
    if (state.shown.length < state.nodes.length * 2 || state.positions.length !== state.shown.length) return;
    const { nodes, shown, positions, view, target } = state, dark = document.documentElement.dataset.theme === 'dark';
    // Nodes glide toward where the physics says they are, and the camera glides toward where you asked it to go.
    if (state.tree) growTree(now); else for (let i = 0; i < positions.length; i++) shown[i] += (positions[i] - shown[i]) * 0.22;
    view.x += (target.x - view.x) * 0.16; view.y += (target.y - view.y) * 0.16; view.k += (target.k - view.k) * 0.16;
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    context.translate(width / 2, height / 2); context.scale(view.k, view.k); context.translate(view.x, view.y);
    const focus = state.hover >= 0 ? state.hover : state.picked, friends = focus >= 0 ? new Set([focus, ...state.near[focus]]) : null, grow = state.tree ? 1 : Math.min(1, (now - state.born) / 900), seen = state.appear;
    const dim = i => friends ? (friends.has(i) ? 1 : 0.12) : state.match ? (state.match.has(i) ? 1 : 0.1) : 1;
    // Threads.
    context.lineWidth = 1 / view.k;
    context.strokeStyle = dark ? `rgba(190,205,255,${state.tree ? 0.2 : 0.11})` : `rgba(40,60,110,${state.tree ? 0.22 : 0.13})`; context.beginPath();
    for (let k = 0; k < state.links.length; k += 2) { const a = state.links[k], b = state.links[k + 1]; if (friends && (a === focus || b === focus)) continue; context.moveTo(shown[a * 2], shown[a * 2 + 1]); context.lineTo(shown[b * 2], shown[b * 2 + 1]); }
    context.globalAlpha = friends || state.match ? 0.35 : 1; context.stroke(); context.globalAlpha = 1;
    if (friends) {
      // The picked light's own threads glow, with a spark travelling along each.
      context.lineWidth = 1.6 / view.k; context.strokeStyle = `hsla(${nodes[focus].hue},90%,${dark ? 72 : 48}%,.75)`; context.beginPath();
      for (const other of state.near[focus]) { context.moveTo(shown[focus * 2], shown[focus * 2 + 1]); context.lineTo(shown[other * 2], shown[other * 2 + 1]); }
      context.stroke();
      const travel = (now / 1400) % 1; context.fillStyle = dark ? '#fff' : `hsl(${nodes[focus].hue},90%,40%)`;
      for (const other of state.near[focus].slice(0, 60)) { const sx = shown[focus * 2] + (shown[other * 2] - shown[focus * 2]) * travel, sy = shown[focus * 2 + 1] + (shown[other * 2 + 1] - shown[focus * 2 + 1]) * travel; context.beginPath(); context.arc(sx, sy, 1.6 / view.k, 0, 6.2832); context.fill(); }
    }
    // Lights: a soft halo, a glass body, and a small highlight. They grow slower than the zoom, so coming closer
    // spreads them apart instead of blowing them up.
    const zoomed = Math.pow(view.k, -0.5);
    const left = -view.x - width / 2 / view.k - 40, right = -view.x + width / 2 / view.k + 40, top = -view.y - height / 2 / view.k - 40, bottom = -view.y + height / 2 / view.k + 40;
    // The vault's notes are by far the most: all of one brightness are drawn as a single shape, not one by one.
    for (const bright of [true, false]) {
      context.beginPath(); let any = false;
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]; if (node.kind !== 'note' || i === focus || (dim(i) === 1) !== bright) continue;
        const x = shown[i * 2], y = shown[i * 2 + 1]; if (x < left || x > right || y < top || y > bottom) continue;
        const radius = node.size * zoomed * grow * (seen ? seen[i] : 1); if (radius < 0.05) continue; context.moveTo(x + radius, y); context.arc(x, y, radius, 0, 6.2832); any = true;
      }
      if (!any) continue;
      context.globalAlpha = bright ? 1 : 0.12; context.fillStyle = `hsla(226,${dark ? 38 : 34}%,${dark ? 74 : 46}%,${dark ? 0.62 : 0.7})`; context.fill();
    }
    context.globalAlpha = 1;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i], x = shown[i * 2], y = shown[i * 2 + 1];
      if (node.kind === 'note' && i !== focus) continue;
      if (x < left || x > right || y < top || y > bottom) continue;
      const big = node.size >= 8, pulse = big ? 1 + Math.sin(now / 900 + i) * 0.04 : 1, radius = node.size * zoomed * pulse * grow * (seen ? seen[i] : 1) * (i === focus ? 1.25 : 1), alpha = dim(i);
      if (radius < 0.05) continue;
      context.globalAlpha = alpha;
      if (big || i === focus) { const halo = context.createRadialGradient(x, y, radius * 0.6, x, y, radius * 2.6); halo.addColorStop(0, `hsla(${node.hue},95%,62%,${dark ? 0.42 : 0.3})`); halo.addColorStop(1, `hsla(${node.hue},95%,62%,0)`); context.fillStyle = halo; context.beginPath(); context.arc(x, y, radius * 2.6, 0, 6.2832); context.fill(); }
      const note = node.kind === 'note';
      context.fillStyle = note ? `hsla(${node.hue},${dark ? 38 : 34}%,${dark ? 74 : 46}%,${dark ? 0.62 : 0.7})` : `hsl(${node.hue},${big ? 82 : 70}%,${dark ? (big ? 62 : 66) : (big ? 50 : 54)}%)`;
      context.beginPath(); context.arc(x, y, radius, 0, 6.2832); context.fill();
      if (node.kind === 'you' && face.complete && face.naturalWidth && !face.failed) {
        context.save(); context.beginPath(); context.arc(x, y, Math.max(0.1, radius - 1.5), 0, 6.2832); context.clip(); const side = Math.max(0.2, (radius - 1.5) * 2), crop = Math.min(face.naturalWidth, face.naturalHeight);
        context.drawImage(face, (face.naturalWidth - crop) / 2, (face.naturalHeight - crop) / 2, crop, crop, x - side / 2, y - side / 2, side, side); context.restore();
        context.lineWidth = 1.5; context.strokeStyle = `hsla(${node.hue},95%,72%,.95)`; context.beginPath(); context.arc(x, y, radius, 0, 6.2832); context.stroke();
      } else if (node.kind === 'agent' || node.kind === 'you') {
        context.fillStyle = 'rgba(255,255,255,.96)'; context.font = `700 ${radius * 0.82}px "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif`; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(initials(node.label), x, y + radius * 0.04);
      } else if (!note && radius * view.k > 5) { context.fillStyle = 'rgba(255,255,255,.45)'; context.beginPath(); context.arc(x - radius * 0.3, y - radius * 0.34, radius * 0.3, 0, 6.2832); context.fill(); }
    }
    // Names: the big lights always, the small ones as you come closer or point at them.
    context.textAlign = 'center'; context.textBaseline = 'top';
    // The biggest lights are named first; a name that would land on another one is left out, and at most 140 are drawn.
    const taken = new Set(); let written = 0;
    for (const i of state.order || []) {
      if (written >= 140) break;
      const node = nodes[i], x = shown[i * 2], y = shown[i * 2 + 1];
      if (x < left || x > right || y < top || y > bottom) continue;
      const near = friends?.has(i) || state.match?.has(i), fade = node.named || near ? 1 : Math.min(1, Math.max(0, (view.k - 1.5) / 0.7));
      if (fade <= 0.02 || (seen && seen[i] < 0.95) || (state.match && !state.match.has(i) && !friends?.has(i))) continue;
      const sx = (x + view.x) * view.k, sy = (y + view.y + node.size * zoomed * 1.25) * view.k + 3, cell = `${Math.round(sx / 110)}:${Math.round(sy / 20)}`;
      if (taken.has(cell) && i !== focus) continue; taken.add(cell); written++;
      const size = (node.named && node.kind !== 'note' ? 12.5 : 11) / view.k;
      context.globalAlpha = fade * dim(i); context.font = `${node.named ? 600 : 500} ${size}px "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif`;
      context.fillStyle = dark ? 'rgba(236,240,250,.94)' : 'rgba(22,28,44,.92)';
      context.fillText(node.label.length > 30 ? `${node.label.slice(0, 29)}…` : node.label, x, y + node.size * zoomed * 1.25 + 3 / view.k);
    }
    context.globalAlpha = 1;
  }
  requestAnimationFrame(draw);

  function show(index) {
    state.picked = index;
    if (index < 0) { card.hidden = true; return; }
    const node = state.nodes[index], friends = state.near[index].map(other => state.nodes[other]).sort((a, b) => b.size - a.size).slice(0, 8);
    state.touched = true;
    card.innerHTML = `<button type="button" class="kg-x" aria-label="Close">×</button><span class="kg-kind" data-h="${node.hue}">${esc(LABELS[node.kind] || node.kind)}</span><h3>${esc(node.kind === 'fact' || node.kind === 'lesson' ? node.text : node.label)}</h3>
      ${node.text && node.kind !== 'fact' && node.kind !== 'lesson' ? `<p>${esc(node.text)}</p>` : ''}
      ${friends.length ? `<h4>Linked to</h4><div class="kg-links">${friends.map(friend => `<button type="button" data-kg-go="${state.nodes.indexOf(friend)}"><i data-h="${friend.hue}"></i>${esc(friend.label)}</button>`).join('')}</div>` : ''}
      ${node.file ? `<button type="button" class="btn small" data-file-open="${esc(node.file)}">Open the note</button>` : ''}`;
    tint(card); card.hidden = false;
    state.target = { x: -state.shown[index * 2], y: -state.shown[index * 2 + 1], k: Math.max(state.view.k, 2.2) };
  }

  // Pointer: drag a light to move it, drag the space to pan, a short press picks.
  const point = event => { const box = canvas.getBoundingClientRect(); return [event.clientX - box.left, event.clientY - box.top]; };
  canvas.addEventListener('pointerdown', event => { const [px, py] = point(event), index = nodeAt(px, py); state.drag = { index, px, py, moved: false, x: state.target.x, y: state.target.y }; state.touched = true; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener('pointermove', event => {
    const [px, py] = point(event), drag = state.drag;
    if (!drag) { const over = nodeAt(px, py); if (over !== state.hover) { state.hover = over; canvas.style.cursor = over >= 0 ? 'pointer' : 'grab'; } return; }
    if (Math.abs(px - drag.px) + Math.abs(py - drag.py) > 4) drag.moved = true;
    if (!drag.moved) return;
    if (drag.index >= 0 && !state.tree) { const [wx, wy] = toWorld(px, py); worker.postMessage({ type: 'drag', index: drag.index, x: wx, y: wy }); }
    else { state.target.x = state.view.x = drag.x + (px - drag.px) / state.view.k; state.target.y = state.view.y = drag.y + (py - drag.py) / state.view.k; }
  });
  canvas.addEventListener('pointerup', () => { const drag = state.drag; state.drag = null; if (!drag) return; if (drag.index >= 0 && drag.moved) worker.postMessage({ type: 'drop', index: drag.index }); else if (!drag.moved) show(drag.index); });
  canvas.addEventListener('pointerleave', () => { state.hover = -1; });
  canvas.addEventListener('wheel', event => {
    event.preventDefault(); state.touched = true;
    const [px, py] = point(event), [wx, wy] = toWorld(px, py), k = Math.min(6, Math.max(0.12, state.target.k * Math.exp(-event.deltaY * 0.0016)));
    state.target = { k, x: (px - width / 2) / k - wx, y: (py - height / 2) / k - wy };
  }, { passive: false });
  host.addEventListener('click', event => {
    const go = event.target.closest('[data-kg-go]'); if (go) { show(Number(go.dataset.kgGo)); return; }
    if (event.target.closest('.kg-x')) show(-1);
    const pick = event.target.closest('[data-kg-style]');
    if (pick && pick.dataset.kgStyle !== mode) { try { localStorage.setItem('rex-knowledge-style', pick.dataset.kgStyle); } catch {} stop(); host.replaceChildren(); mount(host); }
  });
  host.querySelector('input').addEventListener('input', event => {
    const words = event.target.value.trim().toLowerCase();
    state.touched = true;
    if (!words) { state.match = null; return; }
    const found = new Set(); state.nodes.forEach((node, index) => { if (`${node.label} ${node.text || ''}`.toLowerCase().includes(words)) found.add(index); });
    state.match = found;
    if (found.size) { let sx = 0, sy = 0; for (const index of found) { sx += state.shown[index * 2]; sy += state.shown[index * 2 + 1]; } state.target = { x: -sx / found.size, y: -sy / found.size, k: found.size === 1 ? 1.8 : state.target.k }; }
  });

  function stop() { if (!state.alive) return; state.alive = false; clearInterval(fitting); worker.postMessage({ type: 'stop' }); worker.terminate(); watcher.disconnect(); if (live === state) live = null; }
  state.stop = stop; live = state;
}

// The page draws itself again from time to time; the graph mounts whenever its box appears, and stops when it is gone.
const look = () => { const host = document.getElementById('kg'); if (host && !host.querySelector('canvas')) mount(host); else if (!host && live) live.stop(); };
new MutationObserver(look).observe(document.body, { childList: true, subtree: true });
look();
