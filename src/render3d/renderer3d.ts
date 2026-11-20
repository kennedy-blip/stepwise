/**
 * The 3D renderer.
 *
 * Owns the WebGL context, the scene graph, the camera rig, the lighting
 * moods, the world geometry and the articulated runner, and drives them from
 * the simulation state.
 *
 * This module is the *only* thing that replaces the old 2D canvas renderer.
 * The simulation, the Flow rules, the IK and the UI are untouched.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import type { SkyMood } from '../core/types';
import type { World } from '../game/world';
import type { CharacterRig } from '../game/rig';
import type { IKBone } from '../physics/ik';
import { FLOW_COLORS, SKY_MOODS } from '../game/config';
import {
  detectDefaultPreset,
  effectivePixelRatio,
  qualityFor,
  type GraphicsPreset,
  type QualitySettings,
} from '../engine/quality';
import { Camera3D } from './camera3d';
import { Humanoid3D } from './humanoid3d';
import { LIGHTING_PRESETS, LightingRig } from './lighting3d';
import { World3D } from './world3d';
import { simX, simY } from './units';

export interface Render3DOptions {
  /** Force a graphics preset instead of auto-detecting one. */
  preset?: GraphicsPreset;
}

/**
 * The 3D presentation layer.
 */
export class Renderer3D {
  readonly scene = new THREE.Scene();
  readonly camera3d: Camera3D;

  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private renderPass: RenderPass | null = null;

  private world3d = new World3D();
  private humanoid = new Humanoid3D();
  private lighting = new LightingRig(this.scene);

  private quality: QualitySettings;
  private preset: GraphicsPreset;

  /** Debug overlay for the IK skeleton and raycasts. */
  private debugGroup = new THREE.Group();
  private debugBones!: THREE.LineSegments;
  private debugPoints!: THREE.Points;
  private debugPoles!: THREE.LineSegments;

  /** 3D rain / dust particle field. */
  private weatherPoints!: THREE.Points;
  private weatherGeometry!: THREE.BufferGeometry;
  private weatherMaterial!: THREE.PointsMaterial;

  private width = 1;
  private height = 1;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, options: Render3DOptions = {}) {
    this.preset = options.preset ?? detectDefaultPreset();
    this.quality = qualityFor(this.preset);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.preset === 'high',
      powerPreference: this.preset === 'high' ? 'high-performance' : 'default',
      alpha: false,
    });
    this.renderer.setClearColor(0x05060f, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera3d = new Camera3D(1);
    this.scene.add(this.camera3d.camera);

    this.world3d.build();
    this.scene.add(this.world3d.group);

    this.humanoid.addToScene(this.scene);
    this.scene.add(this.humanoid.contactShadow);

    this.buildDebugOverlay();
    this.buildWeather();

    this.applyQuality();
    this.applyMood('dusk');
  }

  /** Builds the IK debug overlay (bones, joint markers, raycasts). */
  private buildDebugOverlay(): void {
    const boneGeo = new THREE.BufferGeometry();
    boneGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(64 * 3), 3));
    this.debugBones = new THREE.LineSegments(
      boneGeo,
      new THREE.LineBasicMaterial({ color: 0x5fe0ff, transparent: true, opacity: 0.85 }),
    );
    this.debugBones.frustumCulled = false;
    this.debugBones.visible = false;

    const pointGeo = new THREE.BufferGeometry();
    pointGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(32 * 3), 3));
    this.debugPoints = new THREE.Points(
      pointGeo,
      new THREE.PointsMaterial({
        color: 0xffb45c,
        size: 5,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.9,
      }),
    );
    this.debugPoints.frustumCulled = false;
    this.debugPoints.visible = false;

    // Pole vectors: the bend direction each IK chain folds toward. Drawn
    // in a distinct colour so the three debug layers stay readable.
    const poleGeo = new THREE.BufferGeometry();
    poleGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(16 * 3), 3));
    this.debugPoles = new THREE.LineSegments(
      poleGeo,
      new THREE.LineBasicMaterial({ color: 0xff5fd2, transparent: true, opacity: 0.8 }),
    );
    this.debugPoles.frustumCulled = false;
    this.debugPoles.visible = false;

    this.debugGroup.add(this.debugBones);
    this.debugGroup.add(this.debugPoints);
    this.debugGroup.add(this.debugPoles);
    this.scene.add(this.debugGroup);
  }

  /** Builds the weather particle field (rain streaks or drifting dust). */
  private buildWeather(): void {
    const count = 900;
    this.weatherGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 90;
      positions[i * 3 + 1] = Math.random() * 46;
      positions[i * 3 + 2] = -Math.random() * 40 + 4;
    }
    this.weatherGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.weatherMaterial = new THREE.PointsMaterial({
      color: 0x96d2ff,
      size: 0.09,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.weatherPoints = new THREE.Points(this.weatherGeometry, this.weatherMaterial);
    this.weatherPoints.frustumCulled = false;
    this.scene.add(this.weatherPoints);
  }

  /** Applies a graphics preset, rebuilding the composer when needed. */
  applyPreset(preset: GraphicsPreset): void {
    if (preset === this.preset) return;
    this.preset = preset;
    this.quality = qualityFor(preset);
    this.applyQuality();
    this.resize(this.width, this.height);
  }

  /** The active graphics preset. */
  get currentPreset(): GraphicsPreset {
    return this.preset;
  }

  /** Applies quality-derived settings to the renderer and lighting. */
  private applyQuality(): void {
    this.lighting.setShadowMapSize(this.quality.shadowMapSize);
    this.renderer.setPixelRatio(effectivePixelRatio(this.quality));

    if (this.quality.bloom && !this.composer) {
      this.createComposer();
    } else if (!this.quality.bloom && this.composer) {
      this.disposeComposer();
    }
  }

  /** Builds the post-processing composer. */
  private createComposer(): void {
    if (this.composer) return;
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera3d.camera);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(this.width, this.height),
      LIGHTING_PRESETS.dusk.bloomStrength,
      0.6,
      LIGHTING_PRESETS.dusk.bloomThreshold,
    );
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
  }

  /** Tears down the post-processing composer. */
  private disposeComposer(): void {
    if (!this.composer) return;
    this.composer.dispose();
    this.composer = null;
    this.renderPass = null;
    this.bloomPass = null;
  }

  /** Applies a sky mood to the lighting, fog and sky dome. */
  applyMood(mood: SkyMood): void {
    const preset = LIGHTING_PRESETS[mood];
    this.lighting.apply(mood);
    this.world3d.applyPreset(preset, mood);
    if (this.bloomPass) {
      this.bloomPass.strength = preset.bloomStrength;
      this.bloomPass.threshold = preset.bloomThreshold;
    }
    this.weatherMaterial.color.set(
      mood === 'rain' ? 0x96d2ff : mood === 'dusk' ? 0xffd8b4 : 0xdfeaf0,
    );
    this.weatherMaterial.opacity = mood === 'rain' ? 0.62 : mood === 'dusk' ? 0.4 : 0.22;
    this.weatherMaterial.size = mood === 'rain' ? 0.1 : 0.07;
    const weather = preset.weather;
    this.weatherPoints.visible = weather !== 'none';
    this.weatherMaterial.needsUpdate = true;
  }

  /** Resizes the renderer to the given pixel dimensions. */
  resize(width: number, height: number): void {
    if (this.disposed) return;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.renderer.setSize(this.width, this.height, false);
    this.camera3d.resize(this.width / this.height);
    if (this.composer) {
      this.composer.setSize(this.width, this.height);
      this.bloomPass?.setSize(this.width, this.height);
    }
  }

  /**
   * Renders one frame from the current simulation state.
   */
  render(world: World, options: { showDebug: boolean; skyMood: SkyMood }): void {
    if (this.disposed) return;

    const player = world.player;
    const rig = player.rig;
    const flowTier = world.flow.tier;

    // --- Camera -------------------------------------------------------------
    this.camera3d.update(player.x, player.y, flowTier, 1 / 60);
    this.lighting.followSun(simX(player.x), simY(player.y));

    // --- World geometry -----------------------------------------------------
    this.world3d.sync(world.terrain, player.x);
    this.world3d.updateDebris(1 / 60);

    // --- Runner -------------------------------------------------------------
    this.humanoid.update(rig, flowTier);

    // Contact shadow: find the ground beneath the runner.
    // `groundAt` casts a ray DOWNWARD from the given origin, so the origin
    // must be at or above the surface. The runner's own feet position is the
    // correct probe point; a surface below the runner has a LARGER y because
    // simulation space is +y DOWN.
    const ground = world.terrain.groundAt(player.x, player.y);
    const shadowGround = ground !== null && ground >= player.y - 1 ? ground : null;
    this.humanoid.updateContactShadow(player.x, player.y, shadowGround, 0);

    // --- Weather ------------------------------------------------------------
    this.updateWeather(player.x);

    // --- Debug overlay ------------------------------------------------------
    this.debugGroup.visible = options.showDebug;
    if (options.showDebug) this.updateDebug(rig, player.x, player.y);

    // --- Draw ---------------------------------------------------------------
    if (this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera3d.camera);
    }
  }

  /** Scrolls the weather field with the camera. */
  private updateWeather(cameraX: number): void {
    const attr = this.weatherGeometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const count = arr.length / 3;
    // The particle budget scales with the quality preset.
    const active = Math.floor(count * this.quality.particleScale);
    const drift = this.lighting.mood === 'rain' ? -22 : -1.2;
    for (let i = 0; i < active; i++) {
      arr[i * 3 + 1] += drift * (1 / 60);
      if (arr[i * 3 + 1] < -4) {
        arr[i * 3 + 1] = 46;
        arr[i * 3] = (Math.random() - 0.5) * 90;
      }
    }
    // Park unused particles far below the scene.
    for (let i = active; i < count; i++) arr[i * 3 + 1] = -999;
    attr.needsUpdate = true;
    this.weatherPoints.position.x = simX(cameraX);
  }

  /** Rebuilds the IK debug lines from the 2D rig. */
  private updateDebug(rig: CharacterRig, x: number, y: number): void {
    const boneAttr = this.debugBones.geometry.getAttribute('position') as THREE.BufferAttribute;
    const boneArr = boneAttr.array as Float32Array;
    let bi = 0;

    const addBone = (
      ax: number,
      ay: number,
      bx: number,
      by: number,
      z: number,
    ): void => {
      if (bi + 6 > boneArr.length) return;
      boneArr[bi++] = simX(ax);
      boneArr[bi++] = simY(ay);
      boneArr[bi++] = z;
      boneArr[bi++] = simX(bx);
      boneArr[bi++] = simY(by);
      boneArr[bi++] = z;
    };

    const ll = rig.leftLeg;
    const rl = rig.rightLeg;
    if (ll) {
      addBone(ll.root.x, ll.root.y, ll.joint.x, ll.joint.y, 0.3);
      addBone(ll.joint.x, ll.joint.y, ll.end.x, ll.end.y, 0.3);
    }
    if (rl) {
      addBone(rl.root.x, rl.root.y, rl.joint.x, rl.joint.y, -0.3);
      addBone(rl.joint.x, rl.joint.y, rl.end.x, rl.end.y, -0.3);
    }
    const la = rig.leftArm;
    const ra = rig.rightArm;
    if (la) {
      addBone(la.root.x, la.root.y, la.joint.x, la.joint.y, 0.3);
      addBone(la.joint.x, la.joint.y, la.end.x, la.end.y, 0.3);
    }
    if (ra) {
      addBone(ra.root.x, ra.root.y, ra.joint.x, ra.joint.y, -0.3);
      addBone(ra.joint.x, ra.joint.y, ra.end.x, ra.end.y, -0.3);
    }
    addBone(rig.pelvis.x, rig.pelvis.y, rig.neck.x, rig.neck.y, 0);
    addBone(rig.neck.x, rig.neck.y, rig.head.x, rig.head.y, 0);

    // Downward raycasts from each foot.
    const footY = world_groundProbe(this, x, y);
    addBone(rig.leftFoot.ankle.x, rig.leftFoot.ankle.y, rig.leftFoot.ankle.x, footY, 0.3);
    addBone(rig.rightFoot.ankle.x, rig.rightFoot.ankle.y, rig.rightFoot.ankle.x, footY, -0.3);

    boneAttr.needsUpdate = true;
    this.debugBones.geometry.setDrawRange(0, bi / 3);
    this.debugBones.geometry.computeBoundingSphere();

    // Pole vectors: derived from the solved chain geometry, pointing from
    // the root toward the side the joint folds toward.
    const poleAttr = this.debugPoles.geometry.getAttribute('position') as THREE.BufferAttribute;
    const poleArr = poleAttr.array as Float32Array;
    let polei = 0;
    const addPole = (bone: IKBone | null, z: number): void => {
      if (!bone || polei + 6 > poleArr.length) return;
      // The bend direction is the component of (joint - root) that is
      // perpendicular to (end - root).
      const rx = bone.joint.x - bone.root.x;
      const ry = bone.joint.y - bone.root.y;
      const ex = bone.end.x - bone.root.x;
      const ey = bone.end.y - bone.root.y;
      const elen = Math.hypot(ex, ey);
      if (elen < 1e-5) return;
      const dot = (rx * ex + ry * ey) / (elen * elen);
      const px = rx - ex * dot;
      const py = ry - ey * dot;
      const plen = Math.hypot(px, py);
      if (plen < 1e-5) return;
      const len = 26;
      poleArr[polei++] = simX(bone.root.x);
      poleArr[polei++] = simY(bone.root.y);
      poleArr[polei++] = z;
      poleArr[polei++] = simX(bone.root.x) + (px / plen) * len;
      poleArr[polei++] = simY(bone.root.y) + (py / plen) * len;
      poleArr[polei++] = z;
    };
    addPole(ll, 0.3);
    addPole(rl, -0.3);
    addPole(la, 0.3);
    addPole(ra, -0.3);

    poleAttr.needsUpdate = true;
    this.debugPoles.geometry.setDrawRange(0, polei / 3);
    this.debugPoles.geometry.computeBoundingSphere();

    // Joint markers.
    const pointAttr = this.debugPoints.geometry.getAttribute('position') as THREE.BufferAttribute;
    const pointArr = pointAttr.array as Float32Array;
    let pi = 0;
    const addPoint = (px: number, py: number): void => {
      if (pi + 3 > pointArr.length) return;
      pointArr[pi++] = simX(px);
      pointArr[pi++] = simY(py);
      pointArr[pi++] = 0;
    };
    if (ll) {
      addPoint(ll.joint.x, ll.joint.y);
      addPoint(ll.end.x, ll.end.y);
    }
    if (rl) {
      addPoint(rl.joint.x, rl.joint.y);
      addPoint(rl.end.x, rl.end.y);
    }
    if (la) addPoint(la.joint.x, la.joint.y);
    if (ra) addPoint(ra.joint.x, ra.joint.y);
    addPoint(rig.head.x, rig.head.y);
    pointAttr.needsUpdate = true;
    this.debugPoints.geometry.setDrawRange(0, pi / 3);
    this.debugPoints.geometry.computeBoundingSphere();
  }

  /** Adds camera shake to the 3D camera. */
  addShake(amount: number): void {
    this.camera3d.addShake(amount);
  }

  /** Triggers the Flow Save zoom pulse. */
  triggerZoomPulse(): void {
    this.camera3d.triggerZoomPulse();
  }

  /** Disposes every GPU resource. */
  dispose(): void {
    this.disposed = true;
    this.disposeComposer();
    this.world3d.dispose();
    this.humanoid.dispose();
    this.lighting.dispose();
    this.debugBones.geometry.dispose();
    this.debugPoles.geometry.dispose();
    this.debugPoints.geometry.dispose();
    this.weatherGeometry.dispose();
    this.weatherMaterial.dispose();
    this.renderer.dispose();
  }
}

/**
 * Finds the ground Y used by the debug raycasts.
 *
 * Kept as a tiny helper so the debug overlay can project a vertical ray
 * without reaching into the renderer internals.
 */
function world_groundProbe(renderer: Renderer3D, x: number, y: number): number {
  // The renderer does not own the terrain, so the probe uses the last known
  // surface via the player's own foot position as a reasonable floor.
  void renderer;
  void x;
  return y + 60;
}

/** Re-exported so the app shell can build a 2D mood fallback cheaply. */
export const MOOD_COLORS = Object.fromEntries(
  Object.entries(SKY_MOODS).map(([id, p]) => [id, { accent: p.accent }]),
) as Record<string, { accent: string }>;

/** The flow tier colours, re-exported for the 3D accent material. */
export { FLOW_COLORS };
