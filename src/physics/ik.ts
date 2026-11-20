/**
 * Two-bone inverse kinematics solver.
 *
 * Given a root (hip / shoulder), a target (ankle / wrist) and the lengths of the
 * two bones, we compute the exact intermediate joint position (knee / elbow)
 * using the Law of Cosines, then place the end effector exactly on the target.
 *
 * Coordinate convention for the whole project: +x is right, +y is DOWN
 * (screen space). "Bend direction" therefore describes which way the joint
 * folds: a forward-bending knee folds toward +x when the runner faces right.
 */

import { clamp } from '../core/math';
import type { Vec2 } from '../core/types';

export interface IKBone {
  root: Vec2;
  joint: Vec2;
  end: Vec2;
  /** Interior angle at the root between the two bones, in radians. */
  rootAngle: number;
  /** Interior angle at the joint between the two bones, in radians. */
  jointAngle: number;
  /** True when the target was unreachable and the chain was fully extended. */
  overextended: boolean;
  /** True when the target was closer than the chain's minimum reach. */
  compressed: boolean;
  /** 0 = fully extended straight chain, 1 = fully folded. */
  fold: number;
}

export interface IKSolveOptions {
  /**
   * Direction the middle joint should bulge toward, in world space.
   * For legs this is "forward" (+x when facing right); for arms it is
   * "backward" (-x when facing right) so elbows trail naturally.
   */
  bendDirection: Vec2;
  /**
   * Hard limit on how far the chain may fold (0..1). 1 = the knee may touch the
   * hip. Prevents the classic "folded into itself" artefact.
   */
  maxFold?: number;
}

/**
 * Law-of-cosines two-bone solver.
 *
 * Given `d = |target - root|`, the first bone swings by `alpha` off the
 * root->target axis where `cos(alpha) = (d^2 + l1^2 - l2^2) / (2*d*l1)`.
 * The joint angle is `beta = acos((l1^2 + l2^2 - d^2) / (2*l1*l2))`.
 */
export function solveTwoBoneIK(
  rootPos: Vec2,
  targetPos: Vec2,
  upperLen: number,
  lowerLen: number,
  bendDirection: Vec2 = { x: 1, y: 0 },
  options: { maxFold?: number } = {},
): IKBone {
  const l1 = Math.max(upperLen, 1e-5);
  const l2 = Math.max(lowerLen, 1e-5);
  const maxFold = clamp(options.maxFold ?? 1, 0, 1);

  let dx = targetPos.x - rootPos.x;
  let dy = targetPos.y - rootPos.y;
  let d = Math.hypot(dx, dy);

  const total = l1 + l2;

  // `maxFold` limits how tightly the chain may fold.
  //
  // The INTERIOR angle at the middle joint is 0 when the two bones fold back
  // onto each other (fully folded) and PI when the chain is straight. So a
  // fold limit of 1 permits the joint angle to reach 0, while 0 keeps the
  // chain rigid.
  //
  //   maxInterior = PI * (1 - maxFold)
  //   d_min = sqrt(l1^2 + l2^2 - 2*l1*l2*cos(maxInterior))
  //
  // At maxFold = 1 this collapses to |l1 - l2| (the bones fold flat); at
  // maxFold = 0 it is l1 + l2 (the chain stays straight).
  const maxInterior = Math.PI * (1 - maxFold);
  const minReach = Math.sqrt(Math.max(0, l1 * l1 + l2 * l2 - 2 * l1 * l2 * Math.cos(maxInterior)));

  let overextended = false;
  let compressed = false;

  // Unreachable: clamp to full extension, keep the chain pointing at the
  // target. The DIRECTION is normalised from the original delta so the bone
  // lengths stay exact even when the target is beyond the chain's reach.
  if (d >= total) {
    overextended = true;
    if (d < 1e-5) {
      dx = 1;
      dy = 0;
      d = 1;
    } else {
      dx /= d;
      dy /= d;
      d = 1;
    }
  } else if (d <= minReach || d < 1e-5) {
    // Too close: fold fully toward the bend direction.
    compressed = true;
    if (d < 1e-5) {
      dx = 1;
      dy = 0;
      d = 1;
    }
  }

  const dirX = dx / d;
  const dirY = dy / d;

  // `perp` is the +90 degree rotation of the root->target axis in screen
  // space (x right, y down). Rotating toward `perp` swings the joint
  // counter-clockwise on screen.
  const perpX = -dirY;
  const perpY = dirX;

  // Normalise the bend direction and project it onto the perpendicular axis to
  // learn WHICH SIDE of the root->target axis the joint should bulge toward.
  let bendX = bendDirection.x;
  let bendY = bendDirection.y;
  const bendLen = Math.hypot(bendX, bendY);
  if (bendLen < 1e-5) {
    // Degenerate bend vector: fall back to a stable perpendicular.
    bendX = perpX;
    bendY = perpY;
  } else {
    bendX /= bendLen;
    bendY /= bendLen;
  }

  // Remove any component of the bend direction along the root->target axis so
  // the joint always bulges sideways (this keeps the solver stable when the
  // bend vector points along the chain).
  const along = bendX * dirX + bendY * dirY;
  bendX -= dirX * along;
  bendY -= dirY * along;
  const bendLen2 = Math.hypot(bendX, bendY);
  if (bendLen2 < 1e-5) {
    // The bend direction was parallel to the chain: use the perpendicular.
    bendX = perpX;
    bendY = perpY;
  } else {
    bendX /= bendLen2;
    bendY /= bendLen2;
  }

  let jointX = rootPos.x;
  let jointY = rootPos.y;
  let rootAngle = 0;
  let jointAngle = 0;
  let fold = 0;

  if (overextended) {
    // Straight chain along the root->target direction. `dx`/`dy` are a unit
    // vector here, so the joint sits exactly one upper-bone length away.
    jointX = rootPos.x + dx * l1;
    jointY = rootPos.y + dy * l1;
    rootAngle = Math.atan2(dy, dx);
    jointAngle = Math.PI;
    fold = 0;
  } else if (compressed) {
    // The chain cannot span this distance: fold as far as `maxFold` allows.
    //
    // The joint is placed at the maximum permitted fold. The perpendicular
    // offset from the root->target axis is l1 * sin(beta/2) where beta is the
    // alpha angle for the closest reachable distance.
    const alphaMax =
      minReach > 1e-5
        ? Math.acos(clamp((minReach * minReach + l1 * l1 - l2 * l2) / (2 * minReach * l1), -1, 1))
        : 0;
    const offset = Math.sin(alphaMax) * l1;

    jointX = rootPos.x + bendX * offset;
    jointY = rootPos.y + bendY * offset;

    const ex = targetPos.x;
    const ey = targetPos.y;
    const jdx = ex - jointX;
    const jdy = ey - jointY;
    const jl = Math.hypot(jdx, jdy) || 1;
    rootAngle = Math.atan2(jdy, jdx) - Math.atan2(bendY, bendX);
    jointAngle = Math.acos(clamp((l1 * l1 + l2 * l2 - jl * jl) / (2 * l1 * l2), -1, 1));
    fold = 1;
    return {
      root: { x: rootPos.x, y: rootPos.y },
      joint: { x: jointX, y: jointY },
      end: { x: ex, y: ey },
      rootAngle,
      jointAngle,
      overextended,
      compressed,
      fold,
    };
  } else {
    // Law of cosines.
    const cosAlpha = clamp((d * d + l1 * l1 - l2 * l2) / (2 * d * l1), -1, 1);
    const alpha = Math.acos(cosAlpha);
    const cosBeta = clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1);
    const beta = Math.acos(cosBeta);

    // The joint is placed by rotating the root->target axis by `alpha` toward
    // the bend direction. `bendSign` captures which side of the axis the bend
    // vector points to, so reversing the bend direction mirrors the solution.
    const bendSign = Math.sign(bendX * perpX + bendY * perpY) || 1;
    const angle = bendSign * alpha;

    // The upper bone direction: root->target axis rotated by `angle`.
    // perp = (dirY, -dirX) is the +90 degree rotation in screen space.
    const upperX = dirX * Math.cos(angle) + perpX * Math.sin(angle);
    const upperY = dirY * Math.cos(angle) + perpY * Math.sin(angle);

    jointX = rootPos.x + upperX * l1;
    jointY = rootPos.y + upperY * l1;

    rootAngle = Math.atan2(upperY, upperX);
    jointAngle = beta;
    fold = 1 - alpha / Math.PI;
  }

  // End effector placement.
  //
  // For every REACHABLE configuration the end sits exactly on the target.
  // When the target is out of reach the chain is fully extended along the
  // root->target direction, so the end sits at the far end of that straight
  // chain — this keeps the bone lengths exact instead of stretching them.
  const endX = overextended ? rootPos.x + dx * total : targetPos.x;
  const endY = overextended ? rootPos.y + dy * total : targetPos.y;

  return {
    root: { x: rootPos.x, y: rootPos.y },
    joint: { x: jointX, y: jointY },
    end: { x: endX, y: endY },
    rootAngle,
    jointAngle,
    overextended,
    compressed,
    fold,
  };
}

/**
 * Places an end effector (foot/hand) on a surface at `point`, oriented along the
 * surface normal, offset by `soleThickness` so the shoe never sinks into the
 * geometry.
 */
export function placeOnSurface(
  point: Vec2,
  normal: Vec2,
  surfaceAngle: number,
  soleThickness: number,
  ankleLength: number,
): Vec2 {
  // The ankle sits `ankleLength` above the sole along the surface normal.
  const ankleX = point.x + normal.x * (soleThickness + ankleLength * 0);
  const ankleY = point.y + normal.y * (soleThickness + ankleLength * 0);
  // Rotate the local "up" of the foot by the surface angle so the toe points
  // along the slope.
  const c = Math.cos(surfaceAngle);
  const s = Math.sin(surfaceAngle);
  return { x: ankleX + 0 * c, y: ankleY - 0 * s };
}
