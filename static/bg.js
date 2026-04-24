// 3D CAD-style animated background using Three.js.
// Renders a rotating wireframe isocahedron + orbiting gears for a blueprint vibe.
import * as THREE from 'three';

const canvas = document.getElementById('bg');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
camera.position.z = 8;

const fit = () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
};
fit();
window.addEventListener('resize', fit);

// Colors drawn from praFMT palette to match the brand
const C_ACCENT = 0xad0021;
const C_PINK = 0xedb1bc;
const C_ORANGE = 0xe07b00;
const C_GREEN = 0x3c7a4a;

// Central wireframe isocahedron — the "part" of the CAD drawing
const coreGeom = new THREE.IcosahedronGeometry(1.6, 1);
const coreEdges = new THREE.EdgesGeometry(coreGeom);
const coreMat = new THREE.LineBasicMaterial({
  color: C_PINK,
  transparent: true,
  opacity: 0.55,
});
const core = new THREE.LineSegments(coreEdges, coreMat);
scene.add(core);

// Inner solid shell (subtle, glows through the wireframe)
const innerGeom = new THREE.IcosahedronGeometry(1.55, 1);
const innerMat = new THREE.MeshBasicMaterial({
  color: C_ACCENT,
  transparent: true,
  opacity: 0.08,
});
const inner = new THREE.Mesh(innerGeom, innerMat);
scene.add(inner);

// Orbiting torus rings — blueprint overlays
const rings = [];
const ringConfigs = [
  { r: 2.6, tube: 0.012, color: C_ORANGE, tilt: [0.5, 0.2, 0], speed: 0.3 },
  { r: 3.1, tube: 0.010, color: C_PINK, tilt: [-0.3, 0.6, 0.2], speed: -0.22 },
  { r: 3.7, tube: 0.008, color: C_GREEN, tilt: [0.8, -0.4, 0.1], speed: 0.18 },
];
for (const cfg of ringConfigs) {
  const g = new THREE.TorusGeometry(cfg.r, cfg.tube, 8, 128);
  const m = new THREE.MeshBasicMaterial({ color: cfg.color, transparent: true, opacity: 0.45 });
  const torus = new THREE.Mesh(g, m);
  torus.rotation.set(...cfg.tilt);
  torus.userData = cfg;
  scene.add(torus);
  rings.push(torus);
}

// Floating satellite cubes on the outer orbit
const satellites = [];
for (let i = 0; i < 8; i++) {
  const size = 0.08 + Math.random() * 0.06;
  const g = new THREE.BoxGeometry(size, size, size);
  const e = new THREE.EdgesGeometry(g);
  const m = new THREE.LineBasicMaterial({
    color: i % 2 === 0 ? C_PINK : C_ORANGE,
    transparent: true,
    opacity: 0.7,
  });
  const box = new THREE.LineSegments(e, m);
  const angle = (i / 8) * Math.PI * 2;
  box.userData = { angle, radius: 4 + Math.random() * 0.6, yOff: (Math.random() - 0.5) * 1.5, speed: 0.15 + Math.random() * 0.2 };
  scene.add(box);
  satellites.push(box);
}

// Starfield for depth
const starCount = 160;
const starGeom = new THREE.BufferGeometry();
const starPositions = new Float32Array(starCount * 3);
for (let i = 0; i < starCount; i++) {
  starPositions[i * 3]     = (Math.random() - 0.5) * 30;
  starPositions[i * 3 + 1] = (Math.random() - 0.5) * 30;
  starPositions[i * 3 + 2] = (Math.random() - 0.5) * 30 - 5;
}
starGeom.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
const starMat = new THREE.PointsMaterial({
  color: 0xedb1bc,
  size: 0.04,
  transparent: true,
  opacity: 0.5,
});
const stars = new THREE.Points(starGeom, starMat);
scene.add(stars);

// Parallax via pointer/device orientation
let targetX = 0, targetY = 0;
window.addEventListener('pointermove', (e) => {
  targetX = (e.clientX / window.innerWidth - 0.5) * 0.6;
  targetY = (e.clientY / window.innerHeight - 0.5) * 0.4;
});
window.addEventListener('deviceorientation', (e) => {
  if (e.gamma != null && e.beta != null) {
    targetX = Math.max(-1, Math.min(1, e.gamma / 45)) * 0.5;
    targetY = Math.max(-1, Math.min(1, (e.beta - 40) / 45)) * 0.35;
  }
}, true);

let t0 = performance.now();
function tick() {
  const now = performance.now();
  const dt = (now - t0) / 1000;
  t0 = now;
  const t = now / 1000;

  // Ease camera toward target (parallax)
  camera.position.x += (targetX * 1.2 - camera.position.x) * 0.04;
  camera.position.y += (-targetY * 1.0 - camera.position.y) * 0.04;
  camera.lookAt(0, 0, 0);

  core.rotation.x += dt * 0.15;
  core.rotation.y += dt * 0.22;
  inner.rotation.copy(core.rotation);

  for (const ring of rings) {
    ring.rotation.z += dt * ring.userData.speed;
    ring.rotation.x += dt * ring.userData.speed * 0.4;
  }

  for (const sat of satellites) {
    const u = sat.userData;
    u.angle += dt * u.speed;
    sat.position.set(
      Math.cos(u.angle) * u.radius,
      u.yOff + Math.sin(u.angle * 1.3) * 0.2,
      Math.sin(u.angle) * u.radius
    );
    sat.rotation.x = t * 0.5;
    sat.rotation.y = t * 0.7;
  }

  stars.rotation.y += dt * 0.015;

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

// Pause rendering when tab is hidden to save battery on mobile
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    renderer.setAnimationLoop(null);
  } else {
    t0 = performance.now();
  }
});
