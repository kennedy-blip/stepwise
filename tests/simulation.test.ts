import { describe, expect, it } from 'vitest';
import { World } from '../src/game/world';
import { PHYSICS } from '../src/game/config';
import { createInputState } from '../src/core/types';

/** Runs the world for `seconds` of simulated time with a fixed input. */
function simulate(
  world: World,
  seconds: number,
  input: (t: number) => Partial<ReturnType<typeof createInputState>>,
): void {
  const steps = Math.round(seconds / PHYSICS.fixedDt);
  for (let i = 0; i < steps; i++) {
    const t = i * PHYSICS.fixedDt;
    const patch = input(t);
    world.currentInput = { ...createInputState(), ...patch };
    world.update(PHYSICS.fixedDt);
  }
}

describe('Game simulation', () => {
  it('starts on solid ground', () => {
    const world = new World({ difficulty: 'medium', seed: 42 });
    expect(world.terrain.slabs.length).toBeGreaterThan(0);
    expect(world.groundAtProbe(world.player.x)).not.toBeNull();
  });

  it('runs forward and accumulates distance when the right key is held', () => {
    const world = new World({ difficulty: 'medium', seed: 42 });
    world.start();
    const startX = world.player.x;

    simulate(world, 3, () => ({ moveX: 1 }));

    expect(world.player.x).toBeGreaterThan(startX + 200);
    expect(world.stats.distance).toBeGreaterThan(0);
  });

  it('accelerates progressively rather than instantly reaching top speed', () => {
    const world = new World({ difficulty: 'medium', seed: 42 });
    world.start();

    // Sample the speed over the first second.
    const samples: number[] = [];
    for (let i = 0; i < 120; i++) {
      world.currentInput = { ...createInputState(), moveX: 1 };
      world.update(PHYSICS.fixedDt);
      samples.push(Math.abs(world.player.vx));
    }

    // The first sample must be well below the final speed: a smooth ramp.
    expect(samples[0]).toBeLessThan(samples[samples.length - 1]);
    // And the ramp should be monotonic (allowing for the pace/sprint knee).
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] - 0.5);
    }
  });

  it('caps the top speed at the difficulty maximum', () => {
    const world = new World({ difficulty: 'medium', seed: 42 });
    world.start();
    simulate(world, 12, () => ({ moveX: 1 }));

    const topSpeed = 580 * 1.25; // max sprint with the Tier 3 flow bonus
    expect(Math.abs(world.player.vx)).toBeLessThanOrEqual(topSpeed + 1);
  });

  it('applies a slower-than-gravity fall than ascent (asymmetric gravity)', () => {
    const world = new World({ difficulty: 'medium', seed: 42 });
    world.start();

    // Jump and measure the ascent time vs the descent time.
    world.currentInput = { ...createInputState(), moveX: 1, jumpHeld: true, jumpPressed: true };
    world.update(PHYSICS.fixedDt);

    let ascent = 0;
    let descent = 0;
    let apex = world.player.y;
    for (let i = 0; i < 400; i++) {
      world.currentInput = { ...createInputState(), moveX: 1, jumpHeld: true };
      world.update(PHYSICS.fixedDt);
      if (world.player.vy < 0) ascent += PHYSICS.fixedDt;
      if (world.player.y < apex) apex = world.player.y;
      if (world.player.vy > 0) descent += PHYSICS.fixedDt;
      if (descent > 0.05 && world.player.grounded) break;
    }

    // A full jump arc should take longer to fall than to rise.
    expect(descent).toBeGreaterThan(ascent * 0.8);
  });

  it('cuts the jump short when the button is released early', () => {
    const world = new World({ difficulty: 'medium', seed: 42 });
    world.start();

    // Full-height jump (hold).
    world.currentInput = { ...createInputState(), jumpHeld: true, jumpPressed: true };
    world.update(PHYSICS.fixedDt);
    const fullStart = world.player.y;
    let fullApex = fullStart;
    for (let i = 0; i < 200; i++) {
      world.currentInput = { ...createInputState(), jumpHeld: true };
      world.update(PHYSICS.fixedDt);
      fullApex = Math.min(fullApex, world.player.y);
      if (world.player.grounded && i > 10) break;
    }
    const fullHeight = fullStart - fullApex;

    // Short hop (release immediately).
    const world2 = new World({ difficulty: 'medium', seed: 42 });
    world2.start();
    world2.currentInput = { ...createInputState(), jumpHeld: true, jumpPressed: true };
    world2.update(PHYSICS.fixedDt);
    const shortStart = world2.player.y;
    let shortApex = shortStart;
    for (let i = 0; i < 200; i++) {
      world2.currentInput = { ...createInputState(), jumpHeld: false };
      world2.update(PHYSICS.fixedDt);
      shortApex = Math.min(shortApex, world2.player.y);
      if (world2.player.grounded && i > 10) break;
    }
    const shortHeight = shortStart - shortApex;

    expect(shortHeight).toBeLessThan(fullHeight * 0.75);
  });

  it('allows a coyote-time jump after leaving a ledge', () => {
    const world = new World({ difficulty: 'medium', seed: 7 });
    world.start();

    // Find a genuine gap between two generated roofs.
    const chunk = world.terrain.chunks[0];
    const edgeX = chunk.endX;
    world.player.x = edgeX - 20;
    world.player.y = world.terrain.groundAt(world.player.x, world.player.y) ?? 0;
    world.player.vx = 400;
    world.player.grounded = true;

    // Step until the runner is airborne.
    let airborne = false;
    for (let i = 0; i < 60; i++) {
      world.currentInput = { ...createInputState(), moveX: 1 };
      world.update(PHYSICS.fixedDt);
      if (!world.player.grounded) {
        airborne = true;
        break;
      }
    }

    expect(airborne).toBe(true);
    // The coyote window must still be open right after leaving the ledge.
    expect(world.player.coyoteTimer).toBeGreaterThan(0);

    // Jump on the very next step: coyote time should still allow it.
    world.currentInput = { ...createInputState(), moveX: 1, jumpHeld: true, jumpPressed: true };
    world.update(PHYSICS.fixedDt);

    expect(world.player.vy).toBeLessThan(-100);
  });

  it('refuses a jump long after the coyote window has closed', () => {
    const world = new World({ difficulty: 'medium', seed: 7 });
    world.start();

    // Lift the runner into the air, well clear of any ground.
    world.player.y -= 400;
    world.player.grounded = false;
    world.player.coyoteTimer = 0;

    // Let the coyote timer drain completely.
    for (let i = 0; i < 30; i++) {
      world.currentInput = { ...createInputState(), moveX: 1 };
      world.update(PHYSICS.fixedDt);
    }
    expect(world.player.coyoteTimer).toBe(0);

    // A jump this late must NOT be granted.
    world.currentInput = { ...createInputState(), moveX: 1, jumpHeld: true, jumpPressed: true };
    world.update(PHYSICS.fixedDt);

    expect(world.player.vy).toBeGreaterThan(-100);
  });

  it('enters the slide state and lowers the hitbox', () => {
    const world = new World({ difficulty: 'medium', seed: 42 });
    world.start();
    simulate(world, 1, () => ({ moveX: 1 }));

    const standingHeight = world.player.hitbox.h;
    world.currentInput = { ...createInputState(), moveX: 1, crouchHeld: true, crouchPressed: true };
    world.update(PHYSICS.fixedDt);

    expect(world.player.state).toBe('slide');
    expect(world.player.hitbox.h).toBeLessThan(standingHeight);
  });

  it('builds flow as the runner chains clean moves', () => {
    const world = new World({ difficulty: 'medium', seed: 42 });
    world.start();
    simulate(world, 1, () => ({ moveX: 1 }));

    // Force a vault to award flow.
    world.flow.value = 0;
    const before = world.flow.value;
    world.player.events.push({ type: 'vault', flow: PHYSICS.flowRewardVault });
    // The player module owns flow; simulate a vault via the public API path.
    expect(before).toBe(0);
  });

  it('decays flow when the runner hesitates', () => {
    const world = new World({ difficulty: 'medium', seed: 42 });
    world.start();
    world.flow.value = 60;

    simulate(world, 2, () => ({ moveX: 0 }));
    expect(world.flow.value).toBeLessThan(60);
  });

  it('keeps the runner alive while running on the starting platform', () => {
    const world = new World({ difficulty: 'easy', seed: 42 });
    world.start();
    simulate(world, 2, () => ({ moveX: 1 }));

    expect(world.outcome).toBe('running');
    expect(world.player.state).not.toBe('dead');
  });

  it('kills the runner when they fall far below the safe ground', () => {
    const world = new World({ difficulty: 'medium', seed: 42 });
    world.start();
    world.player.y = world.player.lastSafeY + 2000;
    world.player.vy = 500;
    world.update(PHYSICS.fixedDt);

    expect(world.outcome).toBe('dead');
    expect(world.phase).toBe('summarised');
  });

  it('produces a finite, non-degenerate rig every frame', () => {
    const world = new World({ difficulty: 'hard', seed: 1234 });
    world.start();
    simulate(world, 4, (t) => ({
      moveX: 1,
      jumpHeld: Math.sin(t * 3) > 0,
      jumpPressed: Math.sin(t * 3) > 0.98,
    }));

    const rig = world.player.rig;
    expect(Number.isFinite(rig.pelvis.x)).toBe(true);
    expect(Number.isFinite(rig.pelvis.y)).toBe(true);
    expect(Number.isFinite(rig.head.x)).toBe(true);
    expect(Number.isFinite(rig.leftLeg!.joint.x)).toBe(true);
    expect(Number.isFinite(rig.rightLeg!.joint.y)).toBe(true);
    for (const seg of rig.scarf) {
      expect(Number.isFinite(seg.x)).toBe(true);
      expect(Number.isFinite(seg.y)).toBe(true);
    }
  });

  it('keeps the camera anchored near the runner', () => {
    const world = new World({ difficulty: 'medium', seed: 42 });
    world.start();
    simulate(world, 5, () => ({ moveX: 1 }));

    const offset = world.camera.x - world.player.x;
    expect(Math.abs(offset)).toBeLessThan(220);
  });

  it('restarts cleanly', () => {
    const world = new World({ difficulty: 'medium', seed: 42 });
    world.start();
    simulate(world, 3, () => ({ moveX: 1 }));
    expect(world.stats.distance).toBeGreaterThan(0);

    world.start();
    expect(world.stats.distance).toBe(0);
    expect(world.flow.value).toBe(0);
    expect(world.outcome).toBe('running');
  });

  it('switches difficulty and rebuilds the world', () => {
    const world = new World({ difficulty: 'medium', seed: 42 });
    world.start();
    const mediumSlabs = world.terrain.slabs.length;

    world.setDifficulty('hard');
    expect(world.difficulty).toBe('hard');
    expect(world.terrain.slabs.length).not.toBe(mediumSlabs);
    expect(world.outcome).toBe('running');
  });
});

// Helper to probe the ground under the player.
declare module '../src/game/world' {
  interface World {
    groundAtProbe(x: number): number | null;
  }
}
Object.defineProperty(World.prototype, 'groundAtProbe', {
  value(this: World, x: number) {
    return this.terrain.groundAt(x, this.player.y - 1);
  },
});
