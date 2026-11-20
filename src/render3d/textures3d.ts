/**
 * Procedural PBR textures.
 *
 * The project ships no image files: every map here is drawn into an offscreen
 * canvas at boot and uploaded as a `CanvasTexture`. That keeps the download
 * small enough to boot on mobile data and keeps the whole game offline-capable.
 *
 * Textures are generated lazily and cached, because a run only ever uses a
 * handful of them and regenerating them on every scene rebuild would cause a
 * visible hitch.
 */

import * as THREE from 'three';

const cache = new Map<string, THREE.Texture>();

/**
 * Creates an offscreen canvas for texture painting.
 *
 * Returns null when the environment cannot provide a 2D context (some
 * headless test environments cannot). Callers fall back to flat colours
 * rather than failing, because a missing texture must never stop the game.
 */
function makeCanvas(
  size: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    return { canvas, ctx };
  } catch {
    return null;
  }
}

/** Deterministic hash-based pseudo-random in [0,1). */
function rand(seed: number): number {
  const t = Math.sin(seed * 127.1) * 43758.5453;
  return t - Math.floor(t);
}

/**
 * Draws concrete grain: fine aggregate speckle plus broad blotches so the
 * surface reads as weathered poured concrete under a moving key light.
 */
function paintConcrete(ctx: CanvasRenderingContext2D, size: number, tint: string): void {
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, size, size);

  // Broad tonal blotches.
  for (let i = 0; i < 90; i++) {
    const x = rand(i * 3.1) * size;
    const y = rand(i * 7.7) * size;
    const r = 6 + rand(i * 11.3) * 34;
    const light = rand(i * 5.9) > 0.5;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, light ? 'rgba(255,255,255,0.055)' : 'rgba(0,0,0,0.07)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Fine aggregate speckle.
  for (let i = 0; i < 2600; i++) {
    const x = rand(i * 1.7) * size;
    const y = rand(i * 2.3) * size;
    const v = rand(i * 4.9);
    ctx.fillStyle = v > 0.5 ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.13)';
    ctx.fillRect(x, y, 1 + (v > 0.85 ? 1 : 0), 1 + (v > 0.85 ? 1 : 0));
  }

  // Faint pour seams.
  ctx.strokeStyle = 'rgba(0,0,0,0.14)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const p = (i / 4) * size;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
}

/** Draws brushed metal: directional streaks plus rivets. */
function paintMetal(ctx: CanvasRenderingContext2D, size: number, tint: string): void {
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, size, size);

  // Horizontal brushing.
  for (let i = 0; i < 700; i++) {
    const y = rand(i * 2.7) * size;
    const w = 20 + rand(i * 6.1) * size;
    const x = rand(i * 9.3) * size;
    ctx.strokeStyle = rand(i * 8.1) > 0.5 ? 'rgba(255,255,255,0.055)' : 'rgba(0,0,0,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.stroke();
  }

  // Rivet grid.
  for (let gx = 0; gx < 4; gx++) {
    for (let gy = 0; gy < 4; gy++) {
      const x = (gx + 0.5) * (size / 4);
      const y = (gy + 0.5) * (size / 4);
      const g = ctx.createRadialGradient(x - 1, y - 1, 0, x, y, 4);
      g.addColorStop(0, 'rgba(255,255,255,0.28)');
      g.addColorStop(1, 'rgba(0,0,0,0.3)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Draws rough roof gravel. */
function paintGravel(ctx: CanvasRenderingContext2D, size: number, tint: string): void {
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 2200; i++) {
    const x = rand(i * 1.3) * size;
    const y = rand(i * 2.9) * size;
    const r = 1 + rand(i * 5.7) * 2.6;
    const v = rand(i * 3.3);
    ctx.fillStyle = v > 0.55 ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.2)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Draws a glass facade: pane grid with a subtle reflection gradient. */
function paintGlass(ctx: CanvasRenderingContext2D, size: number, tint: string): void {
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, size, size);
  const sheen = ctx.createLinearGradient(0, 0, size, size);
  sheen.addColorStop(0, 'rgba(255,255,255,0.1)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
  sheen.addColorStop(1, 'rgba(120,190,230,0.07)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(180,220,255,0.14)';
  ctx.lineWidth = 2;
  for (let i = 1; i < 6; i++) {
    const p = (i / 6) * size;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
}

/** Draws wood planking. */
function paintWood(ctx: CanvasRenderingContext2D, size: number, tint: string): void {
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, size, size);
  const planks = 6;
  for (let p = 0; p < planks; p++) {
    const y = (p / planks) * size;
    const h = size / planks;
    ctx.fillStyle = `rgba(${p % 2 ? 255 : 0},${p % 2 ? 235 : 0},${p % 2 ? 205 : 0},${p % 2 ? 0.05 : 0.07})`;
    ctx.fillRect(0, y, size, h);
    // Grain.
    ctx.strokeStyle = 'rgba(0,0,0,0.16)';
    ctx.lineWidth = 1;
    for (let g = 0; g < 7; g++) {
      const gy = y + rand(p * 13.7 + g * 2.3) * h;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.bezierCurveTo(
        size * 0.3,
        gy + rand(g * 5.1) * 4 - 2,
        size * 0.7,
        gy + rand(g * 7.7) * 4 - 2,
        size,
        gy,
      );
      ctx.stroke();
    }
    // Plank separation.
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, y + h - 2, size, 2);
  }
}

/**
 * Paints an emissive grid of lit apartment windows for the background city.
 */
function paintWindows(
  ctx: CanvasRenderingContext2D,
  size: number,
  cols: number,
  rows: number,
  color: string,
  density: number,
): void {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);
  const cw = size / cols;
  const ch = size / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const seed = rand(r * 31.7 + c * 11.3);
      if (seed > density) continue;
      const bright = 0.45 + rand(r * 3.1 + c * 7.9) * 0.55;
      ctx.globalAlpha = bright;
      ctx.fillStyle = color;
      const pad = cw * 0.22;
      ctx.fillRect(c * cw + pad, r * ch + ch * 0.2, cw - pad * 2, ch * 0.5);
    }
  }
  ctx.globalAlpha = 1;
}

type Painter = (ctx: CanvasRenderingContext2D, size: number) => void;

function buildTexture(key: string, size: number, painter: Painter): THREE.Texture {
  const cached = cache.get(key);
  if (cached) return cached;

  const made = makeCanvas(size);
  let tex: THREE.Texture;
  if (made) {
    painter(made.ctx, size);
    tex = new THREE.CanvasTexture(made.canvas);
  } else {
    // No 2D context available: fall back to a 1x1 white texture so the
    // material still renders, just without procedural detail.
    tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  }
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

/** Concrete colour map. */
export function concreteTexture(tint = '#3a3f4d'): THREE.Texture {
  return buildTexture(`concrete-${tint}`, 256, (ctx, size) => paintConcrete(ctx, size, tint));
}

/** Concrete roughness map — rougher in the blotches. */
export function concreteRoughness(): THREE.Texture {
  return buildTexture('concrete-rough', 256, (ctx, size) => {
    ctx.fillStyle = '#c8c8c8';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 120; i++) {
      const x = rand(i * 3.1) * size;
      const y = rand(i * 7.7) * size;
      const r = 8 + rand(i * 11.3) * 40;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const v = rand(i * 5.9) > 0.5 ? 255 : 150;
      g.addColorStop(0, `rgba(${v},${v},${v},0.3)`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 2400; i++) {
      const x = rand(i * 1.7) * size;
      const y = rand(i * 2.3) * size;
      ctx.fillStyle = rand(i * 4.9) > 0.5 ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.16)';
      ctx.fillRect(x, y, 1.5, 1.5);
    }
  });
}

/** Brushed metal colour map. */
export function metalTexture(tint = '#59616f'): THREE.Texture {
  return buildTexture(`metal-${tint}`, 256, (ctx, size) => paintMetal(ctx, size, tint));
}

/** Brushed metal roughness map — mostly smooth with streaks. */
export function metalRoughness(): THREE.Texture {
  return buildTexture('metal-rough', 256, (ctx, size) => {
    ctx.fillStyle = '#6a6a6a';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 600; i++) {
      const y = rand(i * 2.7) * size;
      const w = 20 + rand(i * 6.1) * size;
      const x = rand(i * 9.3) * size;
      ctx.strokeStyle = rand(i * 8.1) > 0.5 ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y);
      ctx.stroke();
    }
  });
}

/** Roof gravel colour map. */
export function gravelTexture(tint = '#2f333d'): THREE.Texture {
  return buildTexture(`gravel-${tint}`, 256, (ctx, size) => paintGravel(ctx, size, tint));
}

/** Glass façade colour map. */
export function glassTexture(tint = '#1d2a38'): THREE.Texture {
  return buildTexture(`glass-${tint}`, 256, (ctx, size) => paintGlass(ctx, size, tint));
}

/** Wood plank colour map. */
export function woodTexture(tint = '#4a382c'): THREE.Texture {
  return buildTexture(`wood-${tint}`, 256, (ctx, size) => paintWood(ctx, size, tint));
}

/**
 * Skin tone map for the runner's face, hands and forearms.
 *
 * A flat colour reads as plastic under a moving key light. A faint
 * mottling gives the surface something to catch, which is what makes skin
 * look like skin rather than painted plastic.
 */
export function skinTexture(tint = '#c98d6b'): THREE.Texture {
  return buildTexture(`skin-${tint}`, 128, (ctx, size) => {
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, size, size);
    // Soft blotches of slightly varied tone.
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = 3 + Math.random() * 11;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const light = Math.random() > 0.5;
      g.addColorStop(0, light ? 'rgba(255,225,205,0.16)' : 'rgba(120,70,50,0.14)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
}

/**
 * Woven fabric map for the runner's clothing.
 *
 * A fine cross-hatch keeps the jacket and trousers from looking like flat
 * coloured plastic when the runner turns through the key light.
 */
export function fabricTexture(tint = '#1a1d27'): THREE.Texture {
  return buildTexture(`fabric-${tint}`, 128, (ctx, size) => {
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.lineWidth = 1;
    for (let i = 0; i < size; i += 3) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, size);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.10)';
    for (let i = 0; i < size; i += 3) {
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(size, i);
      ctx.stroke();
    }
    // A few darker fibres for grain.
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    for (let i = 0; i < 400; i++) {
      ctx.fillRect(Math.random() * size, Math.random() * size, 1, 1);
    }
  });
}

/**
 * Emissive window grid for the background city, tinted per sky mood.
 */
export function windowTexture(color: string, density: number, key: string): THREE.Texture {
  return buildTexture(`windows-${key}`, 128, (ctx, size) =>
    paintWindows(ctx, size, 8, 12, color, density),
  );
}

/**
 * Building facade for the near face of a rooftop block.
 *
 * The playable slabs are extruded boxes. Seen from the front, their side
 * faces are a large flat area of concrete, which is exactly what makes a
 * rooftop read as a grey plank instead of the top of a real building.
 *
 * This map paints that face as a facade: a concrete ground floor, rows of
 * windows in recessed dark frames, a horizontal floor band between each
 * row, and the occasional lit room. It is used on the front and back faces
 * of the slab, so the roof block reads as a tower from any angle.
 */
export function facadeTexture(tint = '#2c313c'): THREE.Texture {
  return buildTexture(`facade-${tint}`, 512, (ctx, size) => {
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, size, size);

    // Ground floor: a plinth of darker stone.
    const plinth = Math.round(size * 0.14);
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.fillRect(0, size - plinth, size, plinth);

    // Window rows.
    const rows = 6;
    const cols = 10;
    const top = size * 0.06;
    const rowH = (size - plinth - top) / rows;
    const colW = size / cols;

    for (let r = 0; r < rows; r++) {
      const y = top + r * rowH;

      // Floor band between rows.
      ctx.fillStyle = 'rgba(255,255,255,0.055)';
      ctx.fillRect(0, y + rowH - 3, size, 3);

      for (let c = 0; c < cols; c++) {
        const x = c * colW;
        const padX = colW * 0.22;
        const padY = rowH * 0.24;
        const w = colW - padX * 2;
        const h = rowH - padY * 2;

        // Recessed frame.
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(x + padX - 2, y + padY - 2, w + 4, h + 4);

        // Glass. Most rooms are dark; a few are lit.
        const seed = rand(r * 13.7 + c * 3.3);
        if (seed > 0.76) {
          ctx.fillStyle = 'rgba(255,206,140,0.62)';
        } else if (seed > 0.4) {
          ctx.fillStyle = 'rgba(120,160,200,0.2)';
        } else {
          ctx.fillStyle = 'rgba(16,22,32,0.86)';
        }
        ctx.fillRect(x + padX, y + padY, w, h);

        // A thin mullion splits each window.
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(x + padX + w / 2 - 1, y + padY, 2, h);
      }
    }

    // Vertical grime streaks, so the facade is not perfectly clean.
    for (let i = 0; i < 60; i++) {
      const x = rand(i * 5.3) * size;
      const w = 1 + rand(i * 7.1) * 4;
      const g = ctx.createLinearGradient(0, 0, 0, size);
      g.addColorStop(0, 'rgba(0,0,0,0.22)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, w, size);
    }
  });
}

/** Disposes every cached texture. Used on teardown. */
export function disposeTextures(): void {
  for (const tex of cache.values()) tex.dispose();
  cache.clear();
}
