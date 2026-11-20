/**
 * Headless software-rasterised preview of the 3D scene.
 *
 * The real `World3D`, `Humanoid3D`, `Camera3D` and `LightingRig` build a
 * Three.js scene graph, but drawing needs a GPU. This tool walks the scene
 * with the real camera, projects every mesh's corners with the real
 * perspective matrix, and rasterises the resulting triangles with a simple
 * z-buffered flat-shade fill. It is not a substitute for the browser, but
 * it is enough to judge composition, framing and silhouette.
 *
 *   npx tsx tools/preview3d.ts [outfile.png] [mood] [frames]
 */

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import * as THREE from 'three';
import { createCanvas } from '@napi-rs/canvas';
import { World } from '../src/game/world';
import { World3D } from '../src/render3d/world3d';
import { Humanoid3D } from '../src/render3d/humanoid3d';
import { Camera3D } from '../src/render3d/camera3d';
import { LightingRig } from '../src/render3d/lighting3d';
import type { SkyMood } from '../src/core/types';
import { Autopilot } from './autopilot';

const OUT = process.argv[2] ?? 'preview3d.png';
const MOOD = (process.argv[3] ?? 'dusk') as SkyMood;
const FRAMES = Number(process.argv[4] ?? 240);

const W = 1280;
const H = 720;

// ---------------------------------------------------------------------------
// Canvas backend
//
// The procedural textures are drawn into a 2D canvas. Node has no DOM, so
// the preview installs a small shim that hands out @napi-rs/canvas
// surfaces. This is preview-only tooling and is never bundled.
// ---------------------------------------------------------------------------

const doc = {
  createElement(tag: string): unknown {
    if (tag !== 'canvas') throw new Error(`preview shim only supports canvas`);
    return createCanvas(512, 512);
  },
};
(globalThis as unknown as { document: unknown }).document = doc;

// ---------------------------------------------------------------------------
// PNG writer
// ---------------------------------------------------------------------------

function crc32(buf: Uint8Array): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function writePng(path: string, rgba: Uint8Array, w: number, h: number): void {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
  writeFileSync(path, png);
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const world = new World({ difficulty: 'medium', seed: 20240 });
world.start();

const scene = new THREE.Scene();
const lighting = new LightingRig(scene);
lighting.apply(MOOD);

const camera3d = new Camera3D(W / H);
const world3d = new World3D();
world3d.build();
scene.add(world3d.group);

const humanoid = new Humanoid3D();
scene.add(humanoid.group);

const autopilot = new Autopilot(world);
for (let i = 0; i < FRAMES; i++) {
  world.currentInput = autopilot.step(1 / 60);
  world.update(1 / 60);
  world3d.sync(world.terrain, world.player.x);
  humanoid.update(world.player.rig, world.flow.tier);
  camera3d.update(world.player.x, world.player.y, world.flow.tier, 1 / 60);
  lighting.followSun(world.player.x / 40, -(world.player.y / 40));
}

// Fog is part of the scene; the preview applies it so the depth cue the
// player will actually see is present in the snapshot.
const fog = scene.fog as THREE.FogExp2 | null;

const camera = camera3d.camera;
camera.updateMatrixWorld(true);
camera.updateProjectionMatrix();

const camPos = new THREE.Vector3();
camera.getWorldPosition(camPos);

// Collect drawable triangles.
interface Tri {
  pts: { x: number; y: number; z: number }[];
  uvs: [number, number][];
  color: [number, number, number];
  sampler: TexSampler | null;
  /** Base colour multiplied by the texture sample. */
  tint: [number, number, number];
  /** How much the texture modulates the base colour. */
  texMix: number;
  /** Distance from the camera, in metres. */
  dist: number;
  /** Straight alpha, used by the translucent haze layers. */
  alpha: number;
}

// ---------------------------------------------------------------------------
// Texture sampling
// ---------------------------------------------------------------------------

interface TexSampler {
  size: number;
  data: Uint8ClampedArray;
}

const texCache = new Map<string, TexSampler | null>();

function samplerFor(tex: THREE.Texture | null | undefined): TexSampler | null {
  if (!tex) return null;
  const img = (tex as unknown as { image?: unknown }).image;
  if (!img || typeof img !== 'object') return null;
  const canvas = img as { width: number; height: number; getContext: (t: string) => unknown };
  if (!canvas.getContext) return null;
  const key = `${tex.uuid}`;
  if (texCache.has(key)) return texCache.get(key) ?? null;
  let result: TexSampler | null = null;
  try {
    const ctx = canvas.getContext('2d') as {
      getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray };
    };
    const size = canvas.width;
    const data = ctx.getImageData(0, 0, size, size).data;
    result = { size, data };
  } catch {
    result = null;
  }
  texCache.set(key, result);
  return result;
}

function sampleTex(sampler: TexSampler, u: number, v: number): [number, number, number] {
  const { size, data } = sampler;
  let x = Math.floor((((u % 1) + 1) % 1) * size);
  let y = Math.floor((((v % 1) + 1) % 1) * size);
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x >= size) x = size - 1;
  if (y >= size) y = size - 1;
  const o = (y * size + x) * 4;
  return [data[o] / 255, data[o + 1] / 255, data[o + 2] / 255];
}

const tris: Tri[] = [];
const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const vC = new THREE.Vector3();
const mid = new THREE.Vector3();
const nrm = new THREE.Vector3();
const e1 = new THREE.Vector3();
const e2 = new THREE.Vector3();
const sunDir = new THREE.Vector3();
lighting.sun.getWorldPosition(sunDir);
sunDir.sub(camPos).normalize();

// The rim light comes from behind and above, opposite the key.
const rimDir = new THREE.Vector3();
lighting.rim.getWorldPosition(rimDir);
rimDir.sub(camPos).normalize();

const sunColor = new THREE.Color(lighting.sun.color.getHex());
const hemiSky = new THREE.Color(lighting.hemisphere.color.getHex());
const hemiGround = new THREE.Color(lighting.hemisphere.groundColor.getHex());
const hemiIntensity = lighting.hemisphere.intensity;
const sunIntensity = lighting.sun.intensity;
const rimColor = new THREE.Color(lighting.rim.color.getHex());
const rimIntensity = lighting.rim.intensity;

scene.updateMatrixWorld(true);

/**
 * Approximates Three.js's standard-material lighting: a hemisphere fill
 * (sky above, ground below), a directional key with a wrapped diffuse
 * term, and a directional rim from behind.
 */
function shade(
  color: THREE.Color,
  worldNormal: THREE.Vector3,
  emissive: number,
): [number, number, number] {
  const n = worldNormal;

  // Hemisphere: lerp ground -> sky by the normal's Y.
  const t = n.y * 0.5 + 0.5;
  let r = (hemiGround.r + (hemiSky.r - hemiGround.r) * t) * hemiIntensity;
  let g = (hemiGround.g + (hemiSky.g - hemiGround.g) * t) * hemiIntensity;
  let b = (hemiGround.b + (hemiSky.b - hemiGround.b) * t) * hemiIntensity;

  // Key light, with a wrapped diffuse so the terminator is soft.
  const ndl = (n.dot(sunDir) + 0.35) / 1.35;
  if (ndl > 0) {
    r += sunColor.r * sunIntensity * ndl;
    g += sunColor.g * sunIntensity * ndl;
    b += sunColor.b * sunIntensity * ndl;
  }

  // Rim light from behind.
  const ndr = Math.max(0, n.dot(rimDir));
  r += rimColor.r * rimIntensity * ndr * ndr;
  g += rimColor.g * rimIntensity * ndr * ndr;
  b += rimColor.b * rimIntensity * ndr * ndr;

  return [
    Math.min(255, color.r * r * 255 + emissive * 255),
    Math.min(255, color.g * g * 255 + emissive * 255),
    Math.min(255, color.b * b * 255 + emissive * 255),
  ];
}

scene.traverse((obj) => {
  if (!(obj instanceof THREE.Mesh) || !obj.visible) return;
  const geo = obj.geometry;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return;
  const index = geo.getIndex();
  const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
  const std = mat as THREE.MeshStandardMaterial;
  const base = std.color ? new THREE.Color(std.color.getHex()) : new THREE.Color(0x888888);
  const emissive = std.emissive ? std.emissive.getHex() : 0;
  const emissiveBoost = emissive === 0 ? 0 : 0.25;

  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const sampler = uv ? samplerFor(std.map) : null;

  // Shader-driven surfaces (sky dome, street haze) cannot be shaded by the
  // rasteriser, so they get an analytic approximation instead.
  const isShader = (mat as THREE.Material).isShaderMaterial === true;
  if (isShader) {
    const uniforms = (mat as THREE.ShaderMaterial).uniforms ?? {};
    const hazeU = uniforms.opacity as { value: number } | undefined;
    const hazeC = uniforms.hazeColor as { value: THREE.Color } | undefined;
    const isHaze = hazeU !== undefined && hazeC !== undefined;
    const skyTop = uniforms.topColor as { value: THREE.Color } | undefined;
    const skyMid = uniforms.midColor as { value: THREE.Color } | undefined;
    const skyBottom = uniforms.bottomColor as { value: THREE.Color } | undefined;
    if (skyTop && skyMid && skyBottom) {
      // Sky dome: a vertical gradient by world Y.
      for (const vert of [vA, vB, vC]) {
        void vert;
      }
    }
    if (isHaze) {
      // Street haze: dense at the bottom, gone by the top, tinted by the
      // fog colour, with an alpha that fades toward the top edge.
      const count2 = index ? index.count : pos.count;
      const triCount2 = Math.floor(count2 / 3);
      for (let t4 = 0; t4 < triCount2; t4++) {
        const j0 = index ? index.getX(t4 * 3) : t4 * 3;
        const j1 = index ? index.getX(t4 * 3 + 1) : t4 * 3 + 1;
        const j2 = index ? index.getX(t4 * 3 + 2) : t4 * 3 + 2;
        vA.fromBufferAttribute(pos, j0).applyMatrix4(obj.matrixWorld);
        vB.fromBufferAttribute(pos, j1).applyMatrix4(obj.matrixWorld);
        vC.fromBufferAttribute(pos, j2).applyMatrix4(obj.matrixWorld);
        const pp = [vA, vB, vC].map((v) => {
          const q = v.clone().project(camera);
          return { x: (q.x * 0.5 + 0.5) * W, y: (-q.y * 0.5 + 0.5) * H, z: q.z };
        });
        if (pp.some((q) => !Number.isFinite(q.x))) continue;
        const vv = uv ? [j0, j1, j2].map((i) => uv.getY(i)) : [0, 1, 0];
        const alpha = Math.pow(1 - Math.min(1, Math.max(0, (vv[0] + vv[1] + vv[2]) / 3)), 2);
        const c = hazeC.value;
        tris.push({
          pts: pp,
          uvs: [
            [0, vv[0]],
            [1, vv[1]],
            [0, vv[2]],
          ],
          color: [c.r * 255, c.g * 255, c.b * 255],
          sampler: null,
          tint: [c.r, c.g, c.b],
          texMix: 0,
          dist: mid.distanceTo(camPos),
          alpha: alpha * hazeU.value,
        });
      }
      return;
    }
  }
  // The map's repeat/offset scale the UVs the same way Three.js does.
  const repeat = std.map ? std.map.repeat : null;
  const offset = std.map ? std.map.offset : null;

  const count = index ? index.count : pos.count;
  const triCount = Math.floor(count / 3);
  for (let t3 = 0; t3 < triCount; t3++) {
    const i0 = index ? index.getX(t3 * 3) : t3 * 3;
    const i1 = index ? index.getX(t3 * 3 + 1) : t3 * 3 + 1;
    const i2 = index ? index.getX(t3 * 3 + 2) : t3 * 3 + 2;
    vA.fromBufferAttribute(pos, i0).applyMatrix4(obj.matrixWorld);
    vB.fromBufferAttribute(pos, i1).applyMatrix4(obj.matrixWorld);
    vC.fromBufferAttribute(pos, i2).applyMatrix4(obj.matrixWorld);

    e1.subVectors(vB, vA);
    e2.subVectors(vC, vA);
    nrm.crossVectors(e1, e2);
    if (nrm.lengthSq() < 1e-12) continue;
    nrm.normalize();

    mid
      .copy(vA)
      .add(vB)
      .add(vC)
      .multiplyScalar(1 / 3);
    const toCam = new THREE.Vector3().subVectors(camPos, mid).normalize();
    if (nrm.dot(toCam) <= 0) continue; // back-face cull

    const p = [vA, vB, vC].map((v) => {
      const q = v.clone().project(camera);
      return {
        x: (q.x * 0.5 + 0.5) * W,
        y: (-q.y * 0.5 + 0.5) * H,
        z: q.z,
      };
    });
    if (p.some((q) => !Number.isFinite(q.x) || !Number.isFinite(q.y))) continue;

    let uvs: [number, number][] = [
      [0, 0],
      [1, 0],
      [0, 1],
    ];
    if (uv) {
      uvs = [i0, i1, i2].map((i) => {
        let u = uv.getX(i);
        let v = uv.getY(i);
        if (repeat) {
          u = u * repeat.x + offset.x;
          v = v * repeat.y + offset.y;
        }
        return [u, v] as [number, number];
      });
    }

    const dist = mid.distanceTo(camPos);
    tris.push({
      pts: p,
      uvs,
      color: shade(base, nrm, emissiveBoost),
      sampler,
      tint: [base.r, base.g, base.b],
      texMix: sampler ? 1 : 0,
      dist,
      alpha: 1,
    });
  }
});

// ---------------------------------------------------------------------------
// Rasterise
// ---------------------------------------------------------------------------

const rgba = new Uint8Array(W * H * 4);
// Sky gradient background.
const preset = lighting.constructor;
for (let y = 0; y < H; y++) {
  const f = y / H;
  const r = Math.round(30 + f * 90);
  const g = Math.round(34 + f * 70);
  const b = Math.round(56 + f * 60);
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = 255;
  }
}

const depth = new Float32Array(W * H).fill(Infinity);

function fillTriangle(tri: Tri): void {
  const [p0, p1, p2] = tri.pts;
  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
  if (minX > maxX || minY > maxY) return;
  const area = (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
  if (Math.abs(area) < 1e-9) return;
  const [uv0, uv1, uv2] = tri.uvs;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((p1.x - px) * (p2.y - py) - (p2.x - px) * (p1.y - py)) / area;
      const w1 = ((p2.x - px) * (p0.y - py) - (p0.x - px) * (p2.y - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * p0.z + w1 * p1.z + w2 * p2.z;
      const idx = y * W + x;
      const a = tri.alpha;
      if (a < 0.004) continue;
      if (a >= 0.999) {
        if (z >= depth[idx]) continue;
        depth[idx] = z;
      } else if (z >= depth[idx]) {
        continue;
      }

      // Interpolate the UV and sample the albedo map.
      let r = tri.color[0];
      let g = tri.color[1];
      let b = tri.color[2];
      if (tri.sampler && tri.texMix > 0) {
        const u = w0 * uv0[0] + w1 * uv1[0] + w2 * uv2[0];
        const v = w0 * uv0[1] + w1 * uv1[1] + w2 * uv2[1];
        const t = sampleTex(tri.sampler, u, v);
        // The flat shade was computed on the base colour; re-apply the
        // ratio between the sampled texel and the base colour.
        const br = Math.max(tri.tint[0], 0.001);
        const bg = Math.max(tri.tint[1], 0.001);
        const bb = Math.max(tri.tint[2], 0.001);
        r = Math.min(255, (t[0] / br) * r);
        g = Math.min(255, (t[1] / bg) * g);
        b = Math.min(255, (t[2] / bb) * b);
      }
      // Exponential-squared fog, matching THREE.FogExp2.
      if (fog) {
        const d = tri.dist;
        const factor = 1 - Math.exp(-fog.density * fog.density * d * d);
        const fr = fog.color.r * 255;
        const fg = fog.color.g * 255;
        const fb = fog.color.b * 255;
        r = r * (1 - factor) + fr * factor;
        g = g * (1 - factor) + fg * factor;
        b = b * (1 - factor) + fb * factor;
      }
      const o = idx * 4;
      if (a >= 0.999) {
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = 255;
      } else {
        // Source-over blending against what is already there.
        rgba[o] = r * a + rgba[o] * (1 - a);
        rgba[o + 1] = g * a + rgba[o + 1] * (1 - a);
        rgba[o + 2] = b * a + rgba[o + 2] * (1 - a);
        rgba[o + 3] = 255;
      }
    }
  }
}

tris.sort((a, b) => {
  // Opaque geometry is sorted far -> near so the z-buffer resolves it.
  // Translucent layers (the street haze) are always drawn last.
  const at = a.alpha >= 0.999 ? 0 : 1;
  const bt = b.alpha >= 0.999 ? 0 : 1;
  if (at !== bt) return at - bt;
  return b.dist - a.dist;
});

for (const tri of tris) {
  fillTriangle(tri);
}

writePng(OUT, rgba, W, H);
const onScreen = tris.filter((t) =>
  t.pts.every((q) => q.x >= 0 && q.x < W && q.y >= 0 && q.y < H),
).length;
console.log('player', world.player.x.toFixed(1), world.player.y.toFixed(1), world.player.state);
console.log(
  'camera pos',
  camPos
    .toArray()
    .map((n) => n.toFixed(2))
    .join(', '),
);
console.log(
  'cam rot',
  camera.rotation
    .toArray()
    .slice(0, 3)
    .map((n) => n.toFixed(3))
    .join(', '),
);
console.log('tris', tris.length, 'fully on screen', onScreen);
console.log(
  'sample projected pts',
  tris[0]?.pts.map((q) => `${q.x.toFixed(0)},${q.y.toFixed(0)},${q.z.toFixed(3)}`).join(' | '),
);
console.log(`wrote ${OUT} — ${tris.length} triangles, runner at x=${world.player.x.toFixed(1)}`);
void preset;
