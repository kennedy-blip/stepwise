/**
 * Stepwise — application entry point.
 *
 * Responsibilities:
 *  - Own the fixed-timestep simulation loop (decoupled from rAF rendering)
 *  - Wire the input layer to the world
 *  - Drive the renderer and the HUD
 *  - Handle screen state transitions (title / playing / paused / summary)
 */

import './styles.css';

import { InputManager } from './core/input';
import { AudioSynth } from './audio/synth';
import { Renderer } from './render/renderer';
import { UI } from './ui/hud';
import { World } from './game/world';
import { PHYSICS } from './game/config';
import type { Difficulty, GameSettings, SkyMood } from './core/types';

const STORAGE_KEY = 'stepwise.settings.v1';
const BEST_KEY = 'stepwise.personalBest.v1';

class App {
  private canvas: HTMLCanvasElement;
  private root: HTMLElement;
  private world: World;
  private renderer: Renderer;
  private ui: UI;
  private input: InputManager;
  private audio = new AudioSynth();

  private settings: GameSettings = {
    skyMood: 'dusk',
    difficulty: 'medium',
    masterVolume: 0.7,
    muted: false,
    autoSprint: false,
    showDebug: false,
    haptics: true,
    frameRateTarget: 60,
  };

  private paused = false;
  private accumulator = 0;
  private lastTime = 0;
  private personalBest = 0;

  constructor() {
    this.root = document.getElementById('app')!;
    this.canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

    this.loadSettings();

    this.world = new World({ difficulty: this.settings.difficulty });
    this.renderer = new Renderer(this.canvas);
    this.ui = new UI(this.root, this.settings);
    this.input = new InputManager(this.canvas);

    this.bindEvents();
    this.applySettings();

    // The title screen shows the live scene, so start rendering immediately.
    this.ui.showTitle();
    this.lastTime = performance.now();
    requestAnimationFrame(this.frame);
  }

  // ----------------------------------------------------------------------
  // Setup
  // ----------------------------------------------------------------------
  private loadSettings(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) Object.assign(this.settings, JSON.parse(raw) as Partial<GameSettings>);
      const best = localStorage.getItem(BEST_KEY);
      if (best) this.personalBest = Number(best) || 0;
    } catch {
      /* ignore corrupted storage */
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
  }

  private saveBest(): void {
    try {
      localStorage.setItem(BEST_KEY, String(Math.floor(this.personalBest)));
    } catch {
      /* ignore */
    }
  }

  private bindEvents(): void {
    // --- Resize ---
    const onResize = () => this.renderer.resize();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    if ('visualViewport' in window) {
      window.visualViewport?.addEventListener('resize', onResize);
    }

    // --- Touch detection ---
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
      document.body.classList.add('is-touch');
    }

    // --- Input actions ---
    this.input.setActionHandler((action) => {
      switch (action) {
        case 'jump':
          this.audio.resume();
          if (this.world.phase === 'title') {
            this.startRun();
          } else if (this.world.phase === 'summarised') {
            this.startRun();
          } else {
            this.input.latchJump();
          }
          break;
        case 'crouch':
          this.audio.resume();
          if (this.world.phase === 'playing') this.input.latchCrouch();
          break;
        case 'restart':
          this.restartRun();
          break;
        case 'pause':
          this.togglePause();
          break;
        case 'debug':
          this.settings.showDebug = !this.settings.showDebug;
          this.saveSettings();
          this.ui.closeSettings();
          break;
        default:
          break;
      }
    });

    // --- UI events ---
    this.root.addEventListener('stepwise:play', () => this.startRun());
    this.root.addEventListener('stepwise:restart', () => this.restartRun());
    this.root.addEventListener('stepwise:pause', () => this.togglePause());
    this.root.addEventListener('stepwise:difficulty', (e) => {
      const d = (e as CustomEvent<Difficulty>).detail;
      this.settings.difficulty = d;
      this.saveSettings();
      this.world.setDifficulty(d);
      this.ui.showTitle();
    });
    this.root.addEventListener('stepwise:mood', (e) => {
      this.settings.skyMood = (e as CustomEvent<SkyMood>).detail;
      this.saveSettings();
    });
    this.root.addEventListener('stepwise:volume', (e) => {
      this.settings.masterVolume = (e as CustomEvent<number>).detail;
      this.audio.setVolume(this.settings.masterVolume);
      this.saveSettings();
    });
    this.root.addEventListener('stepwise:mute', (e) => {
      this.settings.muted = (e as CustomEvent<boolean>).detail;
      this.audio.setMuted(this.settings.muted);
      this.saveSettings();
    });
    this.root.addEventListener('stepwise:autosprint', (e) => {
      this.settings.autoSprint = (e as CustomEvent<boolean>).detail;
      this.input.autoSprint = this.settings.autoSprint;
      this.saveSettings();
    });
    this.root.addEventListener('stepwise:debug', (e) => {
      this.settings.showDebug = (e as CustomEvent<boolean>).detail;
      this.saveSettings();
    });
    this.root.addEventListener('stepwise:haptics', (e) => {
      this.settings.haptics = (e as CustomEvent<boolean>).detail;
      this.saveSettings();
    });
    this.root.addEventListener('stepwise:fps', (e) => {
      this.settings.frameRateTarget = (e as CustomEvent<60 | 120>).detail;
      this.saveSettings();
    });

    // --- HUD buttons (static ones in index.html) ---
    document.getElementById('hud-restart')?.addEventListener('click', () => this.restartRun());
    document.getElementById('hud-pause')?.addEventListener('click', () => this.togglePause());
    document.getElementById('resume-button')?.addEventListener('click', () => this.togglePause());

    // --- Escape closes the settings modal ---
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.ui.settingsOpen) {
        this.ui.closeSettings();
      }
    });
  }

  private applySettings(): void {
    this.audio.setVolume(this.settings.masterVolume);
    this.audio.setMuted(this.settings.muted);
    this.input.autoSprint = this.settings.autoSprint;
  }

  // ----------------------------------------------------------------------
  // State transitions
  // ----------------------------------------------------------------------
  private startRun(): void {
    this.audio.resume();
    this.world.setDifficulty(this.settings.difficulty);
    this.world.start();
    this.ui.showHud();
    this.ui.setGestureGuides(
      document.body.classList.contains('is-touch') && this.input.showGestureGuides,
    );
    this.paused = false;
    this.accumulator = 0;
    this.lastTime = performance.now();
    this.input.dismissGuides();
  }

  private restartRun(): void {
    if (this.world.phase === 'title') {
      this.startRun();
      return;
    }
    this.world.start();
    this.ui.showHud();
    this.paused = false;
    this.accumulator = 0;
    this.lastTime = performance.now();
  }

  private togglePause(): void {
    if (this.world.phase !== 'playing') return;
    this.paused = !this.paused;
    if (this.paused) {
      this.ui.showPause();
    } else {
      this.ui.hidePause();
      this.lastTime = performance.now();
    }
  }

  private endRun(): void {
    const stats = this.world.stats;
    if (stats.distance > this.personalBest) {
      this.personalBest = stats.distance;
      this.saveBest();
    }
    this.ui.showSummary(
      stats,
      this.personalBest,
      this.world.outcome === 'dead' ? 'dead' : 'finished',
    );
    this.audio.fail();
  }

  // ----------------------------------------------------------------------
  // The loop
  // ----------------------------------------------------------------------
  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);

    let frameTime = (now - this.lastTime) / 1000;
    this.lastTime = now;

    // Clamp to avoid a spiral of death after a tab switch.
    if (frameTime > 0.25) frameTime = 0.25;

    this.input.update();
    this.input.tickGuides(frameTime);

    if (!this.paused) {
      this.accumulator += frameTime;
      let steps = 0;
      while (this.accumulator >= PHYSICS.fixedDt && steps < PHYSICS.maxStepsPerFrame) {
        this.simulateStep(PHYSICS.fixedDt);
        this.accumulator -= PHYSICS.fixedDt;
        steps++;
      }
      if (steps >= PHYSICS.maxStepsPerFrame) {
        // Drop the backlog rather than accumulating debt.
        this.accumulator = 0;
      }
    }

    this.world.updateShake(frameTime);
    this.renderer.render(this.world, {
      showDebug: this.settings.showDebug,
      skyMood: this.settings.skyMood,
    });

    // HUD.
    if (this.world.phase === 'playing' || this.world.phase === 'summarised') {
      this.ui.updateHud(
        this.world.stats.distance,
        this.world.flow.value,
        this.world.flow.tier,
        this.world.flow.armed,
      );
    }

    this.audio.setWind(Math.abs(this.world.player.vx), Math.abs(this.world.player.y));
  };

  /** One fixed simulation step. */
  private simulateStep(dt: number): void {
    this.world.currentInput = this.input.state;
    this.world.update(dt);
    this.input.clearEdges();

    if (this.world.phase === 'playing' && this.world.outcome !== 'running') {
      this.endRun();
    }
  }
}

// Boot.
function boot(): void {
  try {
    new App();
  } catch (err) {
    console.error('[Stepwise] Failed to start:', err);
    const root = document.getElementById('app');
    if (root) {
      root.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;padding:24px;text-align:center">
          <h1 style="font-size:22px;letter-spacing:.2em;margin:0">STEPWISE</h1>
          <p style="color:#8b93a6;font-size:12px;max-width:420px;line-height:1.7;margin:0">
            This game needs a browser with Canvas 2D support. Please open it in a modern browser.
          </p>
        </div>`;
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
