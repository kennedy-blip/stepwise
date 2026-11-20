/**
 * Rooftop dressing.
 *
 * The walkable slabs are the plain boxes the simulation describes. This
 * module adds the things that make a rooftop read as a real place rather
 * than a grey plank: a parapet wall along the front lip, a crisp rim strip
 * catching the key light, expansion seams, rooftop plant (air handlers,
 * vents, ducts), and puddles that reflect the sky.
 *
 * Everything here is decorative. It lives strictly behind the Z = 0
 * traversal plane and never reaches the lane the runner occupies, so it
 * can never change what the player sees at the moment of a landing.
 *
 * All geometry comes from the shared pool in `world3d.ts`, so the whole
 * dressing layer costs a handful of buffers.
 */

import * as THREE from 'three';
import { DEPTH, simX, simY } from './units';

/** A deterministic hash, so dressing is stable across frames. */
function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * How much of the building face below a rooftop is skinned with windows.
 *
 * The camera looks slightly down at the roof, so only the top few storeys
 * of the building are ever visible. Skinning the full height would paint a
 * wall across the bottom of the frame and hide the street canyon.
 */
const FACADE_HEIGHT_CAP_M = 7.5;

/** The kind of rooftop plant to place at a given dressing slot. */
export type DressingKind = 'ac' | 'vent' | 'duct' | 'pipe' | 'crate' | 'antenna';

export interface DressingSlot {
  kind: DressingKind;
  /** Offset along the slab, in metres from the slab's left edge. */
  x: number;
  /** Offset back from the front lip, in metres. */
  z: number;
  /** Uniform scale. */
  scale: number;
  /** Y rotation, radians. */
  yaw: number;
}

/**
 * Chooses the dressing for a rooftop.
 *
 * The layout is derived from the slab's identity and size, so it is stable
 * while the slab is on screen and does not shimmer as the camera moves.
 */
export function dressingFor(
  slabSeed: number,
  slabWidthMetres: number,
  slabDepthMetres: number,
): DressingSlot[] {
  const slots: DressingSlot[] = [];
  if (slabWidthMetres < 2.5) return slots;

  // How much plant a roof carries depends on how big it is.
  const budget = Math.min(7, Math.floor(slabWidthMetres / 2.2));
  const kinds: DressingKind[] = ['ac', 'vent', 'duct', 'crate', 'antenna', 'pipe'];

  for (let i = 0; i < budget; i++) {
    const r1 = hash(slabSeed * 3.7 + i * 1.13);
    const r2 = hash(slabSeed * 5.1 + i * 2.71);
    const r3 = hash(slabSeed * 7.9 + i * 4.37);
    const r4 = hash(slabSeed * 11.3 + i * 6.19);

    // Keep a clear lane: plant sits behind the front lip, never on it.
    const z = -(slabDepthMetres / 2) + 0.55 + r3 * Math.max(0.2, slabDepthMetres - 1.1);
    const x = 0.6 + r2 * Math.max(0.4, slabWidthMetres - 1.4);

    slots.push({
      kind: kinds[Math.floor(r1 * kinds.length) % kinds.length],
      x,
      z: -Math.abs(z),
      scale: 0.72 + r4 * 0.5,
      yaw: (r1 - 0.5) * 0.7,
    });
  }
  return slots;
}

/**
 * Builds the mesh for one dressing slot.
 *
 * The returned mesh is positioned in the SLAB's local space: X along the
 * roof, Z across its depth, with the front lip at +Z.
 */
export function buildDressing(
  slot: DressingSlot,
  unitBox: THREE.BufferGeometry,
  unitCylinder: (segments: number) => THREE.BufferGeometry,
  materials: {
    metal: THREE.Material;
    darkMetal: THREE.Material;
    vent: THREE.Material;
    crate: THREE.Material;
  },
): THREE.Group {
  const group = new THREE.Group();
  group.position.set(slot.x, 0, slot.z);
  group.rotation.y = slot.yaw;
  group.scale.setScalar(slot.scale);

  const box = (w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh => {
    const m = new THREE.Mesh(unitBox, mat);
    m.scale.set(w, h, d);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };
  const cyl = (
    radius: number,
    length: number,
    segments: number,
    mat: THREE.Material,
  ): THREE.Mesh => {
    const m = new THREE.Mesh(unitCylinder(segments), mat);
    m.scale.set(radius * 2, length, radius * 2);
    m.castShadow = true;
    return m;
  };

  switch (slot.kind) {
    case 'ac': {
      // A rooftop air handler: a boxy housing with a fan grille on top.
      const housing = box(0.95, 0.52, 0.72, materials.metal);
      housing.position.y = 0.26;
      group.add(housing);

      const grille = cyl(0.26, 0.06, 10, materials.darkMetal);
      grille.position.set(0.18, 0.54, 0);
      group.add(grille);

      const lip = box(1.0, 0.06, 0.78, materials.darkMetal);
      lip.position.y = 0.53;
      group.add(lip);
      break;
    }
    case 'vent': {
      // A mushroom vent with a spinning cap.
      const stem = cyl(0.11, 0.3, 8, materials.darkMetal);
      stem.position.y = 0.15;
      group.add(stem);

      const cap = cyl(0.2, 0.1, 10, materials.vent);
      cap.position.y = 0.34;
      group.add(cap);
      break;
    }
    case 'duct': {
      // A run of ducting on short legs.
      const run = box(1.3, 0.34, 0.42, materials.metal);
      run.position.y = 0.4;
      group.add(run);

      for (const lx of [-0.45, 0.45]) {
        const leg = box(0.1, 0.26, 0.36, materials.darkMetal);
        leg.position.set(lx, 0.13, 0);
        group.add(leg);
      }
      break;
    }
    case 'pipe': {
      // A conduit run on the roof.
      const run = cyl(0.08, 1.4, 8, materials.metal);
      run.rotation.z = Math.PI / 2;
      run.position.y = 0.2;
      group.add(run);

      for (const lx of [-0.5, 0.5]) {
        const post = cyl(0.05, 0.2, 6, materials.darkMetal);
        post.position.set(lx, 0.1, 0);
        group.add(post);
      }
      break;
    }
    case 'crate': {
      // A shipping crate, slightly askew.
      const boxMesh = box(0.6, 0.5, 0.5, materials.crate);
      boxMesh.position.y = 0.25;
      boxMesh.rotation.y = 0.18;
      group.add(boxMesh);
      break;
    }
    case 'antenna': {
      // A slim mast with a dish.
      const mast = cyl(0.035, 1.5, 6, materials.darkMetal);
      mast.position.y = 0.75;
      group.add(mast);

      const dish = cyl(0.16, 0.06, 10, materials.metal);
      dish.position.set(0.12, 1.2, 0);
      dish.rotation.z = 0.7;
      group.add(dish);
      break;
    }
    default:
      break;
  }
  return group;
}

/**
 * The front parapet lip.
 *
 * Sits at `DEPTH.parapet` (Z = +1.28), which is flush with or a hair
 * below the walk surface, so it never hides the landing edge. It gives the
 * roof a physical boundary and catches the key light.
 */
export function buildParapet(
  widthMetres: number,
  unitBox: THREE.BufferGeometry,
  material: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();

  // The lip itself: a thin wall along the front edge. Its FRONT face must
  // sit exactly at DEPTH.parapet (Z = +1.28), so the wall is pushed back
  // by half its depth rather than centred on the line.
  const lipDepth = 0.1;
  const lip = new THREE.Mesh(unitBox, material);
  lip.scale.set(widthMetres, 0.16, lipDepth);
  lip.position.set(0, -0.08, DEPTH.parapet - lipDepth / 2);
  lip.receiveShadow = true;
  lip.castShadow = true;
  group.add(lip);

  // A crisp rim strip on top of the lip, catching the key light. It is
  // slightly proud of the wall behind it but must not cross the lip line.
  const rimDepth = 0.12;
  const rim = new THREE.Mesh(unitBox, material);
  rim.scale.set(widthMetres, 0.035, rimDepth);
  rim.position.set(0, 0.018, DEPTH.parapet - rimDepth / 2);
  group.add(rim);

  return group;
}

/**
 * Expansion seams across the roof surface.
 *
 * Real roofs are poured in panels with a joint every few metres. The seams
 * break up the large flat area and give the eye something to read depth
 * against.
 */
export function buildSeams(
  widthMetres: number,
  depthMetres: number,
  unitBox: THREE.BufferGeometry,
  material: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  const count = Math.max(1, Math.floor(widthMetres / 3.2));

  for (let i = 1; i <= count; i++) {
    const x = -widthMetres / 2 + (i * widthMetres) / (count + 1);
    const seam = new THREE.Mesh(unitBox, material);
    seam.scale.set(0.05, 0.012, depthMetres * 0.92);
    seam.position.set(x, 0.006, 0);
    group.add(seam);
  }
  return group;
}

/**
 * A shallow puddle that mirrors the sky.
 *
 * Puddles are the cheapest way to make a flat roof look wet and alive; a
 * low-roughness plane with a faint reflective tint reads as standing
 * water catching the sky.
 */
export function buildPuddle(
  widthMetres: number,
  depthMetres: number,
  seed: number,
  unitBox: THREE.BufferGeometry,
  material: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  const count = Math.min(3, 1 + Math.floor(hash(seed * 3.1) * 3));

  for (let i = 0; i < count; i++) {
    const r1 = hash(seed * 5.3 + i * 1.7);
    const r2 = hash(seed * 7.9 + i * 3.3);
    const puddle = new THREE.Mesh(unitBox, material);
    const w = 0.7 + r1 * 1.9;
    const d = 0.5 + r2 * 1.1;
    puddle.scale.set(w, 0.008, d);
    puddle.position.set(
      (r1 - 0.5) * Math.max(0.2, widthMetres - w),
      0.008,
      (r2 - 0.5) * Math.max(0.2, depthMetres - d),
    );
    group.add(puddle);
  }
  return group;
}

/**
 * The building face below a rooftop.
 *
 * The playable slabs are extruded boxes. From the camera, the near vertical
 * face of a roof block fills a large part of the lower frame. Left as bare
 * concrete it reads as a grey plank rather than the top of a building, so
 * the face is skinned with a window-grid facade and a darker plinth at the
 * base.
 *
 * The facade is a flat panel placed just proud of the slab's front face,
 * so it never changes the shape of the collision surface.
 */
export function buildFacade(
  widthMetres: number,
  heightMetres: number,
  unitBox: THREE.BufferGeometry,
  material: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  if (widthMetres <= 0.2 || heightMetres <= 0.2) return group;

  // Only the top of the building is ever in frame. Skins the full height
  // would paint a wall across the bottom of the screen, so the facade is
  // capped and the rest of the building is left to the fog.
  const shown = Math.min(heightMetres, FACADE_HEIGHT_CAP_M);

  // The panel is a thin box: wide, tall and very shallow, so it sits on
  // the face of the block without poking into the play lane. Its front
  // face stops exactly at the parapet line, so nothing the facade adds
  // can ever cross in front of the landing edge.
  const panelDepth = 0.06;
  const panel = new THREE.Mesh(unitBox, material);
  panel.scale.set(widthMetres * 0.995, shown * 0.99, panelDepth);
  panel.position.set(0, -shown / 2, DEPTH.parapet - panelDepth / 2);
  panel.receiveShadow = true;
  group.add(panel);

  // A darker plinth along the top of the facade, right under the roof
  // line, reads as the building's cornice.
  const corniceDepth = 0.1;
  const cornice = new THREE.Mesh(unitBox, material);
  cornice.scale.set(widthMetres * 1.01, 0.14, corniceDepth);
  cornice.position.set(0, -0.07, DEPTH.parapet - corniceDepth / 2);
  group.add(cornice);

  // A ledge every few floors breaks the face into storeys.
  const bands = Math.max(1, Math.floor(shown / 3.4));
  for (let i = 1; i < bands; i++) {
    const y = -(i * shown) / bands;
    const bandDepth = 0.085;
    const band = new THREE.Mesh(unitBox, material);
    band.scale.set(widthMetres * 1.006, 0.07, bandDepth);
    band.position.set(0, y, DEPTH.parapet - bandDepth / 2);
    group.add(band);
  }

  return group;
}

/**
 * Builds the whole dressing group for one slab, in the slab's local space.
 *
 * The caller positions and rotates the group to match the slab.
 */
export function buildRooftopDressing(
  slab: { x: number; y: number; w: number; h: number; angle: number },
  slabSeed: number,
  unitBox: THREE.BufferGeometry,
  unitCylinder: (segments: number) => THREE.BufferGeometry,
  materials: {
    metal: THREE.Material;
    darkMetal: THREE.Material;
    vent: THREE.Material;
    crate: THREE.Material;
    seam: THREE.Material;
    puddle: THREE.Material;
    parapet: THREE.Material;
    facade: THREE.Material;
  },
): THREE.Group {
  const widthMetres = slab.w / 40;
  const depthMetres = DEPTH.playableHalf * 2;

  const group = new THREE.Group();
  group.position.set(simX(slab.x + slab.w / 2), simY(slab.y), 0);
  group.rotation.z = -slab.angle;

  group.add(buildFacade(widthMetres, slab.h / 40, unitBox, materials.facade));
  group.add(buildParapet(widthMetres, unitBox, materials.parapet));
  group.add(buildSeams(widthMetres, depthMetres, unitBox, materials.seam));
  group.add(buildPuddle(widthMetres, depthMetres, slabSeed, unitBox, materials.puddle));

  for (const slot of dressingFor(slabSeed, widthMetres, depthMetres)) {
    group.add(
      buildDressing(slot, unitBox, unitCylinder, {
        metal: materials.metal,
        darkMetal: materials.darkMetal,
        vent: materials.vent,
        crate: materials.crate,
      }),
    );
  }

  return group;
}
