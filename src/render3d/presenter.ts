/**
 * The presentation-layer abstraction.
 *
 * The game can present itself two ways:
 *  - `Renderer3D` : the Three.js 2.5D scene (the default).
 *  - `Renderer`    : the original 2D Canvas renderer, kept as a fallback.
 *
 * The fallback exists because WebGL is not guaranteed: old Android WebViews,
 * locked-down browsers and headless test environments may not provide a
 * working GL context. A player who cannot get the 3D scene should still get
 * a playable game rather than a blank screen.
 *
 * Both renderers present the SAME simulation, so gameplay is identical
 * whichever one is active.
 */

import { Renderer } from '../render/renderer';
import { detectDefaultPreset } from '../engine/quality';
import type { Renderer3D } from './renderer3d';
import type { GraphicsPreset } from '../core/types';
import type { World } from '../game/world';
import type { SkyMood } from '../core/types';

export interface Presenter {
  /** Whether this presenter is the 3D scene. */
  readonly is3D: boolean;
  /** The graphics preset, for the 3D presenter. */
  readonly preset: GraphicsPreset;
  render(world: World, options: { showDebug: boolean; skyMood: SkyMood }): void;
  resize(width: number, height: number): void;
  applyMood(mood: SkyMood): void;
  applyPreset(preset: GraphicsPreset): void;
  addShake(amount: number): void;
  triggerZoomPulse(): void;
  dispose(): void;
}

/**
 * Probes whether the browser can give us a usable WebGL context.
 *
 * This must be done with a throwaway canvas, before the real renderer is
 * constructed, because a partially-constructed Three.js renderer is hard to
 * clean up.
 */
export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl =
      (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
      (canvas.getContext('webgl') as WebGLRenderingContext | null);
    if (!gl) return false;
    // Some environments expose a context object that is not really a GL
    // context. Probe for a method that every real GL context has.
    if (typeof (gl as unknown as { getExtension?: unknown }).getExtension !== 'function') {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The 3D presenter.
 *
 * Three.js is loaded with a dynamic import so that the (large) 3D chunk is
 * only downloaded when the device can actually use it. A browser without
 * WebGL never pays for the 3D bundle at all.
 */
class Presenter3D implements Presenter {
  readonly is3D = true;
  private inner: Renderer3D | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly initialPreset: GraphicsPreset;
  private currentPreset: GraphicsPreset;

  constructor(canvas: HTMLCanvasElement, preset: GraphicsPreset) {
    this.canvas = canvas;
    this.initialPreset = preset;
    this.currentPreset = preset;
  }

  get preset(): GraphicsPreset {
    return this.currentPreset;
  }

  /**
   * Loads the Three.js chunk and builds the renderer.
   *
   * Returns false when the 3D path could not be prepared, in which case
   * the caller should fall back to the 2D renderer.
   */
  async init(): Promise<boolean> {
    try {
      const { Renderer3D } = await import('./renderer3d');
      this.inner = new Renderer3D(this.canvas, { preset: this.initialPreset });
      this.currentPreset = this.inner.currentPreset;
      return true;
    } catch (err) {
      console.warn('[Stepwise] 3D renderer unavailable, falling back to 2D.', err);
      this.inner = null;
      return false;
    }
  }

  render(world: World, options: { showDebug: boolean; skyMood: SkyMood }): void {
    this.inner?.render(world, options);
  }

  resize(width: number, height: number): void {
    this.inner?.resize(width, height);
  }

  applyMood(mood: SkyMood): void {
    this.inner?.applyMood(mood);
  }

  applyPreset(preset: GraphicsPreset): void {
    this.currentPreset = preset;
    this.inner?.applyPreset(preset);
  }

  addShake(amount: number): void {
    this.inner?.addShake(amount);
  }

  triggerZoomPulse(): void {
    this.inner?.triggerZoomPulse();
  }

  dispose(): void {
    this.inner?.dispose();
    this.inner = null;
  }
}

/** The 2D fallback presenter, adapted to the `Presenter` interface. */
class Presenter2D implements Presenter {
  readonly is3D = false;
  readonly preset: GraphicsPreset = 'performance';
  private inner: Renderer;

  constructor(canvas: HTMLCanvasElement) {
    this.inner = new Renderer(canvas);
  }

  render(world: World, options: { showDebug: boolean; skyMood: SkyMood }): void {
    this.inner.render(world, options);
  }

  resize(): void {
    this.inner.resize();
  }

  applyMood(): void {
    /* The 2D renderer reads the mood from the render options. */
  }

  applyPreset(): void {
    /* The 2D renderer has no quality presets. */
  }

  addShake(): void {
    /* The 2D renderer has its own shake handling. */
  }

  triggerZoomPulse(): void {
    /* The 2D renderer has no zoom pulse. */
  }

  dispose(): void {
    /* The 2D renderer owns no disposable GPU resources. */
  }
}

/**
 * Creates the best available presenter for the current environment.
 *
 * The 3D scene is preferred. If WebGL is unavailable, the 2D canvas renderer
 * is used so the game stays playable.
 *
 * The 3D presenter starts out un-initialised: its Three.js chunk is fetched
 * asynchronously by `initPresenter`, which resolves to the presenter that
 * actually ended up being used.
 */
export function createPresenter(canvas: HTMLCanvasElement, preset: GraphicsPreset): Presenter {
  if (isWebGLAvailable()) {
    return new Presenter3D(canvas, preset);
  }
  return new Presenter2D(canvas);
}

/**
 * Finishes presenter setup, loading the 3D chunk when it is wanted.
 *
 * Returns the presenter to use. If the 3D path was selected but failed to
 * initialise, the 2D renderer is returned instead so the game stays
 * playable.
 */
export async function initPresenter(
  canvas: HTMLCanvasElement,
  preset: GraphicsPreset,
): Promise<Presenter> {
  const presenter = createPresenter(canvas, preset);
  if (presenter instanceof Presenter3D) {
    const ok = await presenter.init();
    if (!ok) return new Presenter2D(canvas);
  }
  return presenter;
}

/** The auto-detected default preset. */
export { detectDefaultPreset };
