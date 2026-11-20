/**
 * The articulated character rig.
 *
 * This module owns the SKELETON STATE — pelvis, torso, head, the four limbs and
 * the scarf — but NOT the solving of the limbs (that lives in `physics/ik.ts`).
 *
 * The rig is driven by a small set of high-level animation signals:
 *  - `speed`      : horizontal velocity magnitude (px/s)
 *  - `grounded`   : whether the feet have ground contact
 *  - `state`      : the player's state machine state
 *  - `lean`       : torso lean in radians
 *  - `squash`     : landing squash amount (0..1)
 *
 * Limbs are solved with real 2-bone IK so feet land exactly on the terrain and
 * hands snap onto ledge corners.
 */

import { clamp, damp, lerp } from '../core/math';
import { SKELETON } from './config';
import { solveTwoBoneIK, type IKBone } from '../physics/ik';
import type { PlayerState, Vec2 } from '../core/types';

export interface FootRig {
  /** Hip attachment point in world space. */
  hip: Vec2;
  /** Solved knee position. */
  knee: Vec2;
  /** Solved ankle position. */
  ankle: Vec2;
  /** World-space position of the sole (contact point). */
  toe: Vec2;
  /** Surface normal under the foot. */
  normal: Vec2;
  /** Rotation of the foot to match the surface, radians. */
  footAngle: number;
  /** 0 = planted, 1 = swinging through the air. */
  swing: number;
  /** True when the foot has ground contact this frame. */
  grounded: boolean;
  /** Was the foot grounded last frame (used for footstep detection). */
  wasGrounded: boolean;
  /** How far the sole is lifted above the surface, in pixels. */
  soleLift: number;
  /** Distance from the hip to the ankle target (drives the reach). */
  reach: number;
}

export interface HandRig {
  shoulder: Vec2;
  elbow: Vec2;
  wrist: Vec2;
  swing: number;
  /** True when the hand is gripping a ledge. */
  gripping: boolean;
}

export interface ScarfSegment {
  x: number;
  y: number;
  px: number;
  py: number;
}

export interface RigSignal {
  x: number;
  y: number;
  /** Facing: +1 right, -1 left. */
  facing: number;
  speed: number;
  grounded: boolean;
  state: PlayerState;
  lean: number;
  squash: number;
  /** Surface normal under the pelvis. */
  groundNormal: Vec2;
  /** Vertical velocity, used for landing anticipation. */
  vy: number;
  /** How far the left sole is lifted above the surface, in pixels. */
  leftLift: number;
  /** How far the right sole is lifted above the surface, in pixels. */
  rightLift: number;
}

export class CharacterRig {
  pelvis: Vec2 = { x: 0, y: 0 };
  neck: Vec2 = { x: 0, y: 0 };
  head: Vec2 = { x: 0, y: 0 };
  torsoAngle = 0;

  leftLeg: IKBone | null = null;
  rightLeg: IKBone | null = null;
  leftArm: IKBone | null = null;
  rightArm: IKBone | null = null;

  leftFoot: FootRig = createFoot();
  rightFoot: FootRig = createFoot();
  leftHand: HandRig = {
    shoulder: { x: 0, y: 0 },
    elbow: { x: 0, y: 0 },
    wrist: { x: 0, y: 0 },
    swing: 0,
    gripping: false,
  };
  rightHand: HandRig = {
    shoulder: { x: 0, y: 0 },
    elbow: { x: 0, y: 0 },
    wrist: { x: 0, y: 0 },
    swing: 0,
    gripping: false,
  };

  /** Gait phase in [0,1) — advances with distance travelled. */
  gaitPhase = 0;
  /** Distance covered, used to drive the gait. */
  travelled = 0;

  scarf: ScarfSegment[] = [];
  scarfSegments = 9;

  /** Cached pelvis height above the lower foot. */
  pelvisHeight = SKELETON.hipHeight;

  constructor() {
    for (let i = 0; i < this.scarfSegments; i++) {
      this.scarf.push({ x: 0, y: 0, px: 0, py: 0 });
    }
  }

  /**
   * Updates the rig for one simulation step.
   *
   * `footTargets` supplies the world-space ankle targets for each foot (already
   * resolved by the player controller through raycasts), and `handTargets` the
   * optional ledge-grab targets.
   */
  update(
    signal: RigSignal,
    dt: number,
    footTargets: { left: Vec2; right: Vec2 },
    footAngles: { left: number; right: number },
    footNormals: { left: Vec2; right: Vec2 },
    handTargets: { left: Vec2 | null; right: Vec2 | null },
  ): void {
    const face = signal.facing >= 0 ? 1 : -1;
    const running = signal.state === 'run' || (signal.state === 'idle' && signal.speed > 4);
    const airborne =
      signal.state === 'air' || signal.state === 'ledgeHang' || signal.state === 'zip';
    const sliding = signal.state === 'slide';
    const dead = signal.state === 'dead';

    // ------------------------------------------------------------------
    // Pelvis
    // ------------------------------------------------------------------
    // The pelvis height is ADAPTED to the legs rather than fixed, so the feet
    // always reach the ground:
    //
    //   - The pelvis must sit high enough that the HIGHER foot is reachable
    //     (the leg is `legReach` long).
    //   - It must sit low enough that the LOWER foot is still within reach,
    //     otherwise the leg over-extends and the foot floats.
    //
    // `hipHeight` is the nominal standing height; the difference between the
    // two feet is the step, and the pelvis dips by half of it so neither leg
    // has to stretch.
    const breath = Math.sin(this.travelled * 0.02) * 1.2;
    const legReach = SKELETON.thighLength + SKELETON.shinLength;

    const leftFootY = footTargets.left.y;
    const rightFootY = footTargets.right.y;
    const higherFootY = Math.min(leftFootY, rightFootY);
    const lowerFootY = Math.max(leftFootY, rightFootY);

    // Sit at the nominal height above the higher foot, but never so high that
    // the lower foot becomes unreachable.
    const nominalHipY = higherFootY - SKELETON.hipHeight;
    const maxHipY = lowerFootY - legReach;
    const desiredHipY = Math.min(nominalHipY, maxHipY) + breath;

    this.pelvis.x = signal.x;
    this.pelvis.y = damp(this.pelvis.y, desiredHipY, 22, dt);
    // Squash compresses the pelvis toward the feet on impact.
    const squashOffset = signal.squash * 18;
    this.pelvis.y += squashOffset * (dt * 12);

    // ------------------------------------------------------------------
    // Torso + head
    // ------------------------------------------------------------------
    const torsoTarget = signal.lean + (sliding ? 0.55 : 0) + (dead ? -0.4 : 0);
    this.torsoAngle = damp(this.torsoAngle, torsoTarget, 12, dt);

    const torsoLen = SKELETON.torsoLength * (1 - signal.squash * 0.14);
    // Torso extends UP from the pelvis (negative y), tilted by torsoAngle.
    this.neck.x = this.pelvis.x + Math.sin(this.torsoAngle) * torsoLen * face;
    this.neck.y = this.pelvis.y - Math.cos(this.torsoAngle) * torsoLen;

    const headLean = this.torsoAngle + (dead ? 0.5 : 0);
    this.head.x = this.neck.x + Math.sin(headLean) * SKELETON.neckLength * face;
    this.head.y = this.neck.y - Math.cos(headLean) * SKELETON.neckLength;

    // ------------------------------------------------------------------
    // Gait
    // ------------------------------------------------------------------
    // The stride frequency scales with speed but saturates, so the runner
    // does not vibrate at sprint speed.
    const speedN = clamp(signal.speed / 620, 0, 1.25);
    const strideLength = lerp(46, 104, speedN);
    const strideFrequency = running ? clamp(signal.speed / strideLength, 0, 6.5) : 0;
    if (running) {
      this.gaitPhase = (this.gaitPhase + strideFrequency * dt) % 1;
    } else if (airborne) {
      this.gaitPhase = (this.gaitPhase + 1.4 * dt) % 1;
    } else if (sliding) {
      // Tucked legs during a slide.
      this.gaitPhase = damp(this.gaitPhase, 0.5, 8, dt);
    }
    this.travelled += signal.speed * dt;

    // ------------------------------------------------------------------
    // Legs
    // ------------------------------------------------------------------
    const hipY = this.pelvis.y;
    const hipHalf = SKELETON.hipWidth * 0.5;

    // Facing flips the hips so the body reads as having depth.
    const leftHip = { x: this.pelvis.x - face * hipHalf * 0.35, y: hipY };
    const rightHip = { x: this.pelvis.x + face * hipHalf * 0.35, y: hipY };

    const leftAnkleTarget = offsetForAnkle(footTargets.left, footAngles.left, face);
    const rightAnkleTarget = offsetForAnkle(footTargets.right, footAngles.right, face);

    // Knee bends FORWARD (toward the facing direction).
    const kneeBend = { x: face, y: 0 };

    const leftLeg = solveTwoBoneIK(
      leftHip,
      leftAnkleTarget,
      SKELETON.thighLength,
      SKELETON.shinLength,
      kneeBend,
      { maxFold: 0.92 },
    );
    const rightLeg = solveTwoBoneIK(
      rightHip,
      rightAnkleTarget,
      SKELETON.thighLength,
      SKELETON.shinLength,
      kneeBend,
      { maxFold: 0.92 },
    );
    this.leftLeg = leftLeg;
    this.rightLeg = rightLeg;

    // ------------------------------------------------------------------
    // Feet (surface alignment)
    // ------------------------------------------------------------------
    this.leftFoot = this.updateFoot(
      this.leftFoot,
      leftAnkleTarget,
      footTargets.left,
      footAngles.left,
      footNormals.left,
      signal,
      dt,
      'left',
      signal.leftLift,
    );
    this.rightFoot = this.updateFoot(
      this.rightFoot,
      rightAnkleTarget,
      footTargets.right,
      footAngles.right,
      footNormals.right,
      signal,
      dt,
      'right',
      signal.rightLift,
    );

    // ------------------------------------------------------------------
    // Arms
    // ------------------------------------------------------------------
    const shoulderY = this.neck.y + 6;
    const shoulderHalf = SKELETON.shoulderWidth * 0.5;
    const leftShoulder = { x: this.neck.x - face * shoulderHalf, y: shoulderY };
    const rightShoulder = { x: this.neck.x + face * shoulderHalf, y: shoulderY };

    // Elbows bend BACKWARD relative to the facing direction.
    const elbowBend = { x: -face, y: 0 };

    let leftHandTarget = handTargets.left;
    let rightHandTarget = handTargets.right;

    // Free-swinging arm targets when not grabbing.
    if (!leftHandTarget) {
      leftHandTarget = this.swingArmTarget(leftShoulder, face, this.gaitPhase, signal, -1);
    }
    if (!rightHandTarget) {
      rightHandTarget = this.swingArmTarget(rightShoulder, face, this.gaitPhase, signal, 1);
    }

    const leftArm = solveTwoBoneIK(
      leftShoulder,
      leftHandTarget,
      SKELETON.upperArmLength,
      SKELETON.foreArmLength,
      elbowBend,
      { maxFold: 0.95 },
    );
    const rightArm = solveTwoBodyIKSafe(
      rightShoulder,
      rightHandTarget,
      SKELETON.upperArmLength,
      SKELETON.foreArmLength,
      elbowBend,
    );
    this.leftArm = leftArm;
    this.rightArm = rightArm;

    this.leftHand.shoulder = leftShoulder;
    this.leftHand.elbow = leftArm.joint;
    this.leftHand.wrist = leftArm.end;
    this.leftHand.gripping = handTargets.left !== null;

    this.rightHand.shoulder = rightShoulder;
    this.rightHand.elbow = rightArm.joint;
    this.rightHand.wrist = rightArm.end;
    this.rightHand.gripping = handTargets.right !== null;

    // ------------------------------------------------------------------
    // Scarf (Verlet cloth)
    // ------------------------------------------------------------------
    this.updateScarf(signal, dt);
  }

  /** Which foot is in the swing phase right now. */
  swingFoot(): 'left' | 'right' {
    return this.gaitPhase < 0.5 ? 'left' : 'right';
  }

  private updateFoot(
    foot: FootRig,
    ankle: Vec2,
    sole: Vec2,
    angle: number,
    normal: Vec2,
    signal: RigSignal,
    dt: number,
    side: 'left' | 'right',
    lift: number,
  ): FootRig {
    const running = signal.state === 'run';
    const airborne =
      signal.state === 'air' || signal.state === 'ledgeHang' || signal.state === 'zip';
    const sliding = signal.state === 'slide';

    // Swing amount: 1 while the leg is travelling, 0 while planted.
    const phase = side === 'left' ? this.gaitPhase : (this.gaitPhase + 0.5) % 1;
    let swing = 0;
    if (airborne) {
      swing = 0.55 + 0.35 * Math.sin(phase * Math.PI * 2);
    } else if (running) {
      // Smooth sin^2 window: the foot lifts over the middle of its cycle.
      swing = Math.sin(phase * Math.PI) ** 2;
    } else if (sliding) {
      swing = 0.9;
    }

    foot.swing = damp(foot.swing, swing, 24, dt);
    foot.ankle.x = ankle.x;
    foot.ankle.y = ankle.y;
    foot.toe.x = sole.x;
    foot.toe.y = sole.y;
    foot.normal.x = normal.x;
    foot.normal.y = normal.y;
    foot.footAngle = angle;

    // `wasGrounded` must capture the PREVIOUS frame's contact state before
    // `grounded` is recomputed, otherwise the footstep edge detection in
    // `Player.detectFootsteps()` can never see a swing -> plant transition.
    foot.wasGrounded = foot.grounded;

    // Grounded when the runner is on the ground and the foot is not lifted
    // clear of the surface by its swing phase. `lift` is how far the sole
    // sits above the surface, so a swinging foot is genuinely off the ground.
    foot.soleLift = lift;
    const lifted = lift > 2;
    foot.grounded = !airborne && !sliding && !lifted && signal.grounded;
    if (sliding) foot.grounded = signal.grounded;

    // Reach: how far the ankle is from the hip (used for IK quality checks).
    foot.reach = 0;

    return foot;
  }

  private swingArmTarget(
    shoulder: Vec2,
    face: number,
    phase: number,
    signal: RigSignal,
    sideOffset: number,
  ): Vec2 {
    const speedN = clamp(signal.speed / 620, 0, 1);
    const phaseOffset = sideOffset > 0 ? phase : phase + 0.5;
    const swingAmount = Math.sin(phaseOffset * Math.PI * 2) * lerp(6, 26, speedN);
    const forward = face * (10 + swingAmount);

    let y = shoulder.y + 26;
    if (signal.state === 'air') {
      y = shoulder.y + 18;
    } else if (signal.state === 'slide') {
      y = shoulder.y + 14;
      return { x: shoulder.x + forward * 0.4, y };
    } else if (signal.state === 'idle') {
      y = shoulder.y + 28 + Math.sin(phaseOffset * Math.PI * 2) * 1.5;
    }

    return { x: shoulder.x + forward, y };
  }

  /**
   * Verlet scarf simulation anchored at the neck. The scarf trails behind the
   * runner and reacts to velocity and gravity.
   */
  private updateScarf(signal: RigSignal, dt: number): void {
    const anchorX = this.neck.x - signal.facing * 4;
    const anchorY = this.neck.y - 2;

    const segLen = 9;
    const gravity = 900;
    const damping = 0.92;
    const windX = -signal.facing * clamp(signal.speed * 0.55, 0, 340);

    const first = this.scarf[0];
    if (first.x === 0 && first.y === 0) {
      for (let i = 0; i < this.scarf.length; i++) {
        this.scarf[i] = {
          x: anchorX,
          y: anchorY + i * segLen,
          px: anchorX,
          py: anchorY + i * segLen,
        };
      }
    }

    this.scarf[0].x = anchorX;
    this.scarf[0].y = anchorY;

    for (let i = 1; i < this.scarf.length; i++) {
      const s = this.scarf[i];
      const vx = (s.x - s.px) * damping;
      const vy = (s.y - s.py) * damping;
      s.px = s.x;
      s.py = s.y;
      // Wind pushes the scarf back; the trailing segments catch more of it.
      const trailFactor = i / this.scarf.length;
      s.x += vx + windX * trailFactor * 0.5 * dt;
      s.y += vy + gravity * dt * dt * 60;
    }

    // Constraint solving (a few iterations for stiffness).
    for (let iter = 0; iter < 6; iter++) {
      for (let i = 0; i < this.scarf.length - 1; i++) {
        const a = this.scarf[i];
        const b = this.scarf[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 1e-5;
        const diff = (dist - segLen) / dist;
        const mx = dx * diff * 0.5;
        const my = dy * diff * 0.5;
        if (i !== 0) {
          a.x += mx;
          a.y += my;
          b.x -= mx;
          b.y -= my;
        } else {
          b.x -= mx * 2;
          b.y -= my * 2;
        }
      }
    }
  }
}

function createFoot(): FootRig {
  return {
    hip: { x: 0, y: 0 },
    knee: { x: 0, y: 0 },
    ankle: { x: 0, y: 0 },
    toe: { x: 0, y: 0 },
    normal: { x: 0, y: -1 },
    footAngle: 0,
    swing: 0,
    grounded: false,
    wasGrounded: false,
    soleLift: 0,
    reach: 0,
  };
}

/** Places the ankle above the sole, offset along the rotated foot frame. */
function offsetForAnkle(sole: Vec2, footAngle: number, face: number): Vec2 {
  // The ankle sits above the mid-foot by `ankleHeight`, perpendicular to the
  // sole surface. The perpendicular of a surface with angle `a` is (-sin a, -cos a).
  const nx = -Math.sin(footAngle);
  const ny = -Math.cos(footAngle);
  const h = SKELETON.ankleHeight + SKELETON.soleThickness;
  // Shift the ankle slightly toward the heel (opposite to facing).
  return {
    x: sole.x + nx * h - Math.cos(footAngle) * 3 * face,
    y: sole.y + ny * h - Math.sin(footAngle) * 3 * face,
  };
}

/** Guarded wrapper: falls back to a straight chain if the solver ever throws. */
function solveTwoBodyIKSafe(root: Vec2, target: Vec2, l1: number, l2: number, bend: Vec2): IKBone {
  try {
    return solveTwoBoneIK(root, target, l1, l2, bend, { maxFold: 0.95 });
  } catch {
    return {
      root,
      joint: { x: root.x, y: root.y },
      end: target,
      rootAngle: 0,
      jointAngle: Math.PI,
      overextended: true,
      compressed: false,
      fold: 0,
    };
  }
}
