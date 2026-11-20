/**
 * Terrain model: a list of solid slabs plus one-way platforms and hazards.
 *
 * The terrain is pure data; the renderer and the simulation both read it.
 * Raycasting down from a point returns the exact hit height AND the surface
 * normal, which the foot IK uses to align soles to slopes.
 */

import { clamp } from '../core/math';
import type { Rect, Slab, SurfaceMaterial, Vec2 } from '../core/types';

export interface RayHit {
  /** Whether the ray struck anything. */
  hit: boolean;
  /** World-space x of the impact point. */
  x: number;
  /** World-space y of the impact point (smaller y = higher up). */
  y: number;
  /** Surface normal at the impact point (unit length, y < 0 = up). */
  nx: number;
  ny: number;
  /** Slope of the surface in radians. */
  angle: number;
  /** Material of the surface that was hit. */
  material: SurfaceMaterial;
  /** Index of the slab that was hit. */
  slabIndex: number;
}

export interface OneWayPlatform {
  x: number;
  y: number;
  w: number;
  h: number;
  material: SurfaceMaterial;
}

export interface Hazard {
  kind: 'plank' | 'glass' | 'pipe' | 'zipline' | 'spring';
  x: number;
  y: number;
  w: number;
  h: number;
  /** Extra behaviour flags (e.g. zipline anchor). */
  meta?: Record<string, number>;
  /** Runtime state, e.g. collapse timer for planks. */
  state?: number;
  broken?: boolean;
}

export interface TerrainChunk {
  slabs: Slab[];
  platforms: OneWayPlatform[];
  hazards: Hazard[];
  /** World x where this chunk starts. */
  startX: number;
  /** World x where this chunk ends. */
  endX: number;
  /** Ground reference line (used for camera framing + skyline). */
  baseY: number;
  /** Width of the gap that follows this chunk (world units). */
  gapAfter?: number;
  /** World y of the NEXT chunk's roof surface. */
  nextY?: number;
}

export class Terrain {
  slabs: Slab[] = [];
  platforms: OneWayPlatform[] = [];
  hazards: Hazard[] = [];
  chunks: TerrainChunk[] = [];

  /** Leftmost world x covered by terrain. */
  minX = 0;
  /** Rightmost world x covered by terrain. */
  maxX = 0;
  /** Baseline y used for the city silhouette. */
  baseY = 0;

  addChunk(chunk: TerrainChunk): void {
    this.chunks.push(chunk);
    for (const slab of chunk.slabs) this.slabs.push(slab);
    for (const p of chunk.platforms) this.platforms.push(p);
    for (const h of chunk.hazards) this.hazards.push(h);
    if (this.chunks.length === 1) {
      this.minX = chunk.startX;
      this.maxX = chunk.endX;
      this.baseY = chunk.baseY;
    } else {
      this.minX = Math.min(this.minX, chunk.startX);
      this.maxX = Math.max(this.maxX, chunk.endX);
    }
  }

  /**
   * Casts a ray from `(x, y)` straight down and returns the topmost surface
   * hit. `maxDrop` bounds how far the ray travels.
   */
  raycastDown(x: number, y: number, maxDrop = 4000): RayHit {
    const miss: RayHit = {
      hit: false,
      x,
      y: y + maxDrop,
      nx: 0,
      ny: -1,
      angle: 0,
      material: 'concrete',
      slabIndex: -1,
    };

    let bestY = Infinity;
    let bestSlab = -1;
    let bestAngle = 0;

    for (let i = 0; i < this.slabs.length; i++) {
      const s = this.slabs[i];
      if (x < s.x || x > s.x + s.w) continue;
      // Top surface y at x for a sloped slab.
      const surfaceY = s.y + (x - s.x) * Math.tan(s.angle);
      // The ray travels DOWNWARD, so it can only hit surfaces at or below the
      // origin (larger or equal y). Smaller y means higher up.
      if (surfaceY < y - 0.001) continue;
      if (surfaceY > y + maxDrop) continue;
      if (surfaceY < bestY) {
        bestY = surfaceY;
        bestSlab = i;
        bestAngle = s.angle;
      }
    }

    for (let i = 0; i < this.platforms.length; i++) {
      const p = this.platforms[i];
      if (x < p.x || x > p.x + p.w) continue;
      if (p.y < y - 0.001) continue;
      if (p.y > y + maxDrop) continue;
      if (p.y < bestY) {
        bestY = p.y;
        bestSlab = -1;
        bestAngle = 0;
      }
    }

    if (bestSlab === -1 && bestY === Infinity) return miss;

    // Normal of a sloped surface: rotate the up-vector by the slope angle.
    const nx = Math.sin(bestAngle);
    const ny = -Math.cos(bestAngle);
    const material =
      bestSlab >= 0 ? this.slabs[bestSlab].material : this.platformMaterialAt(x, bestY);

    return {
      hit: true,
      x,
      y: bestY,
      nx,
      ny,
      angle: bestAngle,
      material,
      slabIndex: bestSlab,
    };
  }

  private platformMaterialAt(x: number, y: number): SurfaceMaterial {
    for (const p of this.platforms) {
      if (x >= p.x && x <= p.x + p.w && Math.abs(p.y - y) < 0.5) return p.material;
    }
    return 'concrete';
  }

  /**
   * Returns the highest solid surface strictly below `y` at world x.
   * Used for spawn placement and camera framing.
   */
  /**
   * Returns the highest solid surface at world x that is at or below `y`.
   *
   * Screen space has +y pointing DOWN, so a downward ray starts at `y` and
   * travels toward increasing y. The ray origin must therefore be exactly
   * `y` — starting even slightly lower would skip past a surface the caller
   * is standing on.
   */
  groundAt(x: number, y: number): number | null {
    const hit = this.raycastDown(x, y, 6000);
    return hit.hit ? hit.y : null;
  }

  /** True when the world x lies inside a solid slab (used for wall collision). */
  solidAt(x: number, y: number): boolean {
    for (const s of this.slabs) {
      if (x < s.x || x > s.x + s.w) continue;
      const top = s.y + (x - s.x) * Math.tan(s.angle);
      if (y >= top && y <= top + s.h) return true;
    }
    for (const p of this.platforms) {
      if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return true;
    }
    return false;
  }

  /** Nearest hazard overlapping a rect, or null. */
  hazardInRect(rect: Rect): Hazard | null {
    for (const h of this.hazards) {
      if (h.broken) continue;
      if (
        rect.x < h.x + h.w &&
        rect.x + rect.w > h.x &&
        rect.y < h.y + h.h &&
        rect.y + rect.h > h.y
      ) {
        return h;
      }
    }
    return null;
  }

  /** All hazards intersecting a rect (hazards can overlap). */
  hazardsInRect(rect: Rect): Hazard[] {
    const out: Hazard[] = [];
    for (const h of this.hazards) {
      if (h.broken) continue;
      if (
        rect.x < h.x + h.w &&
        rect.x + rect.w > h.x &&
        rect.y < h.y + h.h &&
        rect.y + rect.h > h.y
      ) {
        out.push(h);
      }
    }
    return out;
  }

  /** Hazards whose x-range contains `x` and whose band contains `y`. */
  hazardAt(x: number, y: number, bandHeight = 0): Hazard | null {
    for (const h of this.hazards) {
      if (h.broken) continue;
      if (x < h.x || x > h.x + h.w) continue;
      if (y > h.y - bandHeight && y < h.y + h.h + bandHeight) return h;
    }
    return null;
  }

  /** The world x of the nearest roof lip (edge) to the right of `x`, searching `range` px. */
  findEdgeRight(x: number, range = 400): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    for (const s of this.slabs) {
      const rightEdge = s.x + s.w;
      if (rightEdge < x) continue;
      if (rightEdge > x + range) continue;
      const edgeY = s.y + s.w * Math.tan(s.angle);
      if (!best || rightEdge < best.x) best = { x: rightEdge, y: edgeY };
    }
    return best;
  }
}

/** Creates a flat slab. */
export function flatSlab(
  x: number,
  y: number,
  w: number,
  h: number,
  material: SurfaceMaterial = 'concrete',
  angle = 0,
): Slab {
  return { x, y, w, h, angle, material };
}

/** Creates a sloped slab whose TOP-LEFT corner is at (x, y). */
export function slopedSlab(
  x: number,
  y: number,
  w: number,
  h: number,
  angle: number,
  material: SurfaceMaterial = 'concrete',
): Slab {
  return { x, y, w, h, angle, material };
}

/** Convenience: the four corners of a slab, in world space. */
export function slabCorners(s: Slab): { tl: Vec2; tr: Vec2; br: Vec2; bl: Vec2 } {
  const dy = s.w * Math.tan(s.angle);
  return {
    tl: { x: s.x, y: s.y },
    tr: { x: s.x + s.w, y: s.y + dy },
    br: { x: s.x + s.w, y: s.y + dy + s.h },
    bl: { x: s.x, y: s.y + s.h },
  };
}

/** Clamp helper re-exported for convenience in game modules. */
export { clamp };
