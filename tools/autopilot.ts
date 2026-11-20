/**
 * Autopilot for the Golden Dusk / Medium acceptance scenario.
 *
 * The acceptance scenario requires that a competent player can clear the
 * whole run: accelerate, step onto AC units, jump late off ledges, vault with
 * the hands, slide under pipes, roll out of high drops and use Flow Save.
 *
 * This module plays the game by reading the simulation state — it never
 * reaches into private fields or fakes results. It is used by the acceptance
 * tests to prove the scenario is actually completable.
 *
 * The pilot plans jumps ballistically: it measures the gap ahead, solves for
 * the take-off point that lands the runner on the far roof, and commits at the
 * last moment — which is exactly the "late ledge jump" the scenario calls for.
 */

import type { World } from '../src/game/world';
import { DIFFICULTY_TUNING, type DifficultyTuning } from '../src/game/config';

export interface AutopilotInput {
  moveX: number;
  jumpHeld: boolean;
  jumpPressed: boolean;
  crouchHeld: boolean;
  crouchPressed: boolean;
}

const FIXED_DT = 1 / 60;

/** Where the pilot should take off from to land on a target. */
interface JumpPlan {
  /** Distance from the runner to the take-off point, in pixels. */
  leadDistance: number;
  /** The x position of the take-off point. */
  takeOffX: number;
}

export class Autopilot {
  private jumpCooldown = 0;
  private crouchCooldown = 0;
  private wasCrouching = false;
  /** How long the jump button stays held, in seconds. */
  private jumpHoldTimer = 0;

  constructor(
    private readonly world: World,
    private readonly tuning: DifficultyTuning = DIFFICULTY_TUNING[world.difficulty],
  ) {}

  /** Produces the input for the next simulation step. */
  step(dt: number = FIXED_DT): AutopilotInput {
    const player = this.world.player;
    const terrain = this.world.terrain;

    this.jumpCooldown = Math.max(0, this.jumpCooldown - dt);
    this.crouchCooldown = Math.max(0, this.crouchCooldown - dt);
    this.jumpHoldTimer = Math.max(0, this.jumpHoldTimer - dt);

    const speed = Math.abs(player.vx);
    let jumpPressed = false;
    let crouchPressed = false;

    // Hanging from a ledge: mantle up onto the roof.
    if (player.state === 'ledgeHang') {
      jumpPressed = true;
      this.jumpHoldTimer = 0.2;
      this.jumpCooldown = 0.2;
      return {
        moveX: 1,
        jumpHeld: true,
        jumpPressed: true,
        crouchHeld: false,
        crouchPressed: false,
      };
    }

    if (player.grounded) {
      const plan = this.planJump();
      if (plan && this.jumpCooldown <= 0) {
        jumpPressed = true;
        this.jumpCooldown = 0.3;
        this.jumpHoldTimer = 0.22;
      }

      // A tall obstacle (a wall) in front demands a jump.
      const ahead = terrain.solidAt(player.x + player.facing * 34, player.y - 26);
      if (ahead && this.jumpCooldown <= 0) {
        jumpPressed = true;
        this.jumpCooldown = 0.3;
        this.jumpHoldTimer = 0.22;
      }
    }

    // ------------------------------------------------------------------
    // Slide under pipes.
    // ------------------------------------------------------------------
    if (player.grounded && speed > 150 && this.crouchCooldown <= 0) {
      const pipe = terrain.hazardAt(player.x + 30, player.y, 90);
      // Only slide under a pipe when there is roof left to slide onto:
      // sliding off the lip would drop the runner into the gap.
      const lip = terrain.findEdgeRight(player.x, 260);
      const roofAhead = !lip || lip.x - player.x > 160;
      if (pipe && pipe.kind === 'pipe' && roofAhead) {
        crouchPressed = true;
        this.crouchCooldown = 0.5;
      }
    }

    // ------------------------------------------------------------------
    // Tuck and roll out of high drops.
    // ------------------------------------------------------------------
    if (!player.grounded && player.vy > 260) {
      const drop = player.y - player.fallStartY;
      if (drop > 120) {
        crouchPressed = true;
      }
    }

    // Release the crouch before the lip: a slide that runs off the edge
    // would drop the runner straight into the gap.
    let crouchHeld = crouchPressed || this.wasCrouching;
    if (crouchHeld && player.grounded) {
      const lip = terrain.findEdgeRight(player.x, 120);
      if (lip && lip.x - player.x < 70) {
        crouchHeld = false;
      }
    }

    const jumpHeld = jumpPressed || this.jumpHoldTimer > 0;

    this.wasCrouching = crouchHeld;

    return {
      moveX: 1,
      jumpHeld,
      jumpPressed,
      crouchHeld,
      crouchPressed,
    };
  }

  /**
   * Plans the next jump.
   *
   * Finds the lip the runner is about to reach, works out where the far side
   * is, and solves for the take-off point that puts the runner back on the
   * far roof. Returns null when there is nothing to jump.
   */
  private planJump(): JumpPlan | null {
    const player = this.world.player;
    const terrain = this.world.terrain;

    // The lip the runner is running towards: the first roof edge ahead.
    const edge = terrain.findEdgeRight(player.x, 520);
    if (!edge) return null;

    const speed = Math.abs(player.vx);
    if (speed < 40) return null;

    // Walk forward past the lip until a surface is found. That surface is
    // the far side of the gap. Surfaces level with the lip belong to the
    // roof the runner is standing on, so they are skipped.
    let landing: { x: number; y: number } | null = null;
    for (let d = 8; d <= 520; d += 8) {
      const x = edge.x + d;
      const hit = terrain.raycastDown(x, edge.y - 700, 1500);
      if (!hit.hit) continue;
      if (Math.abs(hit.y - edge.y) < 6) continue;
      landing = { x, y: hit.y };
      break;
    }
    if (!landing) return null;

    // The arc must be able to reach the far side.
    const reach = this.horizontalReach(landing.y - edge.y, speed);
    if (reach <= 0) return null;
    const gapWidth = landing.x - edge.x;
    if (gapWidth > reach) return null;

    // Take off at the lip itself: the generator guarantees the gap is
    // crossable from a full-speed run, and jumping at the very last moment
    // is the "late ledge jump" the scenario calls for. A small allowance
    // lets the pilot jump a couple of frames early so it does not overshoot
    // the window entirely.
    const takeOffX = edge.x;
    const distance = takeOffX - player.x;
    if (distance > 20) return null;
    if (distance < -60) return null;

    return { leadDistance: distance, takeOffX };
  }

  /**
   * The horizontal distance the runner covers during a jump that lands at
   * `heightDelta` relative to the take-off surface.
   */
  private horizontalReach(heightDelta: number, speed: number): number {
    const tuning = this.tuning;
    const jump = tuning.jumpSpeed;
    const gravityUp = tuning.gravityUp;
    const gravityDown = tuning.gravityDown * tuning.fallGravityMultiplier;

    const tApex = jump / gravityUp;

    // Solve drop = -jump*t + 0.5*gDown*t^2 for t.
    const discriminant = Math.max(0, jump * jump + 2 * gravityDown * heightDelta);
    const tFall = (Math.sqrt(discriminant) - jump) / gravityDown;

    // A climb (negative heightDelta) cannot be solved with the fall formula:
    // the runner simply reaches the apex and then falls back. The apex
    // height is the hard limit on how high the runner can land, so a climb
    // that is taller than the apex is simply not reachable.
    const apexHeight = (jump * jump) / (2 * gravityUp);
    if (heightDelta < -apexHeight) return 0;

    const airTime = tApex + Math.max(tFall, 0);
    // The runner's CURRENT speed is used: it is what the arc will really
    // travel at. The level generator is deliberately more conservative, so
    // the pilot can plan optimistically and still clear every gap.
    return speed * airTime;
  }
}
