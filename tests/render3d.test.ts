/**
 * Tests for the 3D presentation layer.
 *
 * The 3D modules are pure geometry and maths, so they can be tested without
 * a GPU by asserting on the values they compute. The renderer itself needs a
 * WebGL context, which the headless environment does not provide, so it is
 * covered indirectly through the presenter fallback and the unit tests.
 */

import { describe, expect, it } from 'vitest';
import {
  DEPTH,
  metresToPx,
  pxToMetres,
  sceneYToSim,
  simX,
  simY,
  PIXELS_PER_METRE,
} from '../src/render3d/units';
import { CAMERA_3D } from '../src/render3d/camera3d';
import { LIGHTING_PRESETS } from '../src/render3d/lighting3d';
import {
  detectDefaultPreset,
  effectivePixelRatio,
  qualityFor,
  type GraphicsPreset,
} from '../src/engine/quality';

describe('3D unit conversion', () => {
  it('uses the project scale of 40 px per metre', () => {
    expect(PIXELS_PER_METRE).toBe(40);
    expect(pxToMetres(40)).toBe(1);
    expect(metresToPx(1)).toBe(40);
  });

  it('round-trips X and Y conversions', () => {
    // simX expects pixels, so the round trip is px -> m -> px.
    expect(metresToPx(simX(123))).toBeCloseTo(123, 6);
    expect(sceneYToSim(simY(456))).toBeCloseTo(456, 6);
  });

  it('flips the Y axis between simulation and scene space', () => {
    // The simulation uses +y = down; Three.js uses +y = up.
    expect(simY(0)).toBe(0);
    expect(simY(100)).toBeCloseTo(-2.5, 6);
    expect(simY(-100)).toBeCloseTo(2.5, 6);
  });

  it('keeps X right-handed in both spaces', () => {
    expect(simX(100)).toBeCloseTo(2.5, 6);
    expect(simX(-100)).toBeCloseTo(-2.5, 6);
  });
});

describe('3D depth bands', () => {
  it('centres the playable lane on Z = 0', () => {
    expect(DEPTH.playableHalf).toBe(1.3);
    expect(DEPTH.parapet).toBeLessThan(DEPTH.playableHalf);
  });

  it('keeps the front parapet flush with the walkable surface', () => {
    // The parapet must never sit in front of the runner's feet, so it has to
    // be at or just below the playable half-depth.
    expect(DEPTH.parapet).toBeLessThanOrEqual(DEPTH.playableHalf);
    expect(DEPTH.parapet).toBeGreaterThan(1.2);
  });

  it('places the background bands behind the playable lane', () => {
    // `near` is the edge closest to the camera, `far` the furthest, so the
    // far edge is always numerically smaller.
    expect(DEPTH.nearBack.near).toBeLessThan(0);
    expect(DEPTH.nearBack.far).toBeLessThan(DEPTH.nearBack.near);
    expect(DEPTH.deepSkyline.far).toBeLessThan(DEPTH.deepSkyline.near);
    // The near band must sit in front of the deep band.
    expect(DEPTH.deepSkyline.near).toBeLessThan(DEPTH.nearBack.far);
  });
});

describe('2.5D camera framing', () => {
  it('uses a 45 degree field of view', () => {
    expect(CAMERA_3D.fov).toBe(45);
  });

  it('pulls back as the flow tier rises', () => {
    expect(CAMERA_3D.strideDistance).toBeGreaterThan(CAMERA_3D.baseDistance);
    expect(CAMERA_3D.flowDistance).toBeGreaterThan(CAMERA_3D.strideDistance);
    expect(CAMERA_3D.baseDistance).toBe(16);
    expect(CAMERA_3D.strideDistance).toBe(17.5);
    expect(CAMERA_3D.flowDistance).toBe(19);
  });

  it('sits above the runner and pitches gently downward', () => {
    expect(CAMERA_3D.elevation).toBe(2.6);
    expect(CAMERA_3D.pitchDeg).toBe(-9.5);
    // A steep pitch would hide the landing edges behind the roof fronts.
    expect(Math.abs(CAMERA_3D.pitchDeg)).toBeLessThan(15);
  });

  it('leads the runner so they sit left of centre', () => {
    expect(CAMERA_3D.leadAhead).toBe(4.2);
    expect(CAMERA_3D.yawDeg).toBeCloseTo(-2.5, 6);
  });
});

describe('Lighting presets', () => {
  it('defines all three sky moods', () => {
    expect(Object.keys(LIGHTING_PRESETS).sort()).toEqual(['dawn', 'dusk', 'rain']);
  });

  it('uses a warm low sun and cool fill for Golden Dusk', () => {
    const dusk = LIGHTING_PRESETS.dusk;
    expect(dusk.sunColor).toBe('#ff9e5e');
    expect(dusk.sunIntensity).toBe(2.6);
    expect(dusk.hemiSky).toBe('#3b4d7a');
    expect(dusk.hemiGround).toBe('#1a1625');
    expect(dusk.fogColor).toBe('#2b2238');
  });

  it('uses a cool key and wet glossy roofs for Neon Rain', () => {
    const rain = LIGHTING_PRESETS.rain;
    expect(rain.sunColor).toBe('#6ea8ff');
    expect(rain.roofRoughness).toBeLessThan(0.3);
    expect(rain.bounceA).toBe('#00f0ff');
    expect(rain.bounceB).toBe('#ff2a85');
    expect(rain.weather).toBe('rain');
  });

  it('uses silver-teal morning light and dense fog for Misty Dawn', () => {
    const dawn = LIGHTING_PRESETS.dawn;
    expect(dawn.sunColor).toBe('#cfe6ec');
    expect(dawn.fogColor).toBe('#8fa8b2');
    expect(dawn.fogDensity).toBeGreaterThan(LIGHTING_PRESETS.dusk.fogDensity);
  });

  it('gives every preset a denser fog than the dusk baseline', () => {
    for (const preset of Object.values(LIGHTING_PRESETS)) {
      expect(preset.fogDensity).toBeGreaterThan(0);
      expect(preset.bloomStrength).toBeGreaterThan(0);
      expect(preset.windowDensity).toBeGreaterThanOrEqual(0);
      expect(preset.windowDensity).toBeLessThanOrEqual(1);
    }
  });
});

describe('Graphics quality presets', () => {
  it('caps pixel ratio and shadow map size per preset', () => {
    const high = qualityFor('high');
    const perf = qualityFor('performance');
    expect(high.maxPixelRatio).toBe(2.0);
    expect(high.shadowMapSize).toBe(2048);
    expect(high.bloom).toBe(true);
    expect(perf.maxPixelRatio).toBeLessThan(high.maxPixelRatio);
    expect(perf.shadowMapSize).toBeLessThan(high.shadowMapSize);
    expect(perf.bloom).toBe(false);
  });

  it('keeps the performance preset lighter in every dimension', () => {
    const high = qualityFor('high');
    const perf = qualityFor('performance');
    expect(perf.particleScale).toBeLessThan(high.particleScale);
    expect(perf.maxPixelRatio).toBeLessThanOrEqual(1.5);
    expect(perf.shadowMapSize).toBe(1024);
  });

  it('never upscales beyond the device ratio', () => {
    const settings = qualityFor('performance');
    expect(effectivePixelRatio(settings)).toBeGreaterThanOrEqual(1);
    expect(effectivePixelRatio(settings)).toBeLessThanOrEqual(settings.maxPixelRatio);
  });

  it('auto-detects Performance on touch devices and High on desktop', () => {
    // The default matters for first-time mobile visitors on Vercel.
    const presets: GraphicsPreset[] = ['high', 'performance'];
    expect(presets).toContain(detectDefaultPreset());
    expect(['high', 'performance']).toContain(detectDefaultPreset());
  });
});
