import { describe, expect, it } from 'vitest';
import { solveTwoBoneIK } from '../src/physics/ik';
import type { Vec2 } from '../src/core/types';

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

describe('solveTwoBoneIK', () => {
  const l1 = 46; // thigh
  const l2 = 44; // shin

  it('places the end effector exactly on a reachable target', () => {
    const root = { x: 0, y: 0 };
    const target = { x: 20, y: 60 };
    const bone = solveTwoBoneIK(root, target, l1, l2, { x: 1, y: 0 });

    expect(dist(bone.end, target)).toBeLessThan(1e-9);
  });

  it('preserves bone lengths exactly', () => {
    const root = { x: 0, y: 0 };
    const target = { x: 25, y: 55 };
    const bone = solveTwoBoneIK(root, target, l1, l2, { x: 1, y: 0 });

    expect(dist(bone.root, bone.joint)).toBeCloseTo(l1, 9);
    expect(dist(bone.joint, bone.end)).toBeCloseTo(l2, 9);
  });

  it('keeps the chain collinear when the target is at full extension', () => {
    const root = { x: 0, y: 0 };
    const target = { x: l1 + l2, y: 0 };
    const bone = solveTwoBoneIK(root, target, l1, l2, { x: 1, y: 0 });

    expect(bone.overextended).toBe(true);
    expect(dist(bone.joint, root)).toBeCloseTo(l1, 9);
    expect(dist(bone.end, bone.joint)).toBeCloseTo(l2, 9);
    // The joint must lie on the root->target line.
    expect(bone.joint.y).toBeCloseTo(0, 9);
  });

  it('bends the knee toward the requested bend direction', () => {
    const root = { x: 0, y: 0 };
    const target = { x: 0, y: 70 };

    const forward = solveTwoBoneIK(root, target, l1, l2, { x: 1, y: 0 });
    const backward = solveTwoBoneIK(root, target, l1, l2, { x: -1, y: 0 });

    expect(forward.joint.x).toBeGreaterThan(0);
    expect(backward.joint.x).toBeLessThan(0);
  });

  it('mirrors correctly when the bend direction is reversed', () => {
    const root = { x: 0, y: 0 };
    const target = { x: 0, y: 70 };

    const forward = solveTwoBoneIK(root, target, l1, l2, { x: 1, y: 0 });
    const backward = solveTwoBoneIK(root, target, l1, l2, { x: -1, y: 0 });

    expect(forward.joint.x).toBeCloseTo(-backward.joint.x, 9);
    expect(forward.joint.y).toBeCloseTo(backward.joint.y, 9);
  });

  it('folds without inverting when the target is too close', () => {
    const root = { x: 0, y: 0 };
    const target = { x: 2, y: 0 };
    const bone = solveTwoBoneIK(root, target, l1, l2, { x: 1, y: 0 });

    expect(bone.compressed).toBe(true);
    expect(Number.isFinite(bone.joint.x)).toBe(true);
    expect(Number.isFinite(bone.joint.y)).toBe(true);
    // The joint must not sit on the far side of the root.
    expect(bone.joint.x).toBeGreaterThanOrEqual(-1e-9);
  });

  it('handles a zero-length root->target vector without NaN', () => {
    const bone = solveTwoBoneIK({ x: 5, y: 5 }, { x: 5, y: 5 }, l1, l2, { x: 1, y: 0 });
    expect(Number.isNaN(bone.joint.x)).toBe(false);
    expect(Number.isNaN(bone.joint.y)).toBe(false);
    expect(Number.isNaN(bone.end.x)).toBe(false);
  });

  it('produces the law-of-cosines joint angle', () => {
    const root = { x: 0, y: 0 };
    const target = { x: 30, y: 50 };
    const bone = solveTwoBoneIK(root, target, l1, l2, { x: 1, y: 0 });

    const d = dist(root, target);
    const expected = Math.acos((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2));
    expect(bone.jointAngle).toBeCloseTo(expected, 9);
  });

  it('reaches every target on the reachable annulus', () => {
    for (let angle = 0; angle < Math.PI * 2; angle += 0.3) {
      const reach = (l1 + l2) * 0.7;
      const target = { x: Math.cos(angle) * reach, y: Math.sin(angle) * reach };
      const bone = solveTwoBoneIK({ x: 0, y: 0 }, target, l1, l2, { x: 1, y: 0 });

      expect(dist(bone.root, bone.joint)).toBeCloseTo(l1, 8);
      expect(dist(bone.joint, bone.end)).toBeCloseTo(l2, 8);
      expect(dist(bone.end, target)).toBeLessThan(1e-8);
    }
  });

  it('never returns NaN for degenerate inputs', () => {
    const cases: [Vec2, Vec2, number, number][] = [
      [{ x: 0, y: 0 }, { x: 0, y: 0 }, 0, 0],
      [{ x: 0, y: 0 }, { x: 0, y: 0 }, 10, 10],
      [{ x: 3, y: 3 }, { x: 3, y: 3 }, 46, 44],
      [{ x: 0, y: 0 }, { x: 1000, y: -1000 }, 46, 44],
    ];

    for (const [root, target, a, b] of cases) {
      const bone = solveTwoBoneIK(root, target, a, b, { x: 0, y: 0 });
      expect(Number.isFinite(bone.joint.x)).toBe(true);
      expect(Number.isFinite(bone.joint.y)).toBe(true);
      expect(Number.isFinite(bone.end.x)).toBe(true);
      expect(Number.isFinite(bone.end.y)).toBe(true);
    }
  });

  it('respects the maxFold clamp by capping the interior joint angle', () => {
    const root = { x: 0, y: 0 };
    const target = { x: 0, y: 5 };
    const maxFold = 0.5;
    const bone = solveTwoBoneIK(root, target, l1, l2, { x: 1, y: 0 }, { maxFold });

    // The interior angle at the knee is capped at maxFold * PI.
    expect(bone.jointAngle).toBeLessThanOrEqual(Math.PI * maxFold + 1e-6);
  });

  it('limits how far the joint may fold perpendicular to the chain', () => {
    const root = { x: 0, y: 0 };
    const target = { x: 0, y: 20 };

    const loose = solveTwoBoneIK(root, target, l1, l2, { x: 1, y: 0 }, { maxFold: 1 });
    const tight = solveTwoBoneIK(root, target, l1, l2, { x: 1, y: 0 }, { maxFold: 0.35 });

    // A tighter fold limit must keep the joint closer to the chain axis.
    expect(Math.abs(tight.joint.x)).toBeLessThan(Math.abs(loose.joint.x));
  });
});
