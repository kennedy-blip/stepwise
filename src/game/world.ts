/**
 * The world / game orchestrator.
 *
 * Owns the terrain, the player, the flow meter, the camera and the particle
 * system. It is still pure simulation — the renderer reads from it.
 */

import { clamp, damp, lerp } from '../core/math';
import { CAMERA, DIFFICULTY_TUNING, PHYSICS, PIXELS_PER_METRE } from './config';
import { createFlowState, type FlowState } from './flow';
import { generateLevel } from './chunks';
import { Player, type GameEvent } from './player';
import { Terrain } from '../physics/terrain';
import type { Camera, Difficulty, FloatingLabel, Particle, RunStats, Vec2 } from '../core/types';

export type WorldPhase = 'title' | 'playing' | 'summarised';

export interface WorldOptions {
  difficulty: Difficulty;
  seed?: number;
}

export class World {
  terrain = new Terrain();
  player: Player;
  flow: FlowState;
  camera: Camera = { x: 0, y: 0, zoom: 1, targetZoom: 1, anchorY: CAMERA.anchorY };

  phase: WorldPhase = 'title';
  stats: RunStats = { distance: 0, peakFlow: 0, cleanMoves: 0, flowSavesUsed: 0, time: 0 };

  particles: Particle[] = [];
  labels: FloatingLabel[] = [];

  difficulty: Difficulty;
  seed: number;

  /** Global slow-motion factor (Flow Save hit-stop). */
  timeScale = 1;
  private hitStopTimer = 0;

  /** Death / run-end info. */
  outcome: 'running' | 'finished' | 'dead' = 'running';
  deathReason = '';

  private runTime = 0;

  constructor(options: WorldOptions) {
    this.difficulty = options.difficulty;
    this.seed = options.seed ?? 20260101;
    this.flow = createFlowState();

    this.buildLevel();

    const tuning = DIFFICULTY_TUNING[this.difficulty];
    this.player = new Player({
      x: this.terrain.minX + 120,
      y: this.terrain.groundAt(this.terrain.minX + 120, 0) ?? 0,
      tuning,
      difficulty: this.difficulty,
      terrain: this.terrain,
      flow: this.flow,
    });
    this.player.setStartX(this.player.x);

    this.camera.x = this.player.x;
    this.camera.y = this.player.y;
  }

  private buildLevel(): void {
    this.terrain = new Terrain();
    const tuning = DIFFICULTY_TUNING[this.difficulty];
    const chunks = generateLevel(
      0,
      0,
      {
        tuning,
        seed: this.seed,
        difficulty: this.difficulty,
      },
      260,
    );
    for (const chunk of chunks) this.terrain.addChunk(chunk);

    // A starting platform that is always flat and safe. It ends exactly where
    // the first generated roof begins, so the very first gap is a real gap.
    const firstRoof = this.terrain.slabs[0];
    const startY = firstRoof ? firstRoof.y : 0;
    this.terrain.slabs.unshift({
      x: -600,
      y: startY,
      w: 600 + (firstRoof ? firstRoof.x : 0),
      h: 400,
      angle: 0,
      material: 'concrete',
    });
    this.terrain.minX = -600;
  }

  /** Starts (or restarts) a run. */
  start(): void {
    this.phase = 'playing';
    this.outcome = 'running';
    this.deathReason = '';
    this.stats = { distance: 0, peakFlow: 0, cleanMoves: 0, flowSavesUsed: 0, time: 0 };
    this.runTime = 0;
    this.particles = [];
    this.labels = [];

    const tuning = DIFFICULTY_TUNING[this.difficulty];
    this.flow = createFlowState();
    this.buildLevel();

    const spawnX = this.terrain.minX + 120;
    this.player = new Player({
      x: spawnX,
      y: this.terrain.groundAt(spawnX, 0) ?? 0,
      tuning,
      difficulty: this.difficulty,
      terrain: this.terrain,
      flow: this.flow,
    });
    this.player.setStartX(spawnX);
    this.camera.x = this.player.x;
    this.camera.y = this.player.y;
  }

  setDifficulty(difficulty: Difficulty): void {
    this.difficulty = difficulty;
    const tuning = DIFFICULTY_TUNING[difficulty];
    this.player.setTuning(tuning, difficulty);
    this.start();
  }

  /**
   * Abandons the current run and returns the world to its title state, so
   * the title screen can show the live idle scene again.
   */
  toTitle(): void {
    this.phase = 'title';
    this.outcome = 'running';
    this.deathReason = '';
    this.hitStopTimer = 0;
    this.particles = [];
    this.labels = [];

    // Rebuild the level so the idle scene is a fresh rooftop rather than
    // wherever the abandoned run happened to end.
    const tuning = DIFFICULTY_TUNING[this.difficulty];
    this.flow = createFlowState();
    this.buildLevel();

    const spawnX = this.terrain.minX + 120;
    this.player = new Player({
      x: spawnX,
      y: this.terrain.groundAt(spawnX, 0) ?? 0,
      tuning,
      difficulty: this.difficulty,
      terrain: this.terrain,
      flow: this.flow,
    });
    this.player.setStartX(spawnX);
    this.camera.x = this.player.x;
    this.camera.y = this.player.y;
  }

  /**
   * Advances the world by a fixed timestep.
   * `dt` is always the fixed simulation step (1/120 s) scaled by timeScale.
   */
  update(dt: number): GameEvent[] {
    if (this.phase === 'title') {
      // The title screen shows the live scene: the runner breathes in the wind.
      this.updateCamera(dt, true);
      this.updateParticles(dt);
      return [];
    }

    if (this.hitStopTimer > 0) {
      this.hitStopTimer -= dt;
      // The world barely advances during the Flow Save flash.
      this.updateCamera(dt, false);
      this.updateParticles(dt * 0.25);
      return [];
    }

    this.runTime += dt;

    // Zipline grabbing happens outside the state machine.
    this.player.tryGrabZipline();

    this.player.update(this.currentInput, dt);

    const events = this.player.drainEvents();
    for (const ev of events) this.handleEvent(ev);

    // Death check: falling far below the last safe ground.
    if (this.player.y > this.player.lastSafeY + 900 && this.player.state !== 'dead') {
      // A fully charged Flow Save can rescue a missed roof: the runner
      // scrabbles back up onto the last safe ground instead of dying.
      if (this.player.tryFlowSaveRescue()) {
        // The rescue is handled by the player; keep the run alive.
      } else {
        this.kill('MISSED THE ROOF');
      }
    }

    // Distance + stats.
    const metres = Math.max(0, this.player.distance) / PIXELS_PER_METRE;
    this.stats.distance = metres;
    this.stats.peakFlow = this.flow.peak;
    this.stats.cleanMoves = this.flow.cleanMoves;
    this.stats.flowSavesUsed = this.flow.savesUsed;
    this.stats.time = this.runTime;

    this.updateCamera(dt, false);
    this.updateParticles(dt);
    this.updateLabels(dt);
    this.spawnAmbientParticles(dt);

    return events;
  }

  /** The input snapshot the world consumes. Set by the app each frame. */
  currentInput = {
    moveX: 0,
    jumpHeld: false,
    jumpPressed: false,
    crouchHeld: false,
    crouchPressed: false,
  };

  private handleEvent(ev: GameEvent): void {
    switch (ev.type) {
      case 'footstep':
        this.spawnDust(this.player.x, this.player.y, 2, '#cfcabb');
        break;
      case 'land': {
        this.spawnDust(this.player.x, this.player.y, 8 + Math.floor(ev.impact / 60), '#d8d2c4');
        if (ev.impact > 500) this.shake(6);
        break;
      }
      case 'jump':
        this.spawnDust(this.player.x, this.player.y, 4, '#cfcabb');
        break;
      case 'slide':
        this.spawnDust(this.player.x, this.player.y, 10, '#e0d8c8');
        break;
      case 'roll':
        this.spawnDust(this.player.x, this.player.y, 12, '#e0d8c8');
        break;
      case 'flowSave':
        this.hitStopTimer = PHYSICS.flowSaveHitStop;
        this.shake(10);
        for (let i = 0; i < 26; i++) this.spawnParticle(this.player.x, this.player.y, '#5fe0ff');
        break;
      case 'stumble':
        this.shake(8);
        break;
      case 'break':
        if (ev.kind === 'glass') {
          for (let i = 0; i < 18; i++) this.spawnParticle(this.player.x, this.player.y, '#bfeaff');
        } else if (ev.kind === 'plank') {
          for (let i = 0; i < 12; i++) this.spawnParticle(this.player.x, this.player.y, '#a97b4f');
        }
        break;
      case 'springLaunch':
        this.spawnDust(this.player.x, this.player.y, 12, '#cfe6ff');
        this.shake(4);
        break;
      case 'crack':
        this.shake(2);
        break;
      default:
        break;
    }
  }

  kill(reason: string): void {
    if (this.outcome !== 'running') return;
    this.outcome = 'dead';
    this.deathReason = reason;
    this.phase = 'summarised';
  }

  // ----------------------------------------------------------------------
  // Camera
  // ----------------------------------------------------------------------
  private updateCamera(dt: number, titleMode: boolean): void {
    const p = this.player;
    const speed = Math.abs(p.vx);

    // Zoom out at high speed so upcoming gaps stay readable.
    const zoomT = clamp(speed / CAMERA.fastZoomSpeed, 0, 1);
    this.camera.targetZoom = lerp(CAMERA.baseZoom, CAMERA.fastZoom, zoomT);
    this.camera.zoom = damp(this.camera.zoom, this.camera.targetZoom, CAMERA.zoomRate, dt);

    // Anchor the runner at 28% from the left.
    const targetX = p.x;
    this.camera.x = damp(this.camera.x, targetX, CAMERA.followRate, dt);

    // Vertical follow with a dead zone so hops do not bob the view.
    const targetY = p.y;
    const dy = targetY - this.camera.y;
    if (Math.abs(dy) > CAMERA.verticalDeadZone) {
      const excess = dy - Math.sign(dy) * CAMERA.verticalDeadZone;
      this.camera.y = damp(this.camera.y, this.camera.y + excess, CAMERA.followRate, dt);
    }

    if (titleMode) {
      // A slow drift across the starting roof.
      this.camera.x = damp(this.camera.x, p.x + 40, 1.2, dt);
    }
  }

  /** Camera shake magnitude (decays over time). */
  shakeAmount = 0;
  private shake(amount: number): void {
    this.shakeAmount = Math.max(this.shakeAmount, amount);
  }

  updateShake(dt: number): void {
    this.shakeAmount = Math.max(0, this.shakeAmount - this.shakeAmount * 6 * dt - 4 * dt);
  }

  // ----------------------------------------------------------------------
  // Particles & labels
  // ----------------------------------------------------------------------
  private spawnDust(x: number, y: number, count: number, color: string): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI - Math.PI;
      const sp = 40 + Math.random() * 120;
      this.particles.push({
        x: x + (Math.random() - 0.5) * 14,
        y: y - 2 + (Math.random() - 0.5) * 6,
        vx: Math.cos(a) * sp * 0.5 - this.player.vx * 0.15,
        vy: Math.sin(a) * sp * 0.35 - 30,
        life: 0,
        maxLife: 0.35 + Math.random() * 0.5,
        size: 1.5 + Math.random() * 3.5,
        color,
        gravity: 120,
        drag: 2.4,
      });
    }
  }

  private spawnParticle(x: number, y: number, color: string): void {
    const a = Math.random() * Math.PI * 2;
    const sp = 80 + Math.random() * 220;
    this.particles.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 60,
      life: 0,
      maxLife: 0.5 + Math.random() * 0.7,
      size: 1.5 + Math.random() * 3,
      color,
      gravity: 260,
      drag: 1.4,
    });
  }

  private updateParticles(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vy += p.gravity * dt;
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  private spawnAmbientParticles(dt: number): void {
    // Flow trail particles at Tier 3.
    if (this.flow.tier === 3 && this.player.state === 'run') {
      if (Math.random() < dt * 34) {
        this.particles.push({
          x: this.player.x - this.player.facing * 8 + (Math.random() - 0.5) * 10,
          y: this.player.y - 40 + (Math.random() - 0.5) * 50,
          vx: -this.player.facing * (30 + Math.random() * 60),
          vy: (Math.random() - 0.5) * 30,
          life: 0,
          maxLife: 0.5,
          size: 2 + Math.random() * 2.5,
          color: Math.random() < 0.5 ? '#5fe0ff' : '#ffd98a',
          gravity: 0,
          drag: 1.6,
        });
      }
    }
  }

  private updateLabels(dt: number): void {
    for (let i = this.labels.length - 1; i >= 0; i--) {
      const l = this.labels[i];
      l.age += dt;
      l.y -= 34 * dt;
      if (l.age >= l.life) this.labels.splice(i, 1);
    }
  }

  addLabel(text: string, color: string): void {
    this.labels.push({
      x: this.player.x,
      y: this.player.y - 110,
      text,
      color,
      age: 0,
      life: 1.1,
      pop: 1,
    });
  }

  /** World position of the runner's head, for HUD anchoring. */
  get headWorldPos(): Vec2 {
    return { x: this.player.x, y: this.player.y - 110 };
  }
}
