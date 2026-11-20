/**
 * UI layer tests.
 *
 * These run against a real DOM (happy-dom) so the HUD, title overlay, run
 * summary and settings modal are exercised exactly as a browser would run
 * them. This catches wiring errors that would otherwise only appear at
 * runtime in the browser.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { Window } from 'happy-dom';
import type { GameSettings } from '../src/core/types';

/** Builds the DOM skeleton the UI module expects. */
function buildMarkup(): string {
  return `
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
          <h2>PAUSED</h2>
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
          <div class="settings-header">
            <h2>Settings</h2>
            <button id="settings-close" class="icon-btn">X</button>
          </div>
          <div class="settings-body"></div>
        </div>
      </div>
    </div>`;
}

function makeWindow(): Window {
  const win = new Window({ url: 'https://example.test' });
  win.document.body.innerHTML = buildMarkup();
  return win;
}

function defaultSettings(): GameSettings {
  return {
    skyMood: 'dusk',
    difficulty: 'medium',
    masterVolume: 0.7,
    muted: false,
    autoSprint: false,
    showDebug: false,
    haptics: true,
    frameRateTarget: 60,
  };
}

/** Installs a window as the global one so the UI module can use `document`. */
function installGlobals(win: Window): void {
  const define = (key: string, value: unknown): void => {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  };
  define('window', win);
  define('document', win.document);
  define('navigator', win.navigator);
  define('HTMLElement', win.HTMLElement);
  define('HTMLInputElement', win.HTMLInputElement);
  define('CustomEvent', win.CustomEvent);
  define('Event', win.Event);
}

describe('UI layer', () => {
  let win: Window;
  let root: HTMLElement;

  beforeEach(() => {
    win = makeWindow();
    installGlobals(win);
    root = win.document.getElementById('app') as unknown as HTMLElement;
  });

  it('constructs and wires up every panel', async () => {
    const { UI } = await import('../src/ui/hud');
    const ui = new UI(root, defaultSettings());

    // The title screen builds a difficulty pill row and a mood row.
    expect(root.querySelectorAll('.pill').length).toBeGreaterThanOrEqual(6);

    // The HUD builds a flow shell, tick marks and icon buttons.
    expect(root.querySelectorAll('.flow-shell').length).toBe(1);
    expect(root.querySelectorAll('.flow-tick').length).toBe(2);
    expect(root.querySelectorAll('.icon-btn').length).toBeGreaterThanOrEqual(2);

    // The settings modal builds its sections.
    expect(root.querySelectorAll('.settings-section').length).toBeGreaterThanOrEqual(4);

    // The APK card is present for browser (non-native) users.
    expect(root.querySelectorAll('.apk-card').length).toBe(1);

    // The touch layer is present for mobile.
    expect(root.querySelectorAll('.touch-layer').length).toBe(1);

    expect(ui).toBeTruthy();
  });

  it('switches between the title, HUD and summary states', async () => {
    const { UI } = await import('../src/ui/hud');
    const ui = new UI(root, defaultSettings());

    const title = root.querySelector('#title-screen')!;
    const hud = root.querySelector('#hud')!;
    const summary = root.querySelector('#summary')!;

    ui.showTitle();
    expect(title.classList.contains('is-visible')).toBe(true);
    expect(hud.classList.contains('is-visible')).toBe(false);

    ui.showHud();
    expect(title.classList.contains('is-visible')).toBe(false);
    expect(hud.classList.contains('is-visible')).toBe(true);
    expect(summary.classList.contains('is-visible')).toBe(false);

    ui.showSummary(
      { distance: 684, peakFlow: 92, cleanMoves: 7, flowSavesUsed: 1, time: 42 },
      500,
      'dead',
    );
    expect(summary.classList.contains('is-visible')).toBe(true);
    expect(root.querySelector('.summary-distance')!.textContent).toBe('684m');
    expect(root.querySelector('.summary-pb')!.textContent).toContain('NEW PERSONAL BEST');
    expect(root.querySelector('[data-stat="peak"]')!.textContent).toBe('92%');
    expect(root.querySelector('[data-stat="moves"]')!.textContent).toBe('7');
    expect(root.querySelector('[data-stat="saves"]')!.textContent).toBe('1');
  });

  it('reports a lower personal best without the NEW BEST callout', async () => {
    const { UI } = await import('../src/ui/hud');
    const ui = new UI(root, defaultSettings());
    ui.showSummary(
      { distance: 300, peakFlow: 40, cleanMoves: 1, flowSavesUsed: 0, time: 20 },
      900,
      'dead',
    );
    expect(root.querySelector('.summary-pb')!.textContent).toContain('Personal best 900m');
    expect(root.querySelector('.summary-pb')!.textContent).not.toContain('NEW');
  });

  it('updates the HUD from the flow meter state', async () => {
    const { UI } = await import('../src/ui/hud');
    const ui = new UI(root, defaultSettings());

    ui.showHud();
    ui.updateHud(412, 45, 2, false);
    expect(root.querySelector('.hud-distance')!.textContent).toBe('412m');
    expect((root.querySelector('.flow-fill') as HTMLElement).style.width).toBe('45%');
    expect(root.querySelector('.flow-tier')!.textContent).toBe('IN STRIDE');
    expect((root.querySelector('.flow-badge') as HTMLElement).style.display).toBe('none');

    ui.updateHud(412, 92, 3, true);
    expect(root.querySelector('.flow-tier')!.textContent).toBe('PURE FLOW');
    expect((root.querySelector('.flow-badge') as HTMLElement).style.display).toBe('inline-flex');
  });

  it('opens and closes the settings modal', async () => {
    const { UI } = await import('../src/ui/hud');
    const ui = new UI(root, defaultSettings());
    const modal = root.querySelector('#settings')!;

    expect(modal.classList.contains('is-visible')).toBe(false);
    ui.openSettings();
    expect(modal.classList.contains('is-visible')).toBe(true);
    expect(ui.settingsOpen).toBe(true);
    ui.closeSettings();
    expect(modal.classList.contains('is-visible')).toBe(false);
  });

  it('emits a play event when the PLAY button is clicked', async () => {
    const { UI } = await import('../src/ui/hud');
    new UI(root, defaultSettings());

    let played = false;
    root.addEventListener('stepwise:play', () => {
      played = true;
    });
    (root.querySelector('#play-button') as HTMLButtonElement).click();
    expect(played).toBe(true);
  });

  it('emits a difficulty change when a summary pill is clicked', async () => {
    const { UI } = await import('../src/ui/hud');
    new UI(root, defaultSettings());

    let detail: string | undefined;
    root.addEventListener('stepwise:difficulty', (e) => {
      detail = (e as CustomEvent<string>).detail;
    });

    const hardPill = Array.from(root.querySelectorAll('.mini-pill')).find(
      (b) => b.textContent === 'HARD',
    );
    expect(hardPill).toBeDefined();
    (hardPill as HTMLButtonElement).click();
    expect(detail).toBe('hard');
  });

  it('shows native Android controls instead of the APK card inside the wrapper', async () => {
    (win as unknown as Record<string, unknown>).Capacitor = { isNativePlatform: () => true };
    const { UI } = await import('../src/ui/hud');
    const ui = new UI(root, defaultSettings());

    // Inside the wrapper the download banner is replaced by native controls.
    expect(root.querySelectorAll('.apk-card').length).toBe(0);
    const fpsButtons = Array.from(root.querySelectorAll('.mini-pill')).filter((b) =>
      b.textContent?.includes('FPS'),
    );
    expect(fpsButtons.length).toBe(2);
    expect(ui).toBeTruthy();
  });

  it('points the APK card at the configured download URL', async () => {
    const { UI } = await import('../src/ui/hud');
    const { APK_DOWNLOAD_URL } = await import('../src/game/config');
    new UI(root, defaultSettings());

    const card = root.querySelector('.apk-card') as HTMLAnchorElement;
    expect(card).toBeTruthy();
    expect(card.getAttribute('href')).toBe(APK_DOWNLOAD_URL);
    expect(card.getAttribute('download')).toBe('stepwise.apk');
  });

  // ----------------------------------------------------------------------
  // Navigation: pause menu, summary actions and the settings round-trip.
  // ----------------------------------------------------------------------

  it('offers Home, Settings and Restart in the pause menu', async () => {
    const { UI } = await import('../src/ui/hud');
    new UI(root, defaultSettings());

    const pause = root.querySelector('#pause-screen')!;
    expect(pause.querySelector('#pause-home-button')).toBeTruthy();
    expect(pause.querySelector('#pause-settings-button')).toBeTruthy();
    expect(pause.querySelector('#pause-restart-button')).toBeTruthy();
  });

  it('dispatches a home request from the pause menu', async () => {
    const { UI } = await import('../src/ui/hud');
    new UI(root, defaultSettings());

    let home = 0;
    root.addEventListener('stepwise:home', () => {
      home += 1;
    });

    (root.querySelector('#pause-home-button') as HTMLButtonElement).click();
    expect(home).toBe(1);
  });

  it('dispatches a restart request from the pause menu', async () => {
    const { UI } = await import('../src/ui/hud');
    new UI(root, defaultSettings());

    let restarts = 0;
    root.addEventListener('stepwise:restart', () => {
      restarts += 1;
    });

    (root.querySelector('#pause-restart-button') as HTMLButtonElement).click();
    expect(restarts).toBe(1);
  });

  it('opens the settings modal from the pause menu and returns to pause on close', async () => {
    const { UI } = await import('../src/ui/hud');
    const ui = new UI(root, defaultSettings());

    ui.showPause();

    // The pause menu asks the app to open settings with `pause` as the
    // return destination.
    root.dispatchEvent(new CustomEvent('stepwise:open-settings', { detail: 'pause' }));

    const settings = root.querySelector('#settings')!;
    const pause = root.querySelector('#pause-screen')!;
    expect(settings.classList.contains('is-visible')).toBe(true);
    // The pause card hides while the modal is up.
    expect(pause.classList.contains('is-visible')).toBe(false);

    ui.closeSettings();
    expect(settings.classList.contains('is-visible')).toBe(false);
    // Closing returns the player to the pause card.
    expect(pause.classList.contains('is-visible')).toBe(true);
  });

  it('opens the settings modal from the run summary and returns to the summary', async () => {
    const { UI } = await import('../src/ui/hud');
    const ui = new UI(root, defaultSettings());

    const summary = root.querySelector('#summary')!;
    summary.classList.add('is-visible');

    root.dispatchEvent(new CustomEvent('stepwise:open-settings', { detail: 'summary' }));

    const settings = root.querySelector('#settings')!;
    expect(settings.classList.contains('is-visible')).toBe(true);
    expect(summary.classList.contains('is-visible')).toBe(false);

    ui.closeSettings();
    expect(summary.classList.contains('is-visible')).toBe(true);
  });

  it('offers Home and Settings on the run summary', async () => {
    const { UI } = await import('../src/ui/hud');
    new UI(root, defaultSettings());

    const summary = root.querySelector('#summary')!;
    expect(summary.querySelector('#summary-home-button')).toBeTruthy();
    expect(summary.querySelector('#summary-settings-button')).toBeTruthy();
  });

  it('dispatches a home request from the run summary', async () => {
    const { UI } = await import('../src/ui/hud');
    new UI(root, defaultSettings());

    let home = 0;
    root.addEventListener('stepwise:home', () => {
      home += 1;
    });

    (root.querySelector('#summary-home-button') as HTMLButtonElement).click();
    expect(home).toBe(1);
  });

  it('always dismisses the settings modal when returning to the title screen', async () => {
    const { UI } = await import('../src/ui/hud');
    const ui = new UI(root, defaultSettings());

    ui.openSettings('pause');
    ui.showTitle();

    const settings = root.querySelector('#settings')!;
    const title = root.querySelector('#title-screen')!;
    expect(settings.classList.contains('is-visible')).toBe(false);
    expect(title.classList.contains('is-visible')).toBe(true);
  });
});
