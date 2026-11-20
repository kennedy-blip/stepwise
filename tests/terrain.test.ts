import { describe, expect, it } from 'vitest';
import { Terrain, flatSlab, slopedSlab } from '../src/physics/terrain';

describe('Terrain raycasting', () => {
  it('finds the surface of a flat slab and reports an up normal', () => {
    const terrain = new Terrain();
    terrain.addChunk({
      slabs: [flatSlab(0, 100, 400, 200, 'concrete')],
      platforms: [],
      hazards: [],
      startX: 0,
      endX: 400,
      baseY: 100,
    });

    const hit = terrain.raycastDown(200, 0);
    expect(hit.hit).toBe(true);
    expect(hit.y).toBeCloseTo(100, 6);
    expect(hit.nx).toBeCloseTo(0, 6);
    expect(hit.ny).toBeCloseTo(-1, 6);
    expect(hit.angle).toBeCloseTo(0, 6);
    expect(hit.material).toBe('concrete');
  });

  it('interpolates the surface height of a sloped slab', () => {
    const terrain = new Terrain();
    const angle = Math.atan(0.5); // 1:2 slope
    terrain.addChunk({
      slabs: [slopedSlab(0, 100, 400, 200, angle, 'metal')],
      platforms: [],
      hazards: [],
      startX: 0,
      endX: 400,
      baseY: 100,
    });

    const hit = terrain.raycastDown(200, 0);
    expect(hit.hit).toBe(true);
    expect(hit.y).toBeCloseTo(100 + 200 * Math.tan(angle), 6);
    // The normal is the up-vector rotated by the slope angle.
    expect(hit.nx).toBeCloseTo(Math.sin(angle), 6);
    expect(hit.ny).toBeCloseTo(-Math.cos(angle), 6);
    expect(hit.material).toBe('metal');
  });

  it('misses when there is no ground within the drop distance', () => {
    const terrain = new Terrain();
    terrain.addChunk({
      slabs: [flatSlab(0, 100, 100, 100)],
      platforms: [],
      hazards: [],
      startX: 0,
      endX: 100,
      baseY: 100,
    });

    const hit = terrain.raycastDown(500, 0, 100);
    expect(hit.hit).toBe(false);
  });

  it('does not hit a surface that is above the ray origin', () => {
    const terrain = new Terrain();
    terrain.addChunk({
      slabs: [flatSlab(0, 100, 400, 200)],
      platforms: [],
      hazards: [],
      startX: 0,
      endX: 400,
      baseY: 100,
    });

    // Origin is below the slab top, so nothing is hit going down.
    const hit = terrain.raycastDown(200, 150);
    expect(hit.hit).toBe(false);
  });

  it('hits the topmost surface when slabs overlap vertically', () => {
    const terrain = new Terrain();
    terrain.addChunk({
      slabs: [flatSlab(0, 100, 400, 200), flatSlab(0, 40, 400, 20, 'metal')],
      platforms: [],
      hazards: [],
      startX: 0,
      endX: 400,
      baseY: 100,
    });

    const hit = terrain.raycastDown(200, 0);
    expect(hit.y).toBeCloseTo(40, 6);
    expect(hit.material).toBe('metal');
  });

  it('treats one-way platforms as walkable surfaces', () => {
    const terrain = new Terrain();
    terrain.addChunk({
      slabs: [],
      platforms: [{ x: 0, y: 80, w: 200, h: 12, material: 'wood' }],
      hazards: [],
      startX: 0,
      endX: 200,
      baseY: 80,
    });

    const hit = terrain.raycastDown(100, 0);
    expect(hit.hit).toBe(true);
    expect(hit.y).toBeCloseTo(80, 6);
    expect(hit.material).toBe('wood');
  });

  it('detects solid overlap for walls', () => {
    const terrain = new Terrain();
    terrain.addChunk({
      slabs: [flatSlab(0, 100, 400, 200)],
      platforms: [],
      hazards: [],
      startX: 0,
      endX: 400,
      baseY: 100,
    });

    expect(terrain.solidAt(200, 150)).toBe(true);
    expect(terrain.solidAt(200, 50)).toBe(false);
    expect(terrain.solidAt(800, 150)).toBe(false);
  });

  it('finds the nearest roof lip to the right', () => {
    const terrain = new Terrain();
    terrain.addChunk({
      slabs: [flatSlab(0, 100, 300, 200), flatSlab(500, 100, 300, 200)],
      platforms: [],
      hazards: [],
      startX: 0,
      endX: 800,
      baseY: 100,
    });

    const edge = terrain.findEdgeRight(100, 600);
    expect(edge).not.toBeNull();
    expect(edge!.x).toBeCloseTo(300, 6);
    expect(edge!.y).toBeCloseTo(100, 6);
  });

  it('detects hazards overlapping a rect', () => {
    const terrain = new Terrain();
    terrain.addChunk({
      slabs: [flatSlab(0, 100, 400, 200)],
      platforms: [],
      hazards: [{ kind: 'pipe', x: 100, y: 0, w: 120, h: 40, state: 40 }],
      startX: 0,
      endX: 400,
      baseY: 100,
    });

    const hit = terrain.hazardInRect({ x: 120, y: 20, w: 30, h: 30 });
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('pipe');

    const miss = terrain.hazardInRect({ x: 300, y: 20, w: 30, h: 30 });
    expect(miss).toBeNull();
  });
});
