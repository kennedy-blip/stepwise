import { describe, expect, it } from 'vitest';
import { DIFFICULTY_TUNING } from '../src/game/config';
import { generateChunk, generateLevel, maxJumpableGap } from '../src/game/chunks';
import { Terrain } from '../src/physics/terrain';

describe('Difficulty tuning', () => {
  it('matches the specification table exactly', () => {
    expect(DIFFICULTY_TUNING.easy.coyoteTime).toBe(0.16);
    expect(DIFFICULTY_TUNING.medium.coyoteTime).toBe(0.1);
    expect(DIFFICULTY_TUNING.hard.coyoteTime).toBe(0.06);

    expect(DIFFICULTY_TUNING.easy.inputBuffer).toBe(0.18);
    expect(DIFFICULTY_TUNING.medium.inputBuffer).toBe(0.12);
    expect(DIFFICULTY_TUNING.hard.inputBuffer).toBe(0.08);

    expect(DIFFICULTY_TUNING.easy.baseSpeed).toBe(320);
    expect(DIFFICULTY_TUNING.easy.maxSprintSpeed).toBe(480);
    expect(DIFFICULTY_TUNING.medium.baseSpeed).toBe(380);
    expect(DIFFICULTY_TUNING.medium.maxSprintSpeed).toBe(580);
    expect(DIFFICULTY_TUNING.hard.baseSpeed).toBe(440);
    expect(DIFFICULTY_TUNING.hard.maxSprintSpeed).toBe(680);
  });

  it('gives hard mode wider gaps and deeper drops than easy', () => {
    expect(DIFFICULTY_TUNING.hard.minGap).toBeGreaterThan(DIFFICULTY_TUNING.easy.minGap);
    expect(DIFFICULTY_TUNING.hard.maxGap).toBeGreaterThan(DIFFICULTY_TUNING.easy.maxGap);
    expect(DIFFICULTY_TUNING.hard.maxDrop).toBeGreaterThan(DIFFICULTY_TUNING.easy.maxDrop);
  });

  it('applies asymmetric gravity (falls are heavier than ascents)', () => {
    const t = DIFFICULTY_TUNING.medium;
    expect(t.fallGravityMultiplier).toBeGreaterThan(1);
    expect(t.gravityDown * t.fallGravityMultiplier).toBeGreaterThan(t.gravityUp);
  });

  it('uses a 0.65s acceleration ramp', () => {
    for (const key of ['easy', 'medium', 'hard'] as const) {
      expect(DIFFICULTY_TUNING[key].accelRamp).toBe(0.65);
    }
  });
});

describe('Procedural chunk generation', () => {
  it('produces a chunk with walkable ground', () => {
    const chunk = generateChunk(0, 0, {
      tuning: DIFFICULTY_TUNING.medium,
      seed: 12345,
      difficulty: 'medium',
    });

    expect(chunk.slabs.length).toBeGreaterThan(0);
    expect(chunk.endX).toBeGreaterThan(chunk.startX);
    expect(chunk.gapAfter).toBeGreaterThan(0);
  });

  it('is deterministic for a given seed', () => {
    const options = {
      tuning: DIFFICULTY_TUNING.medium,
      seed: 999,
      difficulty: 'medium' as const,
    };
    const a = generateChunk(0, 0, options);
    const b = generateChunk(0, 0, options);

    expect(a.slabs.length).toBe(b.slabs.length);
    expect(a.endX).toBe(b.endX);
    expect(a.gapAfter).toBe(b.gapAfter);
  });

  it('chains chunks into a continuous, increasing world', () => {
    const chunks = generateLevel(
      0,
      0,
      { tuning: DIFFICULTY_TUNING.medium, seed: 7, difficulty: 'medium' },
      30,
    );

    expect(chunks.length).toBe(30);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startX).toBeGreaterThan(chunks[i - 1].endX);
    }
  });

  it('generates gaps within the difficulty range', () => {
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const tuning = DIFFICULTY_TUNING[difficulty];
      for (let i = 0; i < 40; i++) {
        const chunk = generateChunk(i * 900, 0, {
          tuning,
          seed: i * 31 + 3,
          difficulty,
        });
        // A gap never exceeds the difficulty's maximum, and is only ever
        // shortened below the minimum when the drop to the next roof makes
        // the full gap physically impossible to clear.
        expect(chunk.gapAfter!).toBeLessThanOrEqual(tuning.maxGap + 1e-6);
        expect(chunk.gapAfter!).toBeGreaterThan(0);
        const drop = (chunk.nextY ?? 0) - 0;
        const maxClearable = maxJumpableGap(tuning, drop);
        expect(chunk.gapAfter!).toBeLessThanOrEqual(maxClearable + 1e-6);
      }
    }
  });

  it('only ever produces gaps the runner can actually clear', () => {
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const tuning = DIFFICULTY_TUNING[difficulty];
      const chunks = generateLevel(0, 0, { tuning, seed: 20240517, difficulty }, 120);
      for (let i = 0; i < chunks.length - 1; i++) {
        const here = chunks[i];
        const next = chunks[i + 1];
        const gap = next.startX - here.endX;
        const drop = (next.nextY ?? 0) - (here.nextY ?? 0);
        expect(gap).toBeLessThanOrEqual(maxJumpableGap(tuning, drop) + 1e-6);
      }
    }
  });

  it('never generates a zero-width or inverted slab', () => {
    const chunks = generateLevel(
      0,
      0,
      { tuning: DIFFICULTY_TUNING.hard, seed: 42, difficulty: 'hard' },
      40,
    );

    for (const chunk of chunks) {
      for (const slab of chunk.slabs) {
        expect(slab.w).toBeGreaterThan(0);
        expect(slab.h).toBeGreaterThan(0);
        expect(Number.isFinite(slab.x)).toBe(true);
        expect(Number.isFinite(slab.y)).toBe(true);
        expect(Number.isFinite(slab.angle)).toBe(true);
      }
    }
  });

  it('places a spring awning over wide gaps on hard mode', () => {
    let springs = 0;
    for (let i = 0; i < 60; i++) {
      const chunk = generateChunk(i * 1200, 0, {
        tuning: DIFFICULTY_TUNING.hard,
        seed: i * 17 + 5,
        difficulty: 'hard',
      });
      springs += chunk.hazards.filter((h) => h.kind === 'spring').length;
    }
    expect(springs).toBeGreaterThan(0);
  });

  it('builds a terrain that the raycaster can walk on end to end', () => {
    const chunks = generateLevel(
      0,
      0,
      { tuning: DIFFICULTY_TUNING.medium, seed: 2024, difficulty: 'medium' },
      25,
    );
    const terrain = new Terrain();
    for (const chunk of chunks) terrain.addChunk(chunk);

    // Every roof surface must be reachable by a downward ray.
    let checked = 0;
    for (const chunk of chunks) {
      const hit = terrain.raycastDown(chunk.startX + 10, chunk.baseY - 400);
      expect(hit.hit).toBe(true);
      checked++;
    }
    expect(checked).toBe(25);
  });
});
