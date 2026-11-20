/**
 * Input handling: keyboard + multi-touch.
 *
 * The keyboard layer and the touch layer both write into a single shared
 * `InputState`, which the simulation reads once per fixed step.
 */

import { createInputState, type InputState } from '../core/types';

export type InputAction = 'left' | 'right' | 'jump' | 'crouch' | 'restart' | 'pause' | 'debug';

export class InputManager {
  readonly state: InputState = createInputState();

  /** Set of currently pressed logical actions. */
  private pressed = new Set<string>();

  /** True when the last input came from touch. */
  touchActive = false;

  /** Auto-sprint assist for mobile. */
  autoSprint = false;

  /** Touch state for the on-screen indicators. */
  touchLeft = { active: false, dx: 0, x: 0, y: 0 };
  touchRight = { active: false, mode: 'none' as 'none' | 'jump' | 'crouch' };

  /** Gesture guides are shown for the first few seconds of a mobile run. */
  showGestureGuides = true;
  gestureGuideTimer = 0;

  private onAction?: (action: InputAction) => void;

  constructor(private target: HTMLElement | Window = window) {
    this.bindKeyboard();
    this.bindTouch();
  }

  setActionHandler(handler: (action: InputAction) => void): void {
    this.onAction = handler;
  }

  private bindKeyboard(): void {
    const down = (e: KeyboardEvent) => {
      const code = e.code;
      const key = e.key.toLowerCase();

      // Prevent the page from scrolling while playing.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) {
        e.preventDefault();
      }

      if (this.pressed.has(code)) return; // ignore auto-repeat
      this.pressed.add(code);

      switch (code) {
        case 'KeyA':
        case 'ArrowLeft':
          this.onAction?.('left');
          break;
        case 'KeyD':
        case 'ArrowRight':
          this.onAction?.('right');
          break;
        case 'Space':
        case 'KeyW':
        case 'ArrowUp':
          this.onAction?.('jump');
          break;
        case 'KeyS':
        case 'ArrowDown':
        case 'ShiftLeft':
        case 'ShiftRight':
          this.onAction?.('crouch');
          break;
        case 'KeyR':
          this.onAction?.('restart');
          break;
        case 'Escape':
        case 'KeyP':
          this.onAction?.('pause');
          break;
        case 'KeyI':
          this.onAction?.('debug');
          break;
        default:
          break;
      }
      if (key === 'enter') this.onAction?.('jump');
    };

    const up = (e: KeyboardEvent) => {
      this.pressed.delete(e.code);
    };

    window.addEventListener('keydown', down, { passive: false });
    window.addEventListener('keyup', up);
    window.addEventListener('blur', () => {
      this.pressed.clear();
    });
  }

  private bindTouch(): void {
    const el = this.target as HTMLElement;
    if (!el || !('ontouchstart' in window)) {
      // Still attach pointer handlers for desktop testing of touch controls.
      this.bindPointerFallback(el);
      return;
    }

    const active = new Map<
      number,
      { side: 'left' | 'right'; x: number; y: number; startX: number; startY: number }
    >();

    const handleStart = (e: TouchEvent) => {
      this.touchActive = true;
      for (const t of Array.from(e.changedTouches)) {
        const rect = el.getBoundingClientRect();
        const side: 'left' | 'right' = t.clientX - rect.left < rect.width * 0.5 ? 'left' : 'right';
        active.set(t.identifier, {
          side,
          x: t.clientX - rect.left,
          y: t.clientY - rect.top,
          startX: t.clientX - rect.left,
          startY: t.clientY - rect.top,
        });

        if (side === 'right') {
          // A downward swipe means slide/tuck-roll.
          if (t.clientY - rect.top > rect.height * 0.6) {
            this.touchRight.mode = 'crouch';
            this.onAction?.('crouch');
          } else {
            this.touchRight.mode = 'jump';
            this.onAction?.('jump');
          }
        }
      }
      e.preventDefault();
    };

    const handleMove = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        const rec = active.get(t.identifier);
        if (!rec) continue;
        const rect = el.getBoundingClientRect();
        rec.x = t.clientX - rect.left;
        rec.y = t.clientY - rect.top;

        if (rec.side === 'right') {
          // Swipe down converts a jump into a slide.
          const dy = rec.y - rec.startY;
          if (dy > 34 && this.touchRight.mode === 'jump') {
            this.touchRight.mode = 'crouch';
            this.onAction?.('crouch');
          }
        }
      }
      e.preventDefault();
    };

    const handleEnd = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        active.delete(t.identifier);
      }
      e.preventDefault();
    };

    el.addEventListener('touchstart', handleStart, { passive: false });
    el.addEventListener('touchmove', handleMove, { passive: false });
    el.addEventListener('touchend', handleEnd, { passive: false });
    el.addEventListener('touchcancel', handleEnd, { passive: false });

    this.touchPositions = active;
  }

  private bindPointerFallback(el: HTMLElement): void {
    // Pointer Events cover touch-capable browsers that do not expose the
    // legacy ontouchstart feature flag. Keep the same shared input model as
    // the Touch Events path so left-thumb pacing and held jump/slide work.
    const active = new Map<
      number,
      { side: 'left' | 'right'; x: number; y: number; startX: number; startY: number }
    >();

    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      this.touchActive = true;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const side: 'left' | 'right' = x < rect.width * 0.5 ? 'left' : 'right';
      active.set(e.pointerId, { side, x, y, startX: x, startY: y });

      if (side === 'right') {
        this.touchRight.mode = y > rect.height * 0.6 ? 'crouch' : 'jump';
        this.onAction?.(this.touchRight.mode);
      }
      this.touchPositions = active;
      e.preventDefault();
    };

    const move = (e: PointerEvent) => {
      const rec = active.get(e.pointerId);
      if (!rec) return;
      const rect = el.getBoundingClientRect();
      rec.x = e.clientX - rect.left;
      rec.y = e.clientY - rect.top;

      if (rec.side === 'right' && rec.y - rec.startY > 34 && this.touchRight.mode === 'jump') {
        this.touchRight.mode = 'crouch';
        this.onAction?.('crouch');
      }
      e.preventDefault();
    };

    const up = (e: PointerEvent) => {
      const rec = active.get(e.pointerId);
      active.delete(e.pointerId);
      if (rec?.side === 'right' && !Array.from(active.values()).some((item) => item.side === 'right')) {
        this.touchRight.mode = 'none';
      }
      e.preventDefault();
    };

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    this.touchPositions = active;
  }

  private touchPositions?: Map<
    number,
    { side: 'left' | 'right'; x: number; y: number; startX: number; startY: number }
  >;

  /** Snapshot of the left thumb's drag, in pixels from the origin. */
  get leftThumbDx(): number {
    return this.touchLeft.dx;
  }

  /** Updates the shared input state. Call once per rendered frame. */
  update(): void {
    const s = this.state;

    // --- Keyboard ---------------------------------------------------------
    let moveX = 0;
    if (this.pressed.has('KeyA') || this.pressed.has('ArrowLeft')) moveX -= 1;
    if (this.pressed.has('KeyD') || this.pressed.has('ArrowRight')) moveX += 1;

    let jumpHeld =
      this.pressed.has('Space') || this.pressed.has('KeyW') || this.pressed.has('ArrowUp');
    let crouchHeld =
      this.pressed.has('KeyS') ||
      this.pressed.has('ArrowDown') ||
      this.pressed.has('ShiftLeft') ||
      this.pressed.has('ShiftRight');

    // --- Touch -------------------------------------------------------------
    if (this.touchPositions && this.touchPositions.size > 0) {
      let leftDx = 0;
      let rightTouched = false;
      for (const rec of this.touchPositions.values()) {
        if (rec.side === 'left') {
          leftDx = rec.x - rec.startX;
        } else {
          rightTouched = true;
        }
      }
      this.touchLeft.dx = leftDx;
      this.touchLeft.active = leftDx !== 0 || this.touchPositions.size > 0;

      // The left thumb acts as a dynamic pace control: a dead zone in the
      // middle, full throttle at the extremes.
      const dead = 14;
      if (leftDx > dead) moveX = 1;
      else if (leftDx < -dead) moveX = -1;
      else if (this.autoSprint) moveX = 1;

      if (rightTouched) {
        if (this.touchRight.mode === 'jump') jumpHeld = true;
        if (this.touchRight.mode === 'crouch') crouchHeld = true;
      }
    } else {
      // Do not leave stale thumb indicators or held gestures after the last
      // pointer is released/cancelled.
      this.touchLeft.dx = 0;
      this.touchLeft.active = false;
      this.touchRight.mode = 'none';
      if (this.touchActive && this.autoSprint) moveX = 1;
    }

    // --- Edge detection ----------------------------------------------------
    // Jump/crouch "pressed" edges are latched by the action handler so that a
    // press is never missed between simulation steps.
    s.moveX = moveX;
    s.jumpHeld = jumpHeld;
    s.crouchHeld = crouchHeld;
  }

  /** Latches a jump press (edge). */
  latchJump(): void {
    this.state.jumpPressed = true;
  }

  /** Latches a crouch press (edge). */
  latchCrouch(): void {
    this.state.crouchPressed = true;
  }

  /** Clears the latched edges — called after the simulation consumes them. */
  clearEdges(): void {
    this.state.jumpPressed = false;
    this.state.crouchPressed = false;
  }

  /** Tracks how long the gesture guides should remain visible. */
  tickGuides(dt: number): void {
    if (!this.showGestureGuides) return;
    this.gestureGuideTimer += dt;
    if (this.gestureGuideTimer > 5) this.showGestureGuides = false;
  }

  /** Marks the guides as seen. */
  dismissGuides(): void {
    this.showGestureGuides = false;
  }
}
