/**
 * HUD, title overlay, run summary and settings modal.
 *
 * The UI is DOM-based (not canvas) so it stays crisp at any DPI, respects
 * safe-area insets and is fully accessible via keyboard.
 */

import { DIFFICULTY_TUNING, APK_DOWNLOAD_URL, APP_VERSION, SKY_MOODS } from '../game/config';
import type { Difficulty, GameSettings, SkyMood } from '../core/types';
import type { RunStats } from '../core/types';

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: 'EASY',
  medium: 'MEDIUM',
  hard: 'HARD',
};

const DIFFICULTY_NAMES: Record<Difficulty, string> = {
  easy: 'Rooftop Cruise',
  medium: 'City Flow',
  hard: 'Razorline',
};

export interface UIRefs {
  root: HTMLElement;
  titleScreen: HTMLElement;
  hud: HTMLElement;
  summary: HTMLElement;
  settings: HTMLElement;
  pauseScreen: HTMLElement;
}

export class UI {
  private refs: UIRefs;
  private settings: GameSettings;

  // Cached DOM nodes.
  private distanceEl!: HTMLElement;
  private difficultyTagEl!: HTMLElement;
  private flowFillEl!: HTMLElement;
  private flowBadgeEl!: HTMLElement;
  private tierLabelEl!: HTMLElement;

  private summaryHeaderEl!: HTMLElement;
  private summaryDistanceEl!: HTMLElement;
  private summaryPBEl!: HTMLElement;
  private summaryPeakEl!: HTMLElement;
  private summaryMovesEl!: HTMLElement;
  private summarySavesEl!: HTMLElement;
  private summaryDiffButtons!: HTMLButtonElement[];
  private summaryMoodButtons!: HTMLButtonElement[];

  private titleDiffButtons!: HTMLButtonElement[];
  private titleMoodButtons!: HTMLButtonElement[];

  /**
   * Where the settings modal should send the user when it closes. The modal
   * can be opened from the title screen, the pause menu or the run summary,
   * and each of those has a different "back" destination.
   */
  private settingsReturn: 'title' | 'pause' | 'summary' = 'title';

  constructor(root: HTMLElement, settings: GameSettings) {
    this.refs = {
      root,
      titleScreen: root.querySelector('#title-screen')!,
      hud: root.querySelector('#hud')!,
      summary: root.querySelector('#summary')!,
      settings: root.querySelector('#settings')!,
      pauseScreen: root.querySelector('#pause-screen')!,
    };
    this.settings = settings;
    this.build();
    // The UI handles its own "open settings" requests so the modal works
    // whether it is triggered by the pause menu, the summary, or the app.
    this.refs.root.addEventListener('stepwise:open-settings', ((
      e: CustomEvent<'title' | 'pause' | 'summary'>,
    ) => {
      this.openSettings(e.detail ?? 'title');
    }) as EventListener);
  }

  // ----------------------------------------------------------------------
  // Construction
  // ----------------------------------------------------------------------
  private build(): void {
    this.buildTitle();
    this.buildHud();
    this.buildPauseMenu();
    this.buildSummary();
    this.buildSummaryActions();
    this.buildSettings();
  }

  private buildTitle(): void {
    const screen = this.refs.titleScreen;

    const diffRow = document.createElement('div');
    diffRow.className = 'pill-row';
    diffRow.setAttribute('role', 'group');
    diffRow.setAttribute('aria-label', 'Difficulty');

    this.titleDiffButtons = (['easy', 'medium', 'hard'] as Difficulty[]).map((d) => {
      const btn = document.createElement('button');
      btn.className = 'pill';
      btn.textContent = DIFFICULTY_LABELS[d];
      btn.title = DIFFICULTY_NAMES[d];
      btn.dataset.difficulty = d;
      btn.setAttribute('aria-pressed', String(this.settings.difficulty === d));
      if (this.settings.difficulty === d) btn.classList.add('is-active');
      btn.addEventListener('click', () => {
        this.settings.difficulty = d;
        this.syncTitleDifficulty();
      });
      diffRow.appendChild(btn);
      return btn;
    });

    const moodRow = document.createElement('div');
    moodRow.className = 'pill-row mood-row';
    moodRow.setAttribute('role', 'group');
    moodRow.setAttribute('aria-label', 'Sky mood');

    this.titleMoodButtons = (['dusk', 'rain', 'dawn'] as SkyMood[]).map((m) => {
      const btn = document.createElement('button');
      btn.className = 'pill pill-mood';
      btn.textContent = SKY_MOODS[m].label;
      btn.dataset.mood = m;
      btn.setAttribute('aria-pressed', String(this.settings.skyMood === m));
      if (this.settings.skyMood === m) btn.classList.add('is-active');
      btn.addEventListener('click', () => {
        this.settings.skyMood = m;
        this.syncTitleMood();
      });
      moodRow.appendChild(btn);
      return btn;
    });

    const playBtn = screen.querySelector<HTMLButtonElement>('#play-button')!;
    playBtn.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('stepwise:play'));
    });

    const settingsBtn = screen.querySelector<HTMLButtonElement>('#title-settings-button')!;
    settingsBtn.addEventListener('click', () => this.openSettings());

    screen.appendChild(diffRow);
    screen.appendChild(moodRow);
  }

  private buildHud(): void {
    const hud = this.refs.hud;

    // The HUD markup already exists in index.html so it is visible before the
    // module loads (no flash of an empty HUD). The module BINDS to it rather
    // than creating a second copy.
    this.distanceEl = hud.querySelector<HTMLElement>('.hud-distance')!;
    this.difficultyTagEl = hud.querySelector<HTMLElement>('.hud-difficulty')!;
    this.flowFillEl = hud.querySelector<HTMLElement>('.flow-fill')!;
    this.flowBadgeEl = hud.querySelector<HTMLElement>('.flow-badge')!;
    this.tierLabelEl = hud.querySelector<HTMLElement>('.flow-tier')!;

    // The flow badge starts hidden until Pure Flow arms the Flow Save.
    this.flowBadgeEl.style.display = 'none';

    // --- Top-right: restart + pause ---
    const restartBtn = hud.querySelector<HTMLButtonElement>('#hud-restart');
    if (restartBtn) {
      restartBtn.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('stepwise:restart'));
      });
    }
    const pauseBtn = hud.querySelector<HTMLButtonElement>('#hud-pause');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('stepwise:pause'));
      });
    }

    // --- Touch controls (mobile) ---
    if (!hud.querySelector('.touch-layer')) {
      const touch = document.createElement('div');
      touch.className = 'touch-layer';
      touch.innerHTML = `
      <div class="touch-zone touch-left-zone">
        <div class="touch-hint touch-hint-left">
          <span class="touch-arrow">&#8592;</span>
          <span class="touch-arrow">&#8594;</span>
          <span class="touch-label">PACE</span>
        </div>
      </div>
      <div class="touch-zone touch-right-zone">
        <div class="touch-hint touch-hint-right">
          <span class="touch-label">JUMP</span>
          <span class="touch-label">SWIPE DOWN = SLIDE</span>
        </div>
      </div>`;
      hud.appendChild(touch);
    }
  }

  /**
   * Wires the pause menu. The pause card is the player's escape hatch
   * mid-run, so it needs a way back into the game, into the settings, and
   * out to the title screen.
   */
  private buildPauseMenu(): void {
    const pause = this.refs.pauseScreen;

    pause
      .querySelector<HTMLButtonElement>('#pause-settings-button')
      ?.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('stepwise:open-settings', { detail: 'pause' }));
      });
    pause
      .querySelector<HTMLButtonElement>('#pause-restart-button')
      ?.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('stepwise:restart'));
      });
    pause.querySelector<HTMLButtonElement>('#pause-home-button')?.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('stepwise:home'));
    });
  }

  /**
   * Wires the run summary actions. A finished run should be able to leave
   * for the title screen or adjust settings without starting another run.
   */
  private buildSummaryActions(): void {
    const summary = this.refs.summary;

    summary
      .querySelector<HTMLButtonElement>('#summary-settings-button')
      ?.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('stepwise:open-settings', { detail: 'summary' }));
      });
    summary
      .querySelector<HTMLButtonElement>('#summary-home-button')
      ?.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('stepwise:home'));
      });
  }

  private buildSummary(): void {
    const summary = this.refs.summary;
    const card = summary.querySelector('.summary-card')!;

    this.summaryHeaderEl = card.querySelector('.summary-header')!;
    this.summaryDistanceEl = card.querySelector('.summary-distance')!;
    this.summaryPBEl = card.querySelector('.summary-pb')!;

    const statGrid = card.querySelector('.summary-stats')!;
    this.summaryPeakEl = statGrid.querySelector('[data-stat="peak"]')!;
    this.summaryMovesEl = statGrid.querySelector('[data-stat="moves"]')!;
    this.summarySavesEl = statGrid.querySelector('[data-stat="saves"]')!;

    // Difficulty quick-switch.
    const diffWrap = card.querySelector('.summary-diffs')!;
    this.summaryDiffButtons = (['easy', 'medium', 'hard'] as Difficulty[]).map((d) => {
      const btn = document.createElement('button');
      btn.className = 'mini-pill';
      btn.textContent = DIFFICULTY_LABELS[d];
      btn.addEventListener('click', () => {
        this.settings.difficulty = d;
        this.syncSummaryDifficulty();
        this.dispatchEvent(new CustomEvent('stepwise:difficulty', { detail: d }));
      });
      diffWrap.appendChild(btn);
      return btn;
    });

    // Mood quick-switch.
    const moodWrap = card.querySelector('.summary-moods')!;
    this.summaryMoodButtons = (['dusk', 'rain', 'dawn'] as SkyMood[]).map((m) => {
      const btn = document.createElement('button');
      btn.className = 'mini-pill';
      btn.textContent = SKY_MOODS[m].label;
      btn.addEventListener('click', () => {
        this.settings.skyMood = m;
        this.syncSummaryMood();
        this.dispatchEvent(new CustomEvent('stepwise:mood', { detail: m }));
      });
      moodWrap.appendChild(btn);
      return btn;
    });

    const againBtn = card.querySelector<HTMLButtonElement>('#again-button')!;
    againBtn.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('stepwise:play'));
    });
  }

  private buildSettings(): void {
    const modal = this.refs.settings;
    const body = modal.querySelector('.settings-body')!;

    // --- Sky mood ---
    const moodSection = document.createElement('section');
    moodSection.className = 'settings-section';
    moodSection.innerHTML = '<h3>Sky Mood</h3>';
    const moodRow = document.createElement('div');
    moodRow.className = 'pill-row';
    (['dusk', 'rain', 'dawn'] as SkyMood[]).forEach((m) => {
      const btn = document.createElement('button');
      btn.className = 'pill';
      btn.textContent = SKY_MOODS[m].label;
      btn.dataset.mood = m;
      btn.addEventListener('click', () => {
        this.settings.skyMood = m;
        this.syncAllMoods();
        this.dispatchEvent(new CustomEvent('stepwise:mood', { detail: m }));
      });
      moodRow.appendChild(btn);
    });
    moodSection.appendChild(moodRow);
    body.appendChild(moodSection);

    // --- Audio ---
    const audioSection = document.createElement('section');
    audioSection.className = 'settings-section';
    audioSection.innerHTML = '<h3>Audio</h3>';
    const volumeRow = document.createElement('div');
    volumeRow.className = 'slider-row';
    const volLabel = document.createElement('label');
    volLabel.textContent = 'Master Volume';
    volLabel.htmlFor = 'volume-slider';
    const volSlider = document.createElement('input');
    volSlider.type = 'range';
    volSlider.id = 'volume-slider';
    volSlider.min = '0';
    volSlider.max = '100';
    volSlider.value = String(Math.round(this.settings.masterVolume * 100));
    const volValue = document.createElement('span');
    volValue.className = 'slider-value';
    volValue.textContent = `${Math.round(this.settings.masterVolume * 100)}%`;
    volSlider.addEventListener('input', () => {
      const v = Number(volSlider.value) / 100;
      this.settings.masterVolume = v;
      volValue.textContent = `${volSlider.value}%`;
      this.dispatchEvent(new CustomEvent('stepwise:volume', { detail: v }));
    });
    volumeRow.appendChild(volLabel);
    volumeRow.appendChild(volSlider);
    volumeRow.appendChild(volValue);

    const muteRow = document.createElement('div');
    muteRow.className = 'toggle-row';
    const muteLabel = document.createElement('span');
    muteLabel.textContent = 'Mute';
    const muteToggle = this.makeToggle(this.settings.muted, (on) => {
      this.settings.muted = on;
      this.dispatchEvent(new CustomEvent('stepwise:mute', { detail: on }));
    });
    muteRow.appendChild(muteLabel);
    muteRow.appendChild(muteToggle);
    audioSection.appendChild(volumeRow);
    audioSection.appendChild(muteRow);
    body.appendChild(audioSection);

    // --- Mobile assist ---
    const mobileSection = document.createElement('section');
    mobileSection.className = 'settings-section';
    mobileSection.innerHTML = '<h3>Mobile Assist</h3>';
    const autoRow = document.createElement('div');
    autoRow.className = 'toggle-row';
    const autoLabel = document.createElement('span');
    autoLabel.textContent = 'Auto-Sprint Assist';
    const autoHelp = document.createElement('small');
    autoHelp.textContent = 'Lets you focus on jump, vault and slide timing with one thumb.';
    const autoToggle = this.makeToggle(this.settings.autoSprint, (on) => {
      this.settings.autoSprint = on;
      this.dispatchEvent(new CustomEvent('stepwise:autosprint', { detail: on }));
    });
    autoRow.appendChild(autoLabel);
    autoRow.appendChild(autoToggle);
    mobileSection.appendChild(autoRow);
    mobileSection.appendChild(autoHelp);
    body.appendChild(mobileSection);

    // --- Developer ---
    const devSection = document.createElement('section');
    devSection.className = 'settings-section';
    devSection.innerHTML = '<h3>Developer</h3>';
    const debugRow = document.createElement('div');
    debugRow.className = 'toggle-row';
    const debugLabel = document.createElement('span');
    debugLabel.textContent = 'Show IK Skeleton & Raycasts';
    const debugToggle = this.makeToggle(this.settings.showDebug, (on) => {
      this.settings.showDebug = on;
      this.dispatchEvent(new CustomEvent('stepwise:debug', { detail: on }));
    });
    debugRow.appendChild(debugLabel);
    debugRow.appendChild(debugToggle);
    devSection.appendChild(debugRow);
    body.appendChild(devSection);

    // --- Platform section: APK download or native controls ---
    const platformSection = document.createElement('section');
    platformSection.className = 'settings-section';
    const isNative = this.isNativeWrapper();
    platformSection.innerHTML = isNative ? '<h3>Android</h3>' : '<h3>Android App</h3>';

    if (isNative) {
      const hapticsRow = document.createElement('div');
      hapticsRow.className = 'toggle-row';
      const hapticsLabel = document.createElement('span');
      hapticsLabel.textContent = 'Native Haptics';
      const hapticsToggle = this.makeToggle(this.settings.haptics, (on) => {
        this.settings.haptics = on;
        this.dispatchEvent(new CustomEvent('stepwise:haptics', { detail: on }));
      });
      hapticsRow.appendChild(hapticsLabel);
      hapticsRow.appendChild(hapticsToggle);
      platformSection.appendChild(hapticsRow);

      const fpsRow = document.createElement('div');
      fpsRow.className = 'toggle-row';
      const fpsLabel = document.createElement('span');
      fpsLabel.textContent = 'Frame Rate Target';
      const fpsWrap = document.createElement('div');
      fpsWrap.className = 'pill-row';
      ([60, 120] as const).forEach((fps) => {
        const btn = document.createElement('button');
        btn.className = 'mini-pill';
        btn.textContent = `${fps} FPS`;
        btn.dataset.fps = String(fps);
        if (this.settings.frameRateTarget === fps) btn.classList.add('is-active');
        btn.addEventListener('click', () => {
          this.settings.frameRateTarget = fps;
          fpsWrap.querySelectorAll('.mini-pill').forEach((b) => b.classList.remove('is-active'));
          btn.classList.add('is-active');
          this.dispatchEvent(new CustomEvent('stepwise:fps', { detail: fps }));
        });
        fpsWrap.appendChild(btn);
      });
      fpsRow.appendChild(fpsLabel);
      fpsRow.appendChild(fpsWrap);
      platformSection.appendChild(fpsRow);

      const note = document.createElement('small');
      note.className = 'platform-note';
      note.textContent = 'Running in the installed Android app — full-screen landscape is locked.';
      platformSection.appendChild(note);
    } else {
      const card = document.createElement('a');
      card.className = 'apk-card';
      card.href = APK_DOWNLOAD_URL;
      card.download = 'stepwise.apk';
      card.innerHTML = `
        <div class="apk-icon" aria-hidden="true">&#9001;</div>
        <div class="apk-text">
          <strong>Download Android APK</strong>
          <span class="apk-sub">One-Tap Install &middot; v${APP_VERSION} &middot; Full-screen offline edition</span>
        </div>
        <span class="apk-badge">APK</span>`;
      platformSection.appendChild(card);

      const tip = document.createElement('small');
      tip.className = 'platform-note';
      tip.textContent =
        'Tap Download → Open the APK to install the full-screen offline mobile edition.';
      platformSection.appendChild(tip);
    }
    body.appendChild(platformSection);

    // --- Close button ---
    const closeBtn = modal.querySelector<HTMLButtonElement>('#settings-close')!;
    closeBtn.addEventListener('click', () => this.closeSettings());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) this.closeSettings();
    });

    this.syncAllMoods();
    this.syncTitleDifficulty();
    this.syncSummaryDifficulty();
  }

  private makeToggle(initial: boolean, onChange: (on: boolean) => void): HTMLElement {
    const wrap = document.createElement('button');
    wrap.className = 'toggle';
    wrap.setAttribute('role', 'switch');
    wrap.setAttribute('aria-checked', String(initial));
    if (initial) wrap.classList.add('is-on');
    const knob = document.createElement('span');
    knob.className = 'toggle-knob';
    wrap.appendChild(knob);
    wrap.addEventListener('click', () => {
      const on = !wrap.classList.contains('is-on');
      wrap.classList.toggle('is-on', on);
      wrap.setAttribute('aria-checked', String(on));
      onChange(on);
    });
    return wrap;
  }

  private isNativeWrapper(): boolean {
    // The Capacitor/Bubblewrap wrapper injects a global flag; we also treat a
    // standalone display-mode web app as native.
    const w = window as unknown as {
      Capacitor?: { isNativePlatform?: () => boolean };
      __stepwiseNative?: boolean;
    };
    if (w.__stepwiseNative) return true;
    try {
      if (w.Capacitor?.isNativePlatform?.()) return true;
    } catch {
      /* ignore */
    }
    return false;
  }

  // ----------------------------------------------------------------------
  // Sync helpers
  // ----------------------------------------------------------------------
  private syncTitleDifficulty(): void {
    for (const btn of this.titleDiffButtons) {
      const on = btn.dataset.difficulty === this.settings.difficulty;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    this.syncSummaryDifficulty();
    this.difficultyTagEl.textContent = DIFFICULTY_NAMES[this.settings.difficulty];
  }

  private syncSummaryDifficulty(): void {
    for (const btn of this.summaryDiffButtons) {
      btn.classList.toggle(
        'is-active',
        btn.textContent === DIFFICULTY_LABELS[this.settings.difficulty],
      );
    }
  }

  private syncAllMoods(): void {
    for (const btn of this.titleMoodButtons) {
      const on = btn.dataset.mood === this.settings.skyMood;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    for (const btn of this.summaryMoodButtons) {
      btn.classList.toggle('is-active', btn.textContent === SKY_MOODS[this.settings.skyMood].label);
    }
    const modal = this.refs.settings.querySelectorAll<HTMLButtonElement>('[data-mood]');
    modal.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.mood === this.settings.skyMood);
    });
  }

  private syncTitleMood(): void {
    this.syncAllMoods();
  }

  private syncSummaryMood(): void {
    this.syncAllMoods();
  }

  private dispatchEvent(ev: Event): void {
    this.refs.root.dispatchEvent(ev);
  }

  // ----------------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------------
  showTitle(): void {
    this.refs.titleScreen.classList.add('is-visible');
    this.refs.hud.classList.remove('is-visible');
    this.refs.summary.classList.remove('is-visible');
    this.refs.pauseScreen.classList.remove('is-visible');
    // The settings modal is always dismissed on the way home so it can
    // never be left stranded on top of the title screen.
    this.refs.settings.classList.remove('is-visible');
  }

  showHud(): void {
    this.refs.titleScreen.classList.remove('is-visible');
    this.refs.hud.classList.add('is-visible');
    this.refs.summary.classList.remove('is-visible');
    this.refs.pauseScreen.classList.remove('is-visible');
  }

  showPause(): void {
    this.refs.pauseScreen.classList.add('is-visible');
  }

  hidePause(): void {
    this.refs.pauseScreen.classList.remove('is-visible');
  }

  openSettings(from: 'title' | 'pause' | 'summary' = 'title'): void {
    this.settingsReturn = from;
    // Hide the screen underneath so the modal is the only thing on screen;
    // it is restored when the modal closes.
    if (from === 'pause') {
      this.refs.pauseScreen.classList.remove('is-visible');
    } else if (from === 'summary') {
      this.refs.summary.classList.remove('is-visible');
    }
    this.refs.settings.classList.add('is-visible');
    this.syncAllMoods();
  }

  closeSettings(): void {
    this.refs.settings.classList.remove('is-visible');
    // Return the player to whatever screen they opened settings from, so
    // closing the modal mid-run does not drop them back into the action.
    if (this.settingsReturn === 'pause') {
      this.refs.pauseScreen.classList.add('is-visible');
    } else if (this.settingsReturn === 'summary') {
      this.refs.summary.classList.add('is-visible');
    }
  }

  /** Dismisses the settings modal without restoring the previous screen. */
  dismissSettings(): void {
    this.refs.settings.classList.remove('is-visible');
  }

  get settingsOpen(): boolean {
    return this.refs.settings.classList.contains('is-visible');
  }

  /** Updates the live HUD. */
  updateHud(distanceMetres: number, flowValue: number, tier: number, flowArmed: boolean): void {
    this.distanceEl.textContent = `${Math.floor(distanceMetres)}m`;
    this.flowFillEl.style.width = `${Math.max(0, Math.min(100, flowValue))}%`;
    this.flowFillEl.dataset.tier = String(tier);
    this.flowBadgeEl.style.display = flowArmed ? 'inline-flex' : 'none';
    this.tierLabelEl.textContent = tier === 3 ? 'PURE FLOW' : tier === 2 ? 'IN STRIDE' : 'STEADY';
    this.tierLabelEl.dataset.tier = String(tier);
  }

  /** Fills in the run-end summary card. */
  showSummary(stats: RunStats, personalBest: number, outcome: 'dead' | 'finished'): void {
    this.refs.hud.classList.remove('is-visible');
    this.refs.summary.classList.add('is-visible');

    this.summaryHeaderEl.textContent = outcome === 'dead' ? 'RUN ENDED' : 'ROOFTOP CLEARED';
    this.summaryHeaderEl.dataset.outcome = outcome;

    this.summaryDistanceEl.textContent = `${Math.floor(stats.distance)}m`;
    const isPB = stats.distance >= personalBest && stats.distance > 0;
    this.summaryPBEl.textContent = isPB
      ? 'NEW PERSONAL BEST'
      : `Personal best ${Math.floor(personalBest)}m`;
    this.summaryPBEl.dataset.pb = String(isPB);

    this.summaryPeakEl.textContent = `${Math.floor(stats.peakFlow)}%`;
    this.summaryMovesEl.textContent = `${stats.cleanMoves}`;
    this.summarySavesEl.textContent = `${stats.flowSavesUsed}`;

    this.syncSummaryDifficulty();
    this.syncAllMoods();
  }

  /** Shows/hides the mobile gesture guides. */
  setGestureGuides(visible: boolean): void {
    this.refs.hud.classList.toggle('show-guides', visible);
  }
}

export { DIFFICULTY_TUNING };
