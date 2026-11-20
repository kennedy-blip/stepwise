/**
 * The 2.5D camera.
 *
 * The camera sits behind the `Z = 0` traversal plane and looks slightly down
 * at it. It never rotates far enough to distort the horizontal gap distances
 * the player has to judge, but it does reveal the top surfaces and the
 * thickness of the rooftops ahead.
 *
 * Framing rules (from the upgrade specification):
 *  - FOV 45°, so there is no wide-angle edge distortion.
 *  - Base distance 16.0 m behind the plane.
 *  - 2.6 m above the runner's pelvis, pitched down 9.5°.
 *  - Look-at target 4.2 m ahead in +X, which lands the runner near 28% from
 *    the left edge on a 16:9 viewport.
 *  - Yaw held near -2.5° so gaps stay honest.
 */

import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import { simX, simY } from './units';

/** Camera framing constants, in scene metres / degrees. */
export const CAMERA_3D = {
  fov: 45,
  /** Base distance behind the Z = 0 plane. */
  baseDistance: 16.0,
  /** Distance while in the "In Stride" flow tier. */
  strideDistance: 17.5,
  /** Distance while in the "Pure Flow" tier. */
  flowDistance: 19.0,
  /** Height above the runner's pelvis. */
  elevation: 2.6,
  /** Downward pitch in degrees. */
  pitchDeg: -9.5,
  /** Slight yaw toward the oncoming path, in degrees. */
  yawDeg: -2.5,
  /** How far ahead of the runner the camera looks. */
  leadAhead: 4.2,
  /** How quickly the camera closes on its target distance. */
  followRate: 6.5,
  /** How quickly the camera catches up in X. */
  xFollowRate: 9,
  /** Camera shake decay per second. */
  shakeDecay: 7.5,
} as const;

export interface Camera3DState {
  /** Current flow tier (1..3) driving the pull-back. */
  flowTier: number;
  /** Extra shake offset in metres, applied after the framing. */
  shake: number;
  /** Time dilation pulse strength, 0..1. */
  zoomPulse: number;
}

/**
 * Manages the perspective camera, its framing and its reactive behaviours.
 */
export class Camera3D {
  readonly camera: THREE.PerspectiveCamera;

  /** Smoothed distance behind the plane. */
  private distance: number = CAMERA_3D.baseDistance;
  /** Smoothed look-at X. */
  private lookX = 0;
  /** Smoothed look-at Y. */
  private lookY = 0;
  /** Vertical dead zone in metres, so small hops do not bob the camera. */
  private verticalDeadZone = 26 / 40;
  /** Current shake amount in metres. */
  private shakeAmount = 0;
  /** Zoom pulse timer in seconds. */
  private pulseTimer = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(CAMERA_3D.fov, aspect, 0.1, 400);
    this.camera.position.set(0, 0, CAMERA_3D.baseDistance);
    this.camera.lookAt(0, 0, 0);
  }

  /** Sets the viewport aspect ratio. */
  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Adds camera shake, in metres. */
  addShake(amount: number): void {
    this.shakeAmount = Math.min(1.2, this.shakeAmount + amount);
  }

  /**
   * Triggers the short zoom pulse used when a Flow Save rescues the runner.
   */
  triggerZoomPulse(): void {
    this.pulseTimer = 0.15;
  }

  /**
   * Updates the camera for one rendered frame.
   *
   * @param runnerX  Runner X in simulation pixels.
   * @param runnerY  Runner Y in simulation pixels.
   * @param flowTier Current flow tier, 1..3.
   * @param dt       Frame delta in seconds.
   */
  update(runnerX: number, runnerY: number, flowTier: number, dt: number): void {
    const targetDistance =
      flowTier >= 3
        ? CAMERA_3D.flowDistance
        : flowTier >= 2
          ? CAMERA_3D.strideDistance
          : CAMERA_3D.baseDistance;
    this.distance = damp(this.distance, targetDistance, CAMERA_3D.followRate, dt);

    const targetX = simX(runnerX);
    const targetY = simY(runnerY);

    this.lookX = damp(this.lookX, targetX, CAMERA_3D.xFollowRate, dt);

    // Vertical dead zone: only chase the runner once they leave the band.
    const deltaY = targetY - this.lookY;
    if (Math.abs(deltaY) > this.verticalDeadZone) {
      const overshoot = deltaY - Math.sign(deltaY) * this.verticalDeadZone;
      this.lookY = damp(this.lookY, this.lookY + overshoot, CAMERA_3D.xFollowRate, dt);
    }

    // Decaying shake, applied as a small positional jitter.
    this.shakeAmount = Math.max(0, this.shakeAmount - this.shakeAmount * CAMERA_3D.shakeDecay * dt);
    const shakeOffset =
      this.shakeAmount > 0.001 ? (Math.random() - 0.5) * this.shakeAmount * 0.9 : 0;

    // The Flow Save zoom pulse briefly pushes the camera back.
    let pulse = 0;
    if (this.pulseTimer > 0) {
      this.pulseTimer = Math.max(0, this.pulseTimer - dt);
      const t = 1 - this.pulseTimer / 0.15;
      pulse = Math.sin(t * Math.PI) * 1.6;
    }

    const cam = this.camera;
    cam.position.set(
      this.lookX + shakeOffset * 0.4,
      this.lookY + CAMERA_3D.elevation + shakeOffset,
      this.distance + pulse,
    );

    // Aim at a point ahead of the runner on the traversal plane. The
    // authored yaw and pitch are applied as the camera's rotation, and the
    // The framing is specified as an exact pitch and yaw, so the camera
    // ROTATION is authored directly rather than being aimed at a look-at
    // point. The horizontal lead is produced by where the camera SITS
    // relative to the runner, not by an extra rotation — that keeps the
    // gap distances the player has to judge undistorted.
    const leadX = this.lookX + CAMERA_3D.leadAhead;
    const leadY = this.lookY + CAMERA_3D.elevation * 0.12;

    // Sit the camera behind the lead point, along the authored yaw, so the
    // runner falls on the left of the frame.
    const yaw = THREE.MathUtils.degToRad(CAMERA_3D.yawDeg);
    const backX = -Math.sin(yaw) * this.distance;
    const backZ = Math.cos(yaw) * this.distance;

    cam.position.set(
      leadX + backX + shakeOffset * 0.4,
      leadY + CAMERA_3D.elevation + shakeOffset,
      backZ,
    );

    cam.rotation.order = 'YXZ';
    cam.rotation.y = yaw;
    cam.rotation.x = THREE.MathUtils.degToRad(CAMERA_3D.pitchDeg);
    cam.rotation.z = 0;
    cam.updateMatrixWorld();
  }

  /** Returns the world-space position of the camera. */
  get position(): THREE.Vector3 {
    return this.camera.position;
  }

  /** Clamps a value into the camera's usable frustum range. */
  static clampNear(value: number): number {
    return clamp(value, 0.1, 400);
  }
}
