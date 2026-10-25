// The sign-in backdrop: you, as a blocky Roblox-style character, at your Rex Desk. The monitors show your issues and an
// agent's conversation, two small bots (your agents) carry tickets from the inbox tray, and an amber sign pops up when
// something waits for you. Built only from boxes, so nothing is downloaded.
import * as THREE from '/vendor/three/three.module.js';

const SKIN = '#f5cd30', HOODIE = '#3b7cf0', PANTS = '#2b3442', DESK = '#a0693c', DESK_TOP = '#b97b47', BASEPLATE = '#5f7f45', METAL = '#3a3f48';

function box(width, height, depth, color, { x = 0, y = 0, z = 0, emissive } = {}) {
  const material = new THREE.MeshLambertMaterial({ color, ...(emissive ? { emissive, emissiveIntensity: 1 } : {}) });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}
const canvasTexture = (width, height, draw) => {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  draw(canvas.getContext('2d'));
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
};
// A canvas drawn like a tiny Rex Desk, used as a monitor's glowing screen.
function screen(width, height, draw) {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 320;
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture }));
  return { mesh, update: tick => { draw(canvas.getContext('2d'), tick); texture.needsUpdate = true; } };
}
const issueRows = ['#38464 Download shows a blank screen', '#48073 Safari menu overlaps title', '#39349 Org chart label (EN)', '#6658 Cahaya → Terang', '#34348 Gmail status button', '#30671 Microsoft sign-in loop', '#32099 Smart search limit', '#26717 Japanese menu text'];
const transcript = ['Reading issue #6658…', '✓ desk_task', 'Opening the test site', '✓ assertText "Terang"', 'Fix works. Recording saved.', 'Next: #39349', '✓ desk_categorize', 'Waiting for your approval'];
function drawIssues(context, tick) {
  context.fillStyle = '#16181d'; context.fillRect(0, 0, 512, 320);
  context.fillStyle = '#4c8dff'; context.fillRect(0, 0, 512, 36);
  context.fillStyle = '#ffffff'; context.font = 'bold 20px sans-serif'; context.fillText('Rex Desk · My issues', 16, 25);
  context.font = '17px sans-serif';
  for (let row = 0; row < 7; row++) {
    const text = issueRows[(row + Math.floor(tick / 6)) % issueRows.length], y = 64 + row * 37;
    context.fillStyle = row === 1 ? '#1f2b3d' : '#16181d'; context.fillRect(8, y - 22, 496, 32);
    context.fillStyle = row % 3 === 2 ? '#e5a100' : '#3fb950'; context.beginPath(); context.arc(24, y - 6, 6, 0, Math.PI * 2); context.fill();
    context.fillStyle = '#e6e8eb'; context.fillText(text, 40, y);
  }
}
function drawAgent(context, tick) {
  context.fillStyle = '#1c1f25'; context.fillRect(0, 0, 512, 320);
  context.fillStyle = '#9aa3b1'; context.font = 'bold 18px sans-serif'; context.fillText('Agent at work', 16, 30);
  context.font = '17px monospace';
  for (let line = 0; line < 7; line++) {
    const text = transcript[(line + Math.floor(tick / 4)) % transcript.length];
    context.fillStyle = text.startsWith('✓') ? '#3fb950' : text.includes('approval') ? '#e5a100' : '#e6e8eb';
    context.fillText(text, 16, 70 + line * 36);
  }
  if (tick % 2) { context.fillStyle = '#4c8dff'; context.fillRect(16, 300, 12, 4); }
}

// You: the classic blocky avatar, sitting at the desk in a Rex Desk-blue hoodie.
function buildAvatar() {
  const avatar = new THREE.Group(), head = new THREE.Group(); head.position.set(0, 3.55, 0);
  const face = canvasTexture(128, 128, context => {
    context.fillStyle = SKIN; context.fillRect(0, 0, 128, 128);
    context.fillStyle = '#1b1b1b'; context.fillRect(38, 44, 12, 20); context.fillRect(78, 44, 12, 20);
    context.lineWidth = 7; context.strokeStyle = '#1b1b1b'; context.beginPath(); context.arc(64, 72, 26, 0.2 * Math.PI, 0.8 * Math.PI); context.stroke();
  });
  const skin = new THREE.MeshLambertMaterial({ color: SKIN }), faceMaterial = new THREE.MeshLambertMaterial({ map: face });
  const headMesh = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.95, 0.95), [skin, skin, skin, skin, faceMaterial, skin]);
  headMesh.castShadow = true; head.add(headMesh); head.add(box(1.0, 0.28, 1.0, '#2a2a2a', { y: 0.5 }));
  avatar.add(head);
  avatar.add(box(1.6, 1.6, 0.8, HOODIE, { y: 2.3 }));
  avatar.add(box(0.7, 0.2, 0.3, '#2c64d4', { y: 2.95, z: -0.45 })); // hood
  const arm = side => {
    const pivot = new THREE.Group(); pivot.position.set(side * 1.05, 3.0, 0);
    const limb = box(0.6, 1.5, 0.6, HOODIE, { y: -0.6 }); limb.add(box(0.6, 0.35, 0.6, SKIN, { y: -0.82 }));
    pivot.add(limb); avatar.add(pivot); return pivot;
  };
  const left = arm(-1), right = arm(1);
  for (const side of [-1, 1]) { avatar.add(box(0.75, 0.55, 1.5, PANTS, { x: side * 0.4, y: 1.25, z: 0.5 })); avatar.add(box(0.75, 1.3, 0.55, PANTS, { x: side * 0.4, y: 0.6, z: 1.05 })); }
  const tag = canvasTexture(256, 64, context => {
    context.fillStyle = 'rgba(0,0,0,0.45)'; context.fillRect(64, 8, 128, 48);
    context.fillStyle = '#ffffff'; context.font = 'bold 32px sans-serif'; context.textAlign = 'center'; context.fillText('You', 128, 43);
  });
  const nameTag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tag, depthTest: false })); nameTag.scale.set(1.6, 0.4, 1); nameTag.position.set(0, 4.85, 0); avatar.add(nameTag);
  return { avatar, head, left, right };
}
function buildDesk() {
  const desk = new THREE.Group();
  desk.add(box(5.6, 0.3, 2.6, DESK_TOP, { y: 2.2 }));
  for (const [x, z] of [[-2.55, -1.1], [2.55, -1.1], [-2.55, 1.1], [2.55, 1.1]]) desk.add(box(0.3, 2.05, 0.3, DESK, { x, y: 1.05, z }));
  // Two monitors: your issues on the left, an agent's conversation on the right.
  const monitors = [];
  for (const [x, draw, turn] of [[-1.25, drawIssues, 0.12], [1.25, drawAgent, -0.12]]) {
    const monitor = new THREE.Group(); monitor.position.set(x, 3.45, -0.7); monitor.rotation.y = turn;
    monitor.add(box(2.3, 1.45, 0.14, METAL)); monitor.add(box(0.25, 0.6, 0.2, METAL, { y: -0.95 })); monitor.add(box(0.9, 0.08, 0.6, METAL, { y: -1.2 }));
    const display = screen(2.12, 1.28, draw); display.mesh.position.z = 0.08; monitor.add(display.mesh);
    desk.add(monitor); monitors.push({ monitor, display });
  }
  desk.add(box(2.0, 0.08, 0.6, '#2f343c', { y: 2.39, z: 0.45 })); // keyboard
  desk.add(box(0.35, 0.08, 0.5, '#2f343c', { x: 1.5, y: 2.39, z: 0.5 })); // mouse
  const mug = box(0.35, 0.45, 0.35, '#e8e3d8', { x: -2.2, y: 2.58, z: 0.6 }); mug.add(box(0.28, 0.02, 0.28, '#5a3a22', { y: 0.22 })); desk.add(mug);
  const plant = new THREE.Group(); plant.position.set(2.35, 2.35, -0.95);
  plant.add(box(0.45, 0.4, 0.45, '#b5583a', { y: 0.2 })); plant.add(box(0.55, 0.55, 0.55, '#3f8f4a', { y: 0.65 })); plant.add(box(0.3, 0.35, 0.3, '#4ea85a', { y: 1.05 })); desk.add(plant);
  const lamp = new THREE.Group(); lamp.position.set(-2.4, 2.35, -1.0);
  lamp.add(box(0.5, 0.08, 0.5, METAL)); lamp.add(box(0.1, 1.0, 0.1, METAL, { y: 0.5 })); lamp.add(box(0.5, 0.25, 0.35, '#e5a100', { y: 1.0, z: 0.15, emissive: '#5a3e00' })); desk.add(lamp);
  // The inbox tray of issue tickets the agents pick up; the amber one on top waits for you.
  const tray = new THREE.Group(); tray.position.set(-2.1, 2.4, -0.15); tray.add(box(0.8, 0.08, 0.6, METAL));
  for (let layer = 0; layer < 3; layer++) tray.add(box(0.62, 0.04, 0.45, layer === 2 ? '#e5a100' : '#f1f3f5', { y: 0.08 + layer * 0.05 }));
  desk.add(tray);
  const chair = new THREE.Group(); chair.position.set(0, 0, 2.1); chair.rotation.y = -0.55;
  chair.add(box(1.7, 0.25, 1.6, '#30363f', { y: 1.0 })); chair.add(box(1.7, 1.9, 0.25, '#30363f', { y: 2.0, z: 0.85 })); chair.add(box(0.2, 1.0, 0.2, METAL, { y: 0.5 })); desk.add(chair);
  return { desk, monitors, tray, chair };
}
// An agent: a small blocky bot with a glowing visor, carrying a ticket from the tray to a monitor.
function buildBot(color) {
  const bot = new THREE.Group();
  bot.add(box(0.55, 0.45, 0.45, '#dfe3e8'));
  bot.add(box(0.42, 0.14, 0.05, color, { y: 0.03, z: 0.24, emissive: color }));
  bot.add(box(0.06, 0.25, 0.06, METAL, { y: 0.35 })); bot.add(box(0.12, 0.12, 0.12, color, { y: 0.5, emissive: color }));
  const ticket = box(0.36, 0.03, 0.28, '#f1f3f5', { y: -0.32 }); bot.add(ticket);
  return { bot, ticket };
}

export function mountLoginScene(canvas) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' }); }
  catch { canvas.hidden = true; return { celebrate: async () => {}, dispose() {} }; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  scene.add(new THREE.HemisphereLight('#ffffff', '#4a5a3a', 1.6));
  const sun = new THREE.DirectionalLight('#ffffff', 2.2); sun.position.set(-6, 12, 8); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024); Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8 }); scene.add(sun);

  const studs = canvasTexture(64, 64, context => {
    context.fillStyle = BASEPLATE; context.fillRect(0, 0, 64, 64);
    context.fillStyle = 'rgba(255,255,255,0.13)'; context.beginPath(); context.arc(32, 32, 16, 0, Math.PI * 2); context.fill();
    context.strokeStyle = 'rgba(0,0,0,0.18)'; context.lineWidth = 3; context.stroke();
  });
  studs.wrapS = studs.wrapT = THREE.RepeatWrapping; studs.repeat.set(11, 9);
  const baseplate = new THREE.Mesh(new THREE.BoxGeometry(11, 0.4, 9), new THREE.MeshLambertMaterial({ map: studs }));
  baseplate.position.y = -0.2; baseplate.receiveShadow = true; scene.add(baseplate);
  const { desk, monitors, tray, chair } = buildDesk(); scene.add(desk);
  const { avatar, head, left, right } = buildAvatar(); avatar.position.set(0, 0.35, 1.9); avatar.rotation.y = Math.PI - 0.55; scene.add(avatar); // turned a little toward you
  const bots = [buildBot('#4c8dff'), buildBot('#b392f0')];
  bots.forEach(({ bot }) => scene.add(bot));
  const alert = new THREE.Group();
  alert.add(box(0.5, 0.9, 0.12, '#e5a100', { emissive: '#7a5600' })); alert.add(box(0.14, 0.42, 0.14, '#1b1b1b', { y: 0.12, z: 0.06 })); alert.add(box(0.14, 0.14, 0.14, '#1b1b1b', { y: -0.25, z: 0.06 }));
  alert.position.set(-0.9, 5.6, 1.9); scene.add(alert);

  const home = new THREE.Vector3(12, 10, 16.5), target = new THREE.Vector3(-0.2, 2.2, 0.2);
  camera.position.copy(home); camera.lookAt(target);
  const pointer = { x: 0, y: 0 }, look = { x: 0, y: 0 };
  const onPointer = event => { pointer.x = event.clientX / innerWidth - 0.5; pointer.y = event.clientY / innerHeight - 0.5; };
  addEventListener('pointermove', onPointer, { passive: true });
  let wide = false;
  const resize = () => {
    const { clientWidth: width, clientHeight: height } = canvas;
    renderer.setSize(width, height, false); camera.aspect = width / Math.max(1, height);
    // On wide screens the desk sits to the right of the sign-in card.
    wide = width > 900;
    // On narrow screens the card sits low and the desk shows above it.
    if (wide) camera.setViewOffset(width, height, -width * 0.2, 0, width, height); else camera.setViewOffset(width, height, 0, height * 0.17, width, height);
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize); observer.observe(canvas); resize();

  const timer = new THREE.Timer(); let tick = 0, lastTick = -1, celebrating = null, lastFrame = 0;
  const position = new THREE.Vector3(), from = new THREE.Vector3(-2.1, 3.2, -0.15);
  // A backdrop does not need 60 fps: 30 halves the CPU and GPU work. The sign-in fly-in still runs every frame.
  const frame = now => {
    if (now && !celebrating && now - lastFrame < 32) return;
    lastFrame = now || 0;
    timer.update(); const time = timer.getElapsed();
    // You type, and your head turns toward the pointer.
    look.x += (pointer.y * 0.35 - look.x) * 0.06; look.y += (-pointer.x * 0.9 - look.y) * 0.06;
    head.rotation.set(look.x, look.y, 0);
    // A 12-second routine: type at the desk, swivel around to face you and wave, then go back to work.
    const turn = Math.atan2(home.x, home.z - 1.9), working = Math.PI - 0.55;
    const cycle = reduced ? 9 : time % 12, swivel = cycle < 7 ? 0 : cycle < 8 ? cycle - 7 : cycle < 11 ? 1 : 12 - cycle;
    const eased = swivel * swivel * (3 - 2 * swivel), facing = working + (turn + Math.PI * 2 - working) * eased;
    if (!celebrating) {
      avatar.rotation.y = facing; chair.rotation.y = facing - Math.PI;
      const typing = 1 - eased, waving = cycle > 8 && cycle < 9.6;
      left.rotation.set((-1.25 + Math.sin(time * 14) * 0.08) * typing - 0.15 * eased, 0, 0);
      right.rotation.set(waving ? 0 : (-1.25 + Math.sin(time * 14 + 1.7) * 0.08) * typing - 0.15 * eased, 0, waving ? Math.PI * 0.85 + Math.sin(time * 12) * 0.3 : 0);
    }
    // Each agent flies from the inbox tray to a monitor and back, carrying a ticket on the way out.
    bots.forEach(({ bot, ticket }, index) => {
      const phase = (time * 0.18 + index * 0.5) % 1, out = phase < 0.5, t = out ? phase * 2 : (1 - phase) * 2, eased = t * t * (3 - 2 * t);
      const to = monitors[index].monitor.position.clone().add(new THREE.Vector3(index ? 1.4 : -1.4, 0.6, 0.6));
      position.lerpVectors(from, to, eased); position.y += Math.sin(t * Math.PI) * 0.9 + Math.sin(time * 3 + index) * 0.06;
      bot.position.copy(position); bot.rotation.y = out ? (index ? -0.6 : 0.6) : (index ? 2.5 : -2.5);
      ticket.visible = out;
    });
    tray.children.at(-1).visible = Math.sin(time * 0.6) > -0.3;
    // Something needs you: the amber sign bobs above your head.
    alert.visible = Math.sin(time * 0.5) > -0.2; alert.position.y = 5.6 + Math.sin(time * 3) * 0.12; alert.rotation.y = time * 1.2;
    if (time - lastTick > 0.45) { lastTick = time; tick++; monitors.forEach(({ display }) => display.update(tick)); }
    if (celebrating) {
      const t = Math.min(1, (performance.now() - celebrating.start) / celebrating.duration);
      avatar.rotation.y = Math.atan2(home.x, home.z - 1.9); chair.rotation.y = avatar.rotation.y - Math.PI;
      right.rotation.set(0, 0, Math.PI * 0.85 + Math.sin(t * Math.PI * 6) * 0.25); // turn to you and wave
      if (t > 0.35) {
        const fly = (t - 0.35) / 0.65, eased = fly * fly * (3 - 2 * fly), screenAt = monitors[0].monitor.getWorldPosition(new THREE.Vector3());
        if (camera.view?.enabled) { camera.clearViewOffset(); camera.updateProjectionMatrix(); }
        camera.position.lerpVectors(home, screenAt.clone().add(new THREE.Vector3(0.3, 0.05, 2.0)), eased);
        camera.lookAt(target.clone().lerp(screenAt, eased));
      }
      if (t >= 1) celebrating.done();
    }
    renderer.render(scene, camera);
  };
  const run = () => renderer.setAnimationLoop(celebrating || (!reduced && !document.hidden && document.hasFocus()) ? frame : null);
  const onVisibility = () => run();
  document.addEventListener('visibilitychange', onVisibility); addEventListener('focus', onVisibility); addEventListener('blur', onVisibility);
  frame(); run();

  return {
    // After sign-in you wave, and the camera flies into your monitor as the workspace opens.
    celebrate: () => reduced ? Promise.resolve() : new Promise(done => { celebrating = { start: performance.now(), duration: 1100, done }; renderer.setAnimationLoop(frame); }),
    dispose() {
      renderer.setAnimationLoop(null); observer.disconnect(); removeEventListener('pointermove', onPointer); document.removeEventListener('visibilitychange', onVisibility); removeEventListener('focus', onVisibility); removeEventListener('blur', onVisibility);
      scene.traverse(object => { object.geometry?.dispose(); [object.material].flat().forEach(material => { material?.map?.dispose(); material?.dispose(); }); });
      renderer.dispose();
    },
  };
}
