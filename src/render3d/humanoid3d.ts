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

/** Z offsets that separate the left and right limbs in depth. */
const LIMB_Z = 0.15;

export interface HumanoidMaterials {
  body: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  sole: THREE.MeshStandardMaterial;
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
      body: new THREE.MeshStandardMaterial({
        color: '#1a1d27',
        roughness: 0.62,
        metalness: 0.18,
      }),
      accent: new THREE.MeshStandardMaterial({
        color: '#e9eef5',
        roughness: 0.42,
        metalness: 0.35,
        emissive: new THREE.Color('#e9eef5'),
        emissiveIntensity: 0.2,
      }),
      sole: new THREE.MeshStandardMaterial({
        color: '#dfe6ef',
        roughness: 0.85,
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
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.26), m.body);
    hips.castShadow = true;
    this.pelvis.add(hips);

    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.28), m.body);
    chest.position.y = 0.32;
    chest.castShadow = true;
    this.pelvis.add(chest);

    // Chest accent panel.
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.32, 0.3), m.accent);
    panel.position.set(0, 0.36, 0.005);
    this.pelvis.add(panel);

    this.torso.add(this.pelvis);
    this.group.add(this.torso);

    // --- Neck / head --------------------------------------------------------
    const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.1, 8), m.body);
    neckMesh.position.y = 0.62;
    neckMesh.castShadow = true;
    this.neck.add(neckMesh);

    const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 12), m.body);
    headMesh.position.y = 0.76;
    headMesh.castShadow = true;
    this.neck.add(headMesh);

    // Hair / cap mass.
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.135, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.6),
      m.accent,
    );
    cap.position.y = 0.775;
    this.neck.add(cap);

    // Visor band.
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.035, 0.1), m.accent);
    visor.position.set(0.03, 0.765, 0.08);
    this.neck.add(visor);

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
        m.body,
      );
      foreMesh.position.y = -(SKELETON.foreArmLength / 40) / 2;
      foreMesh.castShadow = true;
      fore.add(foreMesh);

      const handMesh = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.07), m.body);
      handMesh.position.y = -0.06;
      handMesh.castShadow = true;
      hand.add(handMesh);

      upper.add(fore);
      fore.add(hand);
      upper.position.z = z;
      this.group.add(upper);
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

      const footMesh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.07, 0.14), m.body);
      footMesh.position.set(0.06, -0.035, 0);
      footMesh.castShadow = true;
      foot.add(footMesh);

      const sole = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.022, 0.15), m.sole);
      sole.position.set(0.06, -0.07, 0);
      foot.add(sole);

      thigh.add(shin);
      shin.add(foot);
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
      const ankleLx = simX(ll.end.x);
      const ankleLy = simY(ll.end.y);

      this.thighL.position.set(hipLx, hipLy, -LIMB_Z);
      const thighAngle = Math.atan2(kneeLy - hipLy, kneeLx - hipLx) - Math.PI / 2;
      this.thighL.rotation.z = thighAngle;
      this.shinL.rotation.z = Math.atan2(ankleLy - kneeLy, ankleLx - kneeLx) - Math.PI / 2 - thighAngle;
      // Align the foot to the ground normal.
      this.footL.rotation.z = rig.leftFoot.footAngle;
      this.footL.position.set(0, -(SKELETON.shinLength / 40), 0);
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
      const thighAngle = Math.atan2(kneeRy - hipRy, kneeRx - hipRx) - Math.PI / 2;
      this.thighR.rotation.z = thighAngle;
      this.shinR.rotation.z = Math.atan2(ankleRy - kneeRy, ankleRx - kneeRx) - Math.PI / 2 - thighAngle;
      this.footR.rotation.z = rig.rightFoot.footAngle;
      this.footR.position.set(0, -(SKELETON.shinLength / 40), 0);
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
      const upperAngle = Math.atan2(elY - shY, elX - shX) - Math.PI / 2;
      this.upperArmL.rotation.z = upperAngle;
      this.foreArmL.rotation.z = Math.atan2(wrY - elY, wrX - elX) - Math.PI / 2 - upperAngle;
      this.handL.position.set(0, -(SKELETON.foreArmLength / 40), 0);
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
      const upperAngle = Math.atan2(elY - shY, elX - shX) - Math.PI / 2;
      this.upperArmR.rotation.z = upperAngle;
      this.foreArmR.rotation.z = Math.atan2(wrY - elY, wrX - elX) - Math.PI / 2 - upperAngle;
      this.handR.position.set(0, -(SKELETON.foreArmLength / 40), 0);
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
