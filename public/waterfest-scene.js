// Bon Om Touk (the Khmer Water Festival) on the Tonle Sap at night, drawn in the background behind the app.
// A full moon for the moon salute, the Royal Palace riverfront in silhouette, illuminated floats (Loy Pratip),
// dragon racing boats with their naga prow and rows of paddlers, lanterns drifting on the water and rising into
// the sky, and far fireworks over the river. Built only from boxes and canvas textures, so nothing is downloaded.
// It lives in .skin-fx (behind every panel), paused when hidden, idled when still, and held as one frame when the
// person asks for less motion.
import * as THREE from '/vendor/three/three.module.js';

const GOLD = '#e9b949', AMBER = '#ff9d4d', RIVER = '#122b44', HULL = '#241a12', HULL2 = '#3a2a18', NAGA = '#c9962f', PADDLE = '#d8c08a';

function box(w, h, d, color, { x = 0, y = 0, z = 0, emissive, emissiveIntensity = 1 } = {}) {
  const material = emissive
    ? new THREE.MeshBasicMaterial({ color: emissive })
    : new THREE.MeshLambertMaterial({ color });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  return mesh;
}
function glowSprite(color, size, opacity = 1) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, color); grad.addColorStop(0.35, color); grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.beginPath(); g.arc(32, 32, 32, 0, Math.PI * 2); g.fill();
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending }));
  sprite.scale.set(size, size, 1); return sprite;
}

// The Royal Palace riverfront: tiered Khmer roofs with chofa finials, a dark silhouette with warm windows, on the far bank.
function palaceTexture() {
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 256;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, 1024, 256);
  const roof = (cx, base, w, tiers, h) => {
    g.fillStyle = '#0a0f17';
    for (let i = 0; i < tiers; i++) {
      const tw = w * (1 - i * 0.18), ty = base - i * h * 0.62;
      g.beginPath();
      g.moveTo(cx - tw / 2, ty);
      g.lineTo(cx - tw * 0.16, ty - h);
      g.lineTo(cx, ty - h * 1.16);
      g.lineTo(cx + tw * 0.16, ty - h);
      g.lineTo(cx + tw / 2, ty);
      g.closePath(); g.fill();
      // chofa upticks at the eaves
      g.strokeStyle = '#0a0f17'; g.lineWidth = 3; g.lineCap = 'round';
      g.beginPath(); g.moveTo(cx - tw / 2, ty); g.quadraticCurveTo(cx - tw / 2 - 8, ty - 10, cx - tw / 2 - 2, ty - 20); g.stroke();
      g.beginPath(); g.moveTo(cx + tw / 2, ty); g.quadraticCurveTo(cx + tw / 2 + 8, ty - 10, cx + tw / 2 + 2, ty - 20); g.stroke();
    }
    // central spire
    g.beginPath(); g.moveTo(cx - 4, base - tiers * h * 0.62); g.lineTo(cx, base - tiers * h * 0.62 - h * 0.9); g.lineTo(cx + 4, base - tiers * h * 0.62); g.closePath(); g.fill();
    // windows glowing warm
    g.fillStyle = 'rgba(233,185,73,0.85)';
    for (let wx = cx - w * 0.3; wx <= cx + w * 0.3; wx += 16) g.fillRect(wx, base - 22, 5, 12);
  };
  // base wall
  g.fillStyle = '#0a0f17'; g.fillRect(0, 196, 1024, 60);
  roof(250, 196, 150, 3, 34);
  roof(512, 190, 210, 4, 44);
  roof(774, 196, 150, 3, 34);
  // smaller halls between
  roof(130, 200, 90, 2, 24); roof(390, 200, 90, 2, 24); roof(634, 200, 90, 2, 24); roof(900, 200, 90, 2, 24);
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; return tex;
}

// Gentle ripples plus the lantern-and-moon light path streaked across the river.
function waterTexture() {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
  const g = canvas.getContext('2d');
  g.fillStyle = RIVER; g.fillRect(0, 0, 512, 512);
  g.globalAlpha = 0.5;
  for (let i = 0; i < 90; i++) {
    const y = Math.random() * 512, w = 20 + Math.random() * 120, x = Math.random() * 512;
    g.strokeStyle = `rgba(120,170,210,${0.04 + Math.random() * 0.08})`; g.lineWidth = 1 + Math.random() * 1.5;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + w / 2, y - 3, x + w, y); g.stroke();
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(6, 6); return tex;
}

// A dragon racing boat (pirogue): a long low hull, an upturned naga prow and tail, two rows of paddlers.
function buildBoat(light) {
  const boat = new THREE.Group();
  const hull = new THREE.Group();
  hull.add(box(7.2, 0.45, 0.9, HULL, { y: 0 }));
  hull.add(box(7.2, 0.28, 1.0, HULL2, { y: 0.28 }));
  // upturned naga prow (front, +x) and tail (back, -x)
  for (const dir of [1, -1]) {
    const tip = new THREE.Group(); tip.position.set(dir * 3.7, 0.1, 0);
    tip.add(box(0.7, 0.32, 0.7, HULL2, {}));
    tip.add(box(0.5, 0.4, 0.5, NAGA, { x: dir * 0.4, y: 0.5 }));
    tip.add(box(0.36, 0.5, 0.36, NAGA, { x: dir * 0.7, y: 1.0 }));
    tip.add(box(0.3, 0.3, 0.3, NAGA, { x: dir * 0.95, y: 1.45 }));
    tip.add(box(0.5, 0.18, 0.18, GOLD, { x: dir * 1.2, y: 1.6, emissive: GOLD }));
    hull.add(tip);
  }
  boat.add(hull);
  // paddlers: two rows of small figures
  const paddlers = [];
  for (let i = 0; i < 9; i++) for (const side of [-1, 1]) {
    const p = new THREE.Group(); p.position.set(-3 + i * 0.75, 0.55, side * 0.26);
    p.add(box(0.26, 0.5, 0.26, '#2a3a52', { y: 0.25 }));        // body
    p.add(box(0.2, 0.2, 0.2, '#caa96a', { y: 0.58 }));          // head
    const arm = box(0.1, 0.44, 0.1, PADDLE, { y: 0.44, z: side * 0.18 });
    arm.geometry.translate(0, -0.22, 0); arm.position.y = 0.6; arm.position.z = side * 0.2;
    p.add(arm);
    boat.add(p); paddlers.push({ arm, phase: i * 0.5 });
  }
  const lantern = glowSprite(light, 1.4, 0.9); lantern.position.set(3.4, 1.9, 0); boat.add(lantern);
  const reflect = glowSprite(light, 2.4, 0.25); reflect.position.set(0, -0.3, 0); boat.add(reflect);
  return { boat, paddlers };
}

// An illuminated float (Loy Pratip): a lit barge far on the river, warm outline and a mirror of light below.
function buildFloat(x, z) {
  const group = new THREE.Group(); group.position.set(x, 0.1, z);
  const frame = box(3.2, 1.6, 0.3, AMBER, { y: 0.9, emissive: AMBER });
  frame.material.opacity = 0.9; frame.material.transparent = true; group.add(frame);
  const inner = box(2.6, 1.1, 0.34, '#1a1206', { y: 0.9 }); group.add(inner);
  for (let i = 0; i < 6; i++) group.add(box(0.12, 0.12, 0.36, GOLD, { x: -1.2 + i * 0.48, y: 1.35, emissive: GOLD }));
  const glow = glowSprite(AMBER, 4, 0.5); glow.position.set(0, 1, 0.2); group.add(glow);
  const reflect = glowSprite(AMBER, 5, 0.22); reflect.position.set(0, -0.6, 0); group.add(reflect);
  return group;
}

export function mountWaterFestival(canvas) {
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motionQuery.matches;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' }); }
  catch { canvas.hidden = true; return { dispose() {} }; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
  camera.position.set(0, 7.5, 34); camera.lookAt(0, 4, -30);

  // Night: a dim cool sky above, a faint warm bounce off the water below.
  scene.add(new THREE.HemisphereLight('#2a3a55', '#1a120a', 1.1));
  const moonLight = new THREE.DirectionalLight('#cdddf2', 0.9); moonLight.position.set(6, 16, 10); scene.add(moonLight);

  // The moon, high over the river, with a soft halo for the moon salute.
  const moon = glowSprite('#f3ead2', 9, 0.95); moon.position.set(12, 20, -70); scene.add(moon);
  const moonHalo = glowSprite('#bcd0ea', 20, 0.18); moonHalo.position.set(12, 20, -71); scene.add(moonHalo);
  const moonCore = new THREE.Mesh(new THREE.CircleGeometry(3.2, 32), new THREE.MeshBasicMaterial({ color: '#fbf4df' }));
  moonCore.position.set(12, 20, -69.5); scene.add(moonCore);

  // The Royal Palace on the far bank.
  const palaceTex = palaceTexture();
  const palace = new THREE.Mesh(new THREE.PlaneGeometry(160, 40), new THREE.MeshBasicMaterial({ map: palaceTex, transparent: true }));
  palace.position.set(0, 9, -78); scene.add(palace);

  // The river: a wide plane with a gentle wave and a slow-scrolling ripple texture.
  const waterTex = waterTexture();
  const waterGeo = new THREE.PlaneGeometry(400, 220, 40, 24);
  const water = new THREE.Mesh(waterGeo, new THREE.MeshLambertMaterial({ map: waterTex, color: '#1a3a58' }));
  water.rotation.x = -Math.PI / 2; water.position.set(0, 0, -40); scene.add(water);
  const base = waterGeo.attributes.position.array.slice();
  // moonlight path on the water
  const moonPath = glowSprite('#cfe0f2', 34, 0.16); moonPath.position.set(11, 0.05, -30); moonPath.scale.set(10, 44, 1); scene.add(moonPath);

  // Illuminated floats, far on the river.
  [buildFloat(-26, -58), buildFloat(22, -52), buildFloat(-6, -64)].forEach(f => scene.add(f));

  // Dragon racing boats, racing across the river at different depths.
  const boats = [
    { ...buildBoat(GOLD), x: -34, z: -16, speed: 7.4, bob: 0 },
    { ...buildBoat('#ff9d4d'), x: -58, z: -26, speed: 6.2, bob: 1.3 },
    { ...buildBoat('#7fd0ff'), x: -20, z: -36, speed: 5.2, bob: 2.4 },
  ];
  boats.forEach(b => { b.boat.position.set(b.x, 0.4, b.z); scene.add(b.boat); });

  // Lanterns: some drift on the water, some rise slowly into the sky.
  const lanterns = [];
  for (let i = 0; i < 22; i++) {
    const rising = i % 3 === 0;
    const s = glowSprite(i % 2 ? GOLD : AMBER, rising ? 1.0 : 0.8, rising ? 0.9 : 0.75);
    const x = -60 + Math.random() * 120, z = -20 - Math.random() * 45;
    s.position.set(x, rising ? 1 + Math.random() * 10 : 0.5, z);
    scene.add(s);
    lanterns.push({ s, rising, x, z, base: s.position.y, speed: 0.25 + Math.random() * 0.4, sway: Math.random() * Math.PI * 2, rise: Math.random() * 20 });
  }

  // Fireworks: an occasional, far, gold burst over the river.
  const bursts = [];
  const spawnBurst = () => {
    const count = 90, geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3), vel = [];
    const ox = -30 + Math.random() * 60, oy = 24 + Math.random() * 10, oz = -62 - Math.random() * 10;
    for (let i = 0; i < count; i++) {
      pos[i * 3] = ox; pos[i * 3 + 1] = oy; pos[i * 3 + 2] = oz;
      const a = Math.random() * Math.PI * 2, e = Math.acos(2 * Math.random() - 1), sp = 4 + Math.random() * 5;
      vel.push([Math.sin(e) * Math.cos(a) * sp, Math.cos(e) * sp, Math.sin(e) * Math.sin(a) * sp * 0.4]);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const color = Math.random() < 0.5 ? 0xffd27a : 0xff9d4d;
    const mat = new THREE.PointsMaterial({ color, size: 0.6, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending });
    const pts = new THREE.Points(geo, mat); scene.add(pts);
    bursts.push({ pts, vel, born: 0, life: 2.4 });
  };

  let wide = false;
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h);
    wide = w > 820;
    camera.position.set(0, wide ? 7.5 : 9, wide ? 34 : 40);
    camera.lookAt(0, wide ? 4 : 5, -30);
    camera.updateProjectionMatrix();
    // With less motion the animation loop is off, so a resize would leave the cleared canvas blank: redraw the still frame.
    if (reduced) renderer.render(scene, camera);
  };
  const observer = new ResizeObserver(resize); observer.observe(canvas); resize();

  const timer = new THREE.Timer();
  let lastFrame = 0, nextBurst = 4, last = 0, idle = 0, lastActive = performance.now();
  const wake = () => { lastActive = performance.now(); };
  addEventListener('pointermove', wake, { passive: true });

  const frame = now => {
    // 30 fps normally; drop to ~15 fps when the window has been still for a while.
    idle = (now - lastActive) > 12000 ? 66 : 33;
    if (now && now - lastFrame < idle) return;
    lastFrame = now || 0;
    timer.update(); const time = timer.getElapsed(), dt = Math.min(0.1, time - last); last = time;

    // Gentle water: a slow wave over the plane and a drifting ripple texture.
    const pos = waterGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const bx = base[i * 3], by = base[i * 3 + 1];
      pos.array[i * 3 + 2] = Math.sin(bx * 0.08 + time * 0.8) * 0.35 + Math.cos(by * 0.1 - time * 0.6) * 0.3;
    }
    pos.needsUpdate = true;
    waterTex.offset.x = time * 0.006; waterTex.offset.y = -time * 0.01;

    // Boats race across the river; the paddlers stroke in time, the hull bobs.
    boats.forEach(b => {
      b.boat.position.x += b.speed * dt;
      if (b.boat.position.x > 72) b.boat.position.x = -72;
      b.boat.position.y = 0.4 + Math.sin(time * 1.6 + b.bob) * 0.12;
      b.boat.rotation.z = Math.sin(time * 1.6 + b.bob) * 0.025;
      b.paddlers.forEach(p => { p.arm.rotation.x = Math.sin(time * 4 + p.phase) * 0.7 - 0.2; });
    });

    // Lanterns sway; the rising ones climb and fade, then start again low.
    lanterns.forEach(l => {
      l.s.position.x = l.x + Math.sin(time * 0.3 + l.sway) * 1.2;
      if (l.rising) {
        l.s.position.y += l.speed * dt;
        if (l.s.position.y > 26) { l.s.position.y = 1; }
        l.s.material.opacity = Math.max(0.1, 0.9 - l.s.position.y / 34);
      } else {
        l.s.position.y = l.base + Math.sin(time * 0.8 + l.sway) * 0.12;
      }
    });

    // Fireworks: spawn now and then, each burst rises and fades.
    if (time > nextBurst) { spawnBurst(); nextBurst = time + 5 + Math.random() * 6; }
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i]; b.born += dt; const k = b.born / b.life;
      const arr = b.pts.geometry.attributes.position.array;
      for (let j = 0; j < b.vel.length; j++) {
        arr[j * 3] += b.vel[j][0] * dt; arr[j * 3 + 1] += (b.vel[j][1] - b.born * 6) * dt; arr[j * 3 + 2] += b.vel[j][2] * dt;
      }
      b.pts.geometry.attributes.position.needsUpdate = true;
      b.pts.material.opacity = Math.max(0, 1 - k);
      if (k >= 1) { scene.remove(b.pts); b.pts.geometry.dispose(); b.pts.material.dispose(); bursts.splice(i, 1); }
    }

    renderer.render(scene, camera);
  };

  const run = () => renderer.setAnimationLoop(!reduced && !document.hidden && document.hasFocus() ? frame : null);
  const onVisibility = () => run();
  document.addEventListener('visibilitychange', onVisibility); addEventListener('focus', onVisibility); addEventListener('blur', onVisibility);

  // One held frame for less-motion: boats parked mid-river, drawn once.
  const stillFrame = () => { boats.forEach(b => { b.boat.position.x = b.x + 40; }); renderer.render(scene, camera); };
  // Start, stop or hold the scene for the current motion setting; re-run when the person changes that setting.
  const applyMotion = () => { reduced = motionQuery.matches; if (reduced) { renderer.setAnimationLoop(null); stillFrame(); } else { frame(0); run(); } };
  motionQuery.addEventListener('change', applyMotion);
  applyMotion();

  return {
    dispose() {
      renderer.setAnimationLoop(null); observer.disconnect();
      motionQuery.removeEventListener('change', applyMotion);
      removeEventListener('pointermove', wake);
      document.removeEventListener('visibilitychange', onVisibility); removeEventListener('focus', onVisibility); removeEventListener('blur', onVisibility);
      bursts.forEach(b => { b.pts.geometry.dispose(); b.pts.material.dispose(); });
      scene.traverse(object => { object.geometry?.dispose(); [object.material].flat().forEach(m => { m?.map?.dispose(); m?.dispose(); }); });
      renderer.dispose();
    },
  };
}
