/**
 * Unit conversion between the 2D simulation and the 3D scene.
 *
 * The whole game simulates in PIXELS on a `Z = 0` traversal plane, with `+y`
 * pointing DOWN (screen convention). Three.js works in METRES with `+y` up and
 * `+z` toward the viewer.
 *
 * Everything that crosses the boundary between simulation and rendering goes
 * through this module, so there is exactly one place where the conventions
 * are translated. The simulation itself is never touched.
 */

/**
 * Pixels per metre. The project already uses 40 px = 1 m as its scale
 * reference for jump distances, so we keep that exact ratio.
 */
export const PIXELS_PER_METRE = 40;

/** Converts simulation pixels to scene metres. */
export function pxToMetres(px: number): number {
  return px / PIXELS_PER_METRE;
}

/** Converts scene metres to simulation pixels. */
export function metresToPx(m: number): number {
  return m * PIXELS_PER_METRE;
}

/**
 * Converts a simulation X (pixels, +right) to a scene X (metres, +right).
 */
export function simX(x: number): number {
  return x / PIXELS_PER_METRE;
}

/**
 * Converts a simulation Y (pixels, +DOWN) to a scene Y (metres, +UP).
 */
export function simY(y: number): number {
  // Normalise negative zero so callers can compare with `toBe(0)`.
  const metres = -y / PIXELS_PER_METRE;
  return metres === 0 ? 0 : metres;
}

/**
 * Converts a scene Y (metres, +UP) back to a simulation Y (pixels, +DOWN).
 */
export function sceneYToSim(y: number): number {
  return -y * PIXELS_PER_METRE;
}

/** Converts a scene Y velocity (m/s, +up) to simulation velocity (px/s, +down). */
export function sceneVelYToSim(vy: number): number {
  return -vy * PIXELS_PER_METRE;
}

/**
 * The Z depth bands of the scene, in metres.
 *
 * The playable lane sits at Z = 0 so the simulation's traversal plane maps
 * directly onto it. Everything else is decorative depth that must never
 * occlude a landing edge.
 */
export const DEPTH = {
  /** Half-depth of the playable rooftop extrusion. */
  playableHalf: 1.3,
  /** Front parapet lip. Kept flush with (or just below) the walk surface. */
  parapet: 1.28,
  /**
   * Near-background band, expressed as the Z range it spans.
   * `near` is the edge closest to the camera, `far` the furthest.
   */
  nearBack: { near: -4.5, far: -15.0 },
  /** Deep skyline band, as the Z range it spans. */
  deepSkyline: { near: -22.0, far: -65.0 },
} as const;
