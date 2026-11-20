import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputManager } from '../src/core/input';

type PointerLike = {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  preventDefault: () => void;
};

function createPointerTarget() {
  const listeners = new Map<string, Array<(event: PointerLike) => void>>();
  const target = {
    addEventListener(type: string, listener: (event: PointerLike) => void) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 400, height: 800, right: 400, bottom: 800, x: 0, y: 0, toJSON: () => ({}) };
    },
    setPointerCapture: vi.fn(),
  };

  return {
    element: target as unknown as HTMLElement,
    dispatch(type: string, event: Omit<PointerLike, 'preventDefault'>) {
      for (const listener of listeners.get(type) ?? []) {
        listener({ ...event, preventDefault: vi.fn() });
      }
    },
    setPointerCapture: target.setPointerCapture,
  };
}

function pointer(pointerId: number, clientX: number, clientY: number): Omit<PointerLike, 'preventDefault'> {
  return { pointerId, pointerType: 'touch', clientX, clientY };
}

describe('InputManager pointer fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createManager() {
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    const target = createPointerTarget();
    const input = new InputManager(target.element);
    return { input, target };
  }

  it('maps a left-thumb drag to horizontal movement and clears it on release', () => {
    const { input, target } = createManager();

    target.dispatch('pointerdown', pointer(1, 80, 300));
    target.dispatch('pointermove', pointer(1, 120, 300));
    input.update();

    expect(input.state.moveX).toBe(1);
    expect(input.leftThumbDx).toBe(40);
    expect(input.touchLeft.active).toBe(true);

    target.dispatch('pointerup', pointer(1, 120, 300));
    input.update();

    expect(input.state.moveX).toBe(0);
    expect(input.leftThumbDx).toBe(0);
    expect(input.touchLeft.active).toBe(false);
  });

  it('holds jump while the right pointer is down and releases it on pointerup', () => {
    const { input, target } = createManager();

    target.dispatch('pointerdown', pointer(2, 320, 220));
    input.update();
    expect(input.state.jumpHeld).toBe(true);

    target.dispatch('pointerup', pointer(2, 320, 220));
    input.update();
    expect(input.state.jumpHeld).toBe(false);
    expect(input.touchRight.mode).toBe('none');
  });

  it('converts a downward right-thumb swipe into a held slide', () => {
    const { input, target } = createManager();

    target.dispatch('pointerdown', pointer(3, 320, 200));
    target.dispatch('pointermove', pointer(3, 320, 250));
    input.update();

    expect(input.state.crouchHeld).toBe(true);
    expect(input.state.jumpHeld).toBe(false);
    expect(input.touchRight.mode).toBe('crouch');
  });

  it('clears held gestures when the browser cancels a pointer', () => {
    const { input, target } = createManager();

    target.dispatch('pointerdown', pointer(4, 320, 220));
    input.update();
    expect(input.state.jumpHeld).toBe(true);

    target.dispatch('pointercancel', pointer(4, 320, 220));
    input.update();

    expect(input.state.jumpHeld).toBe(false);
    expect(input.state.crouchHeld).toBe(false);
    expect(input.touchRight.mode).toBe('none');
  });

  it('captures active touch pointers so drags can finish outside the canvas', () => {
    const { target } = createManager();

    target.dispatch('pointerdown', pointer(5, 320, 220));

    expect(target.setPointerCapture).toHaveBeenCalledWith(5);
  });
});
