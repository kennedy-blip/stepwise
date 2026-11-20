/**
 * App shell smoke test.
 *
 * Boots the real `main.ts` against a DOM with a stubbed canvas, then drives
 * the game loop for a simulated second and asserts that the HUD advanced,
 * that no exception was thrown, and that the keyboard bindings respond.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Window } from 'happy-dom';

const MARKUP = `
  <div id="app">
    <canvas id="game-canvas"></canvas>
    <div id="hud" class="overlay-layer">
      <div class="hud-block hud-left">
        <div class="hud-distance">0m</div>
        <div class="hud-difficulty">City Flow</div>
      </div>
      <div class="hud-block hud-center">
        <div class="flow-shell">
          <div class="flow-fill" data-tier="1"></div>
          <div class="flow-ticks">
            <span class="flow-tick" style="left: 34%"></span>
            <span class="flow-tick" style="left: 80%"></span>
          </div>
        </div>
        <div class="flow-badge">✦</div>
        <div class="flow-tier" data-tier="1">STEADY</div>
      </div>
      <div class="hud-block hud-right">
        <button class="icon-btn" id="hud-restart">R</button>
        <button class="icon-btn" id="hud-pause">P</button>
      </div>
    </div>
    <div id="title-screen" class="overlay-layer is-visible">
      <div class="title-inner">
        <h1 class="game-title">STEPWISE</h1>
        <button id="play-button" class="play-button">PLAY</button>
        <button id="title-settings-button" class="icon-btn">S</button>
      </div>
    </div>
    <div id="pause-screen" class="overlay-layer">
      <div class="pause-card">
        <button id="resume-button" class="play-button">RESUME</button>
        <div class="pause-menu">
          <button id="pause-settings-button" class="menu-btn">Settings</button>
          <button id="pause-restart-button" class="menu-btn">Restart Run</button>
          <button id="pause-home-button" class="menu-btn">Home</button>
        </div>
      </div>
    </div>
    <div id="summary" class="overlay-layer">
      <div class="summary-card">
        <div class="summary-header">RUN ENDED</div>
        <div class="summary-distance">0m</div>
        <div class="summary-pb">Personal best 0m</div>
        <div class="summary-stats">
          <div class="stat"><span class="stat-value" data-stat="peak">0%</span></div>
          <div class="stat"><span class="stat-value" data-stat="moves">0</span></div>
          <div class="stat"><span class="stat-value" data-stat="saves">0</span></div>
        </div>
        <button id="again-button" class="play-button">RUN AGAIN</button>
        <div class="summary-actions">
          <button id="summary-settings-button" class="menu-btn">Settings</button>
          <button id="summary-home-button" class="menu-btn">Home</button>
        </div>
        <div class="summary-quick">
          <div class="quick-group"><div class="summary-diffs"></div></div>
          <div class="quick-group"><div class="summary-moods"></div></div>
        </div>
      </div>
    </div>
    <div id="settings" class="overlay-layer">
      <div class="settings-card">
        <div class="settings-header"><button id="settings-close" class="icon-btn">X</button></div>
        <div class="settings-body"></div>
      </div>
    </div>
  </div>`;

/** A Canvas2D stub that records nothing but never throws. */
function makeCanvasContext(): Record<string, unknown> {
  const noop = (): void => undefined;
  return {
    canvas: { width: 1280, height: 720 },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    globalAlpha: 1,
    font: '',
    textAlign: 'start',
    shadowColor: '',
    shadowBlur: 0,
    save: noop,
    restore: noop,
    scale: noop,
    translate: noop,
    rotate: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    rect: noop,
    quadraticCurveTo: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    fillText: noop,
    setLineDash: noop,
    drawImage: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    measureText: () => ({ width: 10 }),
  };
}

describe('App shell', () => {
  let win: Window;
  let rafCallbacks: ((t: number) => void)[] = [];
  let rafId = 0;

  beforeEach(() => {
    // Each test needs a fresh module instance: `main.ts` boots an App on
    // import, and the module registry caches it otherwise.
    vi.resetModules();
    win = new Window({ url: 'https://example.test' });
    win.document.body.innerHTML = MARKUP;

    const canvas = win.document.getElementById('game-canvas') as unknown as HTMLCanvasElement;
    canvas.getContext = (() => makeCanvasContext()) as unknown as HTMLCanvasElement['getContext'];
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 }) as DOMRect;

    // A controllable requestAnimationFrame so the loop can be stepped by hand.
    rafCallbacks = [];
    rafId = 0;
    win.requestAnimationFrame = ((cb: (t: number) => void) => {
      rafCallbacks.push(cb);
      return ++rafId;
    }) as unknown as typeof win.requestAnimationFrame;
    win.cancelAnimationFrame = (() => undefined) as typeof win.cancelAnimationFrame;

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
    define('requestAnimationFrame', win.requestAnimationFrame);
    define('cancelAnimationFrame', win.cancelAnimationFrame);
    define('performance', win.performance);
    define('localStorage', win.localStorage);
    define('AudioContext', undefined);
    define('webkitAudioContext', undefined);
  });

  afterEach(() => {
    win.close();
  });

  it('boots, shows the title and renders without throwing', async () => {
    await import('../src/main');

    // The boot happens on DOMContentLoaded or immediately.
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    await Promise.resolve();

    const title = win.document.getElementById('title-screen')!;
    expect(title.classList.contains('is-visible')).toBe(true);

    // Step a few frames.
    for (let i = 0; i < 5; i++) {
      const pending = rafCallbacks;
      rafCallbacks = [];
      for (const cb of pending) cb(performance.now());
    }
  });

  it('starts a run when PLAY is pressed and advances the distance HUD', async () => {
    await import('../src/main');
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    await Promise.resolve();

    const play = win.document.getElementById('play-button') as unknown as HTMLButtonElement;
    play.click();

    // The HUD becomes visible.
    const hud = win.document.getElementById('hud')!;
    expect(hud.classList.contains('is-visible')).toBe(true);

    // Step the loop with the right key held.
    const keyEvent = new win.KeyboardEvent('keydown', { code: 'KeyD', key: 'd' });
    win.dispatchEvent(keyEvent);

    let time = performance.now();
    for (let i = 0; i < 200; i++) {
      const pending = rafCallbacks;
      rafCallbacks = [];
      time += 16.7;
      for (const cb of pending) cb(time);
    }

    // The distance readout should have advanced from its initial value.
    const distance = win.document.querySelector('.hud-distance') as unknown as HTMLElement;
    expect(distance.textContent).not.toBe('0m');
    expect(distance.textContent).toMatch(/^\d+m$/);

    win.dispatchEvent(new win.KeyboardEvent('keyup', { code: 'KeyD', key: 'd' }));
  });

  it('pauses and resumes with the Escape key', async () => {
    await import('../src/main');
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    await Promise.resolve();
    (win.document.getElementById('play-button') as unknown as HTMLButtonElement).click();

    win.dispatchEvent(new win.KeyboardEvent('keydown', { code: 'Escape', key: 'Escape' }));
    const pause = win.document.getElementById('pause-screen')!;
    expect(pause.classList.contains('is-visible')).toBe(true);

    // Release, then press again: the input layer ignores auto-repeat.
    win.dispatchEvent(new win.KeyboardEvent('keyup', { code: 'Escape', key: 'Escape' }));
    win.dispatchEvent(new win.KeyboardEvent('keydown', { code: 'Escape', key: 'Escape' }));
    expect(pause.classList.contains('is-visible')).toBe(false);
  });

  it('opens the pause menu when the on-screen pause button is clicked', async () => {
    await import('../src/main');
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    await Promise.resolve();
    (win.document.getElementById('play-button') as unknown as HTMLButtonElement).click();

    const pause = win.document.getElementById('pause-screen')!;
    expect(pause.classList.contains('is-visible')).toBe(false);

    // A single click must open the menu. The button used to be bound twice
    // (once by the UI layer and once by the app shell), so one click paused
    // and then immediately resumed, and the menu never appeared.
    (win.document.getElementById('hud-pause') as unknown as HTMLButtonElement).click();
    expect(pause.classList.contains('is-visible')).toBe(true);

    // Clicking again resumes.
    (win.document.getElementById('hud-pause') as unknown as HTMLButtonElement).click();
    expect(pause.classList.contains('is-visible')).toBe(false);
  });

  it('navigates from the pause menu: settings, then home', async () => {
    await import('../src/main');
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    await Promise.resolve();
    (win.document.getElementById('play-button') as unknown as HTMLButtonElement).click();

    // Pause the run.
    win.dispatchEvent(new win.KeyboardEvent('keydown', { code: 'Escape', key: 'Escape' }));
    const pause = win.document.getElementById('pause-screen')!;
    expect(pause.classList.contains('is-visible')).toBe(true);

    // The pause menu opens the settings modal.
    (win.document.getElementById('pause-settings-button') as unknown as HTMLButtonElement).click();
    const settings = win.document.getElementById('settings')!;
    expect(settings.classList.contains('is-visible')).toBe(true);
    expect(pause.classList.contains('is-visible')).toBe(false);

    // Closing the modal returns to the pause card, not to the action.
    (win.document.getElementById('settings-close') as unknown as HTMLButtonElement).click();
    expect(settings.classList.contains('is-visible')).toBe(false);
    expect(pause.classList.contains('is-visible')).toBe(true);

    // Home leaves the run and returns to the title screen.
    (win.document.getElementById('pause-home-button') as unknown as HTMLButtonElement).click();
    const title = win.document.getElementById('title-screen')!;
    expect(title.classList.contains('is-visible')).toBe(true);
    expect(pause.classList.contains('is-visible')).toBe(false);
    expect(settings.classList.contains('is-visible')).toBe(false);
  });

  it('restarts the run from the pause menu', async () => {
    await import('../src/main');
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    await Promise.resolve();
    (win.document.getElementById('play-button') as unknown as HTMLButtonElement).click();

    win.dispatchEvent(new win.KeyboardEvent('keydown', { code: 'Escape', key: 'Escape' }));
    const pause = win.document.getElementById('pause-screen')!;
    expect(pause.classList.contains('is-visible')).toBe(true);

    (win.document.getElementById('pause-restart-button') as unknown as HTMLButtonElement).click();

    // The restart drops the pause card and the HUD stays up.
    expect(pause.classList.contains('is-visible')).toBe(false);
    const hud = win.document.getElementById('hud')!;
    expect(hud.classList.contains('is-visible')).toBe(true);
  });

  it('toggles the IK debug overlay with the I key', async () => {
    await import('../src/main');
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    await Promise.resolve();

    win.dispatchEvent(new win.KeyboardEvent('keydown', { code: 'KeyI', key: 'i' }));
    // The setting persists to localStorage.
    const stored = JSON.parse(win.localStorage.getItem('stepwise.settings.v1') ?? '{}');
    expect(stored.showDebug).toBe(true);
  });
});
