/**
 * Shared test helpers.
 *
 * happy-dom does not implement the Canvas 2D API, so tests that exercise
 * anything canvas-backed need a stub context. This module provides one,
 * along with a helper that installs a happy-dom window as the global
 * environment.
 */

import { Window } from 'happy-dom';

/**
 * Creates a no-op Canvas 2D context stub.
 *
 * It records nothing and draws nothing, but it exposes the full surface the
 * renderer touches so that code paths are exercised rather than skipped.
 */
export function makeCanvasContext(): Record<string, unknown> {
  const noop = (): void => undefined;
  return {
    canvas: { width: 1280, height: 720 },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    imageSmoothingEnabled: true,
    save: noop,
    restore: noop,
    scale: noop,
    translate: noop,
    rotate: noop,
    beginPath: noop,
    closePath: noop,
    clip: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    arcTo: noop,
    ellipse: noop,
    rect: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    fillText: noop,
    strokeText: noop,
    setLineDash: noop,
    getLineDash: () => [],
    drawImage: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    measureText: () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    putImageData: noop,
    createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  };
}

/**
 * Installs a happy-dom window as the global browser environment and stubs
 * `HTMLCanvasElement.prototype.getContext` so canvases yield a 2D context.
 *
 * Returns the window so callers can build their own markup, plus a cleanup
 * function that restores the previous globals.
 */
export function installDom(url = 'https://stepwise.test/'): {
  win: Window;
  cleanup: () => void;
} {
  const win = new Window({ url });
  const proto = win.HTMLCanvasElement.prototype as unknown as {
    getContext?: (id: string, opts?: unknown) => unknown;
  };
  const originalGetContext = proto.getContext;
  proto.getContext = function getContext(id: string, _opts?: unknown): unknown {
    if (id === '2d') return makeCanvasContext();
    // WebGL is intentionally NOT provided: this lets the presenter's
    // fallback path be exercised deterministically.
    return null;
  };

  const saved: Record<string, unknown> = {};
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLCanvasElement', 'HTMLInputElement', 'CustomEvent', 'Event'];
  for (const key of keys) {
    saved[key] = (globalThis as unknown as Record<string, unknown>)[key];
  }

  const define = (key: string, value: unknown): void => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  define('window', win);
  define('document', win.document);
  define('navigator', win.navigator);
  define('HTMLElement', win.HTMLElement);
  define('HTMLCanvasElement', win.HTMLCanvasElement);
  define('HTMLInputElement', win.HTMLInputElement);
  define('CustomEvent', win.CustomEvent);
  define('Event', win.Event);

  return {
    win,
    cleanup: () => {
      if (originalGetContext) proto.getContext = originalGetContext;
      for (const key of keys) {
        Object.defineProperty(globalThis, key, {
          value: saved[key],
          configurable: true,
          writable: true,
        });
      }
    },
  };
}
