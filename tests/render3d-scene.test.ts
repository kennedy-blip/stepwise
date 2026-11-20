/**
 * Integration tests for the 3D presentation layer.
 *
 * These tests drive the actual `World3D`, `Humanoid3D` and `Camera3D` modules
 * with the real simulation state, so they catch the class of bug that unit
 * tests miss: a mismatch between what the simulation says and what the 3D
 * layer projects.
 *
 * A real WebGL context is not needed, because the modules under test build
 * scene-graph objects rather than issuing draw calls.
 */

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import * as THREE from 'three';
import { installDom } from './helpers/dom';

// The 3D modules build scene-graph objects and procedural canvas textures,
// so they need a DOM. happy-dom provides one without a GPU; the canvas 2D
// context is stubbed so texture generation and the 2D fallback both work.
const dom = installDom();
afterAll(() => dom.cleanup());

import { World } from '../src/game/world';
import { World3D } from '../src/render3d/world3d';
import { Humanoid3D } from '../src/render3d/humanoid3d';
import { Camera3D } from '../src/render3d/camera3d';
import { LightingRig, LIGHTING_PRESETS } from '../src/render3d/lighting3d';
import { DEPTH, simX, simY } from '../src/render3d/units';
import { isWebGLAvailable, createPresenter, initPresenter } from '../src/render3d/presenter';

/** Counts the meshes currently attached to a group. */
function countMeshes(group: THREE.Object3D): number {
  let n = 0;
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) n++;
  });
  return n;
}

describe('World3D — rooftop geometry', () => {
  let world: World;
  let world3d: World3D;

  beforeEach(() => {
    world = new World({ difficulty: 'medium', seed: 4242 });
    world.start();
    world3d = new World3D();
    world3d.build();
  });

  it('projects every simulation slab into a 3D mesh', () => {
    world3d.sync(world.terrain, world.player.x);
    const visible = countMeshes(world3d.group);
    expect(visible).toBeGreaterThan(0);
    // There must be at least one mesh per slab plus the background city.
    expect(visible).toBeGreaterThanOrEqual(world.terrain.slabs.length);
  });

  it('places every rooftop on the Z = 0 traversal plane', () => {
    world3d.sync(world.terrain, world.player.x);
    const slabMeshes: THREE.Mesh[] = [];
    world3d.group.children.forEach((child) => {
      if (child instanceof THREE.Mesh) slabMeshes.push(child);
    });
    expect(slabMeshes.length).toBeGreaterThan(0);
    for (const mesh of slabMeshes) {
      expect(mesh.position.z).toBe(0);
    }
  });

  it('extrudes rooftops to the specified depth', () => {
    world3d.sync(world.terrain, world.player.x);
    const mesh = world3d.group.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh;
    expect(mesh.scale.z).toBeCloseTo(DEPTH.playableHalf * 2, 5);
  });

  it('converts simulation pixels to scene metres', () => {
    world3d.sync(world.terrain, world.player.x);
    const mesh = world3d.group.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh;
    // The first slab's X centre in metres must match the pixel value.
    const slab = world.terrain.slabs[0];
    const expected = simX(slab.x + slab.w / 2);
    expect(mesh.position.x).toBeCloseTo(expected, 5);
  });

  it('keeps the background city behind the playable lane', () => {
    world3d.sync(world.terrain, world.player.x);
    // Background towers live inside a positioned group, so their WORLD z is
    // what matters: every tower must sit behind the Z = 0 play plane.
    const city = world3d.group.children.find((c) => c.type === 'Group') as THREE.Group;
    expect(city).toBeDefined();
    city.updateMatrixWorld(true);
    let checked = 0;
    city.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const worldZ = obj.getWorldPosition(new THREE.Vector3()).z;
        expect(worldZ).toBeLessThan(0);
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(0);
  });

  it('builds 3D props for the simulation hazards', () => {
    // The medium generator emits pipes, planks and glass.
    expect(world.terrain.hazards.length).toBeGreaterThan(0);
    world3d.sync(world.terrain, world.player.x);
    const propGroups = world3d.group.children.filter(
      (c) => c instanceof THREE.Group && c.userData.hazard,
    );
    expect(propGroups.length).toBe(world.terrain.hazards.length);
  });

  it('pools geometry so the buffer count stays bounded', () => {
    // Scroll a long way: the number of distinct geometry buffers must not
    // grow with the number of props, or long runs would stutter on GC.
    for (let i = 0; i < 600; i++) {
      world.update(1 / 60);
      world3d.sync(world.terrain, world.player.x);
    }
    const pool = (world3d as unknown as { geometryPool: Map<string, unknown> }).geometryPool;
    expect(pool.size).toBeLessThanOrEqual(8);

    // The pool must actually be in use.
    const groups = (world3d as unknown as { hazardGroups: Map<unknown, THREE.Group> })
      .hazardGroups;
    expect(groups.size).toBeGreaterThan(0);
  });

  it('does not accumulate meshes when synced repeatedly', () => {
    world3d.sync(world.terrain, world.player.x);
    const first = countMeshes(world3d.group);
    world3d.sync(world.terrain, world.player.x);
    world3d.sync(world.terrain, world.player.x);
    expect(countMeshes(world3d.group)).toBe(first);
  });
});

describe('Humanoid3D — articulated runner', () => {
  let world: World;
  let humanoid: Humanoid3D;

  beforeEach(() => {
    world = new World({ difficulty: 'medium', seed: 4242 });
    world.start();
    humanoid = new Humanoid3D();
  });

  it('builds the full anatomical hierarchy', () => {
    // Pelvis, torso, neck/head, both arms and both legs.
    expect(countMeshes(humanoid.group)).toBeGreaterThanOrEqual(14);
  });

  it('separates the left and right limbs in Z', () => {
    // Left limbs sit at negative Z, right limbs at positive Z, so they
    // cannot z-fight or slice through the torso.
    const positions: number[] = [];
    humanoid.group.children.forEach((child) => {
      if (child instanceof THREE.Group) positions.push(child.position.z);
    });
    expect(positions.some((z) => z < 0)).toBe(true);
    expect(positions.some((z) => z > 0)).toBe(true);
  });

  it('follows the simulation rig without producing NaN', () => {
    for (let i = 0; i < 30; i++) {
      world.update(1 / 60);
      humanoid.update(world.player.rig, world.flow.tier);
    }
    humanoid.group.updateMatrixWorld(true);
    humanoid.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        expect(Number.isFinite(obj.position.x)).toBe(true);
        expect(Number.isFinite(obj.position.y)).toBe(true);
        expect(Number.isFinite(obj.rotation.z)).toBe(true);
      }
    });
  });

  it('keeps the head at the rig head position', () => {
    humanoid.update(world.player.rig, world.flow.tier);
    const head = humanoid.group.children.find(
      (c) => c instanceof THREE.Group && c.children.some((k) => k instanceof THREE.Mesh && k.geometry.type === 'SphereGeometry'),
    ) as THREE.Group | undefined;
    expect(head).toBeDefined();
    expect(head!.position.x).toBeCloseTo(simX(world.player.rig.head.x), 5);
    expect(head!.position.y).toBeCloseTo(simY(world.player.rig.head.y), 5);
  });

  it('projects the contact shadow onto the ground', () => {
    // Let the runner settle onto a rooftop so there is a surface below.
    for (let i = 0; i < 60; i++) world.update(1 / 60);
    const ground = world.terrain.groundAt(world.player.x, world.player.y);
    expect(ground).not.toBeNull();
    humanoid.updateContactShadow(world.player.x, world.player.y, ground, 0);
    expect(humanoid.contactShadow.visible).toBe(true);
    // The shadow sits a hair above the surface to avoid z-fighting.
    expect(humanoid.contactShadow.position.y).toBeCloseTo(simY(ground!) + 0.012, 5);
  });

  it('hides the contact shadow when there is no ground below', () => {
    humanoid.updateContactShadow(world.player.x, world.player.y, null, 0);
    expect(humanoid.contactShadow.visible).toBe(false);
  });

  it('shrinks and fades the shadow as the runner rises', () => {
    for (let i = 0; i < 60; i++) world.update(1 / 60);
    const ground = world.terrain.groundAt(world.player.x, world.player.y) ?? 0;
    humanoid.updateContactShadow(world.player.x, world.player.y, ground, 0);
    const nearScale = humanoid.contactShadow.scale.x;
    const nearOpacity = (humanoid.contactShadow.material as THREE.MeshBasicMaterial).opacity;

    humanoid.updateContactShadow(world.player.x, world.player.y - 200, ground, 0);
    expect(humanoid.contactShadow.scale.x).toBeLessThan(nearScale);
    expect((humanoid.contactShadow.material as THREE.MeshBasicMaterial).opacity).toBeLessThan(nearOpacity);
  });
});

describe('Camera3D — 2.5D framing', () => {
  it('frames the runner left of centre and above the plane', () => {
    const cam = new Camera3D(16 / 9);
    cam.update(0, 0, 1, 1 / 60);
    expect(cam.camera.fov).toBe(45);
    expect(cam.camera.position.z).toBeGreaterThan(0);
    expect(cam.camera.position.y).toBeGreaterThan(0);
  });

  it('pulls back as the flow tier rises', () => {
    const cam = new Camera3D(16 / 9);
    for (let i = 0; i < 240; i++) cam.update(0, 0, 1, 1 / 60);
    const steady = cam.camera.position.z;
    for (let i = 0; i < 240; i++) cam.update(0, 0, 3, 1 / 60);
    const flowing = cam.camera.position.z;
    expect(flowing).toBeGreaterThan(steady);
  });

  it('keeps the runner at roughly 28% from the left edge', () => {
    const cam = new Camera3D(16 / 9);
    for (let i = 0; i < 240; i++) cam.update(0, 0, 1, 1 / 60);
    cam.camera.updateMatrixWorld(true);
    // Project the runner's world position into normalised device coords.
    const runner = new THREE.Vector3(0, simY(0), 0).project(cam.camera);
    const screenX = (runner.x + 1) / 2;
    expect(screenX).toBeGreaterThan(0.15);
    expect(screenX).toBeLessThan(0.42);
  });

  it('never produces a NaN camera transform', () => {
    const cam = new Camera3D(16 / 9);
    for (let i = 0; i < 60; i++) {
      cam.update(i * 100, -i * 20, (i % 3) + 1, 1 / 60);
    }
    expect(Number.isFinite(cam.camera.position.x)).toBe(true);
    expect(Number.isFinite(cam.camera.position.y)).toBe(true);
    expect(Number.isFinite(cam.camera.position.z)).toBe(true);
    expect(Number.isFinite(cam.camera.rotation.x)).toBe(true);
    expect(Number.isFinite(cam.camera.rotation.y)).toBe(true);
  });
});

describe('LightingRig — atmospheric moods', () => {
  it('builds a full light rig for every mood', () => {
    const scene = new THREE.Scene();
    const rig = new LightingRig(scene);
    for (const mood of ['dusk', 'rain', 'dawn'] as const) {
      rig.apply(mood);
      expect(rig.mood).toBe(mood);
      expect(rig.sun.intensity).toBeGreaterThan(0);
      expect(rig.fog.density).toBeGreaterThan(0);
    }
  });

  it('swaps the fog colour and density between moods', () => {
    const scene = new THREE.Scene();
    const rig = new LightingRig(scene);
    rig.apply('dusk');
    const duskFog = rig.fog.color.getHex();
    const duskDensity = rig.fog.density;
    rig.apply('rain');
    expect(rig.fog.color.getHex()).not.toBe(duskFog);
    expect(rig.fog.density).not.toBe(duskDensity);
  });

  it('enables the neon bounce lights only at night', () => {
    const scene = new THREE.Scene();
    const rig = new LightingRig(scene);
    rig.apply('rain');
    expect(rig.bounceA.intensity).toBeGreaterThan(0);
    rig.apply('dawn');
    expect(rig.bounceA.intensity).toBe(0);
  });

  it('keeps the sun shadow frustum centred on the runner', () => {
    const scene = new THREE.Scene();
    const rig = new LightingRig(scene);
    rig.followSun(100, -20);
    expect(rig.sun.target.position.x).toBe(100);
    expect(rig.sun.position.x).toBeGreaterThan(0);
  });

  it('matches the specified dusk lighting values', () => {
    expect(LIGHTING_PRESETS.dusk.sunColor).toBe('#ff9e5e');
    expect(LIGHTING_PRESETS.dusk.sunIntensity).toBeCloseTo(2.6, 5);
  });
});

describe('Presenter — WebGL detection and fallback', () => {
  it('reports WebGL availability without throwing', () => {
    expect(() => isWebGLAvailable()).not.toThrow();
  });

  it('falls back to the 2D renderer when WebGL is unavailable', () => {
    const canvas = document.createElement('canvas');
    const presenter = createPresenter(canvas, 'performance');
    // In happy-dom there is no GL context, so the 2D path must be chosen
    // rather than throwing.
    expect(presenter.is3D).toBe(false);
  });

  it('resolves to a working 2D presenter when WebGL is unavailable', async () => {
    const canvas = document.createElement('canvas');
    const presenter = await initPresenter(canvas, 'performance');
    expect(presenter.is3D).toBe(false);
  });

  it('produces a playable presenter in a headless environment', () => {
    const canvas = document.createElement('canvas');
    const presenter = createPresenter(canvas, 'performance');
    const world = new World({ difficulty: 'medium', seed: 7 });
    world.start();
    expect(() =>
      presenter.render(world, { showDebug: false, skyMood: 'dusk' }),
    ).not.toThrow();
  });

  it('keeps the game playable through the 2D fallback', async () => {
    const canvas = document.createElement('canvas');
    const presenter = await initPresenter(canvas, 'performance');
    const world = new World({ difficulty: 'medium', seed: 11 });
    world.start();
    for (let i = 0; i < 60; i++) world.update(1 / 60);
    expect(() =>
      presenter.render(world, { showDebug: false, skyMood: 'rain' }),
    ).not.toThrow();
    expect(() => presenter.resize(1280, 720)).not.toThrow();
    expect(() => presenter.applyMood('dawn')).not.toThrow();
    expect(() => presenter.dispose()).not.toThrow();
  });
});
