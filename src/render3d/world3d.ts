/**
 * The 3D world: extruded rooftops, interactive props and the background city.
 *
 * All walkable geometry lives on the `Z = 0` plane and is driven directly by
 * the 2D simulation's slabs and hazards. Nothing in this module feeds back
 * into the simulation — it is a pure projection of simulation state into 3D.
 *
 * Depth bands (see `units.ts`):
 *  - `Z = 0`      : playable lane, extruded -1.3 .. +1.3
 *  - `Z = +1.28`  : front parapet lip, flush with or just below the surface
 *  - `Z = -4.5 .. -15` : near-background city
 *  - `Z = -22 .. -65`   : deep skyline silhouettes
 */

import * as THREE from 'three';
import type { Slab } from '../core/types';
import type { Hazard, Terrain } from '../physics/terrain';
import { LIGHTING_PRESETS, type LightingPreset } from './lighting3d';
import { DEPTH, simX, simY } from './units';
import { buildRooftopDressing } from './rooftop3d';

/**
 * How far from the camera (in metres) rooftop dressing is built.
 *
 * Just past the far edge of the frame, so detail fades out before the
 * player can see it end.
 */
const DRESSING_RADIUS_M = 46;

/**
 * Horizontal spacing between near-city towers, in metres.
 */
const NEAR_CITY_SPACING_M = 7.5;

/**
 * Horizontal spacing between deep-skyline towers, in metres.
 */
const DEEP_CITY_SPACING_M = 11;

/**
 * How far the near city scrolls in one step, in metres.
 *
 * Must be a whole number of tower spacings so the pattern tiles without a
 * seam.
 */
const NEAR_CITY_TILE_M = 30 * NEAR_CITY_SPACING_M;

/** How far the deep skyline scrolls in one step, in metres. */
const DEEP_CITY_TILE_M = 52 * DEEP_CITY_SPACING_M;

/**
 * How far from the camera (in metres) a rooftop is drawn.
 *
 * Comfortably wider than the visible frame at the current FOV, so roofs
 * never pop in at the edge of the screen.
 */
const SLAB_RADIUS_M = 70;
import {
  concreteRoughness,
  concreteTexture,
  facadeTexture,
  glassTexture,
  gravelTexture,
  metalRoughness,
  metalTexture,
  windowTexture,
  woodTexture,
} from './textures3d';

/** Materials indexed by the simulation's surface material names. */
type MaterialMap = Record<string, THREE.MeshStandardMaterial>;

export interface World3DOptions {
  /** Number of background towers to build in each depth band. */
  towerCount?: number;
  /** Deterministic seed for the background city layout. */
  seed?: number;
}

/** Deterministic pseudo-random helper for the background city. */
function hash(seed: number): number {
  const t = Math.sin(seed * 127.1) * 43758.5453;
  return t - Math.floor(t);
}

/**
 * The 3D world. Owns the static scene graph and keeps it synchronised with
 * the simulation terrain.
 */
export class World3D {
  readonly group = new THREE.Group();

  /** Materials for the walkable surfaces. */
  private materials: MaterialMap = {};
  /** Materials for props (pipes, vents, planks, glass). */
  private propMaterials: MaterialMap = {};

  /** Live rooftop meshes, keyed by the slab they represent. */
  private slabMeshes = new Map<Slab, THREE.Mesh>();

  /** Rooftop dressing (parapet, seams, plant, puddles), keyed by slab. */
  private dressingGroups = new Map<Slab, THREE.Group>();

  /**
   * A pool of reusable geometry buffers, keyed by a shape signature.
   *
   * Rooftops, props and debris are created and retired constantly as the
   * camera scrolls. Allocating fresh buffers each time causes GC stutters
   * mid-run, so shapes are cached and reused instead. Only genuinely new
   * shape signatures allocate.
   */
  private geometryPool = new Map<string, THREE.BufferGeometry>();
  /** Live prop groups, keyed by the hazard they represent. */
  private hazardGroups = new Map<Hazard, THREE.Group>();
  /** Debris pieces for broken planks and glass. */
  private debris: { mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3; life: number }[] =
    [];

  /** Background city groups, repositioned rather than rebuilt. */
  private nearCity = new THREE.Group();
  private deepCity = new THREE.Group();
  /** Emissive window planes on the near background towers. */
  private windowMaterials: THREE.MeshBasicMaterial[] = [];

  /** The current lighting preset, used to tint materials. */
  private preset: LightingPreset = LIGHTING_PRESETS.dusk;

  private readonly towerCount: number;
  private readonly seed: number;

  constructor(options: World3DOptions = {}) {
    this.towerCount = options.towerCount ?? 26;
    this.seed = options.seed ?? 20260101;
    this.group.add(this.nearCity);
    this.group.add(this.deepCity);
  }

  /** Builds the materials and the background city. Call once at boot. */
  build(): void {
    this.buildMaterials();
    this.buildBackgroundCity();
  }

  /** (Re)builds the surface materials for a lighting preset. */
  private buildMaterials(): void {
    for (const mat of Object.values(this.materials)) mat.dispose();
    for (const mat of Object.values(this.propMaterials)) mat.dispose();
    this.materials = {};
    this.propMaterials = {};
    this.windowMaterials = [];

    const concrete = concreteTexture(this.preset.roofTint);
    const concreteRough = concreteRoughness();
    const metal = metalTexture('#59616f');
    const metalRough = metalRoughness();
    const glass = glassTexture('#1d2a38');
    const wood = woodTexture('#4a382c');
    const gravel = gravelTexture(this.preset.roofTint);

    this.materials.concrete = new THREE.MeshStandardMaterial({
      map: concrete,
      roughnessMap: concreteRough,
      roughness: this.preset.roofRoughness,
      metalness: 0.05,
    });
    this.materials.metal = new THREE.MeshStandardMaterial({
      map: metal,
      roughnessMap: metalRough,
      roughness: Math.min(0.85, this.preset.roofRoughness + 0.02),
      metalness: 0.72,
    });
    this.materials.glass = new THREE.MeshStandardMaterial({
      map: glass,
      roughness: 0.18,
      metalness: 0.55,
      transparent: true,
      opacity: 0.86,
    });
    this.materials.wood = new THREE.MeshStandardMaterial({
      map: wood,
      roughness: 0.88,
      metalness: 0.02,
    });

    // A rough gravel overlay is used on the top surface of wide roofs so
    // they catch the key light with texture rather than reading as a slab.
    this.propMaterials.gravel = new THREE.MeshStandardMaterial({
      map: gravel,
      roughness: 0.95,
      metalness: 0.02,
    });
    // The near face of a rooftop block. Without this the block reads as a
    // plain grey box, which is what makes a rooftop look like a plank.
    this.propMaterials.facade = new THREE.MeshStandardMaterial({
      map: facadeTexture(this.preset.facadeTint),
      roughness: 0.78,
      metalness: 0.12,
    });
    this.propMaterials.pipe = new THREE.MeshStandardMaterial({
      color: '#5a6070',
      roughness: 0.42,
      metalness: 0.78,
    });
    this.propMaterials.darkMetal = new THREE.MeshStandardMaterial({
      color: '#3d434f',
      roughness: 0.6,
      metalness: 0.6,
    });
    this.propMaterials.plank = new THREE.MeshStandardMaterial({
      color: '#8a5c39',
      roughness: 0.9,
      metalness: 0.02,
    });
    this.propMaterials.glassPane = new THREE.MeshStandardMaterial({
      color: '#9fd8f0',
      roughness: 0.12,
      metalness: 0.3,
      transparent: true,
      opacity: 0.55,
      emissive: '#2b5c72',
      emissiveIntensity: 0.35,
    });
    this.propMaterials.vent = new THREE.MeshStandardMaterial({
      color: '#464d5b',
      roughness: 0.55,
      metalness: 0.65,
    });

    // --- Rooftop dressing ------------------------------------------------
    // A weathered crate for the yard clutter.
    this.propMaterials.crate = new THREE.MeshStandardMaterial({
      color: '#6b5238',
      roughness: 0.92,
      metalness: 0.02,
    });
    // Expansion joints: slightly darker and rougher than the deck.
    this.propMaterials.seam = new THREE.MeshStandardMaterial({
      color: '#1d2029',
      roughness: 0.98,
      metalness: 0.0,
    });
    // The parapet lip: a touch lighter than the deck so the roof edge
    // reads clearly against the city behind it.
    this.propMaterials.parapet = new THREE.MeshStandardMaterial({
      color: '#565d6e',
      roughness: 0.8,
      metalness: 0.08,
    });
    // Standing water: near-mirror, so it catches the sky and the sun.
    this.propMaterials.puddle = new THREE.MeshStandardMaterial({
      color: '#2c3548',
      roughness: 0.06,
      metalness: 0.9,
      transparent: true,
      opacity: 0.82,
      envMapIntensity: 1.4,
    });
  }

  /** Applies a lighting preset, refreshing materials and city tints. */
  applyPreset(preset: LightingPreset, mood: string): void {
    this.preset = preset;
    this.buildMaterials();
    this.rebuildWindows(mood);
  }

  /**
   * Rebuilds the emissive window grids for the background city.
   */
  private rebuildWindows(mood: string): void {
    for (const mat of this.windowMaterials) mat.dispose();
    this.windowMaterials = [];

    const tex = windowTexture(this.preset.windowColor, this.preset.windowDensity, mood);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.windowMaterials.push(mat);
    this.nearCity.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.userData.isWindowPlane) {
        obj.material = mat;
      }
    });
  }

  /**
   * Builds the background city: a near band of detailed rooftops and a deep
   * band of tall silhouettes, both recycled as the camera moves.
   */
  private buildBackgroundCity(): void {
    const bodyMat = new THREE.MeshStandardMaterial({
      color: this.preset.roofTint,
      roughness: 0.9,
      metalness: 0.08,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: '#161a26',
      roughness: 0.95,
      metalness: 0.04,
    });

    // The deep skyline is a silhouette, not a building. It is lit only by
    // the sky, so it uses an unlit material tinted toward the fog colour.
    // A fully shaded material turns these towers into black holes punched
    // in the sky, which is exactly what a distant skyline must not be.
    const silhouetteMat = new THREE.MeshBasicMaterial({
      color: this.preset.fogColor,
      fog: true,
    });
    this.windowMaterials.push(silhouetteMat);

    // The deep skyline gets a much sparser window sheet than the near
    // city, and a dimmer one, so the distance reads as distance.
    const deepWinTex = windowTexture(
      this.preset.windowColor,
      this.preset.windowDensity * 0.35,
      'deep',
    );
    const deepWinMat = new THREE.MeshBasicMaterial({
      map: deepWinTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.28,
    });
    this.windowMaterials.push(deepWinMat);

    const winTex = windowTexture(this.preset.windowColor, this.preset.windowDensity, 'init');
    const winMat = new THREE.MeshBasicMaterial({
      map: winTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.windowMaterials.push(winMat);

    // --- Near band: neighbouring rooftops with detail -----------------------
    for (let i = 0; i < this.towerCount; i++) {
      const h = 3 + hash(i * 3.1 + this.seed) * 7;
      const w = 2.4 + hash(i * 7.7 + this.seed) * 4.4;
      const d = 2 + hash(i * 11.3 + this.seed) * 3.5;
      const x = (i - this.towerCount / 2) * 9 + hash(i * 5.5) * 5;
      const z = DEPTH.nearBack.near - hash(i * 2.3) * (DEPTH.nearBack.near - DEPTH.nearBack.far);
      const y = -4 - hash(i * 13.7) * 6;

      const tower = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bodyMat);
      body.receiveShadow = false;
      body.position.y = h / 2;
      body.castShadow = false;
      body.receiveShadow = false;
      tower.add(body);

      // Emissive window plane on the camera-facing side.
      const win = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.92, h * 0.92), winMat);
      win.position.set(0, h / 2, d / 2 + 0.02);
      win.userData.isWindowPlane = true;
      tower.add(win);

      // Rooftop clutter: a water tower or a small block.
      if (hash(i * 17.3) > 0.45) {
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.9, 8), darkMat);
        tank.position.set(hash(i * 19.1) * w - w / 2, h + 0.45, 0);
        tower.add(tank);
        const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.7, 5), darkMat);
        legs.position.copy(tank.position);
        legs.position.y = h + 0.1;
        tower.add(legs);
      } else {
        const box = new THREE.Mesh(new THREE.BoxGeometry(w * 0.35, 0.8, d * 0.5), darkMat);
        box.position.set(hash(i * 23.3) * w - w / 2, h + 0.4, 0);
        tower.add(box);
      }

      tower.position.set(x, y, z);
      this.nearCity.add(tower);
    }

    // --- Deep band: tall silhouettes ---------------------------------------
    const deepCount = Math.round(this.towerCount * 2.4);
    for (let i = 0; i < deepCount; i++) {
      const h = 10 + hash(i * 31.1 + this.seed) * 22;
      const w = 5 + hash(i * 37.7 + this.seed) * 11;
      const d = 5 + hash(i * 41.3 + this.seed) * 9;
      const x = (i - deepCount / 2) * DEEP_CITY_SPACING_M + hash(i * 43.9) * 9;
      const z =
        DEPTH.deepSkyline.near - hash(i * 47.3) * (DEPTH.deepSkyline.near - DEPTH.deepSkyline.far);

      const tower = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), silhouetteMat);
      // Sunk so the tops land near the horizon rather than towering over
      // the player. The tallest tower's crown must still stay below the
      // rooftop line the player runs on.
      tower.position.set(x, h / 2 - 21, z);
      this.deepCity.add(tower);

      // A dim window sheet on the camera-facing side. The deep towers are
      // silhouettes, but a scattering of lights sells the distance.
      const deepWin = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.86, h * 0.86), deepWinMat);
      deepWin.position.set(x, h / 2 - 21, z + d / 2 + 0.05);
      this.deepCity.add(deepWin);

      // A slim crown on the tallest towers breaks up the flat skyline.
      if (hash(i * 53.1 + this.seed) > 0.62) {
        const crown = new THREE.Mesh(
          new THREE.BoxGeometry(w * 0.28, 3 + hash(i * 59.3) * 6, d * 0.28),
          silhouetteMat,
        );
        crown.position.set(x + (hash(i * 61.7) - 0.5) * w * 0.4, h - 18, z);
        this.deepCity.add(crown);
      }
    }
  }

  /**
   * Synchronises the 3D scene with the simulation terrain.
   *
   * Rooftops that scroll out of view are disposed and their meshes released,
   * so long runs do not accumulate geometry.
   */
  sync(terrain: Terrain, cameraX: number): void {
    const slabs = terrain.slabs;
    const seen = new Set<Slab>();

    for (const slab of slabs) {
      seen.add(slab);
      let mesh = this.slabMeshes.get(slab);
      if (!mesh) {
        mesh = this.createSlabMesh(slab);
        this.slabMeshes.set(slab, mesh);
        this.group.add(mesh);
      }
      this.updateSlabMesh(mesh, slab);
      // Slabs far outside the frame are hidden rather than removed: they
      // may come back into view, and removing them would mean rebuilding
      // the mesh every time the camera turns around.
      const centreX = slab.x + slab.w / 2;
      mesh.visible = Math.abs(centreX - cameraX) / 40 <= SLAB_RADIUS_M;
    }

    // Retire slabs that are gone (new level) or scrolled off screen.
    // The geometry is pooled, so it is NOT disposed here.
    for (const [slab, mesh] of this.slabMeshes) {
      if (seen.has(slab)) continue;
      this.group.remove(mesh);
      this.slabMeshes.delete(slab);
    }

    // Rooftop dressing follows the slabs it belongs to.
    //
    // The dressing is only built for roofs near the camera. A level holds
    // hundreds of slabs but only a handful are ever on screen, and dressing
    // every one of them would cost thousands of draw calls for detail the
    // player can never see.
    for (const slab of slabs) {
      const centreX = slab.x + slab.w / 2;
      const distance = Math.abs(centreX - cameraX) / 40;
      const near = distance <= DRESSING_RADIUS_M;
      const far = distance > DRESSING_RADIUS_M * 1.6;

      let dressing = this.dressingGroups.get(slab);
      if (near && !dressing) {
        dressing = this.createDressingGroup(slab);
        this.dressingGroups.set(slab, dressing);
        this.group.add(dressing);
      } else if (far && dressing) {
        this.group.remove(dressing);
        this.releaseGroup(dressing);
        this.dressingGroups.delete(slab);
        dressing = undefined;
      }
      if (dressing) dressing.visible = near;
    }
    for (const [slab, dressing] of this.dressingGroups) {
      if (seen.has(slab)) continue;
      this.group.remove(dressing);
      this.releaseGroup(dressing);
      this.dressingGroups.delete(slab);
    }

    // Props.
    const hazards = terrain.hazards;
    const seenHazards = new Set<Hazard>();
    for (const hazard of hazards) {
      seenHazards.add(hazard);
      let group = this.hazardGroups.get(hazard);
      if (!group) {
        group = this.createHazardGroup(hazard);
        this.hazardGroups.set(hazard, group);
        this.group.add(group);
      }
      this.updateHazardGroup(group, hazard);
      // Props far outside the frame are hidden. They are kept in the map so
      // that scrolling back does not have to rebuild them.
      const centreX = hazard.x + hazard.w / 2;
      group.visible = Math.abs(centreX - cameraX) / 40 <= SLAB_RADIUS_M;
    }
    for (const [hazard, group] of this.hazardGroups) {
      if (seenHazards.has(hazard)) continue;
      this.group.remove(group);
      // Geometry is pooled, so it is released rather than disposed.
      this.releaseGroup(group);
      this.hazardGroups.delete(hazard);
    }

    // Recycle the background city around the camera.
    // The city scrolls with the camera so there is always a skyline behind
    // the runner. It snaps in whole tiles, so the buildings never appear to
    // slide sideways; the tile width divides the spacing of the towers so
    // the pattern repeats seamlessly.
    // `cameraX` arrives in simulation pixels, so it has to be converted to
    // metres before it is compared against the city tile sizes.
    const cameraMetres = cameraX / 40;
    this.nearCity.position.x = Math.round(cameraMetres / NEAR_CITY_TILE_M) * NEAR_CITY_TILE_M;
    this.deepCity.position.x = Math.round(cameraMetres / DEEP_CITY_TILE_M) * DEEP_CITY_TILE_M;
  }

  /**
   * Returns a pooled geometry for the given shape signature.
   *
   * The signature must fully describe the geometry's parameters, so two
   * calls with the same signature always yield an interchangeable buffer.
   */
  private pooledGeometry(
    signature: string,
    build: () => THREE.BufferGeometry,
  ): THREE.BufferGeometry {
    const cached = this.geometryPool.get(signature);
    if (cached) return cached;
    const geo = build();
    this.geometryPool.set(signature, geo);
    return geo;
  }

  /** A pooled unit box, scaled per instance. */
  private unitBox(): THREE.BufferGeometry {
    return this.pooledGeometry('unit-box', () => new THREE.BoxGeometry(1, 1, 1));
  }

  /** A pooled unit cylinder (radius 0.5, height 1), scaled per instance. */
  private unitCylinder(segments: number): THREE.BufferGeometry {
    return this.pooledGeometry(
      `unit-cyl-${segments}`,
      () => new THREE.CylinderGeometry(0.5, 0.5, 1, segments),
    );
  }

  /** A pooled unit torus, scaled per instance. */
  private unitTorus(): THREE.BufferGeometry {
    return this.pooledGeometry('unit-torus', () => new THREE.TorusGeometry(0.5, 0.125, 8, 14));
  }

  /** Releases every pooled geometry buffer. */
  private disposeGeometryPool(): void {
    for (const geo of this.geometryPool.values()) geo.dispose();
    this.geometryPool.clear();
  }

  /**
   * Builds the dressing for one rooftop: parapet, seams, plant and puddles.
   *
   * It is positioned in the slab's local space so it inherits the slab's
   * angle, and it never reaches past the front lip, so it can never hide
   * the landing edge.
   */
  private createDressingGroup(slab: Slab): THREE.Group {
    // A stable seed keeps the layout identical while the slab is on
    // screen, so the dressing does not shimmer as the camera moves.
    const seed = Math.abs(slab.x * 0.37 + slab.y * 0.11 + slab.w * 0.013);
    return buildRooftopDressing(
      slab,
      seed,
      this.unitBox(),
      (segments: number) => this.unitCylinder(segments),
      {
        metal: this.propMaterials.pipe,
        darkMetal: this.propMaterials.darkMetal,
        vent: this.propMaterials.vent,
        crate: this.propMaterials.crate,
        facade: this.propMaterials.facade,
        seam: this.propMaterials.seam,
        puddle: this.propMaterials.puddle,
        parapet: this.propMaterials.parapet,
      },
    );
  }

  /** Creates the mesh for a rooftop slab: an extruded top surface plus a body. */
  private createSlabMesh(slab: Slab): THREE.Mesh {
    const geo = this.pooledGeometry('box1', () => new THREE.BoxGeometry(1, 1, 1));
    const mat = this.materials[slab.material] ?? this.materials.concrete;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /** Positions and scales the slab mesh to match the simulation slab. */
  private updateSlabMesh(mesh: THREE.Mesh, slab: Slab): void {
    const x = simX(slab.x + slab.w / 2);
    const y = simY(slab.y);
    const w = slab.w / 40;
    const h = Math.max(slab.h, 1) / 40;
    const depth = DEPTH.playableHalf * 2;

    mesh.position.set(x, y - h / 2, 0);
    mesh.scale.set(w, h, depth);
    mesh.rotation.z = -slab.angle;

    // Re-point the material when a slab's material changes.
    const wanted = this.materials[slab.material] ?? this.materials.concrete;
    if (mesh.material !== wanted) mesh.material = wanted;
  }

  /**
   * Creates the 3D representation of a hazard.
   *
   * Props are built from simple primitives. Each one keeps its geometry
   * aligned to the `Z = 0` lane so the runner always interacts with the
   * same visual object the simulation is testing against.
   */
  private createHazardGroup(hazard: Hazard): THREE.Group {
    const group = new THREE.Group();
    group.userData.hazard = hazard;

    // All props are built from unit-sized primitives that are scaled to
    // fit. That keeps the number of distinct geometry buffers tiny, so the
    // pool stays small and nothing is allocated once the scene is warm.
    const box = (w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh => {
      const mesh = new THREE.Mesh(this.unitBox(), mat);
      mesh.scale.set(w, h, d);
      return mesh;
    };
    const cyl = (
      radius: number,
      length: number,
      segments: number,
      mat: THREE.Material,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(this.unitCylinder(segments), mat);
      mesh.scale.set(radius * 2, length, radius * 2);
      return mesh;
    };

    switch (hazard.kind) {
      case 'pipe': {
        // Horizontal pipe spanning the lane, with supports set back in Z so
        // the runner slides in front of them without clipping.
        const clearance = hazard.meta?.clearance ?? 40;
        const pipeLen = hazard.w / 40;
        const pipe = cyl(0.18, pipeLen, 12, this.propMaterials.pipe);
        pipe.rotation.z = Math.PI / 2;
        pipe.position.set(0, -0.12, 0);
        pipe.castShadow = true;
        group.add(pipe);

        const highlight = cyl(0.07, pipeLen * 0.98, 8, this.propMaterials.darkMetal);
        highlight.rotation.z = Math.PI / 2;
        highlight.position.set(0, -0.06, 0.06);
        group.add(highlight);

        // Support stanchions sit behind the runner at Z = -1.1.
        for (const sx of [0.25, 0.75]) {
          const post = cyl(0.09, clearance / 40 + 0.2, 8, this.propMaterials.darkMetal);
          post.position.set((sx - 0.5) * pipeLen, -clearance / 80 - 0.1, -1.1);
          post.castShadow = true;
          group.add(post);
        }
        break;
      }
      case 'spring': {
        // A compressed coil spring that launches the runner.
        const base = cyl(0.28, 0.12, 12, this.propMaterials.darkMetal);
        base.position.y = -0.16;
        base.castShadow = true;
        group.add(base);

        const coil = new THREE.Mesh(this.unitTorus(), this.propMaterials.pipe);
        coil.rotation.x = Math.PI / 2;
        coil.position.y = 0.02;
        group.add(coil);

        const pad = cyl(0.26, 0.08, 12, this.propMaterials.vent);
        pad.position.y = 0.16;
        pad.castShadow = true;
        group.add(pad);
        break;
      }
      case 'plank': {
        // Individual slats so they can visibly tilt and drop.
        const slats = 4;
        for (let i = 0; i < slats; i++) {
          const slat = box(
            hazard.w / 40 / slats - 0.04,
            hazard.h / 40,
            1.4,
            this.propMaterials.plank,
          );
          slat.position.set((i - (slats - 1) / 2) * (hazard.w / 40 / slats), 0, 0);
          slat.castShadow = true;
          slat.userData.slatIndex = i;
          group.add(slat);
        }
        break;
      }
      case 'glass': {
        const pane = box(hazard.w / 40, hazard.h / 40, 1.5, this.propMaterials.glassPane);
        pane.castShadow = true;
        group.add(pane);
        const frame = box(
          hazard.w / 40 + 0.06,
          hazard.h / 40 + 0.06,
          0.08,
          this.propMaterials.darkMetal,
        );
        frame.position.z = 0.72;
        group.add(frame);
        break;
      }
      case 'zipline': {
        const endX = hazard.meta?.endX ?? hazard.x + hazard.w;
        const len = (endX - hazard.x) / 40;
        const cable = cyl(0.035, len, 6, this.propMaterials.pipe);
        cable.rotation.z = Math.PI / 2;
        cable.position.set(0, 0.1, 0);
        group.add(cable);

        for (const sx of [-0.45, 0.45]) {
          const post = cyl(0.07, 1.5, 6, this.propMaterials.darkMetal);
          post.position.set(sx * len, -0.6, 0);
          post.castShadow = true;
          group.add(post);
        }
        break;
      }
      default: {
        const boxMesh = box(
          hazard.w / 40,
          Math.max(0.3, hazard.h / 40),
          1.0,
          this.propMaterials.vent,
        );
        boxMesh.castShadow = true;
        group.add(boxMesh);
        break;
      }
    }
    return group;
  }

  /** Updates a hazard group's transform and broken state. */
  private updateHazardGroup(group: THREE.Group, hazard: Hazard): void {
    const x = simX(hazard.x + hazard.w / 2);
    const y = simY(hazard.y + hazard.h / 2);
    group.position.set(x, y, 0);

    if (hazard.kind === 'plank' && hazard.broken) {
      // The broken plank drops away and its slats tumble as debris.
      group.rotation.z += 0.02;
      group.position.y -= 0.35;
      for (const child of group.children) {
        child.rotation.z += 0.05;
        child.position.y -= 0.06;
      }
      if (!group.userData.debrisSpawned) {
        group.userData.debrisSpawned = true;
        this.spawnDebris(group);
      }
    }
  }

  /** Spawns tumbling debris for a broken prop. */
  private spawnDebris(group: THREE.Group): void {
    for (const child of group.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      const mesh = new THREE.Mesh(child.geometry, child.material as THREE.Material);
      mesh.position.copy(child.position);
      mesh.scale.copy(child.scale);
      this.group.add(mesh);
      this.debris.push({
        mesh,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 2,
          Math.random() * 2.5,
          (Math.random() - 0.5) * 1.5,
        ),
        spin: new THREE.Vector3(Math.random() * 4, Math.random() * 4, Math.random() * 4),
        life: 2.4,
      });
    }
  }

  /** Advances debris physics. */
  updateDebris(dt: number): void {
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      d.vel.y -= 9.8 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
      if (d.life <= 0 || d.mesh.position.y < -30) {
        this.group.remove(d.mesh);
        this.debris.splice(i, 1);
      }
    }
  }

  /**
   * Removes every mesh from a group without disposing its geometry.
   *
   * Used for groups whose geometry comes from the shared pool, so the
   * buffers stay available for the next prop that needs them.
   */
  private releaseGroup(group: THREE.Group): void {
    // NOTE: the children are collected FIRST and removed afterwards.
    // `Object3D.traverse` captures `children.length` before iterating, so
    // removing a child while traversing splices the array out from under
    // the loop and it reads past the end. Collect, then remove.
    for (const obj of collectMeshes(group)) {
      obj.removeFromParent();
    }
  }

  /**
   * Removes every mesh from a group and disposes its geometry.
   *
   * Used for groups that own their geometry outright, such as the
   * background city towers.
   */
  private disposeGroup(group: THREE.Group): void {
    for (const obj of collectMeshes(group)) {
      obj.geometry.dispose();
      obj.removeFromParent();
    }
  }

  /** Disposes every GPU resource owned by the world. */
  dispose(): void {
    for (const mesh of this.slabMeshes.values()) {
      this.group.remove(mesh);
    }
    this.slabMeshes.clear();

    for (const group of this.hazardGroups.values()) {
      this.group.remove(group);
      this.releaseGroup(group);
    }
    this.hazardGroups.clear();

    for (const group of this.dressingGroups.values()) {
      this.group.remove(group);
      this.releaseGroup(group);
    }
    this.dressingGroups.clear();

    // Debris reuses pooled geometry.
    for (const d of this.debris) this.group.remove(d.mesh);
    this.debris.length = 0;

    for (const mat of this.windowMaterials) mat.dispose();
    this.windowMaterials = [];
    this.disposeGroup(this.nearCity);
    this.disposeGroup(this.deepCity);
    for (const mat of Object.values(this.materials)) mat.dispose();
    for (const mat of Object.values(this.propMaterials)) mat.dispose();
    this.disposeGeometryPool();
  }
}

/**
 * Collects every mesh under a node into an array.
 *
 * The array must be built before any removal happens: `Object3D.traverse`
 * caches `children.length` up front, so mutating the child list during the
 * walk makes it index past the end of the array.
 */
function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) meshes.push(obj);
  });
  return meshes;
}
