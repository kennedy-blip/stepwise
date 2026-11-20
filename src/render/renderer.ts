/**
 * Canvas renderer.
 *
 * The renderer is the ONLY module that touches Canvas2D. It reads the pure
 * simulation state and draws it. Nothing here feeds back into the simulation.
 *
 * Layers (back to front):
 *   1. Sky gradient + celestial body
 *   2. Weather particles
 *   3. Far city (0.18x parallax)
 *   4. Mid city (0.35x parallax)
 *   5. Near city + foreground rooftops (1.0x)
 *   6. Runner (articulated, IK-driven)
 *   7. Particles + diegetic labels
 */

import { clamp, lerp } from '../core/math';
import { CAMERA, FLOW_COLORS, RUNNER_COLORS, SKY_MOODS } from '../game/config';
import { slabCorners } from '../physics/terrain';
import type { SkyMood } from '../core/types';
import type { World } from '../game/world';
import type { Player } from '../game/player';

export interface RenderOptions {
  showDebug: boolean;
  skyMood: SkyMood;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private dpr = 1;
  private width = 0;
  private height = 0;

  /** Parallax skyline offsets. */
  private skylineSeeds: { x: number; w: number; h: number; lit: number }[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Stepwise requires a 2D canvas context.');
    this.ctx = ctx;
    this.resize();
    this.buildSkyline();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const viewportW = typeof window !== 'undefined' ? window.innerWidth : 0;
    const viewportH = typeof window !== 'undefined' ? window.innerHeight : 0;
    const w = Math.max(1, Math.round(rect.width || viewportW || this.canvas.width));
    const h = Math.max(1, Math.round(rect.height || viewportH || this.canvas.height));
    // Cap the DPR so high-density phones do not tank the fill rate.
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.dpr = Math.min(dpr, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.width = w;
    this.height = h;
  }

  get viewWidth(): number {
    return this.width;
  }

  get viewHeight(): number {
    return this.height;
  }

  private buildSkyline(): void {
    this.skylineSeeds = [];
    let seed = 9;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 160; i++) {
      this.skylineSeeds.push({
        x: i * 120 + rand() * 60,
        w: 60 + rand() * 120,
        h: 90 + rand() * 300,
        lit: rand(),
      });
    }
  }

  /** Converts a world point to canvas space. */
  worldToScreen(
    x: number,
    y: number,
    camera: { x: number; y: number; zoom: number },
  ): { x: number; y: number } {
    const z = camera.zoom;
    return {
      x: (x - camera.x) * z + this.width * CAMERA.anchorX,
      y: (y - camera.y) * z + this.height * CAMERA.anchorY,
    };
  }

  render(world: World, options: RenderOptions): void {
    const ctx = this.ctx;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    // Camera shake.
    const shake = world.shakeAmount;
    const shakeX = shake ? (Math.random() - 0.5) * shake : 0;
    const shakeY = shake ? (Math.random() - 0.5) * shake : 0;

    const camera = {
      x: world.camera.x + shakeX / world.camera.zoom,
      y: world.camera.y + shakeY / world.camera.zoom,
      zoom: world.camera.zoom,
    };

    const palette = SKY_MOODS[options.skyMood];

    this.drawSky(palette.skyTop, palette.skyMid, palette.skyBottom);
    this.drawCelestial(palette.sun, palette.sunGlow);

    if (palette.particle !== 'none') {
      this.drawWeather(palette.particleColor, palette.particleRate, camera);
    }

    this.drawCityLayer(palette.farCity, palette.window, 0.18, camera, 0.55);
    this.drawCityLayer(palette.midCity, palette.window, 0.35, camera, 0.8);

    this.drawTerrain(world, camera);

    this.drawRunner(world.player, world, camera);

    this.drawParticles(world, camera);
    this.drawLabels(world, camera);

    if (options.showDebug) {
      this.drawDebug(world, camera);
    }

    ctx.restore();
  }

  // ----------------------------------------------------------------------
  // Sky
  // ----------------------------------------------------------------------
  private drawSky(top: string, mid: string, bottom: string): void {
    const { ctx, width, height } = this;
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, top);
    grad.addColorStop(0.55, mid);
    grad.addColorStop(1, bottom);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
  }

  private drawCelestial(sun: string, glow: string): void {
    const { ctx, width, height } = this;
    const cx = width * 0.74;
    const cy = height * 0.22;
    const r = Math.min(width, height) * 0.075;

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 4.2);
    grad.addColorStop(0, glow);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(cx - r * 4.2, cy - r * 4.2, r * 8.4, r * 8.4);

    ctx.fillStyle = sun;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawWeather(
    color: string,
    rate: number,
    camera: { x: number; y: number; zoom: number },
  ): void {
    const { ctx, width, height } = this;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    const count = Math.floor(rate);
    for (let i = 0; i < count; i++) {
      // Deterministic pseudo-random positions derived from the camera so the
      // weather scrolls with the world but never re-randomises.
      const seed = i * 97.13;
      const sx = (Math.sin(seed) * 0.5 + 0.5) * (width + 200) - 100;
      const sy = (Math.sin(seed * 1.7) * 0.5 + 0.5) * (height + 200) - 100;
      const x = (sx - camera.x * 0.25) % (width + 200);
      const y = (sy + ((performance.now() * 0.35) % (height + 200))) % (height + 200);
      ctx.moveTo(x, y);
      ctx.lineTo(x - 5, y + 16);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ----------------------------------------------------------------------
  // Parallax city
  // ----------------------------------------------------------------------
  private drawCityLayer(
    color: string,
    windowColor: string,
    parallax: number,
    camera: { x: number; y: number; zoom: number },
    scale: number,
  ): void {
    const { ctx, width, height } = this;
    const offset = camera.x * parallax * camera.zoom;
    const baseY = height * 0.78 + (1 - parallax) * 30;

    ctx.fillStyle = color;
    for (const b of this.skylineSeeds) {
      const x = b.x - (offset % (this.skylineSeeds.length * 120));
      if (x < -b.w - 200 || x > width + 200) continue;
      const h = b.h * scale;
      const w = b.w * scale;
      const y = baseY - h;

      // Layered facade shading turns the skyline into a readable city rather
      // than a row of flat silhouettes. Gradients are deterministic and cheap.
      const facade = ctx.createLinearGradient(x, y, x + w, y + h * 0.12);
      facade.addColorStop(0, color);
      facade.addColorStop(0.48, color);
      facade.addColorStop(1, 'rgba(5,10,20,0.58)');
      ctx.fillStyle = facade;
      ctx.fillRect(x, y, w, h + 40);

      // Roof parapet, vertical concrete seam and rooftop equipment.
      ctx.fillStyle = 'rgba(220,232,255,0.12)';
      ctx.fillRect(x, y, w, Math.max(2, 3 * scale));
      ctx.fillRect(x + w * 0.08, y + 5, Math.max(1, w * 0.018), h * 0.82);
      if (b.lit > 0.62) {
        ctx.fillStyle = 'rgba(8,13,24,0.62)';
        ctx.fillRect(x + w * 0.62, y - 7 * scale, w * 0.2, 7 * scale);
        ctx.strokeStyle = 'rgba(190,210,235,0.22)';
        ctx.lineWidth = Math.max(1, scale);
        ctx.beginPath();
        ctx.moveTo(x + w * 0.72, y - 7 * scale);
        ctx.lineTo(x + w * 0.72, y - 18 * scale);
        ctx.stroke();
      }

      // Lit windows.
      ctx.fillStyle = windowColor;
      const rows = Math.floor(h / 22);
      const cols = Math.floor(w / 18);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const seed = (b.x * 0.013 + r * 3.7 + c * 11.3) % 1;
          if (seed < 0.62) continue;
          ctx.globalAlpha = 0.55 + seed * 0.4;
          ctx.fillRect(x + 6 + c * 18, y + 8 + r * 22, 7, 9);
        }
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
    }

    // Antennas on some rooftops.
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (let i = 0; i < this.skylineSeeds.length; i += 9) {
      const b = this.skylineSeeds[i];
      const x = b.x - (offset % (this.skylineSeeds.length * 120));
      if (x < -50 || x > width + 50) continue;
      const h = b.h * scale;
      ctx.beginPath();
      ctx.moveTo(x + b.w * 0.5 * scale, baseY - h);
      ctx.lineTo(x + b.w * 0.5 * scale, baseY - h - 26);
      ctx.stroke();
    }
  }

  // ----------------------------------------------------------------------
  // Terrain
  // ----------------------------------------------------------------------
  private drawTerrain(world: World, camera: { x: number; y: number; zoom: number }): void {
    const { ctx } = this;
    const zoom = camera.zoom;

    // Determine the visible world range.
    const left = camera.x - (this.width * CAMERA.anchorX) / zoom;
    const right = camera.x + (this.width * (1 - CAMERA.anchorX)) / zoom;

    ctx.save();
    ctx.translate(this.width * CAMERA.anchorX, this.height * CAMERA.anchorY);
    ctx.scale(zoom, zoom);
    ctx.translate(-camera.x, -camera.y);

    for (const slab of world.terrain.slabs) {
      if (slab.x + slab.w < left - 60 || slab.x > right + 60) continue;
      const c = slabCorners(slab);

      // Body.
      ctx.fillStyle = MATERIAL_FILL[slab.material];
      ctx.beginPath();
      ctx.moveTo(c.tl.x, c.tl.y);
      ctx.lineTo(c.tr.x, c.tr.y);
      ctx.lineTo(c.br.x, c.br.y);
      ctx.lineTo(c.bl.x, c.bl.y);
      ctx.closePath();
      ctx.fill();

      // Lit top edge — makes walkable surfaces unmistakable.
      ctx.strokeStyle = MATERIAL_EDGE[slab.material];
      ctx.lineWidth = 3 / zoom;
      ctx.beginPath();
      ctx.moveTo(c.tl.x, c.tl.y);
      ctx.lineTo(c.tr.x, c.tr.y);
      ctx.stroke();

      // Subtle surface texture.
      ctx.strokeStyle = 'rgba(255,255,255,0.035)';
      ctx.lineWidth = 1 / zoom;
      ctx.beginPath();
      for (let i = 1; i < 4; i++) {
        const t = i / 4;
        const x = lerp(c.tl.x, c.tr.x, t);
        const y = lerp(c.tl.y, c.tr.y, t);
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + 26);
      }
      ctx.stroke();
    }

    // Hazards.
    for (const h of world.terrain.hazards) {
      if (h.x + h.w < left - 60 || h.x > right + 60) continue;
      switch (h.kind) {
        case 'pipe': {
          const clearance = h.meta?.clearance ?? 40;
          const y = h.y + h.h;
          ctx.strokeStyle = '#5a6070';
          ctx.lineWidth = 12;
          ctx.beginPath();
          ctx.moveTo(h.x, y + 6);
          ctx.lineTo(h.x + h.w, y + 6);
          ctx.stroke();
          ctx.strokeStyle = '#8b93a6';
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(h.x, y + 3);
          ctx.lineTo(h.x + h.w, y + 3);
          ctx.stroke();
          // Support brackets.
          ctx.strokeStyle = '#3d434f';
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.moveTo(h.x + 8, y + 12);
          ctx.lineTo(h.x + 8, y + 12 + clearance);
          ctx.moveTo(h.x + h.w - 8, y + 12);
          ctx.lineTo(h.x + h.w - 8, y + 12 + clearance);
          ctx.stroke();
          break;
        }
        case 'plank': {
          if (h.broken) {
            ctx.strokeStyle = 'rgba(120,80,50,0.35)';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(h.x, h.y + h.h / 2);
            ctx.lineTo(h.x + h.w, h.y + h.h / 2);
            ctx.stroke();
            break;
          }
          const cracking = h.state && h.state > 0;
          ctx.fillStyle = cracking ? '#c98a55' : '#8a5c39';
          ctx.fillRect(h.x, h.y, h.w, h.h);
          ctx.strokeStyle = 'rgba(0,0,0,0.4)';
          ctx.lineWidth = 1;
          ctx.strokeRect(h.x, h.y, h.w, h.h);
          if (cracking) {
            ctx.strokeStyle = 'rgba(255,220,160,0.9)';
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            const cx = h.x + h.w * 0.5;
            ctx.moveTo(cx, h.y);
            ctx.lineTo(cx - 6, h.y + h.h * 0.5);
            ctx.lineTo(cx + 5, h.y + h.h);
            ctx.stroke();
          }
          break;
        }
        case 'glass': {
          if (h.broken) {
            ctx.strokeStyle = 'rgba(190,235,255,0.35)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(h.x, h.y + h.h);
            ctx.lineTo(h.x + h.w, h.y + h.h);
            ctx.stroke();
            break;
          }
          ctx.fillStyle = 'rgba(150,210,240,0.30)';
          ctx.fillRect(h.x, h.y, h.w, h.h);
          ctx.strokeStyle = 'rgba(200,240,255,0.55)';
          ctx.lineWidth = 1.4;
          ctx.strokeRect(h.x, h.y, h.w, h.h);
          ctx.beginPath();
          ctx.moveTo(h.x + 4, h.y + h.h - 2);
          ctx.lineTo(h.x + h.w * 0.5, h.y + 2);
          ctx.lineTo(h.x + h.w - 4, h.y + h.h - 2);
          ctx.stroke();
          break;
        }
        case 'spring': {
          ctx.fillStyle = h.state ? '#3f7fa8' : '#2c5f80';
          ctx.fillRect(h.x, h.y, h.w, h.h);
          ctx.strokeStyle = '#7fd0ff';
          ctx.lineWidth = 2;
          for (let i = 0; i < 4; i++) {
            const yy = h.y + 3 + i * (h.h / 4);
            ctx.beginPath();
            ctx.moveTo(h.x + 2, yy);
            ctx.lineTo(h.x + h.w - 2, yy);
            ctx.stroke();
          }
          break;
        }
        case 'zipline': {
          ctx.strokeStyle = 'rgba(220,230,245,0.75)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          const endX = h.meta?.endX ?? h.x + h.w;
          ctx.moveTo(h.x, h.y);
          ctx.quadraticCurveTo((h.x + endX) / 2, h.y + 26, endX, h.y + 14);
          ctx.stroke();
          // Anchor posts.
          ctx.strokeStyle = '#39404e';
          ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.moveTo(h.x, h.y);
          ctx.lineTo(h.x, h.y + 60);
          ctx.moveTo(endX, h.y + 14);
          ctx.lineTo(endX, h.y + 74);
          ctx.stroke();
          break;
        }
      }
    }

    ctx.restore();
  }

  // ----------------------------------------------------------------------
  // Runner
  // ----------------------------------------------------------------------
  private drawRunner(
    player: Player,
    world: World,
    camera: { x: number; y: number; zoom: number },
  ): void {
    const { ctx } = this;
    const rig = player.rig;
    const tier = world.flow.tier;
    const tierColor = FLOW_COLORS[tier];

    ctx.save();
    ctx.translate(this.width * CAMERA.anchorX, this.height * CAMERA.anchorY);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    const face = player.facing;

    // Soft contact shadow anchors the articulated runner to the rooftop.
    ctx.save();
    ctx.translate(player.x, player.y + 5);
    ctx.scale(1, 0.22);
    const shadow = ctx.createRadialGradient(0, 0, 2, 0, 0, 34);
    shadow.addColorStop(0, 'rgba(0,0,0,0.42)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.arc(0, 0, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // --- Scarf (behind the body) -----------------------------------------
    ctx.strokeStyle = tierColor.scarf;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < rig.scarf.length; i++) {
      const s = rig.scarf[i];
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();

    // --- Rim glow at Tier 3 ------------------------------------------------
    if (tier === 3) {
      ctx.save();
      ctx.shadowColor = tierColor.glow;
      ctx.shadowBlur = 22;
      this.drawSkeletonBody(player, tierColor.primary, true);
      ctx.restore();
    }

    this.drawSkeletonBody(player, tierColor.primary, false);

    // --- Face hint ---------------------------------------------------------
    ctx.fillStyle = RUNNER_COLORS.head;
    ctx.beginPath();
    ctx.arc(rig.head.x, rig.head.y, 13, 0, Math.PI * 2);
    ctx.fill();

    // Visor / eye glint.
    ctx.fillStyle = tierColor.primary;
    ctx.beginPath();
    ctx.arc(rig.head.x + face * 6, rig.head.y - 1, 2.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  private drawSkeletonBody(player: Player, accent: string, glowOnly: boolean): void {
    const { ctx } = this;
    const rig = player.rig;

    ctx.globalAlpha = glowOnly ? 0.55 : 1;

    const drawLimb = (
      root: { x: number; y: number } | null,
      joint: { x: number; y: number } | null,
      end: { x: number; y: number } | null,
      width: number,
    ) => {
      if (!root || !joint || !end) return;
      ctx.strokeStyle = RUNNER_COLORS.body;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(root.x, root.y);
      ctx.lineTo(joint.x, joint.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();

      // Rim light along the leading edge.
      ctx.strokeStyle = accent;
      ctx.globalAlpha = glowOnly ? 0.45 : 0.8;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(root.x, root.y);
      ctx.lineTo(joint.x, joint.y);
      ctx.stroke();
      ctx.globalAlpha = glowOnly ? 0.55 : 1;
    };

    // Legs.
    const ll = rig.leftLeg;
    const rl = rig.rightLeg;
    if (ll) drawLimb(ll.root, ll.joint, ll.end, 13);
    if (rl) drawLimb(rl.root, rl.joint, rl.end, 13);

    // Feet.
    ctx.strokeStyle = RUNNER_COLORS.body;
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    const drawFoot = (ankle: { x: number; y: number }, angle: number) => {
      const len = 15;
      const dx = Math.cos(angle) * len;
      const dy = Math.sin(angle) * len;
      ctx.beginPath();
      ctx.moveTo(ankle.x, ankle.y);
      ctx.lineTo(ankle.x + dx, ankle.y + dy);
      ctx.stroke();
    };
    drawFoot(rig.leftFoot.ankle, rig.leftFoot.footAngle);
    drawFoot(rig.rightFoot.ankle, rig.rightFoot.footAngle);

    // Reflective sole edges improve foot-placement readability at speed.
    ctx.strokeStyle = 'rgba(225,235,248,0.72)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(rig.leftFoot.ankle.x, rig.leftFoot.ankle.y + 2);
    ctx.lineTo(rig.leftFoot.ankle.x + player.facing * 13, rig.leftFoot.ankle.y + 2);
    ctx.moveTo(rig.rightFoot.ankle.x, rig.rightFoot.ankle.y + 2);
    ctx.lineTo(rig.rightFoot.ankle.x + player.facing * 13, rig.rightFoot.ankle.y + 2);
    ctx.stroke();

    // Torso.
    const pelvis = rig.pelvis;
    const neck = rig.neck;
    ctx.strokeStyle = RUNNER_COLORS.body;
    ctx.lineWidth = 24;
    ctx.beginPath();
    ctx.moveTo(pelvis.x, pelvis.y);
    ctx.lineTo(neck.x, neck.y);
    ctx.stroke();

    // Fabric panel seams and a restrained cool key-light.
    ctx.strokeStyle = 'rgba(225,235,250,0.22)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(pelvis.x - 4, pelvis.y - 4);
    ctx.lineTo(neck.x - 4, neck.y + 5);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(5,9,18,0.34)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pelvis.x + 5, pelvis.y - 2);
    ctx.lineTo(neck.x + 5, neck.y + 4);
    ctx.stroke();

    // Torso rim light.
    ctx.strokeStyle = accent;
    ctx.globalAlpha = glowOnly ? 0.4 : 0.7;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(pelvis.x + player.facing * 6, pelvis.y);
    ctx.lineTo(neck.x + player.facing * 6, neck.y);
    ctx.stroke();
    ctx.globalAlpha = glowOnly ? 0.55 : 1;

    // Arms.
    const la = rig.leftArm;
    const ra = rig.rightArm;
    if (la) drawLimb(la.root, la.joint, la.end, 9);
    if (ra) drawLimb(ra.root, ra.joint, ra.end, 9);

    ctx.globalAlpha = 1;
  }

  // ----------------------------------------------------------------------
  // Particles & labels
  // ----------------------------------------------------------------------
  private drawParticles(world: World, camera: { x: number; y: number; zoom: number }): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(this.width * CAMERA.anchorX, this.height * CAMERA.anchorY);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    for (const p of world.particles) {
      const t = 1 - p.life / p.maxLife;
      ctx.globalAlpha = clamp(t, 0, 1) * 0.85;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.4 + t * 0.8), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private drawLabels(world: World, camera: { x: number; y: number; zoom: number }): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(this.width * CAMERA.anchorX, this.height * CAMERA.anchorY);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    ctx.font = '700 15px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (const l of world.labels) {
      const t = l.age / l.life;
      ctx.globalAlpha = clamp(1 - t * t, 0, 1);
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, l.x, l.y);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ----------------------------------------------------------------------
  // Debug overlay (I key)
  // ----------------------------------------------------------------------
  private drawDebug(world: World, camera: { x: number; y: number; zoom: number }): void {
    const { ctx } = this;
    const rig = world.player.rig;

    ctx.save();
    ctx.translate(this.width * CAMERA.anchorX, this.height * CAMERA.anchorY);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    // Bones.
    ctx.strokeStyle = 'rgba(95, 224, 255, 0.85)';
    ctx.lineWidth = 1.4;
    const bone = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    };
    if (rig.leftLeg) {
      bone(rig.leftLeg.root, rig.leftLeg.joint);
      bone(rig.leftLeg.joint, rig.leftLeg.end);
    }
    if (rig.rightLeg) {
      bone(rig.rightLeg.root, rig.rightLeg.joint);
      bone(rig.rightLeg.joint, rig.rightLeg.end);
    }
    if (rig.leftArm) {
      bone(rig.leftArm.root, rig.leftArm.joint);
      bone(rig.leftArm.joint, rig.leftArm.end);
    }
    if (rig.rightArm) {
      bone(rig.rightArm.root, rig.rightArm.joint);
      bone(rig.rightArm.joint, rig.rightArm.end);
    }
    bone(rig.pelvis, rig.neck);
    bone(rig.neck, rig.head);

    // Joints.
    ctx.fillStyle = 'rgba(255, 180, 92, 0.9)';
    const dots: { x: number; y: number }[] = [];
    if (rig.leftLeg) dots.push(rig.leftLeg.joint, rig.leftLeg.end);
    if (rig.rightLeg) dots.push(rig.rightLeg.joint, rig.rightLeg.end);
    if (rig.leftArm) dots.push(rig.leftArm.joint, rig.leftArm.end);
    if (rig.rightArm) dots.push(rig.rightArm.joint, rig.rightArm.end);
    dots.push(rig.pelvis, rig.neck, rig.head);
    for (const d of dots) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Foot raycasts.
    ctx.strokeStyle = 'rgba(255, 90, 90, 0.8)';
    ctx.setLineDash([3, 3]);
    const targets = [
      { x: rig.leftFoot.toe.x, y: rig.leftFoot.toe.y },
      { x: rig.rightFoot.toe.x, y: rig.rightFoot.toe.y },
    ];
    for (const t of targets) {
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(t.x, t.y + 70);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Hitbox.
    const hb = world.player.hitbox;
    ctx.strokeStyle = 'rgba(255, 220, 100, 0.9)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(hb.x, hb.y, hb.w, hb.h);

    ctx.restore();
  }
}

const MATERIAL_FILL: Record<string, string> = {
  concrete: '#1b1f2b',
  metal: '#232a38',
  glass: '#1d2a38',
  wood: '#241c18',
};

const MATERIAL_EDGE: Record<string, string> = {
  concrete: '#8e9bb3',
  metal: '#b7c6dc',
  glass: '#7fd4ff',
  wood: '#c08a58',
};
