/**
 * Graphics quality presets.
 *
 * The 3D renderer is the first part of Stepwise that can meaningfully hurt
 * mid-range Android hardware, so the renderer is driven by an explicit
 * preset rather than by ad-hoc feature checks scattered across the scene
 * code.
 *
 * Two presets are offered:
 *  - `high`       : full resolution, large shadow map, bloom post-processing.
 *  - `performance`: reduced device pixel ratio, small shadow map, no bloom,
 *                   fewer particles. Default for touch devices.
 */

import type { GraphicsPreset } from '../core/types';

export type { GraphicsPreset };

export interface QualitySettings {
  /** Preset name. */
  preset: GraphicsPreset;
  /** Hard cap on the renderer pixel ratio. */
  maxPixelRatio: number;
  /** Resolution of the directional light shadow map. */
  shadowMapSize: number;
  /** Whether the bloom post-processing pass runs. */
  bloom: boolean;
  /** Multiplier applied to particle spawn counts. */
  particleScale: number;
  /** Whether fog uses the expensive per-fragment exponential curve. */
  volumetricFog: boolean;
}

const HIGH: QualitySettings = {
  preset: 'high',
  maxPixelRatio: 2.0,
  shadowMapSize: 2048,
  bloom: true,
  particleScale: 1.0,
  volumetricFog: true,
};

const PERFORMANCE: QualitySettings = {
  preset: 'performance',
  maxPixelRatio: 1.5,
  shadowMapSize: 1024,
  bloom: false,
  particleScale: 0.45,
  volumetricFog: false,
};

/**
 * Detects the best default preset for the current device.
 *
 * Touch capability is the primary signal: phones and tablets get the
 * Performance preset so a first-time mobile visitor on Vercel sees smooth
 * frame pacing rather than thermal throttling. Desktop keeps High.
 *
 * The device pixel ratio is a secondary signal — a very high-DPR desktop
 * display still runs High because it is thermally forgiving, while a
 * touch device with a modest ratio is usually a mid-range phone.
 */
export function detectDefaultPreset(): GraphicsPreset {
  if (typeof navigator === 'undefined') return 'high';
  const touchPoints = navigator.maxTouchPoints ?? 0;
  if (touchPoints > 0) return 'performance';
  // Some laptops report a single touch point; treat a coarse pointer as a
  // touch device too, but only when the screen is small enough to be a
  // tablet rather than a desktop with a touchscreen.
  if (
    typeof matchMedia === 'function' &&
    matchMedia('(pointer: coarse)').matches &&
    typeof window !== 'undefined' &&
    Math.min(window.innerWidth, window.innerHeight) < 900
  ) {
    return 'performance';
  }
  return 'high';
}

/** Returns the settings for a named preset. */
export function qualityFor(preset: GraphicsPreset): QualitySettings {
  return preset === 'high' ? { ...HIGH } : { ...PERFORMANCE };
}

/**
 * The pixel ratio actually used by the renderer: the device ratio capped by
 * the preset, and never below 1 so the image is never upscaled.
 */
export function effectivePixelRatio(settings: QualitySettings): number {
  const device = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  return Math.max(1, Math.min(device, settings.maxPixelRatio));
}
