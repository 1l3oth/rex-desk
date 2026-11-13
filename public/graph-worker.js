// The physics of the knowledge graph, away from the screen's thread: every node pushes its neighbours away, every link
// pulls like a spring, and everything is drawn gently toward the middle. Positions go back to the page as one array.
let count = 0, x, y, vx, vy, mass, pinned, links = new Uint32Array(0), heat = 1, running = false, timer = 0;
const CELL = 80, REPEL = 1500, SPRING = 0.05, REST = 34, CENTER = 0.022, DAMP = 0.8;

function start(data) {
  count = data.count; links = data.links;
  x = new Float32Array(count); y = new Float32Array(count); vx = new Float32Array(count); vy = new Float32Array(count);
  mass = data.mass; pinned = new Uint8Array(count);
  // Start on a spiral around the middle, so the first seconds open like a flower instead of an explosion.
  for (let i = 0; i < count; i++) { const angle = i * 2.399963, radius = 9 * Math.sqrt(i); x[i] = Math.cos(angle) * radius; y[i] = Math.sin(angle) * radius; }
  heat = 1; if (!running) { running = true; loop(); }
}

function step() {
  // Neighbours only: nodes are sorted into a grid, and a node is pushed by those in its own and the eight cells around it.
  const grid = new Map();
  for (let i = 0; i < count; i++) { const key = (Math.floor(x[i] / CELL) * 73856093) ^ (Math.floor(y[i] / CELL) * 19349663); let cell = grid.get(key); if (!cell) grid.set(key, cell = []); cell.push(i); }
  for (let i = 0; i < count; i++) {
    const cx = Math.floor(x[i] / CELL), cy = Math.floor(y[i] / CELL); let fx = 0, fy = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const cell = grid.get(((cx + dx) * 73856093) ^ ((cy + dy) * 19349663)); if (!cell) continue;
      for (const j of cell) {
        if (j === i) continue;
        let rx = x[i] - x[j], ry = y[i] - y[j], d2 = rx * rx + ry * ry;
        if (d2 > CELL * CELL) continue;
        if (d2 < 1) { rx = (i % 7) - 3 || 1; ry = (j % 5) - 2 || 1; d2 = rx * rx + ry * ry; }
        const push = REPEL * mass[j] / (d2 * Math.sqrt(d2));
        fx += rx * push; fy += ry * push;
      }
    }
    vx[i] += (fx - x[i] * CENTER) * heat; vy[i] += (fy - y[i] * CENTER) * heat;
  }
  for (let k = 0; k < links.length; k += 2) {
    const a = links[k], b = links[k + 1], rx = x[b] - x[a], ry = y[b] - y[a], distance = Math.sqrt(rx * rx + ry * ry) || 1;
    const pull = (distance - REST * (mass[a] + mass[b]) / 2) * SPRING * heat / distance, px = rx * pull, py = ry * pull;
    vx[a] += px / mass[a]; vy[a] += py / mass[a]; vx[b] -= px / mass[b]; vy[b] -= py / mass[b];
  }
  for (let i = 0; i < count; i++) {
    if (pinned[i]) { vx[i] = vy[i] = 0; continue; }
    vx[i] *= DAMP; vy[i] *= DAMP;
    const speed = Math.hypot(vx[i], vy[i]); if (speed > 40) { vx[i] *= 40 / speed; vy[i] *= 40 / speed; }
    x[i] += vx[i]; y[i] += vy[i];
  }
  // It cools down to a slow drift and never fully freezes: the graph keeps breathing.
  heat = Math.max(0.035, heat * 0.992);
}

function loop() {
  if (!running) return;
  step();
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) { out[i * 2] = x[i]; out[i * 2 + 1] = y[i]; }
  postMessage(out, [out.buffer]);
  timer = setTimeout(loop, heat > 0.05 ? 16 : 33);
}

onmessage = ({ data }) => {
  if (data.type === 'start') start(data);
  else if (data.type === 'drag') { const i = data.index; pinned[i] = 1; x[i] = data.x; y[i] = data.y; heat = Math.max(heat, 0.35); }
  else if (data.type === 'drop') { pinned[data.index] = 0; heat = Math.max(heat, 0.25); }
  else if (data.type === 'stop') { running = false; clearTimeout(timer); }
};
