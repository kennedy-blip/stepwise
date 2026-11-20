/**
 * Offline Three.js sanity check.
 *
 * Verifies that the Three.js scene graph, geometry and texture machinery
 * behave as expected outside a browser, which lets the 3D layer be validated
 * in CI without a GPU.
 *
 * It also drives the real 3D modules against the real simulation, so a
 * regression in the simulation-to-scene contract is caught here even when
 * no browser is available.
 */
import * as THREE from 'three';
import { World } from '../src/game/world';
import { Camera3D } from '../src/render3d/camera3d';
import { LightingRig } from '../src/render3d/lighting3d';
import { World3D } from '../src/render3d/world3d';
import { Humanoid3D } from '../src/render3d/humanoid3d';
import { DEPTH, simX, simY } from '../src/render3d/units';

let failures = 0;
function check(label: string, ok: boolean): void {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
}

const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 400);
const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
scene.add(mesh);
mesh.position.set(10, 2, 0);
mesh.updateMatrixWorld(true);

console.log('Three revision:', THREE.REVISION);
console.log('scene children:', scene.children.length);
console.log('world position:', mesh.getWorldPosition(new THREE.Vector3()).toArray().join(','));
console.log('matrixWorld ok:', mesh.matrixWorld.elements[12] === 10);
console.log('fov:', cam.fov);
console.log('');

check('revision is 170', THREE.REVISION === '170');
check('world transform applied', mesh.matrixWorld.elements[12] === 10);

// ---------------------------------------------------------------------------
// The real pipeline: simulation -> 3D scene.
// ---------------------------------------------------------------------------
const world = new World({ difficulty: 'medium', seed: 20240 });
world.start();

const world3d = new World3D();
world3d.build();
const humanoid = new Humanoid3D();
const rig = new LightingRig(scene);
const camera = new Camera3D(16 / 9);

for (let i = 0; i < 120; i++) {
  world.update(1 / 60);
  world3d.sync(world.terrain, world.player.x);
  humanoid.update(world.player.rig, world.flow.tier);
  camera.update(world.player.x, world.player.y, world.flow.tier, 1 / 60);
  rig.followSun(world.player.x, world.player.y);
}
rig.apply('dusk');

function countMeshes(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) n++;
  });
  return n;
}

let nan = 0;
scene.traverse((o) => {
  const p = o.position;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) nan++;
});

check('rooftops were built', countMeshes(world3d.group) > 0);
check('runner was built', countMeshes(humanoid.group) >= 14);
check('no NaN transforms in the scene', nan === 0);
check('camera has a valid transform', Number.isFinite(camera.camera.position.x));

// The runner must sit left of centre on screen.
camera.camera.updateMatrixWorld(true);
const runnerNdc = new THREE.Vector3(
  simX(world.player.x),
  simY(world.player.y),
  0,
).project(camera.camera);
const screenX = (runnerNdc.x + 1) / 2;
console.log('runner screen x:', screenX.toFixed(3));
check('runner sits left of centre', screenX > 0.1 && screenX < 0.45);

// The play plane must be exactly Z = 0.
const slabMeshes = world3d.group.children.filter((c) => c instanceof THREE.Mesh);
check('rooftops are on the Z = 0 plane', slabMeshes.every((m) => m.position.z === 0));
check('playable depth is symmetric', DEPTH.playableHalf === 1.3);
check('parapet sits just inside the play plane', DEPTH.parapet < DEPTH.playableHalf);
check('near city is behind the play plane', DEPTH.nearBack.near < 0 && DEPTH.nearBack.far < DEPTH.nearBack.near);
check('skyline is behind the near city', DEPTH.deepSkyline.near < DEPTH.nearBack.far);

// Metres-per-pixel conversion must round-trip.
const px = 1234;
check('pixel->metre conversion round-trips', Math.abs(simX(px) * 40 - px) < 1e-6);
check('Y axis is inverted', simY(0) === 0 && simY(100) < simY(0));

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('All Three.js checks passed.');
