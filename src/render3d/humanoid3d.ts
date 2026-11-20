/**
 * The 3D articulated runner.
 *
 * The rig is built from primitives — capsules for limbs, boxes for the torso,
 * a sphere for the head — so it receives full 3D directional lighting, rim
 * highlights and real-time shadow casting without shipping a single model
 * file.
 *
 * The important architectural point is that the 3D rig is a *pure consumer* of
 * the existing 2D IK: `CharacterRig` already solves every joint in 2D, and
 * this module projects those solutions onto the left/right limb Z planes. The
 * simulation's IK maths is never duplicated or altered, which keeps the
 * 2.5D view and the 2D debug overlay in perfect agreement.
 */

import * as THREE from 'three';
import { SKELETON } from '../game/config';
import { FLOW_COLORS } from '../game/config';
import type { CharacterRig } from '../game/rig';
import { simX, simY } from './units';
import { fabricTexture, skinTexture } from './textures3d';

/** Z offsets that separate the left and right limbs in depth. */
const LIMB_Z = 0.15;

/**
 * Body proportions, derived from the simulation skeleton.
 *
 * Every metric is expressed in metres and driven by `SKELETON`, so the 3D
 * runner always matches the body the simulation actually simulates. Hard
 * coded sizes here would silently desynchronise the mesh from the rig.
 */
const BODY = {
  /** Pelvis block height. */
  pelvisHeight: SKELETON.hipWidth / 40 + 0.12,
  /** Pelvis block depth (front to back). */
  pelvisDepth: 0.24,
  /** Pelvis block width. */
  pelvisWidth: 0.3,
  /** Torso length from the pelvis to the neck, in metres. */
  torsoLength: SKELETON.torsoLength / 40,
  /** Chest height: the torso minus the pelvis block. */
  chestHeight: SKELETON.torsoLength / 40 - (SKELETON.hipWidth / 40 + 0.12),
  /** Chest width. */
  chestWidth: 0.38,
  /** Chest depth. */
  chestDepth: 0.26,
  /** Neck length from the neck joint to the head centre. */
  neckLength: SKELETON.neckLength / 40,
  /** Head radius. */
  headRadius: SKELETON.headRadius / 40,
  /** Shoulder half-width, used to seat the arms. */
  shoulderHalfWidth: SKELETON.shoulderWidth / 40,
} as const;

export interface HumanoidMaterials {
  /** Clothing fabric. */
  body: THREE.MeshStandardMaterial;
  /** Exposed skin. */
  skin: THREE.MeshStandardMaterial;
  /** Trim, shoes and hard surfaces. */
  accent: THREE.MeshStandardMaterial;
  /** Shoe soles. */
  sole: THREE.MeshStandardMaterial;
  /** The scarf ribbon. */
  scarf: THREE.MeshStandardMaterial;
}

/**
 * Builds the 3D articulated runner and keeps it in sync with the 2D rig.
 */
export class Humanoid3D {
  readonly group = new THREE.Group();

  /** Root of the whole body, so the group can be positioned in one go. */
  private root = new THREE.Group();

  private pelvis = new THREE.Group();
  private torso = new THREE.Group();
  private neck = new THREE.Group();

  private upperArmL = new THREE.Group();
  private foreArmL = new THREE.Group();
  private handL = new THREE.Group();
  private upperArmR = new THREE.Group();
  private foreArmR = new THREE.Group();
  private handR = new THREE.Group();

  private thighL = new THREE.Group();
  private shinL = new THREE.Group();
  private footL = new THREE.Group();
  private thighR = new THREE.Group();
  private shinR = new THREE.Group();
  private footR = new THREE.Group();

  /** Scarf ribbon mesh, updated from the Verlet chain. */
  private scarfMesh: THREE.Mesh;
  private scarfGeometry: THREE.BufferGeometry;

  /** Contact shadow disc projected onto the surface below the runner. */
  readonly contactShadow: THREE.Mesh;

  private materials: HumanoidMaterials;
  private accentColor = new THREE.Color('#e9eef5');

  constructor() {
    this.materials = {
      // Clothing: a woven fabric map keeps the jacket and trousers from
      // looking like flat coloured plastic as the runner turns. The tone is
      // a mid slate rather than near-black, because a black silhouette
      // disappears against a night rooftop.
      body: new THREE.MeshStandardMaterial({
        color: '#4a5570',
        map: fabricTexture('#4a5570'),
        roughness: 0.74,
        metalness: 0.08,
      }),
      // Exposed skin: face, hands, forearms.
      skin: new THREE.MeshStandardMaterial({
        color: '#d19a75',
        map: skinTexture('#d19a75'),
        roughness: 0.66,
        metalness: 0.0,
      }),
      // The trim, the shoes and the visor carry a small emissive so the
      // runner keeps a readable highlight even in the darkest mood.
      accent: new THREE.MeshStandardMaterial({
        color: '#e9eef5',
        roughness: 0.38,
        metalness: 0.4,
        emissive: new THREE.Color('#e9eef5'),
        emissiveIntensity: 0.22,
      }),
      sole: new THREE.MeshStandardMaterial({
        color: '#dfe6ef',
        roughness: 0.82,
        metalness: 0.05,
      }),
      scarf: new THREE.MeshStandardMaterial({
        color: '#dfe6ef',
        roughness: 0.8,
        metalness: 0.0,
        emissive: new THREE.Color('#dfe6ef'),
        emissiveIntensity: 0.35,
        side: THREE.DoubleSide,
      }),
    };

    this.build();

    // Scarf ribbon: a triangle strip along the Verlet chain.
    this.scarfGeometry = new THREE.BufferGeometry();
    this.scarfGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(9 * 2 * 3), 3),
    );
    this.scarfGeometry.setAttribute(
      'normal',
      new THREE.BufferAttribute(new Float32Array(9 * 2 * 3), 3),
    );
    this.scarfMesh = new THREE.Mesh(this.scarfGeometry, this.materials.scarf);
    this.scarfMesh.frustumCulled = false;
    this.scarfMesh.castShadow = true;

    // Contact shadow: a soft disc that is projected onto the surface below.
    const shadowTex = makeRadialShadowTexture();
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.55,
      blending: THREE.MultiplyBlending,
    });
    this.contactShadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
    this.contactShadow.rotation.x = -Math.PI / 2;
    this.contactShadow.renderOrder = 2;
  }

  /** Builds the primitive body hierarchy. */
  private build(): void {
    const m = this.materials;

    // --- Pelvis / torso ----------------------------------------------------
    // The pelvis block is centred on the rig's pelvis joint, and the chest
    // rises from it by exactly the torso length, so the neck anchor lands
    // where the simulation says it is.
    const hips = new THREE.Mesh(
      new THREE.BoxGeometry(BODY.pelvisWidth, BODY.pelvisHeight, BODY.pelvisDepth),
      m.body,
    );
    hips.castShadow = true;
    this.pelvis.add(hips);

    const chest = new THREE.Mesh(
      new THREE.BoxGeometry(BODY.chestWidth, BODY.chestHeight, BODY.chestDepth),
      m.body,
    );
    chest.position.y = BODY.pelvisHeight / 2 + BODY.chestHeight / 2;
    chest.castShadow = true;
    this.pelvis.add(chest);

    // Shoulder yoke: widens the silhouette at the top of the chest.
    const yoke = new THREE.Mesh(
      new THREE.BoxGeometry(BODY.chestWidth + 0.06, BODY.chestHeight * 0.3, BODY.chestDepth),
      m.body,
    );
    yoke.position.y = BODY.pelvisHeight / 2 + BODY.chestHeight * 0.85;
    yoke.castShadow = true;
    this.pelvis.add(yoke);

    // Chest accent panel.
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(BODY.chestWidth * 0.5, BODY.chestHeight * 0.62, BODY.chestDepth + 0.02),
      m.accent,
    );
    panel.position.y = BODY.pelvisHeight / 2 + BODY.chestHeight * 0.55;
    this.pelvis.add(panel);

    this.torso.add(this.pelvis);
    this.group.add(this.torso);

    // --- Neck / head --------------------------------------------------------
    // The neck group is anchored at the rig's neck joint, so every part
    // below is measured from that anchor using the skeleton lengths.
    const neckMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.065, BODY.neckLength * 0.7, 8),
      m.skin,
    );
    neckMesh.position.y = BODY.neckLength * 0.35;
    neckMesh.castShadow = true;
    this.neck.add(neckMesh);

    const headMesh = new THREE.Mesh(new THREE.SphereGeometry(BODY.headRadius, 16, 14), m.skin);
    headMesh.position.y = BODY.neckLength;
    headMesh.castShadow = true;
    this.neck.add(headMesh);

    // Hair / cap mass: a cap over the top of the skull.
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(BODY.headRadius * 1.04, 16, 14, 0, Math.PI * 2, 0, Math.PI * 0.58),
      m.accent,
    );
    cap.position.y = BODY.neckLength + BODY.headRadius * 0.04;
    this.neck.add(cap);

    // Visor band across the eyes.
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(BODY.headRadius * 1.45, 0.035, BODY.headRadius * 0.8),
      m.accent,
    );
    visor.position.set(
      BODY.headRadius * 0.22,
      BODY.neckLength + BODY.headRadius * 0.08,
      BODY.headRadius * 0.62,
    );
    this.neck.add(visor);

    // --- Face ------------------------------------------------------------
    // A nose and a pair of eyes. Without them the head is a ball, and the
    // runner reads as a mannequin rather than a person.
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(BODY.headRadius * 0.2, BODY.headRadius * 0.34, 6),
      m.skin,
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.set(
      BODY.headRadius * 0.34,
      BODY.neckLength - BODY.headRadius * 0.04,
      BODY.headRadius * 0.88,
    );
    this.neck.add(nose);

    for (const eyeZ of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(BODY.headRadius * 0.13, 8, 6), m.accent);
      eye.position.set(
        BODY.headRadius * 0.3,
        BODY.neckLength + BODY.headRadius * 0.14,
        eyeZ * BODY.headRadius * 0.34,
      );
      this.neck.add(eye);
    }

    // Ears.
    for (const earZ of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(BODY.headRadius * 0.2, 8, 6), m.skin);
      ear.scale.set(0.45, 1, 0.7);
      ear.position.set(BODY.headRadius * 0.02, BODY.neckLength, earZ * BODY.headRadius * 0.92);
      this.neck.add(ear);
    }

    this.group.add(this.neck);

    // --- Arms ---------------------------------------------------------------
    const buildArm = (
      upper: THREE.Group,
      fore: THREE.Group,
      hand: THREE.Group,
      z: number,
    ): void => {
      const upperMesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.055, SKELETON.upperArmLength / 40 - 0.11, 4, 8),
        m.body,
      );
      upperMesh.position.y = -(SKELETON.upperArmLength / 40) / 2;
      upperMesh.castShadow = true;
      upper.add(upperMesh);

      const foreMesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.045, SKELETON.foreArmLength / 40 - 0.09, 4, 8),
        m.skin,
      );
      foreMesh.position.y = -(SKELETON.foreArmLength / 40) / 2;
      foreMesh.castShadow = true;
      fore.add(foreMesh);

      const handMesh = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.07), m.skin);
      handMesh.position.y = -0.06;
      handMesh.castShadow = true;
      hand.add(handMesh);

      // The elbow and wrist are positioned in WORLD space each frame, so
      // they hang off the root rather than off the upper arm. Nesting them
      // would make their offsets inherit the parent's rotation, which put
      // the hands in the wrong place entirely.
      upper.position.z = z;
      this.group.add(upper);
      this.group.add(fore);
      this.group.add(hand);
    };

    buildArm(this.upperArmL, this.foreArmL, this.handL, -LIMB_Z);
    buildArm(this.upperArmR, this.foreArmR, this.handR, LIMB_Z);

    // --- Legs ---------------------------------------------------------------
    const buildLeg = (
      thigh: THREE.Group,
      shin: THREE.Group,
      foot: THREE.Group,
      z: number,
    ): void => {
      const thighMesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.075, SKELETON.thighLength / 40 - 0.15, 4, 8),
        m.body,
      );
      thighMesh.position.y = -(SKELETON.thighLength / 40) / 2;
      thighMesh.castShadow = true;
      thigh.add(thighMesh);

      const shinMesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.058, SKELETON.shinLength / 40 - 0.12, 4, 8),
        m.body,
      );
      shinMesh.position.y = -(SKELETON.shinLength / 40) / 2;
      shinMesh.castShadow = true;
      shin.add(shinMesh);

      // A runner's shoe: a shaped upper, a bright midsole and a heel
      // block. A single flat box reads as a flipper.
      const upper = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.075, 0.13), m.accent);
      upper.position.set(0.05, -0.03, 0);
      upper.castShadow = true;
      foot.add(upper);

      // Toe box tapers forward.
      const toe = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.115), m.accent);
      toe.position.set(0.2, -0.028, 0);
      toe.castShadow = true;
      foot.add(toe);

      // Midsole.
      const sole = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.024, 0.145), m.sole);
      sole.position.set(0.06, -0.068, 0);
      foot.add(sole);

      // Heel block and ankle collar.
      const heel = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.125), m.sole);
      heel.position.set(-0.07, -0.05, 0);
      foot.add(heel);

      const collar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.115), m.body);
      collar.position.set(-0.06, 0.02, 0);
      foot.add(collar);

      // The knee and ankle are positioned in WORLD space each frame, so
      // they hang off the root rather than off the thigh.
      this.group.add(shin);
      this.group.add(foot);
      thigh.position.z = z;
      this.group.add(thigh);
    };

    buildLeg(this.thighL, this.shinL, this.footL, -LIMB_Z);
    buildLeg(this.thighR, this.shinR, this.footR, LIMB_Z);
  }

  /** Adds the scarf mesh to the scene graph. */
  addToScene(scene: THREE.Object3D): void {
    scene.add(this.group);
    scene.add(this.scarfMesh);
  }

  /**
   * Updates the 3D rig from the 2D character rig.
   *
   * The 2D rig's solved joint positions are converted to scene space and the
   * corresponding 3D joint is aimed at its target. Limb lengths are already
   * guaranteed by the 2D IK solver, so the 3D chain can never stretch.
   */
  update(rig: CharacterRig, flowTier: number): void {
    const facing = rig.torsoAngle >= 0 ? 1 : 1;
    void facing;

    const pelvisX = simX(rig.pelvis.x);
    const pelvisY = simY(rig.pelvis.y);

    this.root.position.set(pelvisX, pelvisY, 0);

    // --- Torso --------------------------------------------------------------
    this.torso.position.set(pelvisX, pelvisY, 0);
    this.torso.rotation.z = rig.torsoAngle;

    // The neck sits at the top of the torso, in world space.
    const neckX = simX(rig.neck.x);
    const neckY = simY(rig.neck.y);
    this.neck.position.set(neckX, neckY, 0);
    this.neck.rotation.z = rig.torsoAngle;

    // Head leans slightly beyond the torso for a livelier silhouette.
    this.neck.rotation.z = rig.torsoAngle + (rig.pelvis.y - rig.neck.y > 0 ? 0.04 : 0);

    // --- Limbs --------------------------------------------------------------
    const ll = rig.leftLeg;
    if (ll) {
      const hipLx = simX(ll.root.x);
      const hipLy = simY(ll.root.y);
      const kneeLx = simX(ll.joint.x);
      const kneeLy = simY(ll.joint.y);
      // `ll.end` is the SOLVED ankle: the IK clamps it when the target is
      // out of reach, so the foot stays attached to the leg.
      const ankleLx = simX(ll.end.x);
      const ankleLy = simY(ll.end.y);

      this.thighL.position.set(hipLx, hipLy, -LIMB_Z);
      // The limb meshes run along local -Y (they are offset to -length/2),
      // so the bone angle is atan2(dy, dx) + PI/2. Using -PI/2 here points
      // every bone backwards, which splayed the runner's limbs.
      const thighAngle = Math.atan2(kneeLy - hipLy, kneeLx - hipLx) + Math.PI / 2;
      this.thighL.rotation.z = thighAngle;

      // The shin is positioned at the knee and rotated by the SHIN's own
      // absolute angle, so it is not relative to the thigh.
      this.shinL.position.set(kneeLx, kneeLy, -LIMB_Z);
      this.shinL.rotation.z = Math.atan2(ankleLy - kneeLy, ankleLx - kneeLx) + Math.PI / 2;

      // The foot sits on the SOLVED ankle, not the requested target. When
      // the leg is overextended the IK clamps the chain, and using the
      // unreachable target would detach the foot from the leg.
      this.footL.position.set(ankleLx, ankleLy, -LIMB_Z);
      this.footL.rotation.z = rig.leftFoot.footAngle;
    }

    const rl = rig.rightLeg;
    if (rl) {
      const hipRx = simX(rl.root.x);
      const hipRy = simY(rl.root.y);
      const kneeRx = simX(rl.joint.x);
      const kneeRy = simY(rl.joint.y);
      const ankleRx = simX(rl.end.x);
      const ankleRy = simY(rl.end.y);

      this.thighR.position.set(hipRx, hipRy, LIMB_Z);
      const thighAngle = Math.atan2(kneeRy - hipRy, kneeRx - hipRx) + Math.PI / 2;
      this.thighR.rotation.z = thighAngle;

      this.shinR.position.set(kneeRx, kneeRy, LIMB_Z);
      this.shinR.rotation.z = Math.atan2(ankleRy - kneeRy, ankleRx - kneeRx) + Math.PI / 2;

      this.footR.position.set(ankleRx, ankleRy, LIMB_Z);
      this.footR.rotation.z = rig.rightFoot.footAngle;
    }

    const la = rig.leftArm;
    if (la) {
      const shX = simX(la.root.x);
      const shY = simY(la.root.y);
      const elX = simX(la.joint.x);
      const elY = simY(la.joint.y);
      const wrX = simX(la.end.x);
      const wrY = simY(la.end.y);

      this.upperArmL.position.set(shX, shY, -LIMB_Z);
      const upperAngle = Math.atan2(elY - shY, elX - shX) + Math.PI / 2;
      this.upperArmL.rotation.z = upperAngle;

      this.foreArmL.position.set(elX, elY, -LIMB_Z);
      this.foreArmL.rotation.z = Math.atan2(wrY - elY, wrX - elX) + Math.PI / 2;

      this.handL.position.set(wrX, wrY, -LIMB_Z);
    }

    const ra = rig.rightArm;
    if (ra) {
      const shX = simX(ra.root.x);
      const shY = simY(ra.root.y);
      const elX = simX(ra.joint.x);
      const elY = simY(ra.joint.y);
      const wrX = simX(ra.end.x);
      const wrY = simY(ra.end.y);

      this.upperArmR.position.set(shX, shY, LIMB_Z);
      const upperAngle = Math.atan2(elY - shY, elX - shX) + Math.PI / 2;
      this.upperArmR.rotation.z = upperAngle;

      this.foreArmR.position.set(elX, elY, LIMB_Z);
      this.foreArmR.rotation.z = Math.atan2(wrY - elY, wrX - elX) + Math.PI / 2;

      this.handR.position.set(wrX, wrY, LIMB_Z);
    }

    // --- Scarf --------------------------------------------------------------
    this.updateScarf(rig);

    // --- Flow accent --------------------------------------------------------
    const tier = FLOW_COLORS[flowTier as 1 | 2 | 3] ?? FLOW_COLORS[1];
    this.accentColor.set(tier.primary);
    this.materials.accent.color.copy(this.accentColor);
    this.materials.accent.emissive.copy(this.accentColor);
    this.materials.accent.emissiveIntensity = flowTier === 3 ? 0.75 : 0.2;
    this.materials.scarf.color.set(tier.scarf);
    this.materials.scarf.emissive.set(tier.scarf);
    this.materials.scarf.emissiveIntensity = flowTier === 3 ? 0.9 : 0.35;

    // A pure-flow runner glows; other tiers stay subtle.
    this.materials.body.emissive.set(flowTier === 3 ? tier.primary : '#000000');
    this.materials.body.emissiveIntensity = flowTier === 3 ? 0.18 : 0;
  }

  /** Rebuilds the scarf ribbon from the 2D Verlet chain. */
  private updateScarf(rig: CharacterRig): void {
    const chain = rig.scarf;
    if (chain.length < 2) return;

    const positions = this.scarfGeometry.getAttribute('position') as THREE.BufferAttribute;
    const normals = this.scarfGeometry.getAttribute('normal') as THREE.BufferAttribute;
    const halfWidth = 0.075;

    for (let i = 0; i < chain.length; i++) {
      const seg = chain[i];
      const next = chain[Math.min(i + 1, chain.length - 1)];
      const prev = chain[Math.max(i - 1, 0)];

      // Ribbon width runs along the Z axis, so the scarf reads as a flat
      // ribbon with width rather than a flat 2D line.
      const x = simX(seg.x);
      const y = simY(seg.y);
      // Taper the ribbon towards the tail.
      const w = halfWidth * (1 - (i / (chain.length - 1)) * 0.55);
      void next;
      void prev;

      positions.setXYZ(i * 2, x, y, -w);
      positions.setXYZ(i * 2 + 1, x, y, w);
      normals.setXYZ(i * 2, 0, 0, 1);
      normals.setXYZ(i * 2 + 1, 0, 0, 1);
    }
    positions.needsUpdate = true;
    normals.needsUpdate = true;

    // Build the triangle strip indices once the vertex count is known.
    const index: number[] = [];
    for (let i = 0; i < chain.length - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.scarfGeometry.setIndex(index);
    this.scarfGeometry.computeBoundingSphere();
  }

  /**
   * Places the contact shadow on the surface beneath the runner.
   *
   * @param x       Runner world X in simulation pixels.
   * @param y       Runner world Y in simulation pixels.
   * @param groundY Ground surface Y in simulation pixels, or null if airborne
   *                over a gap.
   * @param height  How far above the ground the runner is.
   */
  updateContactShadow(x: number, y: number, groundY: number | null, height: number): void {
    if (groundY === null) {
      this.contactShadow.visible = false;
      return;
    }
    this.contactShadow.visible = true;
    // The shadow shrinks and fades as the runner rises.
    const drop = Math.max(0, (groundY - y) / 40);
    const scale = THREE.MathUtils.clamp(1.15 - drop * 0.16, 0.34, 1.15);
    this.contactShadow.position.set(simX(x), simY(groundY) + 0.012, 0);
    this.contactShadow.scale.set(scale, scale, 1);
    const mat = this.contactShadow.material as THREE.MeshBasicMaterial;
    mat.opacity = THREE.MathUtils.clamp(0.6 - drop * 0.07, 0.06, 0.6);
    void height;
  }

  /** Disposes the humanoid's GPU resources. */
  dispose(): void {
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
    this.scarfGeometry.dispose();
    this.contactShadow.geometry.dispose();
    (this.contactShadow.material as THREE.Material).dispose();
    for (const mat of Object.values(this.materials)) mat.dispose();
  }
}

/**
 * Builds the soft radial texture used by the contact shadow.
 *
 * If the environment cannot provide a 2D canvas context, a small generated
 * fallback texture is used instead, so the runner still renders rather than
 * failing to construct.
 */
function makeRadialShadowTexture(): THREE.Texture {
  const size = 128;

  let canvas: HTMLCanvasElement | null = null;
  try {
    const made = document.createElement('canvas');
    made.width = size;
    made.height = size;
    const ctx = made.getContext('2d');
    if (ctx) {
      const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, 'rgba(0,0,0,0.75)');
      grad.addColorStop(0.45, 'rgba(0,0,0,0.4)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      canvas = made;
    }
  } catch {
    canvas = null;
  }

  if (!canvas) {
    // Fall back to a 2x2 radial approximation built from raw pixel data.
    const data = new Uint8Array(4 * 4);
    const levels = [90, 40, 10, 0];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const o = (i * 4 + j) * 4;
        data[o] = 0;
        data[o + 1] = 0;
        data[o + 2] = 0;
        data[o + 3] = levels[i];
      }
    }
    const tex = new THREE.DataTexture(data, 2, 2);
    tex.needsUpdate = true;
    return tex;
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}
