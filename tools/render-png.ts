/**
 * Headless PNG snapshot of the real game.
 *
 * Runs the real simulation and the real `Renderer` against a minimal
 * Canvas2D implementation that records draw commands, then rasterises them
 * into a PNG so the rendering can be inspected without a browser.
 *
 *   npx tsx tools/render-png.ts [outfile.png] [frames] [mood] [difficulty]
 */

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { World } from '../src/game/world';
import { Renderer } from '../src/render/renderer';
import type { Difficulty, SkyMood } from '../src/core/types';
import { Autopilot } from './autopilot';

const OUT = process.argv[2] ?? 'scene.png';
const FRAMES = Number(process.argv[3] ?? 900);
const MOOD = (process.argv[4] ?? 'dusk') as SkyMood;
const DIFFICULTY = (process.argv[5] ?? 'medium') as Difficulty;

const W = 1280;
const H = 720;

// ---------------------------------------------------------------------------
// Minimal Canvas2D implementation that rasterises into an RGBA buffer.
// ---------------------------------------------------------------------------

interface RGB {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(value: unknown): RGB {
  if (typeof value !== 'string') return { r: 0, g: 0, b: 0, a: 1 };
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split('')
            .map((c) => c + c)
            .join('')
        : hex.slice(0, 6);
    const r = parseInt(full.slice(0, 2), 16) || 0;
    const g = parseInt(full.slice(2, 4), 16) || 0;
    const b = parseInt(full.slice(4, 6), 16) || 0;
    const a = hex.length === 8 ? (parseInt(full.slice(6, 8), 16) || 255) / 255 : 1;
    return { r, g, b, a };
  }
  const m = /rgba?\(([^)]+)\)/.exec(value);
  if (m) {
    const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
    return {
      r: parts[0] ?? 0,
      g: parts[1] ?? 0,
      b: parts[2] ?? 0,
      a: parts[3] ?? 1,
    };
  }
  return { r: 255, g: 0, b: 255, a: 1 };
}

class Raster {
  data = new Uint8ClampedArray(W * H * 4);

  /**
   * Active clip rectangle in device pixels. The renderer only ever clips with
   * axis-aligned rectangles, so a bounding-box clip is exact and keeps this
   * offline renderer honest about what the browser actually shows.
   */
  clipRect: { x0: number; y0: number; x1: number; y1: number } | null = null;

  blend(x: number, y: number, color: RGB): void {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    const a = Math.max(0, Math.min(1, color.a));
    this.data[i] = this.data[i] * (1 - a) + color.r * a;
    this.data[i + 1] = this.data[i + 1] * (1 - a) + color.g * a;
    this.data[i + 2] = this.data[i + 2] * (1 - a) + color.b * a;
    this.data[i + 3] = 255;
  }

  fill(x: number, y: number, w: number, h: number, color: RGB): void {
    let x0 = Math.max(0, Math.round(x));
    let y0 = Math.max(0, Math.round(y));
    let x1 = Math.min(W, Math.round(x + w));
    let y1 = Math.min(H, Math.round(y + h));
    if (this.clipRect) {
      x0 = Math.max(x0, this.clipRect.x0);
      y0 = Math.max(y0, this.clipRect.y0);
      x1 = Math.min(x1, this.clipRect.x1);
      y1 = Math.min(y1, this.clipRect.y1);
    }
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        this.blend(px, py, color);
      }
    }
  }

  /** Fills a polygon using the even-odd rule with 4x vertical supersampling. */
  fillPolygon(points: { x: number; y: number }[], color: RGB): void {
    if (points.length < 3) return;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const pt of points) {
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(H - 1, Math.ceil(maxY));
    const SS = 4;
    for (let py = y0; py <= y1; py++) {
      for (let s = 0; s < SS; s++) {
        const sy = py + (s + 0.5) / SS;
        const xs: number[] = [];
        for (let i = 0; i < points.length; i++) {
          const a = points[i];
          const b = points[(i + 1) % points.length];
          if (a.y === b.y) continue;
          if (sy >= Math.min(a.y, b.y) && sy < Math.max(a.y, b.y)) {
            xs.push(a.x + ((sy - a.y) / (b.y - a.y)) * (b.x - a.x));
          }
        }
        xs.sort((p, q) => p - q);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const xa = Math.round(xs[i]);
          const xb = Math.round(xs[i + 1]);
          for (let px = xa; px < xb; px++) this.blend(px, py, color);
        }
      }
    }
  }

  strokePolyline(points: { x: number; y: number }[], color: RGB, width: number): void {
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.001) continue;
      const steps = Math.ceil(len * 2);
      const half = Math.max(0.5, width / 2);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const cx = a.x + dx * t;
        const cy = a.y + dy * t;
        const r = Math.ceil(half);
        for (let oy = -r; oy <= r; oy++) {
          for (let ox = -r; ox <= r; ox++) {
            if (ox * ox + oy * oy > half * half + 0.4) continue;
            this.blend(Math.round(cx + ox), Math.round(cy + oy), color);
          }
        }
      }
    }
  }
}

const raster = new Raster();

interface GradientStop {
  offset: number;
  color: RGB;
}

/** A linear or radial gradient that can be sampled at a point. */
class Gradient {
  stops: GradientStop[] = [];
  constructor(
    private readonly kind: 'linear' | 'radial',
    private readonly x0: number,
    private readonly y0: number,
    private readonly x1: number,
    private readonly y1: number,
    /** Outer radius for a radial gradient. */
    private readonly radius: number,
  ) {}

  addColorStop(offset: number, color: string): void {
    this.stops.push({ offset, color: parseColor(color) });
    this.stops.sort((a, b) => a.offset - b.offset);
  }

  at(x: number, y: number): RGB {
    if (this.stops.length === 0) return { r: 0, g: 0, b: 0, a: 1 };
    let t: number;
    if (this.kind === 'linear') {
      const dx = this.x1 - this.x0;
      const dy = this.y1 - this.y0;
      const len2 = dx * dx + dy * dy;
      t = len2 === 0 ? 0 : ((x - this.x0) * dx + (y - this.y0) * dy) / len2;
    } else {
      const d = Math.hypot(x - this.x0, y - this.y0);
      t = this.radius === 0 ? 0 : d / this.radius;
    }
    t = Math.max(0, Math.min(1, t));
    let lo = this.stops[0];
    let hi = this.stops[this.stops.length - 1];
    for (let i = 0; i < this.stops.length - 1; i++) {
      if (t >= this.stops[i].offset && t <= this.stops[i + 1].offset) {
        lo = this.stops[i];
        hi = this.stops[i + 1];
        break;
      }
    }
    const span = hi.offset - lo.offset;
    const k = span <= 0 ? 0 : (t - lo.offset) / span;
    return {
      r: lo.color.r + (hi.color.r - lo.color.r) * k,
      g: lo.color.g + (hi.color.g - lo.color.g) * k,
      b: lo.color.b + (hi.color.b - lo.color.b) * k,
      a: lo.color.a + (hi.color.a - lo.color.a) * k,
    };
  }
}

function pointInPolygon(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function makeContext(): Record<string, unknown> {
  let fillStyle: unknown = '#000';
  let strokeStyle: unknown = '#000';
  let globalAlpha = 1;
  let lineWidth = 1;

  // Path state.
  const subPaths: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];

  // Transform matrix [a, b, c, d, e, f] applied as
  //   x' = a*x + c*y + e
  //   y' = b*x + d*y + f
  let m: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
  const stack: (typeof m)[] = [];
  const clipStack: (typeof raster.clipRect)[] = [];

  const apply = (x: number, y: number): { x: number; y: number } => ({
    x: m[0] * x + m[2] * y + m[4],
    y: m[1] * x + m[3] * y + m[5],
  });

  const multiply = (n: [number, number, number, number, number, number]): void => {
    const [a, b, c, d, e, f] = m;
    const [A, B, C, D, E, F] = n;
    m = [
      a * A + c * B,
      b * A + d * B,
      a * C + c * D,
      b * C + d * D,
      a * E + c * F + e,
      b * E + d * F + f,
    ];
  };

  const ctx: Record<string, unknown> = {
    canvas: { width: W, height: H },
    save() {
      stack.push([...m] as typeof m);
      clipStack.push(raster.clipRect);
    },
    restore() {
      const prev = stack.pop();
      if (prev) m = prev;
      const clip = clipStack.pop();
      raster.clipRect = clip === undefined ? null : clip;
    },
    scale(x: number, y: number) {
      multiply([x, 0, 0, y, 0, 0]);
    },
    rotate(angle: number) {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      multiply([c, s, -s, c, 0, 0]);
    },
    translate(x: number, y: number) {
      multiply([1, 0, 0, 1, x, y]);
    },
    transform(a: number, b: number, c: number, d: number, e: number, f: number) {
      multiply([a, b, c, d, e, f]);
    },
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
      m = [a, b, c, d, e, f];
    },
    resetTransform() {
      m = [1, 0, 0, 1, 0, 0];
    },
    beginPath() {
      subPaths.length = 0;
      current = [];
    },
    closePath() {
      if (current.length > 1) {
        current.push({ x: current[0].x, y: current[0].y });
      }
    },
    moveTo(x: number, y: number) {
      if (current.length > 0) subPaths.push(current);
      current = [apply(x, y)];
    },
    lineTo(x: number, y: number) {
      current.push(apply(x, y));
    },
    arc(cx: number, cy: number, r: number, a0: number, a1: number) {
      const steps = Math.max(6, Math.ceil(Math.abs(a1 - a0) * 12));
      for (let i = 0; i <= steps; i++) {
        const a = a0 + ((a1 - a0) * i) / steps;
        const pt = apply(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        if (current.length === 0) current.push(pt);
        else current.push(pt);
      }
    },
    arcTo() {},
    ellipse(cx: number, cy: number, rx: number, ry: number, rot: number, a0: number, a1: number) {
      const steps = Math.max(8, Math.ceil(Math.abs(a1 - a0) * 12));
      for (let i = 0; i <= steps; i++) {
        const a = a0 + ((a1 - a0) * i) / steps;
        current.push(
          apply(
            cx + Math.cos(a) * rx * Math.cos(rot) - Math.sin(a) * ry * Math.sin(rot),
            cy + Math.cos(a) * rx * Math.sin(rot) + Math.sin(a) * ry * Math.cos(rot),
          ),
        );
      }
    },
    rect(x: number, y: number, w: number, h: number) {
      const pts = [apply(x, y), apply(x + w, y), apply(x + w, y + h), apply(x, y + h)];
      pts.push(pts[0]);
      subPaths.push(pts);
      current = [];
    },
    quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
      const from = current[current.length - 1] ?? apply(cx, cy);
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        const mt = 1 - t;
        current.push(
          apply(
            mt * mt * from.x + 2 * mt * t * cx + t * t * x,
            mt * mt * from.y + 2 * mt * t * cy + t * t * y,
          ),
        );
      }
    },
    bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) {
      const from = current[current.length - 1] ?? apply(c1x, c1y);
      for (let i = 1; i <= 10; i++) {
        const t = i / 10;
        const mt = 1 - t;
        current.push(
          apply(
            mt ** 3 * from.x + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t ** 3 * x,
            mt ** 3 * from.y + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t ** 3 * y,
          ),
        );
      }
    },
    clip() {
      // Approximate the clip with the bounding box of the current path. Every
      // clip in the renderer is an axis-aligned rectangle, so this matches the
      // browser exactly for the shapes we actually use.
      const parts = current.length > 0 ? [...subPaths, current] : subPaths;
      if (parts.length === 0) {
        raster.clipRect = null;
        return;
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const part of parts) {
        for (const p of part) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
      }
      raster.clipRect = {
        x0: Math.max(0, Math.floor(minX)),
        y0: Math.max(0, Math.floor(minY)),
        x1: Math.min(W, Math.ceil(maxX)),
        y1: Math.min(H, Math.ceil(maxY)),
      };
    },
    fill() {
      const parts = current.length > 0 ? [...subPaths, current] : subPaths;
      for (const part of parts) {
        if (part.length < 3) continue;
        if (fillStyle instanceof Gradient) {
          // Rasterise the gradient across the polygon's bounding box.
          let minX = Infinity;
          let maxX = -Infinity;
          let minY = Infinity;
          let maxY = -Infinity;
          for (const pt of part) {
            minX = Math.min(minX, pt.x);
            maxX = Math.max(maxX, pt.x);
            minY = Math.min(minY, pt.y);
            maxY = Math.max(maxY, pt.y);
          }
          for (let py = Math.max(0, Math.floor(minY)); py < Math.min(H, Math.ceil(maxY)); py++) {
            for (let px = Math.max(0, Math.floor(minX)); px < Math.min(W, Math.ceil(maxX)); px++) {
              if (pointInPolygon(px + 0.5, py + 0.5, part)) {
                const c = fillStyle.at(px + 0.5, py + 0.5);
                c.a *= globalAlpha;
                raster.blend(px, py, c);
              }
            }
          }
        } else {
          const c = parseColor(fillStyle);
          c.a *= globalAlpha;
          raster.fillPolygon(part, c);
        }
      }
      current = [];
    },
    stroke() {
      const parts = current.length > 0 ? [...subPaths, current] : subPaths;
      for (const part of parts) {
        const c = parseColor(strokeStyle);
        c.a *= globalAlpha;
        raster.strokePolyline(part, c, lineWidth);
      }
      current = [];
    },
    fillText() {},
    strokeText() {},
    drawImage() {},
    setLineDash() {},
    measureText: (t: string) => ({ width: t.length * 6 }),
    createLinearGradient: (x0: number, y0: number, x1: number, y1: number) =>
      new Gradient('linear', x0, y0, x1, y1, 0),
    // createRadialGradient(x0, y0, r0, x1, y1, r1): the inner circle is
    // (x0, y0) with radius r0, the outer circle is (x1, y1) with radius r1.
    createRadialGradient: (
      x0: number,
      y0: number,
      r0: number,
      x1: number,
      y1: number,
      r1: number,
    ) => new Gradient('radial', x0, y0, x0, y0, r1),
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData() {},
  };

  Object.defineProperty(ctx, 'fillStyle', {
    get: () => fillStyle,
    set: (v: unknown) => {
      fillStyle = v;
    },
  });
  Object.defineProperty(ctx, 'strokeStyle', {
    get: () => strokeStyle,
    set: (v: unknown) => {
      strokeStyle = v;
    },
  });
  Object.defineProperty(ctx, 'globalAlpha', {
    get: () => globalAlpha,
    set: (v: number) => {
      globalAlpha = v;
    },
  });
  Object.defineProperty(ctx, 'lineWidth', {
    get: () => lineWidth,
    set: (v: number) => {
      lineWidth = v;
    },
  });
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.globalCompositeOperation = 'source-over';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowBlur = 0;
  ctx.shadowColor = '';
  ctx.filter = 'none';
  ctx.imageSmoothingEnabled = true;

  // Fill a rectangle with the current fill style.
  ctx.fillRect = (x: number, y: number, w: number, h: number) => {
    if (fillStyle instanceof Gradient) {
      let x0 = Math.max(0, Math.round(x));
      let y0 = Math.max(0, Math.round(y));
      let x1 = Math.min(W, Math.round(x + w));
      let y1 = Math.min(H, Math.round(y + h));
      if (raster.clipRect) {
        x0 = Math.max(x0, raster.clipRect.x0);
        y0 = Math.max(y0, raster.clipRect.y0);
        x1 = Math.min(x1, raster.clipRect.x1);
        y1 = Math.min(y1, raster.clipRect.y1);
      }
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const c = fillStyle.at(px + 0.5, py + 0.5);
          c.a *= globalAlpha;
          raster.blend(px, py, c);
        }
      }
      return;
    }
    const c = parseColor(fillStyle);
    c.a *= globalAlpha;
    raster.fill(x, y, w, h, c);
  };
  ctx.clearRect = (x: number, y: number, w: number, h: number) => {
    raster.fill(x, y, w, h, { r: 0, g: 0, b: 0, a: 0 });
  };
  ctx.strokeRect = (x: number, y: number, w: number, h: number) => {
    const c = parseColor(strokeStyle);
    c.a *= globalAlpha;
    raster.fill(x, y, w, lineWidth, c);
    raster.fill(x, y + h - lineWidth, w, lineWidth, c);
    raster.fill(x, y, lineWidth, h, c);
    raster.fill(x + w - lineWidth, y, lineWidth, h, c);
  };

  return ctx;
}

// ---------------------------------------------------------------------------
// PNG encoding (RGBA, no filtering).
// ---------------------------------------------------------------------------

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

function encodePng(rgba: Uint8ClampedArray, width: number, height: number): Buffer {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(chunk('IHDR', ihdr)),
    Buffer.from(chunk('IDAT', new Uint8Array(deflateSync(raw)))),
    Buffer.from(chunk('IEND', new Uint8Array(0))),
  ]);
}

// ---------------------------------------------------------------------------
// Run the simulation and render the final frame.
// ---------------------------------------------------------------------------

const world = new World({ difficulty: DIFFICULTY, seed: 20240517 });
world.start();
const pilot = new Autopilot(world);

const canvas = {
  width: W,
  height: H,
  getBoundingClientRect: () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: W,
    bottom: H,
    width: W,
    height: H,
  }),
} as unknown as HTMLCanvasElement;
const ctx = makeContext();
Object.defineProperty(canvas, 'getContext', { value: () => ctx, configurable: true });
Object.defineProperty(canvas, 'width', { value: W, writable: true, configurable: true });
Object.defineProperty(canvas, 'height', { value: H, writable: true, configurable: true });

const renderer = new Renderer(canvas);

for (let i = 0; i < FRAMES; i++) {
  const input = pilot.step();
  world.currentInput = {
    moveX: input.moveX,
    jumpHeld: input.jumpHeld,
    jumpPressed: input.jumpPressed,
    crouchHeld: input.crouchHeld,
    crouchPressed: input.crouchPressed,
  };
  world.update(1 / 60);
  if (world.outcome === 'dead') break;
}

renderer.render(world, { showDebug: process.env.SW_DEBUG !== '0', skyMood: MOOD });

writeFileSync(OUT, encodePng(raster.data, W, H));
// eslint-disable-next-line no-console
console.log(
  `wrote ${OUT} (${W}x${H}) mood=${MOOD} difficulty=${DIFFICULTY} ` +
    `x=${world.player.x.toFixed(0)} distance=${world.stats.distance.toFixed(1)}m ` +
    `flow=${world.flow.value.toFixed(0)} outcome=${world.outcome}`,
);
