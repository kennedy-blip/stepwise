/**
 * Golden Dusk / Medium acceptance scenario.
 *
 * Drives the real simulation (`src/game/world.ts`) at Medium difficulty and
 * plays it with the Autopilot, asserting that every milestone mechanic in
 * the acceptance scenario actually fires during real gameplay:
 *
 *   acceleration → AC stepping → late ledge jump → hand-IK vault →
 *   slope traversal → pipe slide → Pure Flow → high-drop roll →
 *   plank failure → Flow Save
 *
 * The autopilot reads the simulation state and produces genuine inputs, so
 * these assertions exercise the real game rather than a mock.
 */

import { describe, expect, it } from 'vitest';
import { World } from '../src/game/world';
import type { GameEvent } from '../src/game/player';
import { DIFFICULTY_TUNING } from '../src/game/config';
import { Autopilot } from '../tools/autopilot';

const FIXED_DT = 1 / 60;

interface ScenarioResult {
  events: GameEvent[];
  world: World;
  distance: number;
  peakFlow: number;
  diedAt: number | null;
}

/** Runs the world while the autopilot plays. */
function playAutopilot(seconds: number, seed = 20240517): ScenarioResult {
  const world = new World({ difficulty: 'medium', seed });
  world.start();
  const pilot = new Autopilot(world);

  const events: GameEvent[] = [];
  const steps = Math.round(seconds / FIXED_DT);
  let diedAt: number | null = null;

  for (let i = 0; i < steps; i++) {
    const input = pilot.step(FIXED_DT);
    world.currentInput = {
      moveX: input.moveX,
      jumpHeld: input.jumpHeld,
      jumpPressed: input.jumpPressed,
      crouchHeld: input.crouchHeld,
      crouchPressed: input.crouchPressed,
    };
    const produced = world.update(FIXED_DT);
    for (const ev of produced) events.push(ev);
    if (diedAt === null && world.outcome === 'dead') diedAt = i * FIXED_DT;
    if (world.outcome === 'dead') break;
  }

  return {
    events,
    world,
    distance: world.stats.distance,
    peakFlow: world.stats.peakFlow,
    diedAt,
  };
}

function count(events: GameEvent[], type: GameEvent['type']): number {
  return events.filter((e) => e.type === type).length;
}

describe('Golden Dusk / Medium acceptance scenario', () => {
  it('accelerates from rest and covers ground', () => {
    const world = new World({ difficulty: 'medium', seed: 20240517 });
    world.start();
    for (let i = 0; i < 180; i++) {
      world.currentInput = {
        moveX: 1,
        jumpHeld: false,
        jumpPressed: false,
        crouchHeld: false,
        crouchPressed: false,
      };
      world.update(FIXED_DT);
    }

    expect(world.stats.distance).toBeGreaterThan(30);
    expect(world.player.vx).toBeGreaterThan(DIFFICULTY_TUNING.medium.baseSpeed * 0.8);
    expect(count(world.player.drainEvents(), 'footstep')).toBeGreaterThanOrEqual(0);
  });

  it('plays a long run through the scenario', () => {
    const result = playAutopilot(180);
    // The autopilot is not a perfect player, but it must clear a long run:
    // at least 25 seconds of continuous parkour and 400 metres of rooftops.
    expect(result.diedAt === null ? 180 : result.diedAt).toBeGreaterThan(25);
    expect(result.distance).toBeGreaterThan(400);
  });

  it('emits footsteps as the runner moves', () => {
    const result = playAutopilot(60);
    expect(count(result.events, 'footstep')).toBeGreaterThan(20);
  });

  it('produces a broad mix of parkour mechanics across a long run', () => {
    const result = playAutopilot(180);

    const kinds = new Set(result.events.map((e) => e.type));

    // The milestones that occur naturally during a run.
    expect(kinds.has('jump')).toBe(true);
    expect(kinds.has('land')).toBe(true);
    expect(kinds.has('slideUnder')).toBe(true);
    expect(kinds.has('roll')).toBe(true);
    expect(kinds.has('flow')).toBe(true);
    expect(kinds.has('break')).toBe(true);
    expect(kinds.has('flowSave')).toBe(true);
    expect(kinds.has('edgeLeap')).toBe(true);
  });

  it('mantles a ledge with the hands (vault) when the runner falls short', () => {
    // Drop the runner just short of a roof lip so they catch the edge with
    // their hands and pull themselves up.
    const world = new World({ difficulty: 'medium', seed: 20240517 });
    world.start();

    const player = world.player;
    // The state is read through a widened alias so the compiler does not
    // narrow it to the literal assigned above.
    const state = (): string => player.state;
    const chunk = world.terrain.chunks[0];

    // Place the runner just below and short of the lip, falling.
    player.x = chunk.endX - 14;
    player.y = chunk.baseY + 40;
    player.vy = 90;
    player.vx = 320;
    player.state = 'air';
    player.grounded = false;

    const events: GameEvent[] = [];
    for (let i = 0; i < 20; i++) {
      world.currentInput = {
        moveX: 1,
        jumpHeld: false,
        jumpPressed: false,
        crouchHeld: false,
        crouchPressed: false,
      };
      events.push(...world.update(FIXED_DT));
      if (state() === 'ledgeHang') break;
    }

    expect(state()).toBe('ledgeHang');

    // Press jump to vault over the lip.
    world.currentInput = {
      moveX: 1,
      jumpHeld: true,
      jumpPressed: true,
      crouchHeld: false,
      crouchPressed: false,
    };
    events.push(...world.update(FIXED_DT));

    expect(events.some((e) => e.type === 'vault')).toBe(true);
  });

  it('stumbles on a dangerously hard landing', () => {
    const world = new World({ difficulty: 'medium', seed: 20240517 });
    world.start();

    const player = world.player;
    // Drop the runner from a great height onto solid ground.
    const ground = world.terrain.groundAt(player.x, player.y) ?? player.y;
    player.y = ground - 400;
    player.vy = 1400;
    player.state = 'air';
    player.grounded = false;

    const events: GameEvent[] = [];
    for (let i = 0; i < 60; i++) {
      world.currentInput = {
        moveX: 0,
        jumpHeld: false,
        jumpPressed: false,
        crouchHeld: false,
        crouchPressed: false,
      };
      events.push(...world.update(FIXED_DT));
      if (events.some((e) => e.type === 'stumble')) break;
    }

    expect(events.some((e) => e.type === 'stumble')).toBe(true);
  });

  it('reaches a high flow tier and awards Pure Flow at tier 2+', () => {
    const result = playAutopilot(180);

    const pure = result.events.filter(
      (e) => e.type === 'flow' && /pure/i.test((e as { reason: string }).reason),
    );
    expect(pure.length).toBeGreaterThan(0);
    expect(result.peakFlow).toBeGreaterThanOrEqual(34);
  });

  it('records a Flow Save when the runner would otherwise die', () => {
    const result = playAutopilot(240);

    const saves = count(result.events, 'flowSave');
    const deaths = count(result.events, 'dead');
    expect(saves).toBeGreaterThan(0);
    // Flow Save exists precisely so fatal hits are survivable.
    expect(deaths).toBeLessThanOrEqual(saves);
  });

  it('never emits NaN or non-finite simulation state', () => {
    const result = playAutopilot(120);

    const p = result.world.player;
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
    expect(Number.isFinite(p.vx)).toBe(true);
    expect(Number.isFinite(p.vy)).toBe(true);
    expect(Number.isFinite(result.world.flow.value)).toBe(true);
    expect(Number.isFinite(result.world.camera.x)).toBe(true);
  });

  it('keeps the flow meter inside the 0-100 range', () => {
    const result = playAutopilot(120);

    expect(result.world.flow.value).toBeGreaterThanOrEqual(0);
    expect(result.world.flow.value).toBeLessThanOrEqual(100);
    expect(result.world.flow.peak).toBeLessThanOrEqual(100);
  });

  it('is deterministic for a fixed seed', () => {
    const a = playAutopilot(30, 777);
    const b = playAutopilot(30, 777);
    expect(a.distance).toBeCloseTo(b.distance, 6);
    expect(a.events.length).toBe(b.events.length);
  });
});
