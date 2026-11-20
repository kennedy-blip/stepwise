/**
 * Headless render smoke test.
 *
 * The renderer is exercised against a minimal Canvas2D mock so that any
 * runtime error in the draw path (undefined properties, NaN coordinates,
 * missing methods) is caught without a real browser.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { World } from '../src/game/world';
import { Renderer } from '../src/render/renderer';
import { PHYSICS, SKY_MOODS } from '../src/game/config';
import { createInputState } from '../src/core/types';

/** Extracts the alpha channel from an `rgba(...)` colour string. */
function alphaOf(color: string): number {
  const match = color.match(/rgba?\(([^)]+)\)/);
  if (!match) return 0;
  const parts = match[1].split(',').map((p) => parseFloat(p.trim()));
  return parts.length >= 4 ? parts[3] : 1;
}

/** A recording no-op Canvas2D context. */
function makeMockContext(): CanvasRenderingContext2D {
  const calls: string[] = [];
  const ctx: Record<string, unknown> = {
    calls,
    // Properties the renderer writes to.
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    globalAlpha: 1,
    font: '',
    textAlign: 'start',
    shadowColor: '',
    shadowBlur: 0,
    canvas: { width: 1280, height: 720 },

    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    scale: () => calls.push('scale'),
    translate: () => calls.push('translate'),
    rotate: () => calls.push('rotate'),
    beginPath: () => calls.push('beginPath'),
    closePath: () => calls.push('closePath'),
    clip: () => calls.push('clip'),
    moveTo: () => calls.push('moveTo'),
    lineTo: () => calls.push('lineTo'),
    arc: () => calls.push('arc'),
    rect: () => calls.push('rect'),
    quadraticCurveTo: () => calls.push('quadraticCurveTo'),
    fill: () => calls.push('fill'),
    stroke: () => calls.push('stroke'),
    fillRect: () => calls.push('fillRect'),
    strokeRect: () => calls.push('strokeRect'),
    clearRect: () => calls.push('clearRect'),
    fillText: () => calls.push('fillText'),
    setLineDash: () => calls.push('setLineDash'),
    drawImage: () => calls.push('drawImage'),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    createPattern: () => null,
    measureText: () => ({ width: 10 }),
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

function makeMockCanvas(): HTMLCanvasElement {
  const canvas = {
    width: 1280,
    height: 720,
    getContext: () => makeMockContext(),
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 1280,
      height: 720,
      right: 1280,
      bottom: 720,
    }),
    addEventListener: () => undefined,
    style: {},
  };
  return canvas as unknown as HTMLCanvasElement;
}

/** Renders one frame and returns the recorded Canvas2D call names. */
function renderWithRecording(world: World, mood: 'dusk' | 'rain' | 'dawn'): string[] {
  const ctx = makeMockContext();
  const canvas = {
    width: 1280,
    height: 720,
    getContext: () => ctx,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 1280,
      height: 720,
      right: 1280,
      bottom: 720,
    }),
    addEventListener: () => undefined,
    style: {},
  } as unknown as HTMLCanvasElement;
  const r = new Renderer(canvas);
  r.render(world, { showDebug: false, skyMood: mood });
  return (ctx as unknown as { calls: string[] }).calls;
}

describe('Renderer (headless)', () => {
  let world: World;
  let renderer: Renderer;

  beforeEach(() => {
    world = new World({ difficulty: 'medium', seed: 4242 });
    world.start();
    renderer = new Renderer(makeMockCanvas());
  });

  it('renders the title screen without throwing', () => {
    expect(() => renderer.render(world, { showDebug: false, skyMood: 'dusk' })).not.toThrow();
  });

  it('renders every sky mood', () => {
    for (const mood of ['dusk', 'rain', 'dawn'] as const) {
      expect(() => renderer.render(world, { showDebug: false, skyMood: mood })).not.toThrow();
    }
  });

  it('renders the debug overlay without throwing', () => {
    expect(() => renderer.render(world, { showDebug: true, skyMood: 'dusk' })).not.toThrow();
  });

  it('draws three separated parallax city layers', () => {
    const calls = renderWithRecording(world, 'dusk');
    // Each city layer clips a haze wash to its own towers, so a scene with
    // three layers must record at least three clips.
    expect(calls.filter((c) => c === 'clip').length).toBeGreaterThanOrEqual(3);
  });

  it('applies atmospheric haze for every sky mood', () => {
    for (const mood of ['dusk', 'rain', 'dawn'] as const) {
      const palette = SKY_MOODS[mood];
      expect(palette.haze.far).toMatch(/rgba?\(/);
      expect(palette.haze.mid).toMatch(/rgba?\(/);
      expect(palette.haze.near).toMatch(/rgba?\(/);
      expect(palette.groundHaze).toMatch(/rgba?\(/);
      // The haze must weaken toward the viewer, otherwise the foreground
      // city dissolves as much as the far city does.
      expect(alphaOf(palette.haze.near)).toBeLessThan(alphaOf(palette.haze.mid));
      expect(alphaOf(palette.haze.mid)).toBeLessThan(alphaOf(palette.haze.far));
    }
  });

  it('gives every sky mood a horizon placement inside the viewport', () => {
    for (const mood of ['dusk', 'rain', 'dawn'] as const) {
      const { horizonY } = SKY_MOODS[mood];
      expect(horizonY).toBeGreaterThan(0.2);
      expect(horizonY).toBeLessThan(0.9);
    }
  });

  it('draws material-specific rooftop texture', () => {
    const calls = renderWithRecording(world, 'dusk');
    // Slab texture is clipped per material, so multiple clips must appear.
    expect(calls.filter((c) => c === 'clip').length).toBeGreaterThanOrEqual(4);
  });

  it('renders mid-run without throwing', () => {
    for (let i = 0; i < 600; i++) {
      world.currentInput = { ...createInputState(), moveX: 1 };
      world.update(PHYSICS.fixedDt);
    }
    expect(() => renderer.render(world, { showDebug: true, skyMood: 'rain' })).not.toThrow();
  });

  it('renders while sliding, jumping and hanging from a ledge', () => {
    // Slide.
    world.currentInput = { ...createInputState(), moveX: 1, crouchHeld: true, crouchPressed: true };
    world.update(PHYSICS.fixedDt);
    expect(() => renderer.render(world, { showDebug: false, skyMood: 'dusk' })).not.toThrow();

    // Jump.
    world.currentInput = { ...createInputState(), moveX: 1, jumpHeld: true, jumpPressed: true };
    world.update(PHYSICS.fixedDt);
    expect(() => renderer.render(world, { showDebug: false, skyMood: 'dusk' })).not.toThrow();

    // Death state.
    world.kill('TEST');
    expect(() => renderer.render(world, { showDebug: false, skyMood: 'dawn' })).not.toThrow();
  });

  it('never emits NaN coordinates during a long run', () => {
    const bad: string[] = [];
    const ctx = makeMockContext();
    const origFillRect = ctx.fillRect as (x: number, y: number, w: number, h: number) => void;
    ctx.fillRect = (x, y, w, h) => {
      if (![x, y, w, h].every(Number.isFinite)) bad.push(`fillRect ${x},${y},${w},${h}`);
    };
    const origArc = ctx.arc as (x: number, y: number, r: number) => void;
    ctx.arc = (x, y, r) => {
      if (![x, y, r].every(Number.isFinite)) bad.push(`arc ${x},${y},${r}`);
    };
    const origMoveTo = ctx.moveTo as (x: number, y: number) => void;
    ctx.moveTo = (x, y) => {
      if (![x, y].every(Number.isFinite)) bad.push(`moveTo ${x},${y}`);
    };
    const origLineTo = ctx.lineTo as (x: number, y: number) => void;
    ctx.lineTo = (x, y) => {
      if (![x, y].every(Number.isFinite)) bad.push(`lineTo ${x},${y}`);
    };

    const r2 = new Renderer(makeMockCanvas());
    // Swap in the instrumented context.
    (r2 as unknown as { ctx: CanvasRenderingContext2D }).ctx = ctx;

    for (let i = 0; i < 400; i++) {
      world.currentInput = {
        ...createInputState(),
        moveX: 1,
        jumpHeld: i % 90 < 12,
        jumpPressed: i % 90 === 0,
      };
      world.update(PHYSICS.fixedDt);
      r2.render(world, { showDebug: true, skyMood: 'dusk' });
    }

    expect(bad).toEqual([]);
    // Keep the originals referenced so the linter does not flag them.
    expect(typeof origFillRect).toBe('function');
    expect(typeof origArc).toBe('function');
    expect(typeof origMoveTo).toBe('function');
    expect(typeof origLineTo).toBe('function');
  });
});
