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
import { dressingFor, buildFacade, buildRooftopDressing } from '../src/render3d/rooftop3d';
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

  it('survives a level rebuild without throwing', () => {
    // Rebuilding the level replaces every hazard with fresh objects, which
    // retires the old prop groups. The retirement path must not mutate a
    // child list while walking it: `Object3D.traverse` caches
    // `children.length` up front, so removing a child mid-walk makes it
    // index past the end and crash the render loop every single frame.
    for (let round = 0; round < 3; round++) {
      world.start();
      for (let i = 0; i < 120; i++) {
        world.update(1 / 60);
        expect(() => world3d.sync(world.terrain, world.player.x)).not.toThrow();
      }
    }
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
    const groups = (world3d as unknown as { hazardGroups: Map<unknown, THREE.Group> }).hazardGroups;
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
      (c) =>
        c instanceof THREE.Group &&
        c.children.some((k) => k instanceof THREE.Mesh && k.geometry.type === 'SphereGeometry'),
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

  it('anchors the feet, hands and head exactly on the rig joints', () => {
    // Drive the runner through run / air / stumble so every limb state is
    // exercised. Each anchor must land on its rig joint to the millimetre:
    // an offset here is what made the runner look like a blob rather than
    // a person.
    let t = 0;
    let worstFoot = 0;
    let worstHand = 0;
    let worstNeck = 0;
    const seen = new Set<string>();

    for (let i = 0; i < 900; i++) {
      t += 1 / 60;
      world.currentInput = {
        moveX: 1,
        jumpHeld: t % 3 < 0.2,
        jumpPressed: false,
        crouchHeld: t % 5 > 4.6,
        crouchPressed: false,
      };
      world.update(1 / 60);
      humanoid.update(world.player.rig, world.flow.tier);
      humanoid.group.updateMatrixWorld(true);
      seen.add(world.player.state);

      const rig = world.player.rig;
      const internals = humanoid as unknown as {
        footL: THREE.Group;
        handL: THREE.Group;
        neck: THREE.Group;
      };

      const foot = new THREE.Vector3().setFromMatrixPosition(internals.footL.matrixWorld);
      const hand = new THREE.Vector3().setFromMatrixPosition(internals.handL.matrixWorld);
      const neck = new THREE.Vector3().setFromMatrixPosition(internals.neck.matrixWorld);

      // The foot is anchored to the SOLVED ankle (the IK clamps the chain
      // when the target is out of reach).
      const ankle = rig.leftLeg?.end ?? rig.leftFoot.ankle;
      worstFoot = Math.max(
        worstFoot,
        foot.distanceTo(new THREE.Vector3(simX(ankle.x), simY(ankle.y), -0.15)),
      );
      worstHand = Math.max(
        worstHand,
        hand.distanceTo(
          new THREE.Vector3(simX(rig.leftHand.wrist.x), simY(rig.leftHand.wrist.y), -0.15),
        ),
      );
      worstNeck = Math.max(worstNeck, Math.abs(neck.y - simY(rig.neck.y)));
    }

    expect(seen.size).toBeGreaterThan(1);
    expect(worstFoot).toBeLessThan(0.01);
    expect(worstHand).toBeLessThan(0.01);
    expect(worstNeck).toBeLessThan(0.01);
  });

  it('points every limb along its bone', () => {
    // The limb meshes run along local -Y, so the bone angle must be
    // atan2(dy, dx) + PI/2. Using -PI/2 rotated every bone backwards and
    // splayed the runner's limbs.
    for (let i = 0; i < 120; i++) {
      world.update(1 / 60);
      humanoid.update(world.player.rig, world.flow.tier);
    }
    humanoid.group.updateMatrixWorld(true);

    const rig = world.player.rig;
    const internals = humanoid as unknown as {
      thighL: THREE.Group;
      shinL: THREE.Group;
      upperArmL: THREE.Group;
    };

    const boneDir = (group: THREE.Group): THREE.Vector3 =>
      new THREE.Vector3(0, -1, 0).transformDirection(group.matrixWorld);

    const want = (a: { x: number; y: number }, b: { x: number; y: number }): THREE.Vector3 =>
      new THREE.Vector3(simX(b.x) - simX(a.x), simY(b.y) - simY(a.y), 0).normalize();

    if (rig.leftLeg) {
      expect(
        boneDir(internals.thighL).dot(want(rig.leftLeg.root, rig.leftLeg.joint)),
      ).toBeGreaterThan(0.999);
      expect(
        boneDir(internals.shinL).dot(want(rig.leftLeg.joint, rig.leftLeg.end)),
      ).toBeGreaterThan(0.999);
    }
    if (rig.leftArm) {
      expect(
        boneDir(internals.upperArmL).dot(want(rig.leftArm.root, rig.leftArm.joint)),
      ).toBeGreaterThan(0.999);
    }
  });

  it('has a human silhouette, not a sprawled blob', () => {
    for (let i = 0; i < 120; i++) {
      world.update(1 / 60);
      humanoid.update(world.player.rig, world.flow.tier);
    }
    humanoid.group.updateMatrixWorld(true);

    const size = new THREE.Box3().setFromObject(humanoid.group).getSize(new THREE.Vector3());
    const ratio = size.x / size.y;
    // A running human is roughly 0.25-0.40 as wide as they are tall.
    expect(ratio).toBeGreaterThan(0.15);
    expect(ratio).toBeLessThan(0.5);
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
    expect((humanoid.contactShadow.material as THREE.MeshBasicMaterial).opacity).toBeLessThan(
      nearOpacity,
    );
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
    expect(() => presenter.render(world, { showDebug: false, skyMood: 'dusk' })).not.toThrow();
  });

  it('keeps the game playable through the 2D fallback', async () => {
    const canvas = document.createElement('canvas');
    const presenter = await initPresenter(canvas, 'performance');
    const world = new World({ difficulty: 'medium', seed: 11 });
    world.start();
    for (let i = 0; i < 60; i++) world.update(1 / 60);
    expect(() => presenter.render(world, { showDebug: false, skyMood: 'rain' })).not.toThrow();
    expect(() => presenter.resize(1280, 720)).not.toThrow();
    expect(() => presenter.applyMood('dawn')).not.toThrow();
    expect(() => presenter.dispose()).not.toThrow();
  });
});

describe('Rooftop dressing — realistic rooftop plant', () => {
  it('lays out plant deterministically for the same slab', () => {
    const a = dressingFor(7, 12, 2.6);
    const b = dressingFor(7, 12, 2.6);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('skips narrow slabs that cannot carry plant', () => {
    expect(dressingFor(3, 1.5, 2.6)).toHaveLength(0);
  });

  it('never places decoration in front of the traversal plane', () => {
    const slots = dressingFor(11, 14, 2.6);
    for (const slot of slots) {
      // The parapet lip lives at Z = +1.28; nothing may sit in front of it.
      expect(slot.z).toBeLessThan(DEPTH.playableHalf);
    }
  });

  it('builds a dressing group whose meshes all stay behind the play plane', () => {
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const unitCylinder = (segments: number) => new THREE.CylinderGeometry(1, 1, 1, segments);
    const mat = new THREE.MeshStandardMaterial();
    const group = buildRooftopDressing(
      { x: 0, y: 600, w: 480, h: 160, angle: 0 },
      5,
      unitBox,
      unitCylinder,
      {
        metal: mat,
        darkMetal: mat,
        vent: mat,
        crate: mat,
        seam: mat,
        puddle: mat,
        parapet: mat,
        facade: mat,
      },
    );

    expect(countMeshes(group)).toBeGreaterThan(0);
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    // The whole dressing volume must remain behind the front lip.
    expect(box.max.z).toBeLessThanOrEqual(DEPTH.parapet + 0.001);
    expect(Number.isFinite(box.min.z)).toBe(true);
    expect(Number.isFinite(box.max.z)).toBe(true);
  });
});

describe('World3D — distance culling keeps the draw count sane', () => {
  it('draws far fewer meshes than a fully dressed city contains', () => {
    const world = new World({ difficulty: 'medium', seed: 991 });
    world.start();
    const world3d = new World3D();
    world3d.build();
    world3d.sync(world.terrain, world.player.x);

    let total = 0;
    world3d.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) total++;
    });
    let visible = 0;
    world3d.group.traverseVisible((obj) => {
      if (obj instanceof THREE.Mesh) visible++;
    });

    // Culling must actually remove meshes from the render path.
    expect(visible).toBeLessThan(total);
    // And the visible set must stay small enough for a phone.
    expect(visible).toBeLessThan(600);
  });

  it('keeps the slab under the runner visible at all times', () => {
    const world = new World({ difficulty: 'medium', seed: 31337 });
    world.start();
    const world3d = new World3D();
    world3d.build();
    for (let i = 0; i < 40; i++) {
      world.update(1 / 60);
      world3d.sync(world.terrain, world.player.x);
    }
    // The camera is anchored to the runner, so at least some slab must be
    // drawn even after the far ones are culled.
    let visible = 0;
    world3d.group.traverseVisible((obj) => {
      if (obj instanceof THREE.Mesh) visible++;
    });
    expect(visible).toBeGreaterThan(0);
  });
});

describe('LightingRig — sun disc and street haze', () => {
  it('gives every mood a sun disc and a haze opacity', () => {
    for (const mood of ['dusk', 'rain', 'dawn'] as const) {
      const preset = LIGHTING_PRESETS[mood];
      expect(preset.sunDisc).toBeGreaterThanOrEqual(0);
      expect(preset.sunDisc).toBeLessThanOrEqual(1);
      expect(preset.hazeOpacity).toBeGreaterThan(0);
      expect(preset.hazeOpacity).toBeLessThanOrEqual(1);
    }
  });

  it('hides the sun disc in rain and shows it at dusk', () => {
    expect(LIGHTING_PRESETS.rain.sunDisc).toBe(0);
    expect(LIGHTING_PRESETS.dusk.sunDisc).toBeGreaterThan(0);
  });

  it('drives the sky shader and haze material from the preset', () => {
    const scene = new THREE.Scene();
    const rig = new LightingRig(scene);
    rig.apply('dawn');
    expect(rig.skyMaterial.uniforms.sunDisc.value).toBeCloseTo(LIGHTING_PRESETS.dawn.sunDisc, 5);
    expect((rig.hazeMaterial as THREE.ShaderMaterial).uniforms.opacity.value).toBeCloseTo(
      LIGHTING_PRESETS.dawn.hazeOpacity,
      5,
    );
  });

  it('builds two haze layers for street depth', () => {
    const scene = new THREE.Scene();
    const rig = new LightingRig(scene);
    expect(rig.hazeMaterial).toBeDefined();
    expect(rig.hazeFar).toBeDefined();
    expect(rig.hazeFar).not.toBe(rig.hazeMaterial);
  });
});

describe('Humanoid3D — materials read as a person', () => {
  it('uses fabric on the clothing and skin on the exposed parts', () => {
    const humanoid = new Humanoid3D();
    let hasFabric = false;
    let hasSkin = false;
    humanoid.group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mat = obj.material as THREE.MeshStandardMaterial;
      if (mat.map && mat.roughness > 0.7) hasFabric = true;
      if (
        mat.map &&
        mat.roughness > 0.6 &&
        mat.metalness === 0 &&
        mat.color.getHexString() === 'd19a75'
      )
        hasSkin = true;
    });
    expect(hasFabric).toBe(true);
    expect(hasSkin).toBe(true);
  });

  it('builds a face with eyes, a nose and ears', () => {
    const humanoid = new Humanoid3D();
    let cones = 0;
    let spheres = 0;
    humanoid.group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (obj.geometry instanceof THREE.ConeGeometry) cones++;
      if (obj.geometry instanceof THREE.SphereGeometry) spheres++;
    });
    // The nose.
    expect(cones).toBeGreaterThan(0);
    // Head, cap, two eyes and two ears.
    expect(spheres).toBeGreaterThanOrEqual(5);
  });
});

describe('World3D — background city', () => {
  it('keeps the near and deep city inside their depth bands', () => {
    const world = new World({ difficulty: 'medium', seed: 5150 });
    world.start();
    const world3d = new World3D();
    world3d.build();
    world3d.sync(world.terrain, world.player.x);
    world3d.group.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(world3d.group);
    // The play surface itself reaches DEPTH.playableHalf; nothing may go
    // beyond that.
    expect(box.max.z).toBeLessThanOrEqual(DEPTH.playableHalf + 0.001);
    // The city must reach back into the deep skyline band.
    expect(box.min.z).toBeLessThan(DEPTH.deepSkyline.far);
  });

  it('scrolls the city with the camera so a skyline is always behind', () => {
    const world = new World({ difficulty: 'medium', seed: 771 });
    world.start();
    const world3d = new World3D();
    world3d.build();

    // The city scrolls in whole tiles, so it only moves once the runner
    // has covered a whole tile. The runner needs to travel a long way for
    // the scroll to be observable.
    const positions: number[] = [];
    for (let i = 0; i < 4000; i++) {
      // The autopilot keeps the runner moving, so the camera travels far
      // enough for the city to roll through several tiles.
      world.currentInput = {
        moveX: 1,
        jumpHeld: false,
        jumpPressed: false,
        crouchHeld: false,
        crouchPressed: false,
      };
      world.update(1 / 60);
      world3d.sync(world.terrain, world.player.x);
      // The background city is the only thing that scrolls with the camera
      // at a fixed tile size, so it is identified by the size of its
      // children.
      const city = world3d.group.children.find(
        (child) => child instanceof THREE.Group && child.children.length > 40,
      );
      expect(city).toBeDefined();
      positions.push((city as THREE.Group).position.x);
    }

    // The city must have moved with the runner, not stayed parked at the
    // origin. A city pinned to one X leaves an empty sky behind the player.
    const spread = Math.max(...positions) - Math.min(...positions);
    expect(spread).toBeGreaterThan(100);

    // And it must stay in step with the runner rather than drifting away.
    // The deep skyline scrolls in bigger tiles than the near city, so it
    // is allowed to sit further behind the runner.
    const cameraMetres = world.player.x / 40;
    for (const pos of positions) {
      expect(Math.abs(pos - cameraMetres)).toBeLessThan(1000);
    }
  });

  it('builds a skyline dense enough that the background is never empty', () => {
    const world = new World({ difficulty: 'medium', seed: 4242 });
    world.start();
    const world3d = new World3D();
    world3d.build();
    world3d.sync(world.terrain, world.player.x);
    world3d.group.updateMatrixWorld(true);

    let towers = 0;
    world3d.group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const z = obj.getWorldPosition(new THREE.Vector3()).z;
      if (z < DEPTH.deepSkyline.near) towers++;
    });
    expect(towers).toBeGreaterThan(20);
  });
});

describe('Rooftop facade — the building under the roof', () => {
  it('skins the front face of the roof block with windows', () => {
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial();
    const group = buildFacade(12, 6, unitBox, mat);
    expect(countMeshes(group)).toBeGreaterThan(1);
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    // It hangs below the roof line...
    expect(box.max.y).toBeLessThanOrEqual(0.01);
    // ...and never reaches in front of the parapet.
    expect(box.max.z).toBeLessThanOrEqual(DEPTH.parapet + 0.001);
  });

  it('caps the facade height so it cannot fill the screen', () => {
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial();
    const tall = buildFacade(12, 400, unitBox, mat);
    tall.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(tall);
    // A 400 m tall block must still only skin the top storeys.
    expect(box.max.y - box.min.y).toBeLessThan(12);
  });

  it('skips the facade for blocks too small to carry one', () => {
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial();
    expect(countMeshes(buildFacade(0.1, 6, unitBox, mat))).toBe(0);
    expect(countMeshes(buildFacade(6, 0.1, unitBox, mat))).toBe(0);
  });
});
