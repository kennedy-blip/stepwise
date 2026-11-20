/**
 * Central tuning configuration.
 *
 * Everything gameplay-facing that a designer might want to tweak lives here so
 * the simulation modules stay declarative.
 */

import type { Difficulty, SkyMood } from '../core/types';

/**
 * URL of the Android APK download. The button is intentionally configurable so
 * a placeholder build never produces a hard 404 on the live deployment.
 */
export const APK_DOWNLOAD_URL = '/downloads/stepwise.apk';

/** Version string shown on the APK download card. */
export const APP_VERSION = '1.0.0';

export interface DifficultyTuning {
  label: string;
  /** Coyote time in seconds — how long after leaving a ledge a jump still works. */
  coyoteTime: number;
  /** Input buffer window in seconds. */
  inputBuffer: number;
  /** Speed with no flow bonus, px/s. */
  baseSpeed: number;
  /** Top speed with no flow bonus, px/s. */
  maxSprintSpeed: number;
  /** Acceleration ramp from jog to sprint, in seconds. */
  accelRamp: number;
  /** Ground acceleration, px/s^2. */
  groundAccel: number;
  /** Air acceleration, px/s^2. */
  airAccel: number;
  /** Ground friction when no input, px/s^2. */
  groundFriction: number;
  /** Air drag, px/s^2. */
  airDrag: number;
  /** Jump impulse, px/s. */
  jumpSpeed: number;
  /** Gravity while ascending, px/s^2. */
  gravityUp: number;
  /** Gravity while falling, px/s^2 (asymmetric — falls feel snappy). */
  gravityDown: number;
  /** Multiplier applied to downward gravity. */
  fallGravityMultiplier: number;
  /** Minimum horizontal gap between roofs, px. */
  minGap: number;
  /** Maximum horizontal gap between roofs, px. */
  maxGap: number;
  /** Minimum vertical drop between roofs, px. */
  minDrop: number;
  /** Maximum vertical drop between roofs, px. */
  maxDrop: number;
  /** Probability weights for optional rooftop obstacles. */
  obstacleWeights: {
    acUnit: number;
    plank: number;
    skylight: number;
    pipe: number;
    zipline: number;
    spring: number;
    ramp: number;
    vent: number;
  };
  /** Chance a generated chunk contains a collapsing plank. */
  fragileChance: number;
  /** Chance of a fast-cracking (short fuse) plank. */
  fastCrackChance: number;
  /** Passive flow decay per second while hesitating. */
  flowDecayPerSecond: number;
  /** Whether the flow meter decays at all on this difficulty. */
  flowDecayEnabled: boolean;
}

const BASE_TUNING: Omit<
  DifficultyTuning,
  | 'label'
  | 'coyoteTime'
  | 'inputBuffer'
  | 'baseSpeed'
  | 'maxSprintSpeed'
  | 'minGap'
  | 'maxGap'
  | 'minDrop'
  | 'maxDrop'
> = {
  accelRamp: 0.65,
  groundAccel: 2400,
  airAccel: 1500,
  groundFriction: 2600,
  airDrag: 420,
  jumpSpeed: 760,
  gravityUp: 2350,
  gravityDown: 2350,
  fallGravityMultiplier: 1.35,
  obstacleWeights: {
    acUnit: 30,
    plank: 12,
    skylight: 10,
    pipe: 14,
    zipline: 8,
    spring: 8,
    ramp: 12,
    vent: 12,
  },
  fragileChance: 0.35,
  fastCrackChance: 0.3,
  flowDecayPerSecond: 5,
  flowDecayEnabled: true,
};

export const DIFFICULTY_TUNING: Record<Difficulty, DifficultyTuning> = {
  easy: {
    ...BASE_TUNING,
    label: 'Rooftop Cruise',
    coyoteTime: 0.16,
    inputBuffer: 0.18,
    baseSpeed: 320,
    maxSprintSpeed: 480,
    minGap: 90,
    maxGap: 190,
    minDrop: 0,
    maxDrop: 160,
    obstacleWeights: { ...BASE_TUNING.obstacleWeights, plank: 8, skylight: 6, zipline: 4 },
    fragileChance: 0.25,
    fastCrackChance: 0.1,
    flowDecayPerSecond: 4,
  },
  medium: {
    ...BASE_TUNING,
    label: 'City Flow',
    coyoteTime: 0.1,
    inputBuffer: 0.12,
    baseSpeed: 380,
    maxSprintSpeed: 580,
    minGap: 130,
    maxGap: 280,
    minDrop: 0,
    maxDrop: 260,
  },
  hard: {
    ...BASE_TUNING,
    label: 'Razorline',
    coyoteTime: 0.06,
    inputBuffer: 0.08,
    baseSpeed: 440,
    maxSprintSpeed: 680,
    minGap: 180,
    maxGap: 380,
    minDrop: 0,
    maxDrop: 400,
    obstacleWeights: {
      acUnit: 24,
      plank: 18,
      skylight: 16,
      pipe: 18,
      zipline: 12,
      spring: 10,
      ramp: 10,
      vent: 8,
    },
    fragileChance: 0.55,
    fastCrackChance: 0.65,
  },
};

/** World-to-metre conversion for the distance HUD. */
export const PIXELS_PER_METRE = 40;

/** Character skeleton proportions (pixels). */
export const SKELETON = {
  hipHeight: 96,
  thighLength: 46,
  shinLength: 44,
  upperArmLength: 34,
  foreArmLength: 32,
  neckLength: 12,
  headRadius: 13,
  shoulderWidth: 12,
  hipWidth: 10,
  /** Torso length from pelvis to neck. */
  torsoLength: 54,
  /** Vertical distance from the ankle to the sole of the shoe. */
  ankleHeight: 6,
  /** How far the sole sits off the ground. */
  soleThickness: 2,
  /** Ankle rotation clamp from vertical, radians. */
  maxAnkleAngle: 0.65,
};

/** Player hitbox dimensions. */
export const HITBOX = {
  width: 26,
  height: 86,
  slideHeight: 40,
  /** Hitbox width while sliding (longer, lower). */
  slideWidth: 46,
};

/** Physics constants. */
export const PHYSICS = {
  /** Fixed simulation timestep in seconds (120 Hz internal). */
  fixedDt: 1 / 120,
  /** Maximum simulation steps per rendered frame to avoid spiral of death. */
  maxStepsPerFrame: 8,
  /** Global time scale, used for hit-stop slow motion. */
  timeScale: 1,
  /** Multiplier applied to gravity while sliding on a slope. */
  slopeSlideAcceleration: 900,
  /** Downhill acceleration on sloped surfaces, px/s^2 per radian. */
  slopeAcceleration: 1500,
  /** Minimum slope angle (rad) before the runner starts sliding downhill. */
  slopeSlideThreshold: 0.12,
  /** Slide friction decay, px/s^2. */
  slideFriction: 240,
  /** Slide boost when starting a slide from speed. */
  slideBoost: 1.12,
  /** Slide duration cap, seconds. */
  maxSlideTime: 1.6,
  /**
   * The tallest obstacle the runner can walk over without jumping (px).
   * AC units and vents are designed to sit within this so they showcase the
   * leg IK climbing rather than blocking the run.
   */
  maxStepHeight: 34,
  /** Drop height (px) above which a tuck-roll is offered. */
  tuckRollDropHeight: 1.5 * SKELETON.hipHeight,
  /**
   * Landing speed (px/s) above which a landing is a stumble.
   *
   * A drop of roughly 150px reaches this speed. Smaller drops are ordinary
   * landings, so the meter is never drained by routine rooftop gaps.
   */
  hardLandingSpeed: 1150,
  /** Window before touchdown during which a roll input is accepted, seconds. */
  tuckRollWindow: 0.22,
  /** Speed retained after a successful roll. */
  rollSpeedRetention: 1.15,
  /** Duration of the stumble recovery, seconds. */
  stumbleDuration: 0.5,
  /** Flow lost on a stumble (percentage points). */
  stumbleFlowLoss: 40,
  /** Extra time the runner can jump after leaving a ledge (beyond coyote). */
  ledgeGrabReach: 26,
  /** How far ahead the chest ray is cast for ledge detection. */
  chestRayDistance: 30,
  /**
   * Maximum downward speed at which a ledge grab can still connect (px/s).
   * Above this the runner is falling too fast to catch a lip, which keeps
   * long drops genuinely dangerous. 900 px/s corresponds to a fall of roughly
   * 130px — a short hop onto a lower roof, but not a full-height drop.
   */
  maxLedgeGrabFallSpeed: 900,
  /** Flow Save: hit-stop duration in seconds. */
  flowSaveHitStop: 0.15,
  /** Flow Save: flow consumed (percentage points). */
  flowSaveCost: 50,
  /** Flow Save: horizontal speed granted by the handspring recovery. */
  flowSaveRecoverySpeed: 420,
  /** Flow thresholds. */
  flowTier2: 34,
  flowTier3: 80,
  /** Flow rewards. */
  flowRewardLanding: 15,
  /** Clean moves needed for the streak bonus. */
  flowStreakStep: 4,
  /** Flow awarded for every clean-move streak step. */
  flowStreakBonus: 8,
  flowRewardVault: 20,
  flowRewardSlide: 20,
  flowRewardEdgeLeap: 25,
  /** Distance in px from a roof lip that still counts as an edge leap. */
  edgeLeapWindow: 16,
};

export const FLOW_TIER_SPEEDS = {
  1: 1.0,
  2: 1.15,
  3: 1.25,
} as const;

/** Sky mood palettes used by the parallax renderer. */
export interface SkyPalette {
  id: SkyMood;
  label: string;
  skyTop: string;
  skyMid: string;
  skyBottom: string;
  sun: string;
  sunGlow: string;
  farCity: string;
  midCity: string;
  nearCity: string;
  window: string;
  fog: string;
  particle: 'rain' | 'dust' | 'none';
  particleColor: string;
  particleRate: number;
  accent: string;
}

export const SKY_MOODS: Record<SkyMood, SkyPalette> = {
  dusk: {
    id: 'dusk',
    label: 'Golden Dusk',
    skyTop: '#1b1b3a',
    skyMid: '#7b3f6b',
    skyBottom: '#f0a05a',
    sun: '#ffd98a',
    sunGlow: 'rgba(255, 190, 110, 0.35)',
    farCity: '#2a2440',
    midCity: '#221d33',
    nearCity: '#16121f',
    window: 'rgba(255, 210, 140, 0.75)',
    fog: 'rgba(90, 60, 90, 0.25)',
    particle: 'dust',
    particleColor: 'rgba(255, 220, 180, 0.5)',
    particleRate: 12,
    accent: '#ffb45c',
  },
  rain: {
    id: 'rain',
    label: 'Neon Rain',
    skyTop: '#05060f',
    skyMid: '#0d1330',
    skyBottom: '#182048',
    sun: '#6de3ff',
    sunGlow: 'rgba(90, 200, 255, 0.28)',
    farCity: '#111a35',
    midCity: '#0b1128',
    nearCity: '#060917',
    window: 'rgba(120, 230, 255, 0.8)',
    fog: 'rgba(20, 40, 90, 0.35)',
    particle: 'rain',
    particleColor: 'rgba(150, 210, 255, 0.55)',
    particleRate: 55,
    accent: '#5fe0ff',
  },
  dawn: {
    id: 'dawn',
    label: 'Misty Dawn',
    skyTop: '#243b52',
    skyMid: '#5d7f96',
    skyBottom: '#cfd9dc',
    sun: '#fff4de',
    sunGlow: 'rgba(255, 250, 230, 0.4)',
    farCity: '#7d95a3',
    midCity: '#5f7684',
    nearCity: '#3f5260',
    window: 'rgba(255, 240, 200, 0.45)',
    fog: 'rgba(200, 215, 220, 0.4)',
    particle: 'none',
    particleColor: 'rgba(255,255,255,0.3)',
    particleRate: 0,
    accent: '#cfe6ea',
  },
};

/** Camera configuration. */
export const CAMERA = {
  /** Runner anchor as a fraction of viewport width. */
  anchorX: 0.28,
  /** Runner anchor as a fraction of viewport height. */
  anchorY: 0.66,
  /** Base zoom at which the world is rendered. */
  baseZoom: 1,
  /** Zoom at maximum speed. */
  fastZoom: 0.84,
  /** Speed at which the fast zoom is fully applied, px/s. */
  fastZoomSpeed: 700,
  /** How quickly the camera follows the runner. */
  followRate: 14,
  /** Vertical dead zone so small hops don't bob the camera. */
  verticalDeadZone: 26,
  /** Zoom smoothing rate. */
  zoomRate: 3,
};

/** Flow tier colours used by HUD + character rim light. */
export const FLOW_COLORS = {
  1: { primary: '#e9eef5', glow: 'rgba(233, 238, 245, 0.35)', scarf: '#dfe6ef' },
  2: { primary: '#ffb347', glow: 'rgba(255, 179, 71, 0.45)', scarf: '#ffa63d' },
  3: { primary: '#5fe0ff', glow: 'rgba(95, 224, 255, 0.55)', scarf: '#6defff' },
} as const;

/** Palette for the runner silhouette. */
export const RUNNER_COLORS = {
  body: '#12141c',
  bodyLight: '#242838',
  rim: '#e9eef5',
  head: '#171a24',
  accent: '#5fe0ff',
};
