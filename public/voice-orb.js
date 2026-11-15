// Rex's body in Voice mode: a dark core full of slow stars, wrapped in rings of light that drift and bend around it.
// It breathes when idle, leans in and follows your voice while listening, swirls while thinking, and flares with its own
// voice while speaking. Drawn every frame on a canvas with additive light (no CSS filters), so it stays smooth.
// mountOrb(element, read) starts it; read() returns { state: 'idle'|'listening'|'thinking'|'speaking', level: 0..1 }.

const TAU = Math.PI * 2;
const RINGS = Array.from({ length: 13 }, (_, index) => {
  const seed = index * 9301 + 49297, random = offset => { const value = Math.sin(seed + offset * 233.3) * 43758.5453; return value - Math.floor(value); };
  return {
    radius: 0.66 + random(1) * 0.5,             // distance from the centre, as a share of the orb's size
    squash: 0.58 + random(2) * 0.34,            // how oval the ring is
    tilt: random(3) * TAU,                      // which way the oval leans
    spin: (random(4) - 0.5) * 0.18,             // turns per second, either way
    waves: [2, 3, 4 + Math.floor(random(7) * 2)],
    depth: [0.03 + random(8) * 0.045, 0.01 + random(9) * 0.018, 0.002 + random(10) * 0.005],
    drift: [0.2 + random(11) * 0.5, -0.15 - random(12) * 0.4, 0.4 + random(13) * 0.6],
    gold: index % 4 === 2,                      // a few warm rings among the violet ones
    hero: index % 3 === 0,                      // the brightest, thickest lines
    bright: 0.55 + random(14) * 0.45,
    order: index,                               // when it arrives in the opening
  };
});
const STARS = Array.from({ length: 140 }, (_, index) => {
  const random = offset => { const value = Math.sin(index * 127.1 + offset * 311.7) * 43758.5453; return value - Math.floor(value); };
  return { angle: random(1) * TAU, distance: Math.sqrt(random(2)), speed: 0.02 + random(3) * 0.08, size: 0.4 + random(4) * 1.3, twinkle: random(5) * TAU };
});
// How each state moves: ring speed, how much the rings bend, how bright, and how much the level moves them.
const MOODS = {
  idle: { speed: 0.6, bend: 0.8, glow: 0.75, follow: 0 },
  listening: { speed: 0.8, bend: 1.0, glow: 0.9, follow: 3.2 },
  thinking: { speed: 2.2, bend: 1.15, glow: 0.95, follow: 0 },
  speaking: { speed: 1.1, bend: 0.95, glow: 1.15, follow: 4.5 },
};
const colour = spec => (spec.gold ? [255, 176, 92] : [178, 140, 255]);
// The opening, about 2.5 seconds: a spark flashes, the core grows out of it, then the rings arrive one after another,
// each growing outwards into place. Calm (reduced motion) skips it.
const OPENING = 2500;
const clamp = value => Math.max(0, Math.min(1, value));
const easeOut = value => 1 - Math.pow(1 - value, 3);
const easeBack = value => { const c = 1.4; return 1 + (c + 1) * Math.pow(value - 1, 3) + c * Math.pow(value - 1, 2); };

export function mountOrb(element, read) {
  const canvas = document.createElement('canvas'); canvas.className = 'orb-canvas'; canvas.setAttribute('aria-hidden', 'true');
  element.append(canvas);
  const draw = canvas.getContext('2d');
  // Two layers: the glow (haze, fog and the wide bloom of each ring) is drawn at a third of the size and stretched up,
  // which blurs it for free; the sharp lines, core and stars are drawn at full size. Wide strokes at full size cost a
  // modest laptop most of its frames.
  const soft = document.createElement('canvas'), glow = soft.getContext('2d'), SOFT = 0.34;
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Smoothed values, so changes of state glide instead of jumping.
  const now = { speed: 0.6, bend: 0.8, glow: 0.75, energy: 0.1 };
  let width = 0, height = 0, scale = 1, frame = 0, clock = 0, last = performance.now();
  const born = performance.now();
  let opening = calm ? 1 : 0;
  // How far each ring has arrived (0 to 1), and how big it is on the way.
  const arrived = spec => clamp((opening - 0.22 - spec.order * 0.032) / 0.3);
  const fit = () => {
    scale = Math.min(devicePixelRatio || 1, 1.5); const box = element.getBoundingClientRect();
    width = Math.max(1, Math.round(box.width * scale)); height = Math.max(1, Math.round(box.height * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width; canvas.height = height;
      soft.width = Math.max(1, Math.round(width * SOFT)); soft.height = Math.max(1, Math.round(height * SOFT));
    }
  };
  const resize = new ResizeObserver(fit); resize.observe(element); fit();

  // One ring's path around a centre at a given size (the glow layer draws it smaller).
  function ringPath(spec, cx, cy, size, energy) {
    const points = 96, path = new Path2D();
    const turn = spec.tilt + clock * spec.spin * TAU * 0.25;
    const cosT = Math.cos(turn), sinT = Math.sin(turn), bend = now.bend * (1 + energy * 0.8);
    for (let step = 0; step <= points; step++) {
      const angle = (step / points) * TAU;
      let radius = spec.radius;
      for (let wave = 0; wave < 3; wave++) radius += spec.depth[wave] * bend * Math.sin(spec.waves[wave] * angle + clock * spec.drift[wave] * now.speed);
      radius *= size * (1 + energy * 0.12) * (0.35 + 0.65 * easeBack(arrived(spec)));
      const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius * spec.squash;
      const px = cx + x * cosT - y * sinT, py = cy + x * sinT + y * cosT;
      if (step === 0) path.moveTo(px, py); else path.lineTo(px, py);
    }
    return path;
  }
  const lightOf = (spec, energy) => spec.bright * now.glow * (0.7 + energy * 0.6) * easeOut(arrived(spec));

  function paintGlow(energy) {
    const w = soft.width, h = soft.height, cx = w / 2, cy = h / 2, size = Math.min(w, h) * 0.36, unit = scale * SOFT;
    glow.globalCompositeOperation = 'source-over';
    glow.fillStyle = '#05030c'; glow.fillRect(0, 0, w, h);
    // The space around it: a violet haze that breathes with it, two slow drifting clouds, and a fog where the rings are.
    let fill = glow.createRadialGradient(cx, cy, size * 0.2, cx, cy, size * 2.6), open = easeOut(clamp(opening / 0.7));
    fill.addColorStop(0, `rgba(88,44,170,${(0.32 + energy * 0.25) * open})`); fill.addColorStop(0.45, 'rgba(40,18,90,0.18)'); fill.addColorStop(1, 'rgba(5,3,12,0)');
    glow.fillStyle = fill; glow.fillRect(0, 0, w, h);
    glow.globalCompositeOperation = 'lighter';
    for (const [phase, reach, alpha] of [[0, 1.9, 0.07], [2.1, 1.6, 0.05]]) {
      const x = cx + Math.cos(clock * 0.05 + phase) * size * 0.9, y = cy + Math.sin(clock * 0.04 + phase) * size * 0.7;
      fill = glow.createRadialGradient(x, y, 0, x, y, size * reach); fill.addColorStop(0, `rgba(120,70,220,${alpha})`); fill.addColorStop(1, 'rgba(0,0,0,0)');
      glow.fillStyle = fill; glow.fillRect(0, 0, w, h);
    }
    fill = glow.createRadialGradient(cx, cy, size * 0.45, cx, cy, size * 1.35);
    fill.addColorStop(0, 'rgba(0,0,0,0)'); fill.addColorStop(0.45, `rgba(140,90,255,${0.16 + energy * 0.22})`); fill.addColorStop(1, 'rgba(0,0,0,0)');
    glow.fillStyle = fill; glow.fillRect(0, 0, w, h);
    // Each ring's bloom: wide soft strokes, blurred further by the stretch.
    for (const spec of RINGS) {
      const path = ringPath(spec, cx, cy, size, energy), [r, g, b] = colour(spec), light = lightOf(spec, energy), heavy = spec.hero ? 1.7 : 1;
      glow.lineWidth = 22 * unit * heavy; glow.strokeStyle = `rgba(${r},${g},${b},${0.05 * light})`; glow.stroke(path);
      glow.lineWidth = 8 * unit * heavy; glow.strokeStyle = `rgba(${r},${g},${b},${0.14 * light})`; glow.stroke(path);
    }
  }

  function paint(time) {
    frame = requestAnimationFrame(paint);
    const seconds = Math.min(0.05, (time - last) / 1000); last = time;
    const { state = 'idle', level = 0 } = read() || {}, mood = MOODS[state] || MOODS.idle;
    const ease = 1 - Math.pow(0.04, seconds);
    now.speed += (mood.speed - now.speed) * ease; now.bend += (mood.bend - now.bend) * ease; now.glow += (mood.glow - now.glow) * ease;
    const breathing = 0.08 + 0.05 * Math.sin(time / 1400), target = Math.min(1, breathing + level * mood.follow);
    now.energy += (target - now.energy) * (1 - Math.pow(state === 'speaking' || state === 'listening' ? 0.0005 : 0.05, seconds));
    clock += seconds * (calm ? 0.25 : 1) * now.speed;
    const energy = now.energy;
    opening = calm ? 1 : clamp((time - born) / OPENING);

    paintGlow(energy);
    draw.globalCompositeOperation = 'source-over'; draw.imageSmoothingEnabled = true; draw.imageSmoothingQuality = 'high';
    draw.drawImage(soft, 0, 0, width, height);
    // The rings' bright lines, sharp.
    const cx = width / 2, cy = height / 2, size = Math.min(width, height) * 0.36;
    draw.globalCompositeOperation = 'lighter';
    for (const spec of RINGS) {
      const path = ringPath(spec, cx, cy, size, energy), [r, g, b] = colour(spec), light = lightOf(spec, energy), heavy = spec.hero ? 1.7 : 1;
      draw.lineWidth = 2.6 * scale * heavy; draw.strokeStyle = `rgba(${r},${g},${b},${0.35 * light})`; draw.stroke(path);
      draw.lineWidth = 1.1 * scale * heavy;
      draw.strokeStyle = spec.gold ? `rgba(255,226,180,${Math.min(1, 0.8 * light)})` : `rgba(240,232,255,${Math.min(1, (spec.hero ? 0.95 : 0.6) * light)})`;
      draw.stroke(path);
    }
    // The core: dark glass with a lit rim, then its stars.
    draw.globalCompositeOperation = 'source-over';
    const grown = easeBack(clamp(opening / 0.4)), core = size * (0.44 + energy * 0.03) * Math.max(0.02, grown);
    const glass = draw.createRadialGradient(cx, cy, 0, cx, cy, core);
    glass.addColorStop(0, '#2a1760'); glass.addColorStop(0.55, '#170c3a'); glass.addColorStop(0.9, '#2c1668'); glass.addColorStop(1, '#5a34b8');
    draw.fillStyle = glass; draw.beginPath(); draw.arc(cx, cy, core, 0, TAU); draw.fill();
    draw.globalCompositeOperation = 'lighter';
    const rim = draw.createRadialGradient(cx, cy, core * 0.82, cx, cy, core * 1.25);
    rim.addColorStop(0, 'rgba(0,0,0,0)'); rim.addColorStop(0.3, `rgba(190,150,255,${0.55 + energy * 0.4})`); rim.addColorStop(1, 'rgba(0,0,0,0)');
    draw.fillStyle = rim; draw.beginPath(); draw.arc(cx, cy, core * 1.25, 0, TAU); draw.fill();
    for (const star of STARS) {
      const angle = star.angle + clock * star.speed, distance = star.distance * core * 0.92, dot = star.size * scale * 1.6;
      const twinkle = 0.35 + 0.65 * Math.abs(Math.sin(time / 900 + star.twinkle));
      draw.fillStyle = `rgba(225,215,255,${twinkle * (0.45 + energy * 0.5) * grown})`;
      draw.fillRect(cx + Math.cos(angle) * distance - dot / 2, cy + Math.sin(angle) * distance - dot / 2, dot, dot);
    }
    // The heart of it: a soft light that swells with the voice.
    const heart = draw.createRadialGradient(cx, cy, 0, cx, cy, core * (0.55 + energy * 0.35));
    heart.addColorStop(0, `rgba(210,190,255,${0.1 + energy * 0.35})`); heart.addColorStop(1, 'rgba(0,0,0,0)');
    draw.fillStyle = heart; draw.beginPath(); draw.arc(cx, cy, core, 0, TAU); draw.fill();
    // The spark that starts it: a point of light that flashes and fades as the body forms around it.
    if (opening < 0.6) {
      const flash = Math.sin(clamp(opening / 0.6) * Math.PI), reach = size * (0.15 + opening * 1.4);
      const spark = draw.createRadialGradient(cx, cy, 0, cx, cy, reach);
      spark.addColorStop(0, `rgba(255,250,255,${0.95 * flash})`); spark.addColorStop(0.12, `rgba(210,180,255,${0.6 * flash})`); spark.addColorStop(1, 'rgba(0,0,0,0)');
      draw.fillStyle = spark; draw.beginPath(); draw.arc(cx, cy, reach, 0, TAU); draw.fill();
    }
  }
  frame = requestAnimationFrame(paint);
  return { destroy() { cancelAnimationFrame(frame); resize.disconnect(); canvas.remove(); } };
}
