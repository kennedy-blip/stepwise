/**
 * Core type definitions shared across the engine, game and render layers.
 *
 * The simulation layer (`src/engine`, `src/game`) is pure TypeScript: no DOM
 * references, no Canvas calls. Everything here is a plain data structure so the
 * whole simulation can be unit tested in Node.
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** Axis-aligned rectangle used for terrain solids and hitboxes. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A sloped terrain surface (roof, ramp, awning). */
export interface Slab {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Surface slope in radians. 0 = flat, positive = rising to the right. */
  angle: number;
  /** Material drives footstep synthesis + particle colour. */
  material: SurfaceMaterial;
  /** Optional two-tone accent used for the lit top edge. */
  edgeTint?: string;
}

export type SurfaceMaterial = 'concrete' | 'metal' | 'glass' | 'wood';

export type Difficulty = 'easy' | 'medium' | 'hard';

export type SkyMood = 'dusk' | 'rain' | 'dawn';

export type FlowTier = 1 | 2 | 3;

export type PlayerState =
  'idle' | 'run' | 'air' | 'slide' | 'mantle' | 'ledgeHang' | 'zip' | 'stumble' | 'dead';

/** Player-facing input snapshot, produced by the keyboard/touch layer. */
export interface InputState {
  /** -1 = brake / back, 0 = neutral, +1 = full pace. */
  moveX: number;
  /** Jump is held (variable jump height). */
  jumpHeld: boolean;
  /** Jump was pressed this simulation step. */
  jumpPressed: boolean;
  /** Crouch / slide / tuck-roll is held. */
  crouchHeld: boolean;
  /** Crouch was pressed this simulation step. */
  crouchPressed: boolean;
}

export function createInputState(): InputState {
  return {
    moveX: 0,
    jumpHeld: false,
    jumpPressed: false,
    crouchHeld: false,
    crouchPressed: false,
  };
}

/** A diegetic floating label ("+FLOW", "VAULT" ...) anchored in world space. */
export interface FloatingLabel {
  x: number;
  y: number;
  text: string;
  /** Seconds since spawn. */
  age: number;
  life: number;
  color: string;
  /** Optional scale pop at spawn. */
  pop: number;
}

/** Lightweight particle used for dust, sparks, rain and flow trails. */
export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  gravity: number;
  /** 0 = normal gravity, 1 = wind drift. */
  drag: number;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
  targetZoom: number;
  /** Vertical anchor of the runner within the viewport, 0 = top. */
  anchorY: number;
}

export interface GameSettings {
  skyMood: SkyMood;
  difficulty: Difficulty;
  masterVolume: number;
  muted: boolean;
  autoSprint: boolean;
  showDebug: boolean;
  haptics: boolean;
  frameRateTarget: 60 | 120;
}

export type RunOutcome = 'running' | 'finished' | 'dead';

export interface RunStats {
  distance: number;
  peakFlow: number;
  cleanMoves: number;
  flowSavesUsed: number;
  time: number;
}
