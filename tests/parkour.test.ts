import { describe, expect, it } from 'vitest';
import { World } from '../src/game/world';
import { PHYSICS } from '../src/game/config';
import { createInputState } from '../src/core/types';
import { addFlow } from '../src/game/flow';
import type { InputState, PlayerState } from '../src/core/types';

function step(world: World, input: Partial<InputState> = {}): void {
  world.currentInput = { ...createInputState(), ...input };
  world.update(PHYSICS.fixedDt);
}

/** Places the runner at a world x, snapped to the ground beneath it. */
function place(world: World, x: number): void {
  world.player.x = x;
  const g = world.terrain.groundAt(x, world.player.y - 400);
  world.player.y = g ?? world.player.y;
  world.player.vy = 0;
  world.player.grounded = true;
}

/**
 * Finds a world x that sits on solid roof with no hazards nearby, so a drop
 * test isolates the mechanic under test.
 */
function solidX(world: World): number {
  for (const chunk of world.terrain.chunks) {
    const x = chunk.startX + 40;
    if (world.terrain.groundAt(x, chunk.baseY - 300) === null) continue;
    // Reject positions that overlap a hazard.
    const hazard = world.terrain.hazards.find((h) => x + 60 > h.x && x - 60 < h.x + h.w);
    if (hazard) continue;
    return x;
  }
  return world.terrain.chunks[0].startX + 40;
}

describe('Parkour mechanics', () => {
  it('grabs a ledge when the runner falls just short of a roof lip', () => {
    const world = new World({ difficulty: 'medium', seed: 2024 });
    world.start();

    const chunk = world.terrain.chunks[0];
    const edgeX = chunk.endX;

    // Place the runner just short of the lip, in the air and falling.
    world.player.x = edgeX - 14;
    world.player.y = chunk.baseY + 40;
    world.player.vy = 90;
    world.player.vx = 320;
    world.player.grounded = false;
    world.player.state = 'air';

    for (let i = 0; i < 30 && world.player.state === 'air'; i++) {
      step(world, { moveX: 1 });
    }

    expect(world.player.state).toBe('ledgeHang');
    expect(world.player.ledgeGrab).not.toBeNull();
  });

  it('mantles onto the roof when jump is pressed while hanging', () => {
    const world = new World({ difficulty: 'medium', seed: 2024 });
    world.start();

    const chunk = world.terrain.chunks[0];
    world.player.x = chunk.endX - 14;
    world.player.y = chunk.baseY + 40;
    world.player.vy = 90;
    world.player.vx = 320;
    world.player.grounded = false;
    world.player.state = 'air';

    for (let i = 0; i < 30 && world.player.state === 'air'; i++) {
      step(world, { moveX: 1 });
    }
    expect(world.player.state).toBe('ledgeHang');

    // Press jump to vault.
    step(world, { moveX: 1, jumpPressed: true, jumpHeld: true });
    expect(world.player.state).toBe('mantle');

    // The mantle completes and the runner ends up on the roof.
    for (let i = 0; i < 90; i++) step(world, { moveX: 1 });
    expect(world.player.state).not.toBe('mantle');
    expect(world.player.x).toBeGreaterThan(chunk.endX - 40);
  });

  it('awards flow and counts a clean move for a vault', () => {
    const world = new World({ difficulty: 'medium', seed: 2024 });
    world.start();
    world.flow.value = 0;

    const chunk = world.terrain.chunks[0];
    world.player.x = chunk.endX - 14;
    world.player.y = chunk.baseY + 40;
    world.player.vy = 90;
    world.player.vx = 320;
    world.player.grounded = false;
    world.player.state = 'air';

    for (let i = 0; i < 30 && world.player.state === 'air'; i++) {
      step(world, { moveX: 1 });
    }
    step(world, { moveX: 1, jumpPressed: true, jumpHeld: true });

    expect(world.flow.value).toBeGreaterThan(0);
    expect(world.flow.cleanMoves).toBeGreaterThan(0);
  });

  it('slides under an overhead pipe and awards flow', () => {
    const world = new World({ difficulty: 'medium', seed: 77 });
    world.start();

    // Find a pipe hazard in the generated world.
    const pipe = world.terrain.hazards.find((h) => h.kind === 'pipe');
    expect(pipe).toBeDefined();

    // Run towards the pipe at speed, then slide.
    place(world, (pipe!.x as number) - 320);
    world.player.vx = 500;
    world.flow.value = 0;

    let slid = false;
    for (let i = 0; i < 600; i++) {
      const nearPipe = world.player.x > pipe!.x - 140;
      step(world, {
        moveX: 1,
        crouchHeld: nearPipe,
        crouchPressed: nearPipe && !slid,
      });
      if (nearPipe && !slid) {
        slid = true;
      }
      if (world.flow.value > 0) break;
    }

    expect(world.flow.value).toBeGreaterThan(0);
  });

  it('converts a high fall into a forward roll when crouch is buffered', () => {
    const world = new World({ difficulty: 'medium', seed: 5 });
    world.start();
    addFlow(world.flow, 40);

    // Launch the runner high into the air above solid roof.
    const rx = solidX(world);
    world.player.x = rx;
    world.player.y = world.terrain.groundAt(rx, 0)! - 420;
    world.player.vy = 40;
    world.player.vx = 260;
    world.player.grounded = false;
    world.player.state = 'air';

    // Buffer a crouch mid-air (the tuck-roll input).
    step(world, { moveX: 1, crouchPressed: true, crouchHeld: true });

    // Fall until landing, watching for the roll event.
    let landed = false;
    let rolled = false;
    for (let i = 0; i < 400; i++) {
      const events = world.update(PHYSICS.fixedDt);
      world.currentInput = { ...createInputState(), moveX: 1, crouchHeld: true };
      for (const ev of events) {
        if (ev.type === 'roll') rolled = true;
      }
      if (world.player.grounded) {
        landed = true;
        break;
      }
    }

    expect(landed).toBe(true);
    expect(rolled).toBe(true);
    // The roll also counts as a clean move and preserves forward speed.
    expect(world.flow.cleanMoves).toBeGreaterThan(0);
    expect(world.player.vx).toBeGreaterThan(260);
  });

  it('stumbles on a hard landing and loses flow', () => {
    const world = new World({ difficulty: 'medium', seed: 5 });
    world.start();
    // Tier 2 flow: the Flow Save is NOT armed, so a hard landing stumbles.
    addFlow(world.flow, 60);

    // Drop the runner from a very high altitude with no roll input.
    const sx = solidX(world);
    world.player.x = sx;
    world.player.y = world.terrain.groundAt(sx, 0)! - 1400;
    world.player.vy = 200;
    world.player.vx = 200;
    world.player.grounded = false;
    world.player.state = 'air';

    let stumbled = false;
    for (let i = 0; i < 600; i++) {
      step(world, { moveX: 1 });
      if (world.player.state === ('stumble' as PlayerState)) {
        stumbled = true;
        break;
      }
    }

    expect(stumbled).toBe(true);
    expect(world.flow.value).toBeLessThan(60);
  });

  it('triggers a Flow Save instead of a wipeout when Pure Flow is armed', () => {
    const world = new World({ difficulty: 'medium', seed: 5 });
    world.start();
    addFlow(world.flow, 95);

    // Drop the runner from a lethal altitude.
    const fx = solidX(world);
    world.player.x = fx;
    world.player.y = world.terrain.groundAt(fx, 0)! - 1400;
    world.player.vy = 200;
    world.player.vx = 200;
    world.player.grounded = false;
    world.player.state = 'air';

    let saved = false;
    for (let i = 0; i < 600; i++) {
      step(world, { moveX: 1 });
      if (world.flow.savesUsed > 0) {
        saved = true;
        break;
      }
    }

    expect(saved).toBe(true);
    // The save consumes 50% of the meter instead of ending the run.
    expect(world.flow.value).toBeLessThanOrEqual(50);
    expect(world.flow.value).toBeGreaterThanOrEqual(30);
    expect(world.outcome).toBe('running');
  });

  it('bounces the runner off a spring awning', () => {
    const world = new World({ difficulty: 'medium', seed: 33 });
    world.start();

    // Find a spring that sits on a roof the runner can actually stand on.
    const spring = world.terrain.hazards.find(
      (h) => h.kind === 'spring' && world.terrain.groundAt(h.x + h.w * 0.5, h.y - 200) !== null,
    );
    expect(spring).toBeDefined();

    const groundY = world.terrain.groundAt(spring!.x + spring!.w * 0.5, spring!.y - 200)!;
    world.player.x = spring!.x + spring!.w * 0.5;
    world.player.y = groundY;
    world.player.vy = 50;
    world.player.grounded = true;
    world.player.state = 'run';

    let launched = false;
    for (let i = 0; i < 200; i++) {
      step(world, { moveX: 1 });
      if (world.player.vy < -300) {
        launched = true;
        break;
      }
    }

    expect(launched).toBe(true);
  });

  it("breaks a fragile plank under the runner's weight", () => {
    const world = new World({ difficulty: 'hard', seed: 21 });
    world.start();

    const plank = world.terrain.hazards.find(
      (h) => h.kind === 'plank' && (h.meta?.fragile ?? 0) === 1,
    );
    expect(plank).toBeDefined();

    // Stand still on the plank: the load breaks it.
    const groundY = world.terrain.groundAt(plank!.x + plank!.w * 0.5, plank!.y - 200)!;
    world.player.x = plank!.x + plank!.w * 0.5;
    world.player.y = groundY;
    world.player.vy = 0;
    world.player.grounded = true;
    world.player.state = 'run';

    let broke = false;
    for (let i = 0; i < 200; i++) {
      step(world, { moveX: 0 });
      if (plank!.broken) {
        broke = true;
        break;
      }
    }

    expect(broke).toBe(true);
  });

  it('leaves a sturdy plank intact', () => {
    const world = new World({ difficulty: 'hard', seed: 21 });
    world.start();

    const plank = world.terrain.hazards.find(
      (h) => h.kind === 'plank' && (h.meta?.fragile ?? 0) === 0,
    );
    if (!plank) return;

    const groundY = world.terrain.groundAt(plank.x + plank.w * 0.5, plank.y - 200)!;
    world.player.x = plank.x + plank.w * 0.5;
    world.player.y = groundY;
    world.player.vy = 0;
    world.player.grounded = true;
    world.player.state = 'run';

    for (let i = 0; i < 200; i++) step(world, { moveX: 0 });

    expect(plank.broken).toBe(false);
  });

  it('reaches Pure Flow tier and arms the Flow Save', () => {
    const world = new World({ difficulty: 'medium', seed: 3 });
    world.start();
    addFlow(world.flow, 79);
    // Crossing the threshold promotes the tier.
    addFlow(world.flow, 80);
    step(world, { moveX: 1 });

    expect(world.flow.tier).toBe(3);
    expect(world.flow.armed).toBe(true);
  });

  it('grants a speed bonus at higher flow tiers', () => {
    const world = new World({ difficulty: 'medium', seed: 3 });
    world.start();

    // Tier 1 top speed.
    world.flow.value = 0;
    for (let i = 0; i < 1400; i++) step(world, { moveX: 1 });
    const tier1Speed = Math.abs(world.player.vx);

    // Tier 3 top speed.
    world.flow.value = 100;
    for (let i = 0; i < 1400; i++) step(world, { moveX: 1 });
    const tier3Speed = Math.abs(world.player.vx);

    expect(tier3Speed).toBeGreaterThan(tier1Speed);
  });
});
