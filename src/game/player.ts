/**
 * The player controller.
 *
 * This is the pure simulation heart of the game: grounded movement, jumping,
 * sliding, ledge grabbing, mantling, tuck-and-roll, ziplines and spring
 * awnings. It emits events (footsteps, flow changes) that the presentation
 * layer reacts to — it never touches the DOM or Canvas directly.
 */

import { clamp, damp, lerp, approach } from '../core/math';
import { HITBOX, PHYSICS, SKELETON } from './config';
import { CharacterRig } from './rig';
import {
  addFlow,
  breakCleanStreak,
  consumeFlowSave,
  decayFlow,
  registerCleanMove,
  tierForValue,
} from './flow';
import type { FlowState } from './flow';
import type { DifficultyTuning } from './config';
import type { Terrain } from '../physics/terrain';
import type {
  Difficulty,
  InputState,
  PlayerState,
  Rect,
  SurfaceMaterial,
  Vec2,
} from '../core/types';

export type GameEvent =
  | { type: 'footstep'; material: SurfaceMaterial; speed: number }
  | { type: 'jump' }
  | { type: 'land'; impact: number; material: SurfaceMaterial }
  | { type: 'slide' }
  | { type: 'vault'; flow: number }
  | { type: 'roll'; flow: number }
  | { type: 'edgeLeap'; flow: number }
  | { type: 'slideUnder'; flow: number }
  | { type: 'flow'; amount: number; reason: string }
  | { type: 'stumble' }
  | { type: 'flowSave' }
  | { type: 'break'; kind: 'plank' | 'glass' | 'spring' | 'zipline' }
  | { type: 'crack'; kind: 'plank' | 'glass' }
  | { type: 'ziplineGrab' }
  | { type: 'springLaunch'; power: number }
  | { type: 'dead'; reason: string }
  | { type: 'label'; text: string; color: string };

export interface PlayerInit {
  x: number;
  y: number;
  tuning: DifficultyTuning;
  difficulty: Difficulty;
  terrain: Terrain;
  flow: FlowState;
}

/** Distance travelled (in px) tracked for the distance HUD. */
export class Player {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  facing = 1;
  state: PlayerState = 'idle';

  grounded = false;
  /** True on the frame the runner transitions from air to ground. */
  justLanded = false;
  landingImpact = 0;

  /** Timers. */
  coyoteTimer = 0;
  jumpBufferTimer = 0;
  slideTimer = 0;
  stumbleTimer = 0;
  mantleTimer = 0;
  hangTimer = 0;
  zipTimer = 0;
  springCooldown = 0;
  /** Seconds since the runner left the ground (used for the roll window). */
  airTime = 0;

  /** Ledge interaction. */
  ledgeGrab: { x: number; y: number } | null = null;
  mantleFrom: Vec2 = { x: 0, y: 0 };
  mantleTo: Vec2 = { x: 0, y: 0 };

  /** Zipline state. */
  zip: { x: number; y: number; endX: number } | null = null;

  /** Torso lean in radians (positive = forward). */
  lean = 0;
  /** Landing squash 0..1. */
  squash = 0;

  /** Flow meter. */
  flow: FlowState;

  /** Events queued for the presentation layer. */
  events: GameEvent[] = [];

  /** Highest point reached (for the death check). */
  lastSafeY = 0;
  /** Distance travelled in px. */
  distance = 0;
  /** Fall start Y, used to compute drop height for tuck-roll. */
  fallStartY = 0;
  /** True once `fallStartY` holds a meaningful apex for the current fall. */
  private hasFallApex = false;
  /** True while the runner can still convert the fall into a roll. */
  rollAvailable = false;
  /** True once the roll input was consumed in the air. */
  rollBuffered = false;

  rig = new CharacterRig();

  private tuning: DifficultyTuning;
  /** The difficulty this player was configured with. */
  activeDifficulty: Difficulty;
  private terrain: Terrain;

  constructor(init: PlayerInit) {
    this.x = init.x;
    this.y = init.y;
    this.tuning = init.tuning;
    this.activeDifficulty = init.difficulty;
    this.terrain = init.terrain;
    this.flow = init.flow;
    this.lastSafeY = init.y;
  }

  setTuning(tuning: DifficultyTuning, difficulty: Difficulty): void {
    this.tuning = tuning;
    this.activeDifficulty = difficulty;
  }

  /** The player's current hitbox, accounting for the slide crouch. */
  get hitbox(): Rect {
    const sliding = this.state === 'slide';
    const h = sliding ? HITBOX.slideHeight : HITBOX.height;
    const w = sliding ? HITBOX.slideWidth : HITBOX.width;
    return {
      x: this.x - w * 0.5,
      y: this.y - h,
      w,
      h,
    };
  }

  /** Top of the head (used for ceiling checks). */
  get headY(): number {
    return this.y - (this.state === 'slide' ? HITBOX.slideHeight : HITBOX.height);
  }

  update(input: InputState, dt: number): void {
    this.springCooldown = Math.max(0, this.springCooldown - dt);

    if (this.state === 'dead') {
      this.rig.update(
        this.rigSignal(),
        dt,
        this.footTargets(),
        this.footAngles(),
        this.footNormals(),
        {
          left: null,
          right: null,
        },
      );
      return;
    }

    // ------------------------------------------------------------------
    // Input buffering + coyote time
    // ------------------------------------------------------------------
    if (input.jumpPressed) this.jumpBufferTimer = this.tuning.inputBuffer;
    else this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - dt);

    if (this.grounded) {
      this.coyoteTimer = this.tuning.coyoteTime;
    } else {
      this.coyoteTimer = Math.max(0, this.coyoteTimer - dt);
    }

    // ------------------------------------------------------------------
    // State machine
    // ------------------------------------------------------------------
    switch (this.state) {
      case 'idle':
      case 'run':
        this.updateGrounded(input, dt);
        break;
      case 'air':
        this.updateAir(input, dt);
        break;
      case 'slide':
        this.updateSlide(input, dt);
        break;
      case 'ledgeHang':
        this.updateHang(input, dt);
        break;
      case 'mantle':
        this.updateMantle(dt);
        break;
      case 'zip':
        this.updateZip(dt);
        break;
      case 'stumble':
        this.updateStumble(dt);
        break;
    }

    // ------------------------------------------------------------------
    // Flow decay when hesitating
    // ------------------------------------------------------------------
    // The meter only bleeds while the runner is genuinely stalling: no
    // movement input AND a low speed. A runner who is actively accelerating
    // from a standstill is not hesitating, so their meter is safe.
    const wantsToMove = Math.abs(input.moveX) > 0.01;
    const hesitating =
      !wantsToMove && Math.abs(this.vx) < 90 && (this.state === 'idle' || this.state === 'run');
    decayFlow(this.flow, dt, hesitating, this.tuning.flowDecayPerSecond);

    // ------------------------------------------------------------------
    // Rig update
    // ------------------------------------------------------------------
    this.rig.update(
      this.rigSignal(),
      dt,
      this.footTargets(),
      this.footAngles(),
      this.footNormals(),
      this.handTargets(),
    );

    // Footstep events on the exact contact frame.
    this.detectFootsteps();

    this.distance = Math.max(this.distance, this.x - this.startX);
  }

  private startX = 0;

  setStartX(x: number): void {
    this.startX = x;
  }

  // ----------------------------------------------------------------------
  // Grounded movement
  // ----------------------------------------------------------------------
  private updateGrounded(input: InputState, dt: number): void {
    const speed = Math.abs(this.vx);
    const dir = input.moveX;

    // Slide initiation.
    if (input.crouchPressed && speed > 120 && this.state !== 'slide') {
      this.beginSlide();
      return;
    }

    // Jump.
    if (this.jumpBufferTimer > 0 && this.coyoteTimer > 0) {
      this.jumpBufferTimer = 0;
      this.coyoteTimer = 0;
      this.doJump();
      return;
    }

    // Ledge grab check (only while airborne or when running off an edge).
    if (this.tryLedgeGrab()) return;

    // Acceleration curve: 0.65s smooth ramp from jog to sprint.
    const target = this.targetSpeed(dir, speed);
    const rampT = clamp(speed / Math.max(this.tuning.baseSpeed, 1), 0, 1);
    const accel = this.tuning.groundAccel * lerp(0.72, 1, rampT);

    if (dir !== 0) {
      this.vx = approach(this.vx, target, accel * dt);
      this.facing = dir >= 0 ? 1 : -1;
    } else {
      this.vx = approach(this.vx, 0, this.tuning.groundFriction * dt);
    }

    // Slope acceleration on slanted roofs.
    const slope = this.groundSlope();
    if (Math.abs(slope) > PHYSICS.slopeSlideThreshold) {
      this.vx += Math.sin(slope) * PHYSICS.slopeAcceleration * dt * 0.35;
    }

    this.applyGravityAndMove(dt);
    this.checkHazards(dt);

    // Leaving the ground must switch to the air state, otherwise the runner
    // keeps "running" while falling into the void: no air control, no coyote
    // time, no landing, and no death by missing a roof.
    if (!this.grounded && this.state !== 'air') {
      this.state = 'air';
      this.fallStartY = this.y;
      this.hasFallApex = true;
      this.airTime = 0;
      return;
    }

    if (Math.abs(this.vx) > 8) {
      this.state = 'run';
    } else {
      this.state = 'idle';
    }
  }

  private targetSpeed(dir: number, speed: number): number {
    if (dir === 0) return 0;
    const tierMult =
      tierForValue(this.flow.value) === 1 ? 1 : tierForValue(this.flow.value) === 2 ? 1.15 : 1.25;
    const maxSpeed = this.tuning.maxSprintSpeed * tierMult;
    // Below base speed the runner paces; above it the player must keep the
    // direction held to keep accelerating (a genuine "0.65s ramp").
    if (speed < this.tuning.baseSpeed) {
      return dir > 0 ? this.tuning.baseSpeed : -this.tuning.baseSpeed;
    }
    return dir > 0 ? maxSpeed : -maxSpeed;
  }

  // ----------------------------------------------------------------------
  // Air movement
  // ----------------------------------------------------------------------
  private updateAir(input: InputState, dt: number): void {
    this.airTime += dt;

    // Coyote-time jump: the runner has just left a ledge but the coyote
    // window is still open, so a jump pressed now must still launch.
    //
    // The coyote window is deliberately short (a fraction of a second), so
    // this can only fire immediately after leaving a ledge — it must never
    // turn into a mid-air double jump.
    if (this.jumpBufferTimer > 0 && this.coyoteTimer > 0 && this.airTime < 0.2) {
      this.jumpBufferTimer = 0;
      this.coyoteTimer = 0;
      this.doJump();
      return;
    }

    // Air control.
    const dir = input.moveX;
    if (dir !== 0) {
      const tierMult =
        tierForValue(this.flow.value) === 3 ? 1.25 : tierForValue(this.flow.value) === 2 ? 1.15 : 1;
      const maxSpeed = this.tuning.maxSprintSpeed * tierMult;
      const target = dir > 0 ? maxSpeed : -maxSpeed;
      this.vx = approach(this.vx, target, this.tuning.airAccel * dt);
      this.facing = dir >= 0 ? 1 : -1;
    } else {
      this.vx = approach(this.vx, 0, this.tuning.airDrag * dt);
    }

    // Variable jump height: releasing early cuts upward velocity.
    if (!input.jumpHeld && this.vy < 0) {
      this.vy *= Math.pow(0.02, dt * 6);
    }

    // Ledge grab before the fall resolves.
    if (this.tryLedgeGrab()) return;

    // Tuck-roll input in the air arms the roll for touchdown.
    if (input.crouchPressed && !this.rollBuffered) {
      this.rollBuffered = true;
    }

    // The roll becomes AVAILABLE once the fall is long enough to be worth
    // rolling. The diegetic tuck-roll arc is shown from this point on.
    if (this.y - this.fallStartY > PHYSICS.tuckRollDropHeight * 0.55) {
      this.rollAvailable = true;
    }

    this.applyGravityAndMove(dt);
    this.checkHazards(dt);
  }

  // ----------------------------------------------------------------------
  // Slide
  // ----------------------------------------------------------------------
  private beginSlide(): void {
    this.state = 'slide';
    this.slideTimer = 0;
    this.vx = Math.max(this.vx, 0) * PHYSICS.slideBoost;
    this.events.push({ type: 'slide' });
    this.events.push({ type: 'label', text: 'SLIDE', color: '#9ad7ff' });
  }

  private updateSlide(input: InputState, dt: number): void {
    this.slideTimer += dt;

    // Slide friction decay.
    this.vx = approach(this.vx, 0, PHYSICS.slideFriction * dt);

    // Downhill acceleration while sliding on a slope.
    const slope = this.groundSlope();
    if (Math.abs(slope) > 0.05) {
      this.vx += Math.sin(slope) * PHYSICS.slopeSlideAcceleration * dt;
    }

    // Sliding under an overhead pipe is a clean move.
    this.checkHazards(dt);

    // Release conditions.
    const wantStand = !input.crouchHeld && this.slideTimer > 0.18;
    const tooSlow = Math.abs(this.vx) < 70;
    const tooLong = this.slideTimer > PHYSICS.maxSlideTime;
    if (wantStand || tooSlow || tooLong) {
      // Only stand if there is headroom.
      if (this.hasHeadroom()) {
        this.state = 'run';
        this.slideTimer = 0;
      } else {
        this.slideTimer = 0; // keep sliding until there is room
      }
    }

    this.applyGravityAndMove(dt);

    // Sliding off the edge of a roof must become a fall. Without this the
    // runner keeps the slide state while dropping into the void, and it can
    // never recover.
    if (!this.grounded && this.state === 'slide') {
      this.state = 'air';
      this.fallStartY = this.y;
      this.hasFallApex = true;
      this.airTime = 0;
    }
  }

  // ----------------------------------------------------------------------
  // Ledge grab / mantle
  // ----------------------------------------------------------------------
  private tryLedgeGrab(): boolean {
    if (this.state === 'ledgeHang' || this.state === 'mantle') return false;
    if (this.vy < -40) return false; // only when falling or level
    if (this.state === 'slide') return false;

    // A grab is only plausible for a modest fall. Catching a ledge after a
    // huge drop would trivialise the danger of height, so the fall speed is
    // capped: a very fast descent cannot be snagged.
    if (this.vy > PHYSICS.maxLedgeGrabFallSpeed) return false;

    // The runner must actually be falling. A runner who is still standing on
    // solid ground (or merely running off it) must not snag a lip ahead of
    // them: that would stop a full-speed run dead for no reason.
    if (this.grounded && this.vy <= 0) return false;
    if (this.vy < 8) return false;

    // Look for a lip to grab. Rather than casting a single forward ray, the
    // runner scans the region in front of them for a roof EDGE: a point where
    // solid ground exists but ends a short distance further along.
    //
    // The edge must sit between roughly knee and head height, and the runner
    // must be below its level (they are hanging on the outside of the lip).
    const edge = this.findLedgeEdge();
    if (!edge) return false;

    // The lip must be below the runner's feet (they are hanging on the
    // outside of it) but within arm's reach.
    const aboveFeet = this.y - edge.y;
    if (aboveFeet < 4 || aboveFeet > 86) return false;

    // A grab is only worth committing to if there is a lip to climb onto.
    // Without a landing surface the runner would grab, then immediately fall
    // back into the gap, which reads as a bug rather as a skill moment.
    if (!this.findMantleLanding(edge)) return false;

    // Grab.
    this.state = 'ledgeHang';
    this.ledgeGrab = edge;
    this.vx = 0;
    this.vy = 0;
    this.hangTimer = 0;
    this.events.push({ type: 'label', text: 'GRAB', color: '#ffd27f' });
    return true;
  }

  /**
   * Scans forward from the runner for a roof edge (a lip) within reach.
   *
   * A lip is a surface that exists at some x but has already ended a short
   * distance further along, so the runner can hook it.
   */
  private findLedgeEdge(): { x: number; y: number } | null {
    const reach = PHYSICS.ledgeGrabReach;
    const stepPx = 3;
    const searchTop = this.y - HITBOX.height - 6;
    const searchBottom = this.y - 2;

    for (let ahead = 4; ahead <= reach; ahead += stepPx) {
      const probeX = this.x + this.facing * ahead;

      // The surface at this x, searched from just above the runner's head so
      // roofs above them are not matched.
      const surface = this.terrain.raycastDown(probeX, searchTop, searchBottom - searchTop);
      if (!surface.hit) continue;

      // Is this the end of a surface? Probe a little further along.
      const beyondX = probeX + this.facing * 10;
      const beyond = this.terrain.raycastDown(beyondX, searchTop, searchBottom - searchTop);
      if (beyond.hit) continue; // the surface continues — not an edge

      return { x: probeX, y: surface.y };
    }

    return null;
  }

  /**
   * Searches for a solid landing surface just beyond a ledge.
   * Returns the landing position, or null when there is nothing to climb onto.
   */
  private findMantleLanding(ledge: { x: number; y: number }): Vec2 | null {
    // The roof to climb onto extends BACK from the lip (opposite the facing
    // direction), so the probes go backwards from the edge vertex.
    for (const behind of [8, 16, 24, 34, 46, 60]) {
      const probeX = ledge.x - this.facing * behind;
      const groundY = this.terrain.groundAt(probeX, ledge.y - 2);
      if (groundY !== null && Math.abs(groundY - ledge.y) < 24) {
        return { x: probeX, y: groundY };
      }
    }
    return null;
  }

  private updateHang(input: InputState, dt: number): void {
    this.hangTimer += dt;
    if (!this.ledgeGrab) {
      this.state = 'air';
      return;
    }

    // Mantle: jump / up input.
    if (this.jumpBufferTimer > 0 || input.jumpPressed) {
      this.jumpBufferTimer = 0;
      this.startMantle();
      return;
    }

    // Drop back down.
    if (input.crouchPressed) {
      this.state = 'air';
      this.ledgeGrab = null;
      this.vy = 60;
      return;
    }

    // Slide the hands along the ledge toward the runner's facing direction.
    const grip = this.ledgeGrab;
    this.x = damp(this.x, grip.x - this.facing * 14, 12, dt);
    this.y = damp(this.y, grip.y + 46, 12, dt);

    // Auto-mantle if hanging too long.
    if (this.hangTimer > 1.6) {
      this.startMantle();
    }
  }

  private startMantle(): void {
    if (!this.ledgeGrab) return;

    // Find a SOLID landing spot on top of the ledge. The grab already
    // verified one exists, but the world may have changed (a plank broke),
    // so it is re-checked here.
    const ledge = this.ledgeGrab;
    const landing = this.findMantleLanding(ledge);

    if (!landing) {
      // There is nothing to mantle onto: drop back down instead.
      this.state = 'air';
      this.ledgeGrab = null;
      this.vy = 40;
      return;
    }

    this.mantleFrom = { x: this.x, y: this.y };
    this.mantleTo = landing;
    this.mantleTimer = 0;
    this.state = 'mantle';
    this.events.push({ type: 'vault', flow: PHYSICS.flowRewardVault });
    this.addFlow(PHYSICS.flowRewardVault, 'VAULT');
    this.registerClean();
  }

  private updateMantle(dt: number): void {
    this.mantleTimer += dt;
    const t = clamp(this.mantleTimer / 0.42, 0, 1);
    const ease = t * t * (3 - 2 * t);

    this.x = lerp(this.mantleFrom.x, this.mantleTo.x, ease);
    this.y = lerp(this.mantleFrom.y, this.mantleTo.y, ease);
    this.vx = this.facing * 180 * (1 - ease) + this.facing * 120 * ease;
    this.vy = 0;

    if (t >= 1) {
      this.state = 'run';
      this.ledgeGrab = null;
      // Only claim ground contact if there really is ground here.
      const groundY = this.terrain.groundAt(this.x, this.y + 1);
      this.grounded = groundY !== null && Math.abs(groundY - this.y) < 6;
      this.lastSafeY = this.y;
    }
  }

  // ----------------------------------------------------------------------
  // Zipline
  // ----------------------------------------------------------------------
  private updateZip(dt: number): void {
    if (!this.zip) {
      this.state = 'air';
      return;
    }
    this.zipTimer += dt;
    const z = this.zip;

    // Slide along the cable, accelerating.
    const accel = 520;
    this.vx = Math.min(this.vx + accel * dt, 640);
    this.x += this.vx * dt;

    // The cable sags: interpolate y between the anchors.
    const t = clamp((this.x - z.x) / Math.max(z.endX - z.x, 1), 0, 1);
    const sag = Math.sin(t * Math.PI) * 26;
    const targetY = lerp(z.y, z.y + 14, t) + sag;
    this.y = damp(this.y, targetY, 10, dt);
    this.vy = 0;

    // Release at the end of the line.
    if (this.x >= z.endX - 6) {
      this.zip = null;
      this.state = 'air';
      this.vy = 120;
    }

    // Jump off early.
    if (this.jumpBufferTimer > 0) {
      this.jumpBufferTimer = 0;
      this.zip = null;
      this.state = 'air';
      this.vy = 420;
    }
  }

  // ----------------------------------------------------------------------
  // Stumble
  // ----------------------------------------------------------------------
  private updateStumble(dt: number): void {
    this.stumbleTimer -= dt;
    this.vx = approach(this.vx, 0, 900 * dt);
    this.vy += this.tuning.gravityDown * dt;

    const prevY = this.y;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // A stumbling runner still has to respect the ground: without this the
    // runner can stumble straight off a roof and fall through the world.
    const groundY = this.terrain.groundAt(this.x, Math.min(prevY, this.y));
    if (groundY !== null && this.y >= groundY - 0.001 && this.vy >= -0.001) {
      this.y = groundY;
      this.vy = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    if (this.stumbleTimer <= 0) {
      this.state = this.grounded ? 'run' : 'air';
      if (!this.grounded) {
        this.fallStartY = this.y;
        this.hasFallApex = true;
        this.airTime = 0;
      }
    }
  }

  // ----------------------------------------------------------------------
  // Physics helpers
  // ----------------------------------------------------------------------
  private doJump(): void {
    this.state = 'air';
    this.vy = -this.tuning.jumpSpeed;
    this.grounded = false;
    this.airTime = 0;
    this.fallStartY = this.y;
    this.hasFallApex = true;
    this.rollAvailable = false;
    this.rollBuffered = false;
    this.events.push({ type: 'jump' });

    // Edge leap: jumping within the final 16px of a roof lip.
    if (this.nearEdgeLeap()) {
      this.addFlow(PHYSICS.flowRewardEdgeLeap, 'EDGE LEAP');
      this.events.push({ type: 'edgeLeap', flow: PHYSICS.flowRewardEdgeLeap });
      this.registerClean();
    }
  }

  private nearEdgeLeap(): boolean {
    const edge = this.terrain.findEdgeRight(this.x, 200);
    if (!edge) return false;
    // The edge may be behind the runner too (jump off a lip going backwards).
    const distRight = edge.x - this.x;
    const distLeft = this.x - edge.x;
    const dist = Math.min(
      distRight >= 0 ? distRight : Infinity,
      distLeft >= 0 ? distLeft : Infinity,
    );
    return dist <= PHYSICS.edgeLeapWindow;
  }

  private applyGravityAndMove(dt: number): void {
    const falling = this.vy > 0;
    const g = falling
      ? this.tuning.gravityDown * this.tuning.fallGravityMultiplier
      : this.tuning.gravityUp;

    this.vy += g * dt;

    const wasGrounded = this.grounded;
    const prevY = this.y;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Ground collision.
    //
    // Screen space has +y pointing DOWN, so the probe must start at or above
    // the surface we are looking for. We search from the position BEFORE the
    // move (prevY) so that a runner who has already sunk slightly below a
    // surface still finds it, and clamp the result to the current position.
    const groundY = this.terrain.groundAt(this.x, Math.min(prevY, this.y));
    if (groundY !== null && this.y >= groundY - 0.001 && this.vy >= -0.001) {
      const impact = this.vy;
      this.y = groundY;
      this.vy = 0;
      // Only a genuine air -> ground transition is a landing. While the
      // runner is already grounded the ground probe succeeds every frame,
      // and calling `land()` again would spam landing/flow events and
      // destroy the gait (no foot ever completes a stride).
      if (!wasGrounded) {
        this.grounded = true;
        this.land(impact);
      } else {
        this.grounded = true;
      }
    } else {
      // STEP UP: the runner ran into a low obstacle (an AC unit or vent).
      // If a surface exists just ahead that is only slightly higher than the
      // current one, the runner vaults up onto it — this is what showcases
      // the leg IK climbing without needing a jump.
      //
      // This only applies while the runner is roughly ON the ground: during
      // a long fall the runner passes over many x positions, and stepping up
      // mid-air would cancel the fall entirely.
      const step = wasGrounded || this.vy < 60 ? this.findStepUp(prevY) : null;
      if (step !== null) {
        this.y = step;
        this.vy = 0;
        if (!wasGrounded) {
          this.grounded = true;
          this.land(0);
        } else {
          this.grounded = true;
        }
      } else {
        this.grounded = false;
      }
    }

    if (!this.grounded && wasGrounded) {
      // Just left the ground.
      this.fallStartY = this.y;
      this.hasFallApex = true;
      this.airTime = 0;
    }

    // Track the apex of the current fall: the highest point (smallest y) the
    // runner reached while airborne. The drop height at touchdown is then
    // measured from that apex, so it is correct whether the runner walked
    // off a ledge, jumped, or was already in the air when the level began.
    if (!this.grounded) {
      if (!this.hasFallApex || this.y < this.fallStartY) {
        this.fallStartY = this.y;
        this.hasFallApex = true;
      }
    } else {
      this.lastSafeY = this.y;
      this.rollAvailable = false;
      this.hasFallApex = false;
    }

    // Ceiling collision (head bump).
    if (this.vy < 0) {
      const ceiling = this.terrain.solidAt(this.x, this.headY);
      if (ceiling) {
        this.vy = 0;
      }
    }

    // Wall collision: block horizontal movement into a genuinely TALL
    // obstacle. Low obstacles (AC units, vents, kerbs) are steps that the
    // runner climbs over, so only a wall taller than the step height stops
    // them.
    const stepHeight = PHYSICS.maxStepHeight;
    if (this.vx > 0) {
      const probeX = this.x + this.hitbox.w * 0.5 + 2;
      if (this.isWallAt(probeX, stepHeight)) this.vx = 0;
    } else if (this.vx < 0) {
      const probeX = this.x - this.hitbox.w * 0.5 - 2;
      if (this.isWallAt(probeX, stepHeight)) this.vx = 0;
    }
  }

  /**
   * True when a solid obstacle at `x` rises more than `maxHeight` above the
   * runner's feet, i.e. it is a wall rather than a steppable ledge.
   */
  private isWallAt(x: number, maxHeight: number): boolean {
    // Find the surface directly under the runner.
    const feet = this.terrain.groundAt(this.x, this.y);
    if (feet === null) return false;

    // The obstacle's top at the probe x, searched from above the feet.
    const top = this.terrain.raycastDown(x, feet - 4, 4 + maxHeight + 2);
    if (!top.hit) return false;

    // A wall rises above the allowed step height.
    return feet - top.y > maxHeight;
  }

  /**
   * Finds a low step just ahead of the runner that they can climb onto.
   * Returns the new surface height, or null when there is no step.
   */
  private findStepUp(prevY: number): number | null {
    const maxRise = PHYSICS.maxStepHeight;
    // The step must be a genuine step: the runner is standing at the level
    // of the obstacle's base, not sailing over it.
    const base = this.terrain.groundAt(this.x, prevY);
    if (base === null) return null;

    // Search a short distance ahead for a surface that is slightly higher.
    for (let ahead = 2; ahead <= 14; ahead += 2) {
      const probeX = this.x + this.facing * ahead;
      // Look for a surface between `base - maxRise` and `base`.
      const hit = this.terrain.raycastDown(probeX, base - maxRise, maxRise + 2);
      if (!hit.hit) continue;
      // It must be a step up (higher = smaller y) but not a wall.
      const rise = base - hit.y;
      if (rise <= 0 || rise > maxRise) continue;
      return hit.y;
    }
    return null;
  }

  private land(impact: number): void {
    const dropHeight = this.y - this.fallStartY;

    // Tuck-and-roll: converting fall energy into a forward burst.
    // A roll needs BOTH an explicit tuck input AND a fall long enough to
    // justify one. The `rollAvailable` flag is set once the drop passes the
    // threshold, so holding crouch through the fall satisfies the second
    // condition without needing to time the press exactly.
    const wantsRoll = this.rollBuffered;
    const dropRatio = dropHeight / PHYSICS.tuckRollDropHeight;

    if (wantsRoll && dropRatio >= 0.55) {
      this.rollBuffered = false;
      this.rollAvailable = false;
      this.vx = Math.max(Math.abs(this.vx), this.tuning.baseSpeed) * PHYSICS.rollSpeedRetention;
      this.addFlow(PHYSICS.flowRewardLanding, 'ROLL');
      this.events.push({ type: 'roll', flow: PHYSICS.flowRewardLanding });
      this.registerClean();
      // The roll ends with the runner back on the roof: it must return to the
      // ground state, otherwise it keeps the AIR state and can never plan a
      // jump or pick up another footstep.
      this.state = 'run';
      this.events.push({ type: 'land', impact: Math.min(impact, 400), material: 'concrete' });
      return;
    }

    if (impact > PHYSICS.hardLandingSpeed) {
      // Hard landing -> stumble (unless Flow Save is armed).
      if (this.flow.armed && consumeFlowSave(this.flow)) {
        this.triggerFlowSave();
        return;
      }
      this.state = 'stumble';
      this.stumbleTimer = PHYSICS.stumbleDuration;
      breakCleanStreak(this.flow);
      this.addFlow(-PHYSICS.stumbleFlowLoss, 'STUMBLE');
      this.events.push({ type: 'stumble' });
      this.events.push({ type: 'land', impact: Math.min(impact, 900), material: 'concrete' });
      return;
    }

    // Soft landing on a slope.
    this.squash = clamp(impact / 900, 0, 1);
    // A slide survives contact with the ground — that is the whole point of
    // sliding under a pipe. Only a normal run resumes from a landing.
    if (this.state !== 'slide') {
      this.state = 'run';
    }
    this.rollBuffered = false;
    this.rollAvailable = false;
    this.events.push({ type: 'land', impact: Math.min(impact, 900), material: 'concrete' });

    // A clean landing from a decent height earns flow.
    if (dropHeight > 46 && dropRatio < 0.85) {
      this.addFlow(PHYSICS.flowRewardLanding, 'CLEAN LANDING');
      this.events.push({ type: 'label', text: '+FLOW', color: '#8ef5c8' });
    }
  }

  /** Flow Save recovery: a handspring onto the next roof. */
  /**
   * Rescues the runner who fell past the last safe roof.
   *
   * Returns true when the Flow Save was spent and the runner was pulled back
   * onto solid ground; false when there was no Flow Save to spend and the
   * run must end.
   */
  tryFlowSaveRescue(): boolean {
    if (this.state === 'dead') return false;
    if (!this.flow.armed) return false;
    if (!consumeFlowSave(this.flow)) return false;

    this.events.push({ type: 'flowSave' });
    this.events.push({ type: 'label', text: 'FLOW SAVE!', color: '#5fe0ff' });

    // Haul the runner back up onto solid ground ahead of them. The rescue
    // scans forward for a surface at (or above) the last safe height, so the
    // runner is placed on a real roof rather than in mid-air.
    let rescueX = this.x + this.facing * 60;
    let groundY: number | null = null;
    for (let i = 0; i < 12; i++) {
      const probeX = this.x + this.facing * (40 + i * 45);
      const hit = this.terrain.raycastDown(probeX, this.lastSafeY - 260, 620);
      if (!hit.hit) continue;
      // The rescue spot must be clear: a runner dropped inside an obstacle
      // would be stuck there with no way forward. The whole body is checked.
      let blocked = false;
      for (let bodyY = hit.y - 8; bodyY > hit.y - HITBOX.height - 4; bodyY -= 10) {
        if (this.terrain.solidAt(probeX, bodyY)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      rescueX = probeX;
      groundY = hit.y;
      break;
    }
    if (groundY === null) {
      // No roof ahead: fall back to the last known safe height.
      groundY = this.lastSafeY;
    }
    this.x = rescueX;
    this.y = groundY;
    this.vy = 0;
    this.vx = this.facing * Math.max(Math.abs(this.vx), this.tuning.baseSpeed);
    this.state = 'run';
    this.grounded = true;
    this.fallStartY = this.y;
    this.hasFallApex = false;
    this.airTime = 0;
    this.squash = 0.5;
    return true;
  }

  private triggerFlowSave(): void {
    this.events.push({ type: 'flowSave' });
    this.events.push({ type: 'label', text: 'FLOW SAVE!', color: '#5fe0ff' });
    this.state = 'air';
    this.vy = -PHYSICS.flowSaveRecoverySpeed * 0.75;
    this.vx = this.facing * PHYSICS.flowSaveRecoverySpeed;
    this.grounded = false;
    this.squash = 0;
  }

  /**
   * Registers a clean parkour move and awards the streak bonus when the
   * runner strings enough of them together.
   */
  private registerClean(): void {
    const bonus = registerCleanMove(this.flow);
    if (bonus > 0) {
      this.addFlow(bonus, 'CLEAN STREAK');
    }
  }

  private addFlow(amount: number, reason: string): void {
    const wasPure = this.flow.pureFlow;
    addFlow(this.flow, amount);
    this.events.push({ type: 'flow', amount, reason });
    if (amount > 0) {
      this.events.push({ type: 'label', text: `+${Math.round(amount)} FLOW`, color: '#8ef5c8' });
    }
    // Entering Tier 3 is the Pure Flow moment: the meter is fully charged,
    // the Flow Save is armed and the runner moves at their fastest.
    if (!wasPure && this.flow.pureFlow) {
      this.events.push({ type: 'flow', amount: 0, reason: 'PURE FLOW' });
      this.events.push({ type: 'label', text: 'PURE FLOW', color: '#5fe0ff' });
    }
  }

  private checkHazards(dt: number): void {
    const rect = this.hitbox;

    // --- Overhead pipe: sliding under it is a clean move -----------------------
    for (const h of this.terrain.hazards) {
      if (h.broken) continue;
      if (h.kind !== 'pipe') continue;

      // Only the runner's horizontal span matters for a pipe: they pass
      // through it lengthwise.
      const horizontalOverlap = rect.x < h.x + h.w && rect.x + rect.w > h.x;
      if (!horizontalOverlap) continue;

      // The pipe's bottom edge is the clearance line.
      const pipeBottom = h.y + h.h;

      // A pipe is scored ONCE. After that the runner simply passes through
      // it, so a single collision cannot drain the meter every frame.
      if ((h.meta?.scored ?? 0) === 1) continue;

      if (this.state === 'slide') {
        // A slide clears the pipe: award the clean move.
        this.addFlow(PHYSICS.flowRewardSlide, 'SLIDE UNDER');
        this.events.push({ type: 'slideUnder', flow: PHYSICS.flowRewardSlide });
        this.registerClean();
        h.meta = { ...(h.meta ?? {}), scored: 1 };
      } else if (rect.y < pipeBottom - 2) {
        // Running upright into the pipe hurts and slows the runner.
        this.addFlow(-15, 'HIT');
        this.vx *= 0.4;
        h.meta = { ...(h.meta ?? {}), scored: 1 };
      }
    }

    // --- Fragile planks / glass -----------------------------------------------
    for (const h of this.terrain.hazards) {
      if (h.broken) continue;
      if (h.kind !== 'plank' && h.kind !== 'glass') continue;

      // Fragile surfaces are worn down by the runner's FEET, not by their
      // whole body: standing on a plank loads it, but merely running past
      // underneath one (e.g. while falling) does not.
      const feetOverlap =
        this.x + HITBOX.width * 0.5 > h.x &&
        this.x - HITBOX.width * 0.5 < h.x + h.w &&
        this.y > h.y - 4 &&
        this.y < h.y + h.h + 6;
      if (!feetOverlap) continue;

      const fragile = h.kind === 'plank' ? (h.meta?.fragile ?? 0) === 1 : true;
      if (!fragile) continue;

      // The crack timer accumulates real elapsed seconds so the fuse length
      // is frame-rate independent.
      const previous = h.state ?? 0;
      h.state = previous + dt;
      const fast = h.kind === 'plank' ? (h.meta?.fast ?? 0) === 1 : false;
      const crackAt = fast ? 0.22 : 0.55;

      if (previous === 0) {
        this.events.push({ type: 'crack', kind: h.kind });
      }

      if (h.state >= crackAt) {
        h.broken = true;
        this.events.push({ type: 'break', kind: h.kind });
        // Falling through a fragile surface.
        if (h.kind === 'glass') {
          this.vy = Math.max(this.vy, 40);
        }
      }
    }

    // --- Spring awnings --------------------------------------------------------
    for (const h of this.terrain.hazards) {
      if (h.broken) continue;
      if (h.kind !== 'spring') continue;
      const overlaps =
        rect.x < h.x + h.w && rect.x + rect.w > h.x && rect.y < h.y + h.h && rect.y + rect.h > h.y;
      if (!overlaps) continue;
      if (this.springCooldown > 0) continue;

      this.springCooldown = 0.35;
      h.state = 1;
      const power = 1;
      this.vy = -this.tuning.jumpSpeed * 1.15 * power;
      this.state = 'air';
      this.grounded = false;
      // Lift the runner clear of the awning so the bounce reads cleanly.
      this.y -= 2;
      this.events.push({ type: 'springLaunch', power });
      this.events.push({ type: 'break', kind: 'spring' });
    }
  }

  /** The ground slope under the runner, in radians. */
  private groundSlope(): number {
    const hit = this.terrain.raycastDown(this.x, this.y - 2, 80);
    return hit.hit ? hit.angle : 0;
  }

  private hasHeadroom(): boolean {
    const rect = this.hitbox;
    const head = rect.y - 2;
    for (const h of this.terrain.hazards) {
      if (h.kind !== 'pipe') continue;
      if (head < h.y + h.h && head > h.y) return false;
    }
    return true;
  }

  /** Finds a zipline the runner can grab. */
  tryGrabZipline(): boolean {
    if (this.state !== 'air') return false;
    const handY = this.y - SKELETON.torsoLength;
    for (const h of this.terrain.hazards) {
      if (h.broken) continue;
      if (h.kind !== 'zipline') continue;
      if (this.x < h.x - 10 || this.x > h.x + h.w + 10) continue;
      if (Math.abs(h.y - handY) > 40) continue;
      this.zip = { x: h.x, y: h.y, endX: h.meta?.endX ?? h.x + h.w };
      this.state = 'zip';
      this.vy = 0;
      this.zipTimer = 0;
      this.events.push({ type: 'ziplineGrab' });
      return true;
    }
    return false;
  }

  // ----------------------------------------------------------------------
  // Rig helpers
  // ----------------------------------------------------------------------
  /**
   * Cached swing lift per foot (pixels above the surface).
   *
   * The lift is computed once per frame by `footTargets()` and reused by the
   * rig so the foot's contact state and its visual position can never
   * disagree.
   */
  private leftLift = 0;
  private rightLift = 0;

  private rigSignal() {
    return {
      x: this.x,
      y: this.y,
      facing: this.facing,
      speed: Math.abs(this.vx),
      grounded: this.grounded,
      state: this.state,
      lean: this.lean,
      squash: this.squash,
      groundNormal: { x: 0, y: -1 },
      vy: this.vy,
      leftLift: this.leftLift,
      rightLift: this.rightLift,
    };
  }

  /**
   * World-space ankle targets for each foot.
   * The target is found by casting a ray down from the hip, offset by the
   * stride animation.
   */
  private footTargets(): { left: Vec2; right: Vec2 } {
    const hipY = this.y - SKELETON.hipHeight;

    const phaseL = this.rig.gaitPhase;
    const phaseR = (this.rig.gaitPhase + 0.5) % 1;
    const speedN = clamp(Math.abs(this.vx) / 620, 0, 1);
    const stride = lerp(40, 96, speedN);

    // Stride offset: each foot swings forward of the hip while in swing.
    const offL = Math.sin(phaseL * Math.PI * 2) * stride * 0.5;
    const offR = Math.sin(phaseR * Math.PI * 2) * stride * 0.5;

    const airborne = this.state === 'air' || this.state === 'ledgeHang' || this.state === 'zip';
    const sliding = this.state === 'slide';

    // Swing lift: the foot in the swing phase lifts clear of the surface.
    // Without this both feet stay glued down and the runner never actually
    // takes a step, which kills the footstep audio and the gait animation.
    const liftL = this.swingLift(phaseL, airborne, sliding);
    const liftR = this.swingLift(phaseR, airborne, sliding);
    this.leftLift = liftL;
    this.rightLift = liftR;

    const left = this.resolveFoot(hipY, -offL, airborne, sliding, liftL);
    const right = this.resolveFoot(hipY, -offR, airborne, sliding, liftR);
    return { left, right };
  }

  /**
   * How far the foot lifts above the surface during its swing phase.
   *
   * A sin^2 window keeps the lift smooth: zero while the foot is planted,
   * peaking in the middle of the swing.
   */
  private swingLift(phase: number, airborne: boolean, sliding: boolean): number {
    if (sliding) return 0;
    if (airborne) return 0;

    // A gait cycle has a stance phase (foot planted, lift 0) and a swing
    // phase (foot lifted). The stance window is the first half of the cycle;
    // because the two feet are half a cycle apart, the stance windows never
    // overlap, so exactly one foot is planted at any moment. Without a
    // genuine stance window the foot hovers just above the surface and the
    // contact state flickers, producing almost no footsteps.
    const STANCE = 0.5;
    if (phase < STANCE) return 0;

    const swingT = (phase - STANCE) / (1 - STANCE);
    const speedN = clamp(Math.abs(this.vx) / 620, 0, 1);
    const height = lerp(12, 30, speedN);
    // Smooth bell: zero at the start and end of the swing, peak in the middle.
    return Math.sin(swingT * Math.PI) * height;
  }

  private resolveFoot(
    hipY: number,
    strideOffset: number,
    airborne: boolean,
    sliding: boolean,
    lift = 0,
  ): Vec2 {
    const probeX = this.x + strideOffset;
    const hit = this.terrain.raycastDown(probeX, hipY + 6, 520);

    if (!hit.hit) {
      // The stride reached past the edge of a roof. Fall back to the ground
      // directly beneath the runner so the leg still lands on solid footing
      // instead of dangling into the void.
      const under = this.terrain.raycastDown(this.x, hipY + 6, 520);
      if (under.hit) {
        return { x: this.x, y: under.hit ? under.y : hipY + 80 };
      }
      // No ground below at all: keep the leg hanging at a natural distance.
      return { x: probeX, y: hipY + SKELETON.thighLength + SKELETON.shinLength - 6 };
    }

    if (airborne) {
      // Legs tuck up in the air, but still reach toward the ground.
      const tuck = 26;
      return {
        x: probeX,
        y: Math.min(hit.y, hipY + SKELETON.thighLength + SKELETON.shinLength) - tuck,
      };
    }

    if (sliding) {
      // Slide: both legs extend forward along the ground.
      return { x: probeX + this.facing * 6, y: hit.y };
    }

    // Grounded: the foot sits on the surface, lifted by the swing phase.
    return { x: probeX, y: hit.y - lift };
  }

  private footAngles(): { left: number; right: number } {
    const targets = this.footTargets();
    const l = this.terrain.raycastDown(targets.left.x, targets.left.y - 4, 40);
    const r = this.terrain.raycastDown(targets.right.x, targets.right.y - 4, 40);
    return {
      left: clamp(l.angle, -SKELETON.maxAnkleAngle, SKELETON.maxAnkleAngle),
      right: clamp(r.angle, -SKELETON.maxAnkleAngle, SKELETON.maxAnkleAngle),
    };
  }

  private footNormals(): { left: Vec2; right: Vec2 } {
    const targets = this.footTargets();
    const l = this.terrain.raycastDown(targets.left.x, targets.left.y - 4, 40);
    const r = this.terrain.raycastDown(targets.right.x, targets.right.y - 4, 40);
    return {
      left: { x: l.nx, y: l.ny },
      right: { x: r.nx, y: r.ny },
    };
  }

  /** Hand targets: both hands snap to the ledge corner when hanging. */
  private handTargets(): { left: Vec2 | null; right: Vec2 | null } {
    if (this.state === 'ledgeHang' && this.ledgeGrab) {
      const g = this.ledgeGrab;
      return {
        left: { x: g.x - 4, y: g.y + 1 },
        right: { x: g.x + 4, y: g.y + 1 },
      };
    }
    if (this.state === 'zip') {
      const z = this.zip;
      if (z) {
        return {
          left: { x: this.x - 3, y: z.y + 2 },
          right: { x: this.x + 3, y: z.y + 2 },
        };
      }
    }
    return { left: null, right: null };
  }

  /** Emits a footstep when a foot transitions from swing to contact. */
  private detectFootsteps(): void {
    const speed = Math.abs(this.vx);
    if (speed < 40) return;

    const l = this.rig.leftFoot;
    const r = this.rig.rightFoot;

    const emit = (foot: typeof l): void => {
      if (!foot.grounded || foot.wasGrounded) return;
      const hit = this.terrain.raycastDown(foot.toe.x, foot.toe.y - 2, 30);
      this.events.push({
        type: 'footstep',
        material: hit.material,
        speed: clamp(speed / 620, 0, 1),
      });
    };

    emit(l);
    emit(r);
  }

  /** Consumes a queued event, if any. */
  shiftEvent(): GameEvent | undefined {
    return this.events.shift();
  }

  drainEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}
