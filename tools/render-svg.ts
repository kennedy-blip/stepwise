/**
 * Offline scene visualiser.
 *
 * Runs the real simulation headlessly and emits an SVG snapshot of the scene
 * using the same world->screen transform the canvas renderer uses. It is a
 * development aid for eyeballing the composition and the IK rig without a
 * browser.
 *
 *   npx tsx tools/render-svg.ts [outfile.svg] [frames] [mood]
 */

import { writeFileSync } from 'node:fs';
import { World } from '../src/game/world';
import { CAMERA, SKY_MOODS } from '../src/game/config';
import { createInputState } from '../src/core/types';
import type { SkyMood } from '../src/core/types';

const OUT = process.argv[2] ?? 'scene.svg';
const FRAMES = Number(process.argv[3] ?? 900);
const MOOD = (process.argv[4] ?? 'dusk') as SkyMood;

const W = 1280;
const H = 720;

const world = new World({ difficulty: 'medium', seed: 20260101 });
world.start();

const palette = SKY_MOODS[MOOD];

for (let i = 0; i < FRAMES; i++) {
  world.currentInput = { ...createInputState(), moveX: 1 };
  world.update(1 / 120);
}

const cam = world.camera;
const z = cam.zoom;

function sx(x: number): number {
  return (x - cam.x) * z + W * CAMERA.anchorX;
}
function sy(y: number): number {
  return (y - cam.y) * z + H * CAMERA.anchorY;
}

const parts: string[] = [];

parts.push(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
  `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">`,
  `<stop offset="0" stop-color="${palette.skyTop}"/>`,
  `<stop offset="0.55" stop-color="${palette.skyMid}"/>`,
  `<stop offset="1" stop-color="${palette.skyBottom}"/>`,
  `</linearGradient></defs>`,
  `<rect width="${W}" height="${H}" fill="url(#sky)"/>`,
);

// --- Terrain ---
for (const slab of world.terrain.slabs) {
  if (slab.x + slab.w < cam.x - 900 || slab.x > cam.x + 900) continue;
  const dy = slab.w * Math.tan(slab.angle);
  const x0 = sx(slab.x);
  const y0 = sy(slab.y);
  const x1 = sx(slab.x + slab.w);
  const y1 = sy(slab.y + dy);
  parts.push(
    `<polygon points="${x0},${y0} ${x1},${y1} ${x1},${y1 + slab.h * z} ${x0},${y0 + slab.h * z}" fill="#1b1f2b"/>`,
    `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="#8e9bb3" stroke-width="3"/>`,
  );
}

// --- Hazards ---
for (const h of world.terrain.hazards) {
  if (h.x + h.w < cam.x - 900 || h.x > cam.x + 900) continue;
  if (h.kind === 'plank' && !h.broken) {
    parts.push(
      `<rect x="${sx(h.x)}" y="${sy(h.y)}" width="${h.w * z}" height="${h.h * z}" fill="#8a5c39"/>`,
    );
  } else if (h.kind === 'pipe') {
    const y = sy(h.y + h.h);
    parts.push(
      `<line x1="${sx(h.x)}" y1="${y}" x2="${sx(h.x + h.w)}" y2="${y}" stroke="#5a6070" stroke-width="12"/>`,
    );
  } else if (h.kind === 'spring' && !h.broken) {
    parts.push(
      `<rect x="${sx(h.x)}" y="${sy(h.y)}" width="${h.w * z}" height="${h.h * z}" fill="#2c5f80" stroke="#7fd0ff" stroke-width="2"/>`,
    );
  }
}

// --- Runner skeleton ---
const rig = world.player.rig;
const bone = (a: { x: number; y: number }, b: { x: number; y: number }, color: string, w: number) =>
  `<line x1="${sx(a.x)}" y1="${sy(a.y)}" x2="${sx(b.x)}" y2="${sy(b.y)}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;

if (rig.leftLeg) {
  parts.push(bone(rig.leftLeg.root, rig.leftLeg.joint, '#12141c', 13));
  parts.push(bone(rig.leftLeg.joint, rig.leftLeg.end, '#12141c', 13));
}
if (rig.rightLeg) {
  parts.push(bone(rig.rightLeg.root, rig.rightLeg.joint, '#12141c', 13));
  parts.push(bone(rig.rightLeg.joint, rig.rightLeg.end, '#12141c', 13));
}
parts.push(bone(rig.pelvis, rig.neck, '#12141c', 24));
parts.push(`<circle cx="${sx(rig.head.x)}" cy="${sy(rig.head.y)}" r="${13 * z}" fill="#171a24"/>`);

if (rig.leftArm) {
  parts.push(bone(rig.leftArm.root, rig.leftArm.joint, '#12141c', 9));
  parts.push(bone(rig.leftArm.joint, rig.leftArm.end, '#12141c', 9));
}
if (rig.rightArm) {
  parts.push(bone(rig.rightArm.root, rig.rightArm.joint, '#12141c', 9));
  parts.push(bone(rig.rightArm.joint, rig.rightArm.end, '#12141c', 9));
}

// Scarf.
const scarfPts = rig.scarf.map((s) => `${sx(s.x)},${sy(s.y)}`).join(' ');
parts.push(
  `<polyline points="${scarfPts}" fill="none" stroke="#ffb347" stroke-width="5" stroke-linecap="round"/>`,
);

// Hitbox.
const hb = world.player.hitbox;
parts.push(
  `<rect x="${sx(hb.x)}" y="${sy(hb.y)}" width="${hb.w * z}" height="${hb.h * z}" fill="none" stroke="rgba(255,220,100,0.7)" stroke-width="1.5"/>`,
);

// Info.
parts.push(
  `<text x="24" y="40" fill="#e9eef5" font-family="monospace" font-size="20">x=${world.player.x.toFixed(0)} y=${world.player.y.toFixed(0)} state=${world.player.state} vx=${world.player.vx.toFixed(0)} flow=${world.flow.value.toFixed(0)} tier=${world.flow.tier}</text>`,
  `<text x="24" y="66" fill="#8b93a6" font-family="monospace" font-size="14">speed=${Math.abs(world.player.vx).toFixed(0)} dist=${world.stats.distance.toFixed(1)}m gait=${world.player.rig.gaitPhase.toFixed(2)}</text>`,
  `</svg>`,
);

writeFileSync(OUT, parts.join('\n'));

// Console diagnostics.
console.log(`Wrote ${OUT}`);
console.log(
  `player  x=${world.player.x.toFixed(1)} y=${world.player.y.toFixed(1)} state=${world.player.state}`,
);
console.log(`speed   ${Math.abs(world.player.vx).toFixed(1)} px/s`);
console.log(`flow    ${world.flow.value.toFixed(1)} (tier ${world.flow.tier})`);
console.log(`pelvis  ${rig.pelvis.x.toFixed(1)}, ${rig.pelvis.y.toFixed(1)}`);
console.log(`head    ${rig.head.x.toFixed(1)}, ${rig.head.y.toFixed(1)}`);
console.log(`distance ${world.stats.distance.toFixed(1)} m`);
