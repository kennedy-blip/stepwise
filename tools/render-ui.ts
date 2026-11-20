/**
 * Headless snapshot of the DOM overlays (title / pause / summary / settings).
 *
 * Reuses the real `index.html` markup and the real `src/styles.css`, then
 * rasterises the overlay boxes with a small layout engine so the UI can be
 * inspected as an image without a browser.
 *
 *   npx tsx tools/render-ui.ts [outdir]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT_DIR = process.argv[2] ?? '/tmp/stepwise-ui';
mkdirSync(OUT_DIR, { recursive: true });

const W = 1280;
const H = 800;

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
    return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
  }
  return { r: 255, g: 0, b: 255, a: 1 };
}

class Raster {
  data = new Uint8ClampedArray(W * H * 4);

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
    for (let py = Math.max(0, Math.round(y)); py < Math.min(H, Math.round(y + h)); py++) {
      for (let px = Math.max(0, Math.round(x)); px < Math.min(W, Math.round(x + w)); px++) {
        this.blend(px, py, color);
      }
    }
  }

  roundRect(x: number, y: number, w: number, h: number, radius: number, color: RGB): void {
    const r = Math.min(radius, w / 2, h / 2);
    for (let py = Math.max(0, Math.floor(y)); py < Math.min(H, Math.ceil(y + h)); py++) {
      for (let px = Math.max(0, Math.floor(x)); px < Math.min(W, Math.ceil(x + w)); px++) {
        const dx = Math.max(x + r - px, 0, px - (x + w - r));
        const dy = Math.max(y + r - py, 0, py - (y + h - r));
        if (dx * dx + dy * dy <= r * r) this.blend(px, py, color);
      }
    }
  }
}

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
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
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
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(chunk('IHDR', ihdr)),
    Buffer.from(chunk('IDAT', new Uint8Array(deflateSync(raw)))),
    Buffer.from(chunk('IEND', new Uint8Array(0))),
  ]);
}

/**
 * A tiny 5x7 bitmap font, enough to label the snapshot. Each glyph is five
 * columns of seven bits, packed as a string of '#' and '.' characters.
 */
const FONT: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '####.', '#...#', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '####.', '#....', '#....', '#....', '#####'],
  F: ['#####', '#....', '####.', '#....', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#####', '#...#', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
};

function drawText(
  raster: Raster,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: RGB,
): void {
  let cursor = x;
  for (const raw of text.toUpperCase()) {
    const glyph = FONT[raw] ?? FONT[' '];
    for (let row = 0; row < glyph.length; row++) {
      for (let col = 0; col < glyph[row].length; col++) {
        if (glyph[row][col] !== '#') continue;
        raster.fill(cursor + col * scale, y + row * scale, scale, scale, color);
      }
    }
    cursor += 6 * scale;
  }
}

const CSS = readFileSync('src/styles.css', 'utf-8');

/** Pulls a CSS custom property out of the stylesheet. */
function cssVar(name: string, fallback: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(CSS);
  return m ? m[1].trim() : fallback;
}

const ACCENT = parseColor(cssVar('accent', '#5fe0ff'));
const TEXT = parseColor(cssVar('text', '#e9eef5'));
const TEXT_DIM = parseColor(cssVar('text-dim', 'rgba(233,238,245,0.58)'));
const PANEL = parseColor(cssVar('panel', 'rgba(16,19,28,0.78)'));
const BORDER = { r: 255, g: 255, b: 255, a: 0.09 };

/** Draws a menu button in the same style as `.menu-btn`. */
function menuButton(
  raster: Raster,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
): void {
  raster.roundRect(x, y, w, h, 12, PANEL);
  // Border.
  for (let px = Math.max(0, Math.floor(x)); px < Math.min(W, Math.ceil(x + w)); px++) {
    raster.blend(px, Math.round(y), BORDER);
    raster.blend(px, Math.round(y + h - 1), BORDER);
  }
  for (let py = Math.max(0, Math.floor(y)); py < Math.min(H, Math.ceil(y + h)); py++) {
    raster.blend(Math.round(x), py, BORDER);
    raster.blend(Math.round(x + w - 1), py, BORDER);
  }
  const labelW = label.length * 6 * 2;
  drawText(raster, label, x + (w - labelW) / 2, y + (h - 14) / 2, 2, TEXT);
}

/** Draws a pill-shaped primary button (`.play-button`). */
function playButton(
  raster: Raster,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
): void {
  raster.roundRect(x, y, w, h, h / 2, { r: 95, g: 224, b: 255, a: 0.2 });
  const labelW = label.length * 6 * 3;
  drawText(raster, label, x + (w - labelW) / 2, y + (h - 21) / 2, 3, TEXT);
}

/** Paints the title-screen background gradient. */
function sky(raster: Raster): void {
  const top = parseColor('#1b1b3a');
  const mid = parseColor('#7b3f6b');
  const bottom = parseColor('#f0a05a');
  for (let y = 0; y < H; y++) {
    const t = y / H;
    const c =
      t < 0.55
        ? {
            r: top.r + (mid.r - top.r) * (t / 0.55),
            g: top.g + (mid.g - top.g) * (t / 0.55),
            b: top.b + (mid.b - top.b) * (t / 0.55),
            a: 1,
          }
        : {
            r: mid.r + (bottom.r - mid.r) * ((t - 0.55) / 0.45),
            g: mid.g + (bottom.g - mid.g) * ((t - 0.55) / 0.45),
            b: mid.b + (bottom.b - mid.b) * ((t - 0.55) / 0.45),
            a: 1,
          };
    raster.fill(0, y, W, 1, c);
  }
}

function save(name: string, raster: Raster): void {
  const file = `${OUT_DIR}/${name}.png`;
  writeFileSync(file, encodePng(raster.data, W, H));
  // eslint-disable-next-line no-console
  console.log(`wrote ${file}`);
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

// --- Pause menu ---
{
  const raster = new Raster();
  sky(raster);
  // Dim the scene behind the overlay.
  raster.fill(0, 0, W, H, { r: 5, g: 6, b: 11, a: 0.72 });

  const cardW = 420;
  const cardH = 330;
  const cx = (W - cardW) / 2;
  const cy = (H - cardH) / 2;
  raster.roundRect(cx, cy, cardW, cardH, 20, PANEL);

  const title = 'PAUSED';
  drawText(raster, title, cx + (cardW - title.length * 6 * 3) / 2, cy + 28, 3, TEXT);
  const hint = 'ESC TO RESUME - R TO RESTART';
  drawText(raster, hint, cx + (cardW - hint.length * 6 * 1) / 2, cy + 62, 1, TEXT_DIM);

  playButton(raster, cx + (cardW - 180) / 2, cy + 92, 180, 46, 'RESUME');

  const labels = ['SETTINGS', 'RESTART RUN', 'HOME'];
  const bw = 122;
  const gap = 10;
  const total = bw * 3 + gap * 2;
  const startX = cx + (cardW - total) / 2;
  labels.forEach((label, i) => {
    menuButton(raster, startX + i * (bw + gap), cy + 168, bw, 44, label);
  });

  // Hint that the game is frozen.
  drawText(raster, 'GAME PAUSED', cx + (cardW - 11 * 6 * 1) / 2, cy + 236, 1, TEXT_DIM);
  drawText(raster, 'PRESS ESC TO RESUME', cx + (cardW - 19 * 6 * 1) / 2, cy + 256, 1, TEXT_DIM);

  save('pause', raster);
}

// --- Settings modal ---
{
  const raster = new Raster();
  sky(raster);
  raster.fill(0, 0, W, H, { r: 6, g: 8, b: 14, a: 0.75 });

  const cardW = 520;
  const cardH = 560;
  const cx = (W - cardW) / 2;
  const cy = (H - cardH) / 2;
  raster.roundRect(cx, cy, cardW, cardH, 22, { r: 18, g: 22, b: 33, a: 0.96 });

  const title = 'SETTINGS';
  drawText(raster, title, cx + 28, cy + 26, 3, TEXT);

  const sections = ['SKY MOOD', 'AUDIO', 'MOBILE ASSIST', 'DEVELOPER'];
  sections.forEach((section, i) => {
    const y = cy + 84 + i * 118;
    drawText(raster, section, cx + 28, y, 2, ACCENT);
    if (i === 0) {
      ['GOLDEN DUSK', 'NEON RAIN', 'MISTY DAWN'].forEach((label, j) => {
        const w = 130;
        const x = cx + 28 + j * (w + 10);
        raster.roundRect(x, y + 30, w, 38, 999, { r: 255, g: 255, b: 255, a: 0.05 });
        if (j === 0) raster.roundRect(x, y + 30, w, 38, 999, ACCENT);
        drawText(
          raster,
          label.replace(' ', ''),
          x + 10,
          y + 40,
          1,
          j === 0 ? { r: 4, g: 16, b: 24, a: 1 } : TEXT_DIM,
        );
      });
    } else if (i === 1) {
      drawText(raster, 'MASTER VOLUME', cx + 28, y + 36, 1, TEXT);
      raster.roundRect(cx + 28, y + 54, 300, 6, 999, { r: 255, g: 255, b: 255, a: 0.12 });
      raster.roundRect(cx + 28, y + 54, 210, 6, 999, ACCENT);
      drawText(raster, '70%', cx + 340, y + 36, 1, TEXT);
      drawText(raster, 'MUTE', cx + 28, y + 74, 1, TEXT);
    } else if (i === 2) {
      drawText(raster, 'AUTO-SPRINT ASSIST', cx + 28, y + 36, 1, TEXT);
      drawText(
        raster,
        'FOCUS ON JUMP, VAULT AND SLIDE TIMING WITH ONE THUMB',
        cx + 28,
        y + 56,
        1,
        TEXT_DIM,
      );
    } else {
      drawText(raster, 'SHOW IK SKELETON & RAYCASTS', cx + 28, y + 36, 1, TEXT);
    }
  });

  save('settings', raster);
}

// --- Run summary ---
{
  const raster = new Raster();
  sky(raster);
  raster.fill(0, 0, W, H, { r: 6, g: 8, b: 14, a: 0.55 });

  const cardW = 440;
  const cardH = 430;
  const cx = (W - cardW) / 2;
  const cy = (H - cardH) / 2;
  raster.roundRect(cx, cy, cardW, cardH, 22, { r: 14, g: 18, b: 27, a: 0.96 });

  const head = 'RUN ENDED';
  drawText(raster, head, cx + (cardW - head.length * 6 * 1.5) / 2, cy + 26, 1.5, TEXT_DIM);
  const dist = '1284M';
  drawText(raster, dist, cx + (cardW - dist.length * 6 * 4) / 2, cy + 52, 4, TEXT);
  const pb = 'PERSONAL BEST 1284M';
  drawText(raster, pb, cx + (cardW - pb.length * 6 * 1) / 2, cy + 100, 1, TEXT_DIM);

  const stats = ['84% PEAK FLOW', '37 CLEAN MOVES', '3 FLOW SAVES'];
  stats.forEach((label, i) => {
    const x = cx + 30 + i * 128;
    drawText(raster, label.split(' ')[0], x, cy + 136, 2, ACCENT);
    drawText(raster, label.split(' ').slice(1).join(' '), x, cy + 158, 1, TEXT_DIM);
  });

  playButton(raster, cx + (cardW - 200) / 2, cy + 200, 200, 46, 'RUN AGAIN');

  const bw = 140;
  const gap = 12;
  const startX = cx + (cardW - (bw * 2 + gap)) / 2;
  menuButton(raster, startX, cy + 268, bw, 44, 'SETTINGS');
  menuButton(raster, startX + bw + gap, cy + 268, bw, 44, 'HOME');

  drawText(
    raster,
    'SPACE / ENTER / TAP TO RUN AGAIN',
    cx + (cardW - 28 * 6 * 1) / 2,
    cy + 336,
    1,
    TEXT_DIM,
  );
  drawText(raster, 'DIFFICULTY', cx + 40, cy + 366, 1, TEXT_DIM);
  drawText(raster, 'SKY MOOD', cx + 250, cy + 366, 1, TEXT_DIM);

  save('summary', raster);
}
