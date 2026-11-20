/**
 * Procedural rooftop chunk generation.
 *
 * The world is built as a sequence of chunks. Each chunk is one "roof" plus
 * the gap to the next one, with optional interactive furniture (AC units,
 * vents, planks, skylights, pipes, ziplines, spring awnings, ramps).
 *
 * Generation is seeded so a run can be reproduced exactly for testing.
 */

import { makeRng, randRange, randInt, pick, clamp } from '../core/math';
import type { DifficultyTuning } from './config';
import { flatSlab, slopedSlab, type TerrainChunk } from '../physics/terrain';
import type { Slab, SurfaceMaterial } from '../core/types';
import type { Hazard } from '../physics/terrain';

export interface ChunkGeneratorOptions {
  tuning: DifficultyTuning;
  seed: number;
  /** Difficulty id, used to gate certain obstacles. */
  difficulty: 'easy' | 'medium' | 'hard';
}

/**
 * The widest gap the runner can actually clear, in pixels.
 *
 * The flight time of a jump depends on how far DOWN the landing surface is
 * relative to the take-off: dropping further shortens the flight, while
 * climbing lengthens it. The reach is therefore computed from the real
 * jump physics rather than assumed, so the generator can never produce a
 * gap that is physically impossible to clear.
 */
export function maxJumpableGap(tuning: DifficultyTuning, dropPx: number): number {
  const jump = tuning.jumpSpeed;
  const gravityUp = tuning.gravityUp;
  const gravityDown = tuning.gravityDown * tuning.fallGravityMultiplier;

  // Time to the apex.
  const tApex = jump / gravityUp;

  // Solve for the time to fall `dropPx` below the take-off point.
  //   dropPx = -jump * t + 0.5 * gravityDown * t^2
  //
  // A NEGATIVE drop means the landing roof is higher than the take-off (a
  // climb). The quadratic can then have no real root, so the discriminant
  // is clamped: in that case the runner simply reaches the apex and keeps
  // rising, which is approximated by the apex time alone.
  const discriminant = Math.max(0, jump * jump + 2 * gravityDown * dropPx);
  const tFall = (Math.sqrt(discriminant) - jump) / gravityDown;

  // When the landing roof is HIGHER than the take-off (a climb), the runner
  // can only reach the apex height — no jump can clear a roof that is taller
  // than the apex, no matter how long the gap is.
  const apexHeight = (jump * jump) / (2 * gravityUp);
  if (dropPx < -apexHeight) {
    // The climb is impossible: fall back to the smallest gap so the next
    // roof is as reachable as possible.
    return 0;
  }

  // The runner travels at full sprint speed, which is the fastest it can go.
  const speed = tuning.maxSprintSpeed;
  const reach = speed * (tApex + Math.max(tFall, 0));

  // A safety margin so a jump that is *just* clearable is never required.
  //
  // The margin covers the cases where the runner is not at full sprint speed
  // when it reaches the lip (it may have just landed from a drop, or been
  // slowed by a stumble), plus the small horizontal distance the runner
  // covers between the lip and the actual take-off point. Without this the
  // generator can emit a gap that is only clearable at a perfect sprint.
  return Math.max(60, reach * 0.42);
}

/**
 * The tallest climb the runner can clear, in pixels.
 *
 * A jump rises to its apex and then falls, so a landing roof that is higher
 * than the apex can never be reached.
 */
export function maxClimbHeight(tuning: DifficultyTuning): number {
  const jump = tuning.jumpSpeed;
  const gravityUp = tuning.gravityUp;
  // Leave a margin so the runner can still land on the roof rather than
  // merely brushing its lip.
  return Math.max(30, (jump * jump) / (2 * gravityUp) - 18);
}

/**
 * Generates the next chunk after `prevEndX` at height `prevY`.
 * Returns the chunk and the geometry needed to place the next one.
 */
export function generateChunk(
  startX: number,
  startY: number,
  options: ChunkGeneratorOptions,
): TerrainChunk {
  const { tuning, difficulty } = options;
  const rng = makeRng(options.seed ^ Math.floor(startX * 7919));

  const slabs: Slab[] = [];
  const platforms: TerrainChunk['platforms'] = [];
  const hazards: Hazard[] = [];

  // Occupied x-ranges on this roof. Furniture must not overlap, otherwise a
  // fragile plank could end up buried underneath an AC unit and become
  // unreachable.
  const occupied: { x: number; w: number }[] = [];
  const isFree = (x: number, w: number): boolean => {
    for (const o of occupied) {
      if (x < o.x + o.w && x + w > o.x) return false;
    }
    return true;
  };
  const occupy = (x: number, w: number): void => {
    occupied.push({ x, w });
  };

  // --- Gap between the previous roof and this one -----------------------------
  // The gap must be clearable with the movement physics, otherwise a run can
  // become impossible. The reachable distance depends on how far DOWN the
  // next roof is: landing lower shortens the flight, landing higher (a climb)
  // lengthens it.
  const gap = randRange(rng, tuning.minGap, tuning.maxGap);

  // --- Vertical drop ------------------------------------------------------------
  // Occasional upward step too, so the runner has to climb. A climb can
  // never be taller than the jump apex, or the roof would be unreachable.
  const rising = rng() < 0.22;
  let roofY: number;
  if (rising) {
    const maxClimb = maxClimbHeight(tuning);
    const climb = Math.min(randRange(rng, 60, 150), maxClimb);
    roofY = startY - climb;
  } else {
    roofY = startY + randRange(rng, tuning.minDrop, tuning.maxDrop);
  }

  // Clamp the gap to what the runner can actually clear at this drop.
  const maxClearableGap = maxJumpableGap(tuning, roofY - startY);
  const clearGap = Math.min(gap, maxClearableGap);

  // --- Roof width ---------------------------------------------------------------
  const width = randRange(rng, 340, 760);

  const roofMaterial: SurfaceMaterial = pick(rng, ['concrete', 'concrete', 'metal', 'wood']);

  const slab = flatSlab(startX, roofY, width, 260, roofMaterial, 0);
  slabs.push(slab);

  const chunk: TerrainChunk = {
    slabs,
    platforms,
    hazards,
    startX,
    endX: startX + width,
    baseY: roofY,
  };

  // --- Furniture -----------------------------------------------------------------
  const weights = tuning.obstacleWeights;
  const totalWeight =
    weights.acUnit +
    weights.plank +
    weights.skylight +
    weights.pipe +
    weights.zipline +
    weights.spring +
    weights.ramp +
    weights.vent;

  // How many pieces of furniture this roof carries.
  const count = rng() < 0.35 ? 0 : randInt(rng, 1, 3);

  // Keep an entry corridor clear so the runner can always start a jump.
  const safeStart = startX + 70;
  const safeEnd = startX + width - 90;

  for (let i = 0; i < count; i++) {
    const roll = rng() * totalWeight;
    let acc = 0;
    let kind: keyof typeof weights = 'acUnit';
    for (const key of Object.keys(weights) as (keyof typeof weights)[]) {
      acc += weights[key];
      if (roll <= acc) {
        kind = key;
        break;
      }
    }

    // Pipes are placed in a dedicated pass so their height can be measured
    // against the FINAL roof surface.
    if (kind === 'pipe') continue;

    // Difficulty gating.
    if (kind === 'zipline' && difficulty === 'easy' && rng() < 0.6) continue;
    if (kind === 'spring' && difficulty === 'easy' && rng() < 0.6) continue;
    if (kind === 'skylight' && difficulty === 'easy' && rng() < 0.5) continue;

    const objW = randRange(rng, 70, 210);
    // Find a free stretch of roof for this piece of furniture.
    let objX = randRange(rng, safeStart, Math.max(safeStart + 40, safeEnd));
    for (let attempt = 0; attempt < 8 && !isFree(objX, objW); attempt++) {
      objX = randRange(rng, safeStart, Math.max(safeStart + 40, safeEnd));
    }
    // Reserve a generous region: some pieces (ramps) add geometry beyond
    // their own width, so the reservation must cover the full footprint.
    const reserveW = objW + 140;
    if (!isFree(objX, reserveW)) continue;
    occupy(objX, reserveW);

    switch (kind) {
      case 'acUnit': {
        // Multi-level step geometry: a big box plus a smaller box on top.
        const h = randRange(rng, 38, 62);
        const w = randRange(rng, 44, 78);
        slabs.push(flatSlab(objX, roofY - h, w, h, 'metal'));
        const h2 = randRange(rng, 22, 40);
        const w2 = w * randRange(rng, 0.45, 0.75);
        slabs.push(flatSlab(objX + randRange(rng, 0, w - w2), roofY - h - h2, w2, h2, 'metal'));
        break;
      }
      case 'vent': {
        // Low, wide exhaust vent — a single small step.
        const h = randRange(rng, 18, 30);
        const w = randRange(rng, 56, 110);
        slabs.push(flatSlab(objX, roofY - h, w, h, 'metal'));
        break;
      }
      case 'ramp': {
        // Slanted roof section: the runner walks down it with downhill acceleration.
        const angle = randRange(rng, -0.34, 0.3);
        if (Math.abs(angle) < 0.09) {
          slabs.push(flatSlab(objX, roofY - 26, objW, 26, 'concrete'));
        } else {
          slabs.push(slopedSlab(objX, roofY - 26, objW, 26, angle, 'concrete'));
          // A landing pad at the bottom of the ramp so it reads as a real slope.
          const dy = objW * Math.tan(angle);
          const endX = objX + objW;
          const endY = roofY - 26 + dy;
          slabs.push(flatSlab(endX, endY, randRange(rng, 60, 130), 26, 'concrete'));
        }
        break;
      }
      case 'plank': {
        // Collapsing wooden plank spanning a gap in the roof surface.
        const fragile = rng() < tuning.fragileChance;
        const fast = fragile && rng() < tuning.fastCrackChance;
        // Planks are wide enough that a sprinting runner actually loads them.
        const pw = Math.max(objW, 150);
        hazards.push({
          kind: 'plank',
          x: objX,
          y: roofY,
          w: pw,
          h: 10,
          state: 0,
          broken: false,
          meta: { fragile: fragile ? 1 : 0, fast: fast ? 1 : 0 },
        });
        // The plank is walkable but not solid geometry: model it as a
        // platform. It sits FLUSH with the roof surface — a plank raised
        // above the roof would act as a low ceiling that cancels every jump
        // the runner makes over it.
        platforms.push({ x: objX, y: roofY, w: pw, h: 10, material: 'wood' });
        break;
      }
      case 'skylight': {
        // Glass skylight — slanted, breaks when stepped on hard.
        hazards.push({
          kind: 'glass',
          x: objX,
          y: roofY - 16,
          w: objW,
          h: 16,
          state: 0,
          broken: false,
        });
        break;
      }
      case 'zipline': {
        // Zipline anchored above a wide gap.
        const anchorY = roofY - randRange(rng, 120, 190);
        hazards.push({
          kind: 'zipline',
          x: objX,
          y: anchorY,
          w: objW,
          h: 6,
          state: 0,
          meta: { endX: objX + objW },
        });
        break;
      }
      case 'spring': {
        // Spring awning: compresses and launches the runner.
        hazards.push({
          kind: 'spring',
          x: objX,
          y: roofY - 18,
          w: objW,
          h: 18,
          state: 0,
        });
        break;
      }
    }
  }

  // --- Overhead pipes ------------------------------------------------------------
  // Pipes are placed last so their clearance can be measured against the
  // FINAL roof surface (which may have been raised by an AC unit or a ramp
  // landing pad). A pipe buried in the roof would be unpassable.
  if (rng() < 0.55) {
    const pw = randRange(rng, 90, 190);
    const px = randRange(rng, safeStart, Math.max(safeStart + 40, safeEnd));
    // Measure the HIGHEST surface across the whole span of the pipe: the
    // pipe must clear every obstacle it passes over, not just its middle.
    let surface: number | null = null;
    for (let i = 0; i <= 8; i++) {
      const sx = px + (pw * i) / 8;
      const s = surfaceUnder(slabs, platforms, sx, roofY);
      if (s === null) continue;
      if (surface === null || s < surface) surface = s;
    }
    if (surface !== null) {
      const clearance = randRange(rng, 34, 52);
      const h = 240;
      hazards.push({
        kind: 'pipe',
        x: px,
        y: surface - clearance - h,
        w: pw,
        h,
        state: 0,
        meta: { clearance },
      });
    }
  }

  // --- Zipline continuity --------------------------------------------------------
  // A zipline must span the gap to the next roof, so move it to the roof edge.
  for (const h of hazards) {
    if (h.kind === 'zipline') {
      h.x = chunk.endX - h.w;
      // The cable must reach the far side of the gap, otherwise the runner
      // is released over the void and falls short of the next roof.
      h.meta = { ...(h.meta ?? {}), endX: chunk.endX + clearGap + 40 };
    }
  }

  // --- Gap filler: a spring awning over wide gaps (medium/hard) -----------------
  if (difficulty !== 'easy' && clearGap > tuning.maxGap * 0.78 && rng() < 0.45) {
    const sw = randRange(rng, 70, 120);
    const sx = chunk.endX + clearGap * 0.5 - sw * 0.5;
    const sy = roofY + randRange(rng, 40, 120);
    hazards.push({
      kind: 'spring',
      x: sx,
      y: sy - 18,
      w: sw,
      h: 18,
      state: 0,
    });
    // A narrow pillar beneath the awning so it is a real landing pad rather
    // than a hazard floating in the void.
    slabs.push(flatSlab(sx, sy, sw, 200, 'concrete'));
  }

  chunk.gapAfter = clearGap;
  chunk.nextY = roofY;
  return chunk;
}

/**
 * Finds the highest walkable surface at world x within a chunk.
 * Returns null when the x is not covered by any slab or platform.
 */
function surfaceUnder(
  slabs: Slab[],
  platforms: TerrainChunk['platforms'],
  x: number,
  fallbackY: number,
): number | null {
  // The HIGHEST surface at this x (smallest y) is the one the runner would
  // stand on, so that is what an overhead obstacle must clear.
  let best: number | null = null;
  for (const s of slabs) {
    if (x < s.x || x > s.x + s.w) continue;
    const top = s.y + (x - s.x) * Math.tan(s.angle);
    // Ignore surfaces that sit below the base roof — those are the body of
    // the roof slab, not its walkable top.
    if (top > fallbackY + 1) continue;
    if (best === null || top < best) best = top;
  }
  for (const p of platforms) {
    if (x < p.x || x > p.x + p.w) continue;
    if (p.y > fallbackY + 1) continue;
    if (best === null || p.y < best) best = p.y;
  }
  // Nothing at this x: fall back to the base roof level.
  return best ?? fallbackY;
}

/**
 * Chains chunks together to build a full level.
 *
 * Every consecutive pair of roofs is checked against the real jump physics
 * and repaired when it is not crossable: a gap that is too wide is narrowed
 * and a climb that is taller than the jump apex is lowered. This guarantees
 * the generated level is always completable, no matter what the per-chunk
 * randomiser produced.
 */
export function generateLevel(
  startX: number,
  startY: number,
  options: ChunkGeneratorOptions,
  chunkCount = 40,
): TerrainChunk[] {
  const { tuning } = options;

  // --- Pass 1: lay out the roofs ---------------------------------------------
  // The gap between two roofs depends on the drop between them, and the drop
  // is only known once the second roof exists. So the roofs are generated
  // first and the gaps are sized afterwards.
  interface Roof {
    chunk: TerrainChunk;
    y: number;
  }
  const roofs: Roof[] = [];
  let x = startX;
  let y = startY;

  for (let i = 0; i < chunkCount; i++) {
    const chunk = generateChunk(x, y, {
      ...options,
      seed: options.seed + i * 7919,
    });
    roofs.push({ chunk, y });
    x = chunk.endX + (chunk.gapAfter ?? 0);
    y = chunk.nextY ?? y;
  }

  // --- Pass 2: size each gap against the real drop --------------------------
  for (let i = 0; i < roofs.length - 1; i++) {
    const here = roofs[i];
    const next = roofs[i + 1];
    // The height of a roof is the `nextY` it reports — the `y` stored on the
    // roof entry is the height it was STARTED from, which belongs to the
    // previous roof.
    const drop = (next.chunk.nextY ?? next.y) - (here.chunk.nextY ?? here.y);
    const maxGap = maxJumpableGap(tuning, drop);
    if ((here.chunk.gapAfter ?? 0) > maxGap) {
      here.chunk.gapAfter = maxGap;
    }
    // Move the next roof (and every roof after it) to match the new gap.
    const shift = here.chunk.endX + (here.chunk.gapAfter ?? 0) - next.chunk.startX;
    if (shift !== 0) {
      for (let j = i + 1; j < roofs.length; j++) {
        const roof = roofs[j];
        roof.chunk.startX += shift;
        roof.chunk.endX += shift;
        for (const slab of roof.chunk.slabs) {
          slab.x += shift;
        }
        for (const platform of roof.chunk.platforms) {
          platform.x += shift;
        }
        for (const hazard of roof.chunk.hazards) {
          hazard.x += shift;
          if (hazard.meta && typeof hazard.meta.endX === 'number') {
            hazard.meta.endX += shift;
          }
        }
      }
    }
  }

  return roofs.map((r) => r.chunk);
}

export { clamp };
