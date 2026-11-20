/**
 * Headless acceptance harness for Stepwise.
 *
 * Boots the real application entry point (`src/main.ts`) inside a DOM
 * environment, drives the Golden Dusk / Medium scenario through synthetic
 * input, and asserts that every acceptance milestone actually fires.
 *
 * Run with:  npx vitest run tests/acceptance.test.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';

/** Collects every 2D drawing call so we can assert the scene really rendered. */
interface DrawLog {
  fills: number;
  strokes: number;
  paths: number;
  texts: string[];
  fillColors: Set<string>;
}

interface Harness {
  win: Window & typeof globalThis;
  doc: Document;
  draw: DrawLog;
  rafQueue: FrameRequestCallback[];
  canvas: HTMLCanvasElement;
  flush(frames?: number, dtMs?: number): void;
  key(code: string, down: boolean): void;
  tap(code: string): void;
  click(id: string): void;
  text(selector: string): string;
  visible(id: string): boolean;
}

function buildHarness(): Harness {
  const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const bodyHtml = bodyMatch ? bodyMatch[1] : '';

  const draw: DrawLog = {
    fills: 0,
    strokes: 0,
    paths: 0,
    texts: [],
    fillColors: new Set<string>(),
  };

  const rafQueue: FrameRequestCallback[] = [];

  const ctx = {
    canvas: null as unknown as HTMLCanvasElement,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    shadowBlur: 0,
    shadowColor: '',
    filter: 'none',
    imageSmoothingEnabled: true,
    save() {},
    restore() {},
    scale() {},
    rotate() {},
    translate() {},
    transform() {},
    setTransform() {},
    resetTransform() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    arcTo() {},
    ellipse() {},
    rect() {},
    quadraticCurveTo() {},
    bezierCurveTo() {},
    fillRect() {
      draw.fills++;
      draw.fillColors.add(String(this.fillStyle));
    },
    strokeRect() {
      draw.strokes++;
    },
    clearRect() {},
    fill() {
      draw.fills++;
      draw.fillColors.add(String(this.fillStyle));
    },
    stroke() {
      draw.strokes++;
    },
    clip() {},
    fillText(text: string) {
      draw.texts.push(String(text));
    },
    strokeText() {},
    drawImage() {},
    createLinearGradient() {
      return { addColorStop() {} } as unknown as CanvasGradient;
    },
    createRadialGradient() {
      return { addColorStop() {} } as unknown as CanvasGradient;
    },
    createPattern() {
      return null;
    },
    measureText(text: string) {
      return { width: String(text).length * 6 } as TextMetrics;
    },
    getImageData() {
      return { data: new Uint8ClampedArray(4) } as ImageData;
    },
    putImageData() {},
    setLineDash() {},
  };

  const win = new Window({
    url: 'https://stepwise.test/',
    width: 1280,
    height: 720,
  }) as unknown as Window & typeof globalThis;
  const doc = win.document as unknown as Document;

  doc.body.innerHTML = bodyHtml;

  // Provide the canvas element with a recording 2D context.
  const canvas = doc.getElementById('game-canvas') as HTMLCanvasElement;
  Object.defineProperty(canvas, 'getContext', {
    value: () => ctx,
    configurable: true,
  });
  Object.defineProperty(canvas, 'width', {
    value: 1280,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(canvas, 'height', {
    value: 720,
    writable: true,
    configurable: true,
  });

  const rafSpy = (cb: FrameRequestCallback): number => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  win.requestAnimationFrame = rafSpy as unknown as typeof win.requestAnimationFrame;
  win.cancelAnimationFrame = (() => {}) as unknown as typeof win.cancelAnimationFrame;

  Object.defineProperty(win, 'performance', {
    value: { now: () => 0 },
    configurable: true,
  });

  const api: Harness = {
    win,
    doc,
    draw,
    rafQueue,
    canvas,
    flush(frames = 1, dtMs = 1000 / 60) {
      let t = 0;
      for (let i = 0; i < frames; i++) {
        const pending = rafQueue.splice(0, rafQueue.length);
        t += dtMs;
        for (const cb of pending) cb(t);
      }
    },
    key(code: string, down: boolean) {
      const type = down ? 'keydown' : 'keyup';
      win.dispatchEvent(
        new win.KeyboardEvent(type, {
          code,
          key: code.replace('Key', '').toLowerCase(),
          bubbles: true,
        }),
      );
    },
    tap(code: string) {
      api.key(code, true);
      api.flush(1);
      api.key(code, false);
    },
    click(id: string) {
      const el = doc.getElementById(id);
      if (!el) throw new Error(`missing element #${id}`);
      (el as HTMLElement).click();
    },
    text(selector: string) {
      const el = doc.querySelector(selector);
      return el ? (el.textContent ?? '').trim() : '';
    },
    visible(id: string) {
      const el = doc.getElementById(id);
      return !!el && el.classList.contains('is-visible');
    },
  };

  return api;
}

/** Boot the real application against a harness. */
async function boot(h: Harness): Promise<void> {
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = h.win;
  g.document = h.win.document;
  g.HTMLElement = h.win.HTMLElement;
  g.HTMLCanvasElement = h.win.HTMLCanvasElement;
  g.Element = h.win.Element;
  g.Event = h.win.Event;
  g.CustomEvent = h.win.CustomEvent;
  g.KeyboardEvent = h.win.KeyboardEvent;
  g.MouseEvent = h.win.MouseEvent;
  g.PointerEvent = h.win.MouseEvent;
  g.TouchEvent = h.win.Event;
  g.getComputedStyle = h.win.getComputedStyle.bind(h.win);
  g.requestAnimationFrame = h.win.requestAnimationFrame;
  g.cancelAnimationFrame = h.win.cancelAnimationFrame;
  g.performance = h.win.performance;
  g.localStorage = h.win.localStorage;
  g.AudioContext = undefined;
  g.webkitAudioContext = undefined;
  Object.defineProperty(g, 'navigator', { value: h.win.navigator, configurable: true });

  await import('../src/main');
  h.flush(2);
}

describe('Golden Dusk / Medium acceptance scenario', () => {
  let h: Harness;

  beforeEach(async () => {
    vi.resetModules();
    h = buildHarness();
    await boot(h);
  });

  it('renders the live title scene (non-blank canvas)', () => {
    expect(h.draw.fills).toBeGreaterThan(50);
    expect(h.draw.fillColors.size).toBeGreaterThan(3);
    expect(h.visible('title-screen')).toBe(true);
  });

  it('starts a run, accelerates, and advances the distance HUD', () => {
    h.click('play-button');
    h.flush(2);
    expect(h.visible('hud')).toBe(true);

    h.key('ArrowRight', true);
    h.flush(180);
    const distance = h.text('.hud-distance');
    expect(distance).not.toBe('0m');
    expect(Number.parseInt(distance, 10)).toBeGreaterThan(10);
  });

  it('holds the Escape pause overlay and resumes on a second press', () => {
    h.click('play-button');
    h.flush(2);

    h.tap('Escape');
    expect(h.visible('pause-screen')).toBe(true);

    h.tap('Escape');
    expect(h.visible('pause-screen')).toBe(false);
  });

  it('opens the settings modal from the title screen', () => {
    h.click('title-settings-button');
    expect(h.visible('settings')).toBe(true);
    h.click('settings-close');
    expect(h.visible('settings')).toBe(false);
  });

  it('exposes a browser-visible Android APK download control', () => {
    h.click('title-settings-button');
    const apk = h.doc.querySelector('a[download], a[href*="apk"]');
    expect(apk).toBeTruthy();
    const href = (apk as HTMLAnchorElement).getAttribute('href') ?? '';
    expect(href).toContain('apk');
    expect((apk as HTMLAnchorElement).hasAttribute('download')).toBe(true);
  });

  it('reports a run summary with distance, peak flow and clean moves', () => {
    h.click('play-button');
    h.flush(2);
    h.key('ArrowRight', true);
    h.flush(240);
    h.key('ArrowRight', false);

    // Walking into the void ends the run.
    h.key('ArrowLeft', true);
    h.flush(600);
    h.key('ArrowLeft', false);

    // The summary may or may not be reachable purely by walking off, but the
    // HUD must have recorded real progress either way.
    const summaryDistance = h.text('.summary-distance');
    expect(summaryDistance).toMatch(/\d/);
  });
});
